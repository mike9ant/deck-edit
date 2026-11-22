# Deck Edit

A local app for developing slide decks **together with an AI agent**. You and
the agent take turns on the same PowerPoint (.pptx) or PDF file: your edits are
saved straight into the file, the agent's changes appear live, and every agent
turn can be reverted with one click.

![Deck Edit with the sample project open: files on the left, the slide rail and the slide being edited
in the middle, a note for the AI pinned on the slide, and the agent's chat on the right](docs/screenshot.png)

*The [sample project](sample-project/) open in Deck Edit: the agent has built a spreadsheet from the
traction slide and rebuilt the slide from it, the changed slides are flagged at the top, and a note
for the AI is pinned on slide 7.* Open `sample-project/` as a project to try it yourself.

```
┌ Project ▾ /path/to/folder ──────────────────────────────────────────────────────┐
│ Files        │ Mini-slides │  Main slide (select · move · resize ·  │ Chat tabs │
│ deck.pptx    │ ▢ 1         │  edit text · drop images · notes)      │ agent …   │
│ notes.md     │ ▣ 2         │                                        │           │
│ deck.pdf     │ ▢ 3         │                                        │ [composer]│
└──────────────┴─────────────┴────────────────────────────────────────┴───────────┘
```

## Download

**Deck Edit 0.2.1 for macOS** (universal — Apple Silicon and Intel — signed and notarized):
[Deck-Edit-0.2.1.dmg](https://github.com/mike9ant/deck-edit/releases/download/v0.2.1/Deck-Edit-0.2.1.dmg)
· [all releases](https://github.com/mike9ant/deck-edit/releases). Open it and drag Deck Edit to
Applications. The agent runs on [Claude Code](https://claude.com/claude-code); the app shows how to
set it up if it isn't installed yet.

To build it yourself or run it in a browser, see [Running](#running). There's no prebuilt app for
Windows or Linux yet — clone the repo and ask Claude (Claude Code, in the repo folder) to build it for
your platform.

## What you can do

- **Projects** — a project is a folder + its agent chats. Pick one in the top bar.
- **Files** — the folder tree: open `.pptx`, `.pdf`, `.md`, text, spreadsheet and image files in
  tabs; rename (click the selected item again, or F2), drag onto a folder to move, **New folder** and
  **Delete** (to the Trash) in the panel header. Everything reloads when a file changes on disk. A newly
  opened file is a *preview* tab (italic) that the next one replaces, until you edit it or double-click it.
- **Slides** (PPTX)
  - mini-slides rail: click, shift/⌘-click to multi-select, drag to reorder,
    duplicate (⌘D), delete (⌫), copy/paste slides (⌘C / ⌘V)
  - main slide: select (click, shift-click, marquee), move (drag or arrow keys,
    snapping to the slide and other shapes — hold ⌥ to disable), resize (handles;
    pictures keep their aspect ratio), edit existing text in place (double-click or
    Enter — formatting of each run is kept; ⌘B / ⌘I / ⌘U toggle bold / italic / underline on the
    selection, or the word at the caret; ⌘V pastes text only, formatted like where it lands,
    ⌥⇧⌘V keeps the source's bold / italic / underline / strikethrough / colour / font / size —
    read from the macOS clipboard by the server), copy/paste/duplicate/delete shapes
    (also across slides and decks), add a text box, drop or paste images; with 2+ shapes selected, toolbar buttons
    align them (left / centers / right, tops / middles / bottoms) or distribute them with equal
    gaps (3+), relative to the selection — one undo step each
  - **speaker notes** under the slide: a collapsible, resizable, editable panel. Edits save into the
    slide's notes page (formatting kept; a notes page — and a notes master, if the deck has none — is
    created when needed) and are reported to the agent like other edits
  - **copy/paste slides between decks**: ⌘C in one deck's slide list, ⌘V in another's — each slide is
    re-created on the target's matching layout with its shapes and images ("use destination theme")
  - undo/redo (⌘Z / ⇧⌘Z) for all of it
- **Agent chats** — tabs of Claude Code conversations. Each message automatically tells
  the agent which deck/slide you're on, what's selected, which other files are open in tabs, and the edits you made since its
  last turn (already saved). The deck reloads as the agent saves; slides it changed get a
  dot in the rail.
  - **You can keep editing while the agent works.** Decks: your edits are *held* (the agent
    rewrites the whole file), re-applied on top of each version it saves, and saved once its
    turn ends; an edit whose slide/shape it removed is skipped, and slides you both changed are
    pointed out. Text/Markdown: your typing is merged with its changes as they land
    (`viewers/textMerge.ts`) and saved; if part of it overlapped the agent's edit, you're told.
    PDFs stay read-only during a turn.
  - The composer's chip shows how the next turn runs — `mode · model · effort · ⚡` — and
    opens a popover (as in ma-code-navigator) to pick:
    - **approval mode** (⇧Tab cycles): *manual* (approve every edit and command),
      *accept edits* (edits in the folder auto-approved, commands ask), *plan* (read-only turn
      that ends in a plan, with an **Implement this plan** button), *auto approve* (edits and
      commands run without asking — the per-turn backup is the safety net). A running turn
      switches immediately, except into/out of plan.
    - **model** — the CLI's aliases labelled with the version they resolve to (probed from
      your CLI), or Default; **effort** (model's own … max); **fast mode** (Opus only;
      `/fast on|off` in the composer works too); **billing** (Claude subscription or API key).
    - Each pick applies to the chat and becomes the default for new chats. Every turn in the
      transcript notes the mode/model/effort it ran with.
  - **Agent settings** (Settings — the gear at the top right; its **About** tab shows the version): Claude Code CLI found/version/path and who it's
    signed in as (`claude auth status`), a custom CLI path, billing source and an optional
    Anthropic API key (stored in `~/.deck-edit/credentials.json`), defaults for new chats, and a
    per-turn spend cap (`--max-budget-usd`).
  - **Your connectors** (Agent settings, off by default): let the agent use your own MCP servers and
    claude.ai connectors (Slack, Google Drive, Gmail, …) as Claude Code has them, not just the app's
    tools. Their actions show an approval card ("Use a connector: Slack · …") in manual and
    accept-edits modes, run automatically in auto approve, and are read-only in plan mode; "Always
    allow" is per connector, per chat. claude.ai connectors need the Claude subscription login.
  - **Web access** (Agent settings): *Allow* (default), *Ask first* (an approval card before each web
    search or page fetch, in every mode) or *Off* (no web tools). The agent is told about both
    settings, so it can point you to them when a request needs Slack or the web.
  - Every turn starts with a backup of the folder. The files it changed are listed under
    the turn with **Revert** (and **Undo revert**).
  - The agent can screenshot a slide exactly as the app renders it (`screenshot_slide`)
    to check its own layout work.
- **Notes for the agent** — "Note for AI" (or "Draw for AI") at the right of the toolbar (apart from the edit tools); **Select**
  (or Esc) goes back to selecting shapes. Its ▾ menu picks how to place one:
  *Pin at a point* (click), or *Draw on the slide* — circle, underline or arrow at an area
  freehand (several strokes per note; a single click still pins). A drawn note reaches the agent
  as the area it covers (% of the slide, circled vs. marked) plus the shapes under it, and
  `screenshot_slide` with `show_notes` shows the agent the marks themselves.
  **Pin note** (⌘Enter) is the main action; **Act now** (on the left of the note box, ⌘⇧Enter) pins the note and immediately asks the agent, in the open
  chat, to handle it — no need to type the request.
  Notes work on slides, PDF pages (a pin, a drawn mark, or selected text) and **images** (pin or
  draw). They also work on **spreadsheets** (pin or draw on the grid — anchored to cells, so they stay
  with the content; the agent gets the cell(s) and what they contain) and on **selected text** in
  text/code/Markdown files (select, then **Note for AI** in the header — the agent gets the lines and the
  quoted text, which stays highlighted while the note is open; the header lists the file's notes).
  Open notes are sent with every message; the agent resolves them (you see them flip to
  resolved with its one-line summary) and can pin its own notes for you.
- **Claude conversations on this computer** (library icon in the chat tabs): every Cowork session,
  Claude desktop Code session and Claude Code CLI session, newest first — search titles, folders
  and full transcripts, read a transcript, copy files a Cowork session produced into the project,
  and **Attach to chat** to hand one to the agent. The agent has the same reach through its
  `search_conversations` / `read_conversation` tools (read-only; the apps' private stores are
  parsed defensively, see `backend/src/conversations.rs`). Found on macOS, Windows (incl. Microsoft
  Store installs) and Linux; Claude Code's `CLAUDE_CONFIG_DIR` is honored, and
  `DECKEDIT_CLAUDE_DESKTOP_DIR` adds another desktop-app folder. Agent settings shows what was found.
- **Other files**
  - **PDF** — page rail, reorder/duplicate/delete pages, drop an image onto a page, undo/redo. The page's
    text is selectable: the bar over a selection copies it or puts a **note for the agent** on it (the
    agent gets the page and the quoted text, which stays highlighted).
  - **Spreadsheets** (.xlsx / .xlsm) — read-only preview: sheet tabs, formatted values (number
    formats, dates, percentages, currency), column widths, merged cells and basic styling; click a
    cell to see its address and formula/value (the agent is told which sheet/cell you're on). Formulas
    show their last computed result; files saved by scripts (openpyxl) have none until Excel
    recalculates, so those cells show the formula. Charts, images and pivot tables aren't shown.
    The agent edits spreadsheets with openpyxl (installed by `./run.sh setup`).
  - **Text and Markdown** — editable (CodeMirror, with syntax highlighting for Markdown, JSON,
    Python, JS/TS, HTML, CSS, XML, YAML). Edits autosave shortly after you stop typing (⌘S saves
    now), etag-guarded like decks; you can keep typing while the agent works (your typing is merged
    with its changes), and your saved edits are reported to the agent with your next message.
    - Markdown has a **Formatted / Markdown** switch; the last choice is remembered for the next file.
      In **Formatted**, click any paragraph, heading, list item or table cell and type (Enter or
      clicking away commits, Esc cancels, ↑/↓ at a block's first/last line moves to the previous/next
      block — in a table the cell above/below — and ←/→ at a cell's start/end to the previous/next
      cell, ⌘Z/⇧⌘Z undo/redo). In a list, Enter at the end of an item adds one below (same level,
      next number / empty task box) and Backspace in an empty item removes it; in a table, Enter at
      the end of a row's last cell adds a blank row below and Backspace in the empty first cell of
      an empty row removes it. Each writes just that line of the file. Blocks turn editable only when clicked, so dragging across
      paragraphs still selects normally — the bar over such a selection has **Copy** (text) and
      **Copy Markdown** (the source of the blocks it touches). **Bold / italic** toggle with ⌘B / ⌘I
      or the small bar over a selection (`**`/`*` added around it; with the caret in bold/italic text,
      its markers are removed); other formatting is changed in the Markdown tab. Each change is
      written back into exactly the characters it came from, so the rest of the file is never
      reformatted, and a toggle that Markdown wouldn't read as formatting is refused rather than
      leaving stray `*` (`viewers/mdSourceEdit.ts`). Inline
      code and code blocks are editable in place too; images are read-only there; ⌘-click opens a link.
    - A document's toolbar shows "Saved" only once the file was changed this session (by you or
      the agent); Saving… / Unsaved… show whenever they apply.

## Running

```bash
./run.sh setup     # once: Python env for the agent (python-pptx, pymupdf, pypdf, openpyxl) + npm install
./run.sh           # build and start → http://127.0.0.1:3101
./run.sh dev       # hot-reload frontend on http://127.0.0.1:5180
./run.sh test      # backend + frontend unit tests
./run.sh desktop   # build the macOS app → /Applications/Deck Edit.app, and open it
./run.sh release   # shareable build: universal, signed + notarized .dmg → release/
./run.sh push      # push main; bumps the patch version once per new day of commits
```

Versioning: `./run.sh push` bumps the **patch** version (0.1.0 → 0.1.1) when the commits being
pushed are from a different day than the last pushed commit, and commits "Version 0.1.1" before
pushing. Bump the **minor** version by hand when you want one: `node scripts/version.mjs bump-minor`
(0.1.4 → 0.2.0), then commit — the next push then adds no patch bump. The version lives in several
files (`desktop/tauri.conf.json`, the `Cargo.toml`s, `frontend/package.json`, `frontend/src/version.ts`);
`node scripts/version.mjs [bump-patch|bump-minor]` reads or bumps them together.
A pre-push hook (`.githooks/`, enabled by `./run.sh setup`) stops a plain `git push` that skipped a due bump.

Requirements: Rust, Node 20+, Python 3, and the [Claude Code CLI](https://claude.com/claude-code)
logged in (`claude login`). The agent uses your Claude Code login (subscription) by default;
switch to an Anthropic API key in Agent settings.

App data (projects, chats, notes, per-turn backups) lives in `~/.deck-edit/`
(`DECKEDIT_DATA_DIR` to change).

### Desktop app (macOS)

`./run.sh desktop` builds **Deck Edit.app** (Tauri), installs it in `/Applications` and opens
it; after that, start it like any app (Launchpad, Spotlight, the Dock). It runs the same server
inside the app on a private localhost port — nothing to start, no terminal — and shares
`~/.deck-edit/` (projects, chats, settings) with `./run.sh`.

- It takes your login shell's PATH, so it finds `claude` (and the tools the agent runs) as a
  terminal would.
- Without the repo's `.venv`, it sets up its own Python env on first launch
  (`~/.deck-edit/venv`, about a minute; Settings shows the progress). Needs `python3`.
- Links out of the app open in your browser. Logs: `~/.deck-edit/logs/desktop.log`.
- The first build downloads and compiles Tauri (a few minutes); later builds are quick.
  The app is built locally and unsigned, which is fine on the Mac that built it.

### Sharing the app (signed, notarized .dmg)

`./run.sh release` makes a build for other Macs: one app for Apple Silicon and Intel, signed
with your Developer ID, notarized by Apple (ticket stapled), in a drag-to-Applications
`release/Deck-Edit-<version>.dmg`. Recipients open it without Gatekeeper warnings. They need
the Claude Code CLI signed in (or an Anthropic API key in Settings) and `python3`.

One-time setup on the building Mac:
1. A **Developer ID Application** certificate in the login keychain (developer.apple.com →
   Certificates; request it from Keychain Access → Certificate Assistant).
2. Notarization credentials, stored in the keychain (an app-specific password from
   appleid.apple.com):
   `xcrun notarytool store-credentials deck-edit --apple-id <email> --team-id <TEAMID>`

Nothing secret is in the repo: the build finds the certificate and the `deck-edit` profile in the
keychain (`DECKEDIT_SIGN_IDENTITY` / `DECKEDIT_NOTARY_PROFILE` to use others). The `.dmg` is named
after the current version (bumped by `./run.sh push`).

## How edits stay safe for PowerPoint

Decks are parsed and rendered with [`@diceui/pptx-core`](https://www.npmjs.com/package/@diceui/pptx-core)
(pinned). Each edit mutates the XML of only the parts it touches; on save,
**every untouched part of the .pptx is copied byte-for-byte** from the original
(animations, comments, embedded fonts, vendor extensions all survive). Speaker-notes
pages, which the engine doesn't model, are repaired by `frontend/src/deck/packageHygiene.ts`
(orphaned notes of deleted slides are dropped; duplicated slides get their own copy).
Shapes repeating an id on a slide (common in script-built decks) are renumbered when the deck
loads, as PowerPoint does — otherwise a click could select, and an edit change, the wrong shape;
a slide is saved with the new ids only when you edit it.

Saves are atomic (temp file + rename) and etag-guarded: if the file changed on disk
since it was loaded (agent, PowerPoint), the save is refused and the deck reloads
instead of overwriting.

Round-trip test against a real deck:

```bash
DECKEDIT_TEST_DECK=/path/to/deck.pptx ./run.sh test frontend
```

It applies every edit kind, saves, and checks that only the expected parts changed and no
relationship dangles; the output (`/tmp/deckedit-roundtrip.pptx`) can be opened in PowerPoint.

## Architecture

- `backend/` — Rust (axum). Projects, folder tree, raw file read/write, a `notify` folder
  watcher → Server-Sent Events (`/api/events`), slide notes, chats running the Claude Code
  CLI headless (`claude -p --output-format stream-json`, resumed per chat), a PreToolUse
  permission relay, per-turn backups (`backups.rs`, APFS copy-on-write), and a small MCP
  server (`mcp.rs`) exposing notes / current view / slide screenshots to the agent.
- `desktop/` — the macOS app (Tauri): runs the backend in-process (`deck_edit::run_server`)
  and shows it in a window, with a splash while it starts. `icons/make_icon.py` draws the icon.
- `frontend/` — React + TypeScript + Vite + Tailwind. `deck/` (PPTX editing on top of
  pptx-core), `pdf/` (pdf.js + pdf-lib), `chat/`, `notes/`, `viewers/`.

The agent engine and chat flow are adapted from ma-code-navigator's Atlas agent.
