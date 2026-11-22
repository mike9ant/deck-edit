#!/bin/bash
# Deck Edit — run script
#   ./run.sh setup            Python env (.venv with python-pptx, pymupdf, pypdf, openpyxl) + npm install
#   ./run.sh                  Build everything and (re)start the server  → http://127.0.0.1:3101
#   ./run.sh build            Just build (backend release + frontend dist)
#   ./run.sh dev              Backend in background + Vite dev server (hot reload) → http://127.0.0.1:5180
#   ./run.sh stop             Stop the server started from this folder
#   ./run.sh logs             Tail the server log
#   ./run.sh test [frontend|backend]   Unit tests
#   ./run.sh desktop          Build the macOS app, install it as /Applications/Deck Edit.app and open it
#   ./run.sh release          Shareable build: universal app, signed + notarized, in a .dmg → release/
#   ./run.sh push             Push main; bumps the patch version first when the commits are from a new day
#
# Env: DECKEDIT_PORT (default 3101), DECKEDIT_DATA_DIR (default ~/.deck-edit),
#      DECKEDIT_TEST_DECK=<path.pptx> runs the round-trip test on that deck (default: the sample deck).
#      release: DECKEDIT_SIGN_IDENTITY (default: the keychain's "Developer ID Application" certificate),
#               DECKEDIT_NOTARY_PROFILE (default deck-edit — `xcrun notarytool store-credentials deck-edit …`).

set -e
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND="$ROOT/frontend"
PID_FILE="$ROOT/.server.pid"
LOG_FILE="$ROOT/.server.log"
PORT="${DECKEDIT_PORT:-3101}"
CARGO="${CARGO:-$(command -v cargo || echo "$HOME/.cargo/bin/cargo")}"
BIN="$ROOT/target/release/deck-edit"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
say() { echo -e "${GREEN}==>${NC} $*"; }
warn() { echo -e "${YELLOW}!!${NC} $*"; }

setup() {
  # The pre-push hook that guards the once-a-day version bump (see push below).
  git -C "$ROOT" config core.hooksPath .githooks
  if [ ! -x "$ROOT/.venv/bin/python3" ]; then
    say "Creating Python env (.venv)"
    python3 -m venv "$ROOT/.venv"
  fi
  "$ROOT/.venv/bin/pip" install -q --upgrade python-pptx pymupdf pypdf pillow openpyxl
  say "Installing frontend packages"
  (cd "$FRONTEND" && npm install --no-audit --no-fund)
}

build_backend() { say "Building backend"; (cd "$ROOT" && "$CARGO" build --release -p deck-edit); }
build_frontend() {
  [ -d "$FRONTEND/node_modules" ] || (cd "$FRONTEND" && npm install --no-audit --no-fund)
  say "Building frontend"; (cd "$FRONTEND" && npm run build)
}

APP_NAME="Deck Edit"
APP_BUNDLE="$ROOT/target/release/bundle/macos/$APP_NAME.app"
APP_INSTALLED="/Applications/$APP_NAME.app"
# The app before it was renamed to Deck Edit; replaced on install.
LEGACY_APP="/Applications/PPTX Edit.app"

# The desktop app (desktop/, Tauri) runs the server in-process and bundles
# frontend/dist, so the frontend must be built first. No beforeBuildCommand:
# tauri's spawned shell can break node on some setups.
build_desktop() {
  say "Building the desktop app (the first build downloads and compiles Tauri — a few minutes)"
  (cd "$ROOT/desktop" && npx --yes @tauri-apps/cli@2 build)
}

# Quit a running copy (the single-instance plugin would just focus the old
# build), replace the installed app, and open it.
install_desktop() {
  if pgrep -f deck-edit-desktop >/dev/null 2>&1; then
    say "Quitting the running app"
    osascript -e "tell application \"$APP_NAME\" to quit" 2>/dev/null || true
    for _ in $(seq 1 20); do pgrep -f deck-edit-desktop >/dev/null 2>&1 || break; sleep 0.5; done
    sleep 1  # let LaunchServices settle; an immediate re-open can fail with -600
  fi
  if [ -d "$LEGACY_APP" ]; then
    osascript -e 'tell application "PPTX Edit" to quit' 2>/dev/null || true
    for _ in $(seq 1 20); do pgrep -f pptx-edit-desktop >/dev/null 2>&1 || break; sleep 0.5; done
    rm -rf "$LEGACY_APP"
    say "Removed the old PPTX Edit.app (now Deck Edit)"
  fi
  rm -rf "$APP_INSTALLED"
  cp -R "$APP_BUNDLE" "$APP_INSTALLED"
  say "Installed → $APP_INSTALLED  (logs: ~/.deck-edit/logs/desktop.log)  · $(date '+%Y-%m-%d %H:%M:%S')"
  open "$APP_INSTALLED"
}

# Submit a file to Apple's notary service and wait; on rejection, show Apple's log and stop.
notarize() {
  local file="$1" out id
  say "Notarizing $(basename "$file") (Apple usually takes a few minutes)"
  out="$(xcrun notarytool submit "$file" --keychain-profile "$NOTARY_PROFILE" --wait 2>&1)" || true
  echo "$out" | grep -E "^ *(id|status):" | sort -u
  if ! echo "$out" | grep -q "status: Accepted"; then
    id="$(echo "$out" | sed -n 's/^ *id: \([0-9a-f-]*\).*/\1/p' | head -1)"
    echo "$out" | tail -5
    [ -n "$id" ] && xcrun notarytool log "$id" --keychain-profile "$NOTARY_PROFILE" | tail -40
    warn "Notarization of $(basename "$file") failed"; exit 1
  fi
}

# A build to give to other people: one app for Apple Silicon and Intel Macs, signed with your
# Developer ID, notarized by Apple (with the ticket stapled, so it opens cleanly offline too),
# packaged in a drag-to-Applications .dmg that is itself signed and notarized.
release() {
  NOTARY_PROFILE="${DECKEDIT_NOTARY_PROFILE:-deck-edit}"
  local identity="${DECKEDIT_SIGN_IDENTITY:-$(security find-identity -v -p codesigning | sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' | head -1)}"
  [ -n "$identity" ] || { warn "No \"Developer ID Application\" certificate in the keychain (set DECKEDIT_SIGN_IDENTITY)"; exit 1; }
  xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" >/dev/null 2>&1 \
    || { warn "No notarization credentials \"$NOTARY_PROFILE\" — run: xcrun notarytool store-credentials $NOTARY_PROFILE --apple-id <email> --team-id <TEAMID>"; exit 1; }
  local version; version="$(node -p "require('$ROOT/desktop/tauri.conf.json').version")"
  local out="$ROOT/release"
  local app="$ROOT/target/universal-apple-darwin/release/bundle/macos/$APP_NAME.app"
  local dmg="$out/Deck-Edit-$version.dmg"
  say "Release $version — signing as: $identity"

  build_frontend
  command -v rustup >/dev/null && rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null
  say "Building the universal app (Apple Silicon + Intel)"
  (cd "$ROOT/desktop" && APPLE_SIGNING_IDENTITY="$identity" npx --yes @tauri-apps/cli@2 build --target universal-apple-darwin --bundles app)
  codesign --verify --deep --strict "$app"
  codesign -dv "$app" 2>&1 | grep -q "runtime" || { warn "The app isn't signed with the hardened runtime (notarization needs it)"; exit 1; }

  mkdir -p "$out"
  local zip="$out/.notarize-app.zip"
  ditto -c -k --keepParent "$app" "$zip"
  notarize "$zip"
  rm -f "$zip"
  xcrun stapler staple -q "$app"

  say "Packaging the .dmg"
  local stage; stage="$(mktemp -d)"
  cp -R "$app" "$stage/"
  ln -s /Applications "$stage/Applications"
  rm -f "$dmg"
  hdiutil create -quiet -volname "$APP_NAME" -srcfolder "$stage" -fs HFS+ -format UDZO "$dmg"
  rm -rf "$stage"
  codesign --sign "$identity" --timestamp "$dmg"
  notarize "$dmg"
  xcrun stapler staple -q "$dmg"

  say "Gatekeeper check (what a recipient's Mac does)"
  spctl -a -vv -t execute "$app" 2>&1 | sed 's/^/   /'
  spctl -a -vv -t open --context context:primary-signature "$dmg" 2>&1 | sed 's/^/   /'
  say "Ready to share → $dmg ($(du -h "$dmg" | cut -f1), $(lipo -archs "$app/Contents/MacOS/deck-edit-desktop"))  · $(date '+%Y-%m-%d %H:%M:%S')"
}

# Push main. The patch version goes up once per new day of commits: when the newest commit being
# pushed is from a different day than the last commit on origin and the version hasn't changed yet,
# bump it (scripts/version.mjs bump-patch), commit "Version X.Y.Z", then push. A minor bump done by
# hand (scripts/version.mjs bump-minor) counts as the bump. The pre-push hook refuses a plain
# `git push` that skipped a due bump.
push() {
  cd "$ROOT"
  local branch; branch="$(git rev-parse --abbrev-ref HEAD)"
  [ "$branch" = main ] || { warn "On branch $branch — ./run.sh push pushes main"; exit 1; }
  [ -z "$(git status --porcelain)" ] || { warn "Uncommitted changes — commit them first"; exit 1; }
  git fetch -q origin
  local count; count="$(git rev-list --count origin/main..HEAD)"
  [ "$count" -gt 0 ] || { say "Nothing to push (main is at origin/main)"; return; }
  local last_day new_day pushed_version version
  last_day="$(git log -1 --format=%cd --date=short-local origin/main)"
  new_day="$(git log -1 --format=%cd --date=short-local HEAD)"
  pushed_version="$(git show origin/main:desktop/tauri.conf.json | sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' | head -1)"
  version="$(node scripts/version.mjs)"
  if [ "$new_day" != "$last_day" ] && [ "$version" = "$pushed_version" ]; then
    local next; next="$(node scripts/version.mjs bump-patch)"
    git add desktop/tauri.conf.json backend/Cargo.toml desktop/Cargo.toml Cargo.lock \
      frontend/src/version.ts frontend/package.json frontend/package-lock.json
    # Dated like the newest commit it versions, so the next push compares days with the work, not the push.
    local when; when="$(git log -1 --format=%cI HEAD)"
    GIT_AUTHOR_DATE="$when" GIT_COMMITTER_DATE="$when" \
      git commit -q -m "Version $next" -m "Commits from $new_day (last push: $last_day)."
    say "Version $version → $next (new day of commits: $new_day; last push: $last_day)"
    count=$((count + 1))
  else
    say "Version stays $version ($([ "$new_day" = "$last_day" ] && echo "same day as the last push" || echo "already bumped since the last push"))"
  fi
  say "Pushing $count commit(s) to origin/main"
  git push origin main
}

stop() {
  if [ -f "$PID_FILE" ]; then
    local pid; pid="$(cat "$PID_FILE")"
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      for _ in 1 2 3 4 5 6; do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
      kill -9 "$pid" 2>/dev/null || true
      say "Stopped server (pid $pid)"
    fi
    rm -f "$PID_FILE"
  fi
}

start_backend() {
  stop
  local busy; busy="$(lsof -nP -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1 || true)"
  if [ -n "$busy" ]; then warn "Port $PORT is in use by pid $busy — set DECKEDIT_PORT to use another"; exit 1; fi
  DECKEDIT_PORT="$PORT" nohup "$BIN" --port "$PORT" >"$LOG_FILE" 2>&1 &
  echo $! >"$PID_FILE"
  for _ in $(seq 1 40); do
    curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break
    sleep 0.25
  done
  say "Server running → http://127.0.0.1:$PORT  (log: ./run.sh logs)  · $(date '+%Y-%m-%d %H:%M:%S')"
}

case "${1:-start}" in
  setup) setup ;;
  build) build_backend; build_frontend ;;
  start) build_backend; build_frontend; start_backend ;;
  dev)
    build_backend; start_backend
    say "Vite dev server → http://127.0.0.1:5180  · $(date '+%Y-%m-%d %H:%M:%S')"
    cd "$FRONTEND" && DECKEDIT_BACKEND="http://127.0.0.1:$PORT" npx vite --host 127.0.0.1
    ;;
  desktop) build_frontend; build_desktop; install_desktop ;;
  release) release ;;
  push) push ;;
  stop) stop ;;
  logs) tail -f "$LOG_FILE" ;;
  test)
    case "${2:-all}" in
      backend) (cd "$ROOT" && "$CARGO" test -p deck-edit) ;;
      frontend) (cd "$FRONTEND" && npx vitest run) ;;
      *) (cd "$ROOT" && "$CARGO" test -p deck-edit) && (cd "$FRONTEND" && npx vitest run) ;;
    esac
    ;;
  *) echo "usage: ./run.sh [setup|start|build|dev|stop|logs|test [frontend|backend]|desktop|release|push]"; exit 1 ;;
esac
