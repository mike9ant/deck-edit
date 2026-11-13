#!/bin/bash
# PPTX Edit — run script
#   ./run.sh setup            Python env (.venv with python-pptx, pymupdf, pypdf) + npm install
#   ./run.sh                  Build everything and (re)start the server  → http://127.0.0.1:3101
#   ./run.sh build            Just build (backend release + frontend dist)
#   ./run.sh dev              Backend in background + Vite dev server (hot reload) → http://127.0.0.1:5180
#   ./run.sh stop             Stop the server started from this folder
#   ./run.sh logs             Tail the server log
#   ./run.sh test [frontend|backend]   Unit tests
#
# Env: PDFEDIT_PORT (default 3101), PDFEDIT_DATA_DIR (default ~/.pdf-edit),
#      PDFEDIT_TEST_DECK=<path.pptx> enables the real-deck round-trip test.

set -e
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND="$ROOT/frontend"
PID_FILE="$ROOT/.server.pid"
LOG_FILE="$ROOT/.server.log"
PORT="${PDFEDIT_PORT:-3101}"
CARGO="${CARGO:-$(command -v cargo || echo "$HOME/.cargo/bin/cargo")}"
BIN="$ROOT/target/release/pdf-edit"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
say() { echo -e "${GREEN}==>${NC} $*"; }
warn() { echo -e "${YELLOW}!!${NC} $*"; }

setup() {
  if [ ! -x "$ROOT/.venv/bin/python3" ]; then
    say "Creating Python env (.venv)"
    python3 -m venv "$ROOT/.venv"
  fi
  "$ROOT/.venv/bin/pip" install -q --upgrade python-pptx pymupdf pypdf pillow
  say "Installing frontend packages"
  (cd "$FRONTEND" && npm install --no-audit --no-fund)
}

build_backend() { say "Building backend"; (cd "$ROOT" && "$CARGO" build --release); }
build_frontend() {
  [ -d "$FRONTEND/node_modules" ] || (cd "$FRONTEND" && npm install --no-audit --no-fund)
  say "Building frontend"; (cd "$FRONTEND" && npm run build)
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
  if [ -n "$busy" ]; then warn "Port $PORT is in use by pid $busy — set PDFEDIT_PORT to use another"; exit 1; fi
  PDFEDIT_PORT="$PORT" nohup "$BIN" --port "$PORT" >"$LOG_FILE" 2>&1 &
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
    cd "$FRONTEND" && PDFEDIT_BACKEND="http://127.0.0.1:$PORT" npx vite --host 127.0.0.1
    ;;
  stop) stop ;;
  logs) tail -f "$LOG_FILE" ;;
  test)
    case "${2:-all}" in
      backend) (cd "$ROOT" && "$CARGO" test) ;;
      frontend) (cd "$FRONTEND" && npx vitest run) ;;
      *) (cd "$ROOT" && "$CARGO" test) && (cd "$FRONTEND" && npx vitest run) ;;
    esac
    ;;
  *) echo "usage: ./run.sh [setup|start|build|dev|stop|logs|test [frontend|backend]]"; exit 1 ;;
esac
