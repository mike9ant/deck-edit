# Deck Edit — notes for working on this repo

- Build/run only through `./run.sh` (`setup`, `build`, `dev`, `test [frontend|backend]`).
- **Push only with `./run.sh push`, never a plain `git push`.** The **patch** version goes up once
  per new day of commits: when the newest commit being pushed is from a different day than the last
  commit on origin, it bumps X.Y.Z → X.Y.(Z+1) everywhere (`scripts/version.mjs bump-patch`),
  commits "Version X.Y.Z", then pushes. The `.githooks/pre-push` hook (enabled by `./run.sh setup`)
  refuses a plain push that skipped a due bump. **Minor** bumps are the owner's call, made by hand
  with `node scripts/version.mjs bump-minor` (never bump minor on your own); a manual bump since
  the last push counts, so no patch bump is added. Never edit version numbers in files directly.
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
