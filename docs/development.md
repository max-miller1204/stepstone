<!-- markdownlint-disable MD013 -->

# Development

```sh
git clone https://github.com/max-miller1204/stepstone.git
cd stepstone
npm install
npm run check
npm run pack:check
npm run no-pi-install:check
```

`npm run worklist` runs this checkout's CLI, and `node src/cli.ts project <action>` is the same thing spelled out; both need Node 22.18 or newer for native type stripping.
The package ships TypeScript source directly because Pi loads extensions through jiti, and compiles to `dist/` only for the published bin, which Node refuses to type-strip under `node_modules`.

## Checks

| Command | What it proves |
| --- | --- |
| `npm run check` | Types, the import scan, Biome lint and format, and the whole test suite |
| `npm run docs:check` | The generated documents match the contract they come from |
| `npm run imports:check` | Nothing the CLI loads imports a Pi package |
| `npm run pack:check` | The tarball's file list is what the manifest claims |
| `npm run no-pi-install:check` | The packed, installed bin works with no Pi present |
| `npm run verify` | `check` plus `pack:check`, the gate the release workflow re-runs |

The test suite includes real Pi RPC load tests in temporary repositories, so it exercises the extension against Pi rather than only against mocks.

`npm run imports:check` reads the module graph behind `src/cli.ts` and refuses any runtime import outside Node's builtins and the package's own `dependencies`.
That is why a Pi type belongs in an `import type` statement rather than an inline `import { type Foo }`: the latter is a runtime import the scan will reject.

`npm run no-pi-install:check` is the slower proof behind it.
It packs the publishable tarball, installs it with no dev dependencies and no Pi packages present, and asserts the exit codes and `--json` envelopes of the installed bin across `list`, `add`, `show`, `find`, `next`, `ready`, `waves`, `apply-plan --dry-run`, and a guarded mutation.
It runs as its own CI job and again before publishing, because this checkout installs every Pi peer as a devDependency and therefore cannot see the failure on its own.

## Generated files

`docs/cli.md` and `.claude/skills/stepstone/SKILL.md` are generated from `src/cli-contract.ts` by `scripts/generate-docs.ts`.
Never hand-edit them: run `npm run docs` and commit the result, which `npm run docs:check` and the test suite both enforce.

The published package name lives in exactly one place, `CLI_COMMAND_CONTRACT.binary`, which feeds every generated document, the CLI's own diagnostics, and the manifest's `name` and `bin` keys as asserted by the tests, so a rename stays a one-line change.
The goal-file directory names and the environment variable live beside it, so the generated documents and the path resolver cannot drift.

## Invariants

`AGENTS.md` is the short list of rules a change here has to respect, and it is worth reading before touching anything under `src/`.
The load-bearing ones:

- Every mutation, from any interface, goes through `WorklistApplicationService` in `src/application-service.ts`, whose writes run through `src/project-mutations.ts` so the cross-process lock and atomic rename apply everywhere.
- Which goal file a repository has comes from `resolveWorklistLocation` in `src/git.ts` and nowhere else, and a long-lived interface holds the locator closure rather than remembering the answer.
- Goal IDs are minted in `src/goal-selection.ts` and frozen; every ID a goal has had stays resolvable through `findGoalByStoredId` and is rewritten by `migrateProjectGoalIds`.
- Dependency edges are stored in one direction only, and `blocked`, dependents, cycles, and the sequencing views are derived in `src/dependencies.ts` rather than stored.
- No project lifecycle path may bypass explicit confirmation.
- The terminal board keeps rendering pure in `src/tui/goal-board.ts` and all I/O in `src/tui/goal-board-runtime.ts`, so frames stay testable without a pseudo-terminal.
- The changelog is generated; never hand-edit it.

## Releases

Releases are published by CI from a tag push, never by hand; see [docs/releasing.md](releasing.md).
