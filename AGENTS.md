# Stepstone agent notes

## Pi APIs

- Before changing an extension API, read Pi's installed `docs/extensions.md`, `docs/tui.md`, `docs/packages.md`, and `docs/session-format.md`.

## Architecture

- Keep Session Tasks as canonical, versioned, branch-aware Pi custom-entry snapshots.
- Route every Project Goal mutation through `WorklistApplicationService` and `src/project-mutations.ts`.
- Preserve the cross-process lock, atomic replacement, and explicit lifecycle confirmation.
- Resolve worklist paths only through `resolveWorklistLocation`.
- Use `createWorklistLocator` for long-lived interfaces. Do not cache or construct worklist paths.
- Preserve frozen, historical, and retired Goal IDs. Use `findGoalByStoredId` and include stored Goal ID references in `migrateProjectGoalIds`.
- Store dependency edges only in `dependsOn`. Derive all other dependency state in `src/dependencies.ts`.
- Keep board rendering pure in `src/tui/goal-board.ts` and I/O in `src/tui/goal-board-runtime.ts`.
- Use `StringEnum` for model-facing string enums.

See `docs/storage.md`, `docs/dependencies.md`, and `docs/pi.md`.

## Published package

- Keep published executable graphs free of runtime Pi imports.
- Put Pi types in separate `import type` statements.
- Add executables to the manifest `bin` map and `BIN_EXERCISES`.
- Run `npm run imports:check` and `npm run no-pi-install:check`.
- Treat `CLI_COMMAND_CONTRACT.binary` as the published identity source.
- Derive the companion executable name with `DISPATCH_BINARY`.
- Keep persistent dispatch namespaces unchanged during package renames.

See `docs/development.md` for checks and package rules.

## Generated files and releases

- Do not hand-edit `docs/cli.md`, `.claude/skills/stepstone/SKILL.md`, or `docs/ROADMAP.md`.
- Run `npm run docs` and commit generated output with its source changes.
- Follow `docs/releasing.md`. Publish only through CI. Never run `npm publish`.
