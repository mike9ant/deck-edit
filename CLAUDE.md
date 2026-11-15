# Deck Edit — notes for working on this repo

- Build/run only through `./run.sh` (`setup`, `build`, `dev`, `test [frontend|backend]`).
- Backend: Rust/axum in `backend/src` (one module per concern; see the module doc comments).
  All models serialize camelCase. Data lives in `~/.deck-edit` (override `DECKEDIT_DATA_DIR`).
- Frontend: React + TS + zustand + Tailwind in `frontend/src`.
  - PPTX editing must go through `useDecks().apply(key, op, description)` — never write
    package XML directly. The description is what the agent is told the user changed.
  - Saving: `writePptx` → `repairPackage` (packageHygiene.ts) → etag-guarded PUT.
    Never bypass `repairPackage`; never save without the etag.
  - `@diceui/pptx-core` is pinned to an exact version on purpose; after upgrading it, rerun
    `DECKEDIT_TEST_DECK=<real deck> ./run.sh test frontend` and check fidelity with
    `render-check.html?url=/api/projects/<id>/file?path=<deck>` (dev server).
- Per-folder/per-deck state is keyed by `${projectId}:${path}`.
- The agent's context block is composed in `backend/src/chat.rs::compose_prompt` and its
  standing instructions in `system_prompt`; its app tools are in `backend/src/mcp.rs`.
