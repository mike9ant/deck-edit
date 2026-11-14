# PPTX Edit

A local app for developing slide decks **together with an AI agent**. You and
the agent take turns on the same PowerPoint (.pptx) or PDF file: your edits are
saved straight into the file, the agent's changes appear live, and every agent
turn can be reverted with one click.

```
┌ Project ▾ /path/to/folder ───────────────────────────────────────────────────┐
│ Files        │ Mini-slides │  Main slide (select · move · resize ·  │ Chat tabs │
│ deck.pptx    │ ▢ 1         │  edit text · drop images · notes)      │ agent …   │
│ notes.md     │ ▣ 2         │                                        │           │
│ deck.pdf     │ ▢ 3         │                                        │ [composer]│
└──────────────┴─────────────┴────────────────────────────────────────┴───────────┘
```

## Running

```bash
./run.sh setup     # once: Python env for the agent (python-pptx, pymupdf, pypdf, openpyxl) + npm install
./run.sh           # build and start → http://127.0.0.1:3101
./run.sh dev       # hot-reload frontend on http://127.0.0.1:5180
./run.sh test      # backend + frontend unit tests
```

Requirements: Rust, Node 20+, Python 3, and the [Claude Code CLI](https://claude.com/claude-code)
logged in (`claude login`). The agent uses your Claude Code login (subscription) by default;
switch to an Anthropic API key in Agent settings.

App data (projects, chats, notes, per-turn backups) lives in `~/.pdf-edit/`
(`PDFEDIT_DATA_DIR` to change).

## What you can do

- **Projects** — a project is a folder + its agent chats. Pick one in the top bar.
- **Files** — the folder tree; open `.pptx`, `.pdf`, `.md`, text and image files in tabs.
  Click selects (and previews a file), double-click opens it to stay; ⌘/⇧-click select several.
  Rename in place by clicking the selected item again after a pause (or Enter / F2); drag items
  onto a folder to move them; **New folder** and **Delete** (⌫, after a confirmation — files go to
  the Trash, folders only when empty) are in the panel header, which also hides the panel. Open
  tabs and notes follow renames and moves; long names are shortened in the middle.
  Everything reloads when the file changes on disk.
  - A newly opened file is a *preview* tab (italic title): opening another file replaces it. It
    stays open once you change the file (any edit, typing, a pinned note), the agent or another
    app changes it, or you double-click the tab; kept tabs stay until you close them.
  - A document's toolbar shows "Saved" only once the file was changed this session (by you or
    the agent); Saving… / Unsaved… show whenever they apply.
  - **Text and Markdown are editable** (CodeMirror, with syntax highlighting for Markdown, JSON,
    Python, JS/TS, HTML, CSS, XML, YAML). Edits autosave shortly after you stop typing (⌘S saves
    now), etag-guarded like decks; the editor is read-only while the agent works, and your saved
    edits are reported to the agent with your next message.
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
    code, code blocks and images are read-only there; ⌘-click opens a link.
- **Slides** (PPTX)
  - mini-slides rail: click, shift/⌘-click to multi-select, drag to reorder,
    duplicate (⌘D), delete (⌫), copy/paste slides (⌘C / ⌘V)
  - main slide: select (click, shift-click, marquee), move (drag or arrow keys,
    snapping to the slide and other shapes — hold ⌥ to disable), resize (handles;
    pictures keep their aspect ratio), edit existing text in place (double-click or
    Enter — formatting of each run is kept; ⌘B / ⌘I / ⌘U toggle bold / italic / underline on the
    selection, or the word at the caret), copy/paste/duplicate/delete shapes
    (also across slides and decks), add a text box, drop or paste images; with 2+ shapes selected, toolbar buttons
    align them (left / centers / right, tops / middles / bottoms) or distribute them with equal
    gaps (3+), relative to the selection — one undo step each
  - **speaker notes** under the slide: a collapsible, resizable, editable panel. Edits save into the
    slide's notes page (formatting kept; a notes page — and a notes master, if the deck has none — is
    created when needed) and are reported to the agent like other edits
  - **copy/paste slides between decks**: ⌘C in one deck's slide list, ⌘V in another's — each slide is
    re-created on the target's matching layout with its shapes and images ("use destination theme")
  - undo/redo (⌘Z / ⇧⌘Z) for all of it
- **PDF** — page rail, reorder/duplicate/delete pages, drop an image onto a page, undo/redo. The page's
  text is selectable: the bar over a selection copies it or puts a **note for the agent** on it (the
  agent gets the page and the quoted text, which stays highlighted).
- **Spreadsheets** (.xlsx / .xlsm) — read-only preview: sheet tabs, formatted values (number
  formats, dates, percentages, currency), column widths, merged cells and basic styling; click a
  cell to see its address and formula/value (the agent is told which sheet/cell you're on). Formulas
  show their last computed result; files saved by scripts (openpyxl) have none until Excel
  recalculates, so those cells show the formula. Charts, images and pivot tables aren't shown.
  The agent edits spreadsheets with openpyxl (installed by `./run.sh setup`).
- **Claude conversations on this computer** (library icon in the chat tabs): every Cowork session,
  Claude desktop Code session and Claude Code CLI session, newest first — search titles, folders
  and full transcripts, read a transcript, copy files a Cowork session produced into the project,
  and **Attach to chat** to hand one to the agent. The agent has the same reach through its
  `search_conversations` / `read_conversation` tools (read-only; the apps' private stores are
  parsed defensively, see `backend/src/conversations.rs`). Found on macOS, Windows (incl. Microsoft
  Store installs) and Linux; Claude Code's `CLAUDE_CONFIG_DIR` is honored, and
  `PDFEDIT_CLAUDE_DESKTOP_DIR` adds another desktop-app folder. Agent settings shows what was found.
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
  - **Agent settings** (gear in the chat tabs): Claude Code CLI found/version/path and who it's
    signed in as (`claude auth status`), a custom CLI path, billing source and an optional
    Anthropic API key (stored in `~/.pdf-edit/credentials.json`), defaults for new chats, and a
    per-turn spend cap (`--max-budget-usd`).
  - Every turn starts with a backup of the folder. The files it changed are listed under
    the turn with **Revert** (and **Undo revert**).
  - The agent can screenshot a slide exactly as the app renders it (`screenshot_slide`)
    to check its own layout work.

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
PDFEDIT_TEST_DECK=/path/to/deck.pptx ./run.sh test frontend
```

It applies every edit kind, saves, and checks that only the expected parts changed and no
relationship dangles; the output (`/tmp/pdfedit-roundtrip.pptx`) can be opened in PowerPoint.

## Architecture

- `backend/` — Rust (axum). Projects, folder tree, raw file read/write, a `notify` folder
  watcher → Server-Sent Events (`/api/events`), slide notes, chats running the Claude Code
  CLI headless (`claude -p --output-format stream-json`, resumed per chat), a PreToolUse
  permission relay, per-turn backups (`backups.rs`, APFS copy-on-write), and a small MCP
  server (`mcp.rs`) exposing notes / current view / slide screenshots to the agent.
- `frontend/` — React + TypeScript + Vite + Tailwind. `deck/` (PPTX editing on top of
  pptx-core), `pdf/` (pdf.js + pdf-lib), `chat/`, `notes/`, `viewers/`.

The agent engine and chat flow are adapted from ma-code-navigator's Atlas agent.
