# Deck Edit — notes for working on this repo

- Build/run only through `./run.sh` (`setup`, `build`, `dev`, `test [frontend|backend]`).
- **Push only with `./run.sh push`, never a plain `git push`.** The minor version goes up once per
  new day of commits: when the newest commit being pushed is from a different day than the last
  commit on origin, it bumps X.Y.Z → X.(Y+1).0 everywhere (`scripts/version.mjs`), commits
  "Version X.Y", then pushes. The `.githooks/pre-push` hook (enabled by `./run.sh setup`) refuses
  a plain push that skipped a due bump. Don't edit version numbers by hand — use the script.
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
