# pi-worklist agent notes

- Read Pi's installed `docs/extensions.md`, `docs/tui.md`, `docs/packages.md`, and `docs/session-format.md` before changing extension APIs.
- Session Tasks are canonical versioned custom-entry snapshots and must remain branch-aware.
- Project Goals are canonical in `<git-root>/.pi/worklist.json` and every mutation, from any interface (tool, command, dashboard, terminal board, CLI), must go through the shared `WorklistApplicationService` in `src/application-service.ts`, whose writes run through `src/project-mutations.ts` so the cross-process lock plus atomic rename apply everywhere.
- Never add a project lifecycle path that bypasses explicit confirmation.
- Goal IDs are derived from the title in `src/goal-selection.ts` and frozen at creation; every ID a live goal has had stays resolvable and reserved, while deleting a goal retires all its IDs so they stay reserved but no longer resolve. Any new live-reference field that stores a goal ID must resolve through `findGoalByStoredId` and be rewritten by `migrateProjectGoalIds`.
- Dependency edges are stored in one direction only, as `dependsOn` on the goal that waits; blocked, dependents, cycles, and the sequencing views behind `next`, `ready`, and `waves` are all derived in `src/dependencies.ts` and must never become stored state.
- Nothing reachable from `src/cli.ts`, including the terminal board in `src/tui/`, may import `@earendil-works/*`; the compiled bin has to run with only Node and its declared runtime dependencies, never Pi peers. `npm run imports:check` (inside `npm run check`) enforces this from the sources, and `npm run no-pi-install:check` proves it by packing the tarball and driving the installed bin with no Pi present, which is why a Pi type belongs in an `import type` statement rather than an inline `import { type Foo }`.
- Keep the board's rendering pure in `src/tui/goal-board.ts` and all I/O in `src/tui/goal-board-runtime.ts`, so frames stay testable without a pseudo-terminal.
- Keep the widget compact and width-safe.
- Keep the model-facing schema compatible with Google providers by using `StringEnum` for string enums.
- Run `npm run check`, `npm audit`, `npm run pack:check`, and the real Pi RPC test before release.
- Releases are published by CI from a `v*.*.*` tag push, never by hand: run `npm version <bump>` and `git push --follow-tags`, and never `npm publish`. The tag must agree with `package.json`, `.github/workflows/release.yml` re-runs `npm run verify` against the tagged commit, and npm authenticates that workflow by filename over OIDC, so renaming or moving it breaks publishing until the package's Trusted Publishers entry is updated to match.
- `docs/cli.md` and `.claude/skills/worklist/SKILL.md` are generated from `src/cli-contract.ts`; never hand-edit them, run `npm run docs` and commit the result, which `npm run docs:check` and the test suite both enforce.
- Do not manually add a changelog.
