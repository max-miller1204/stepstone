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

`npm run worklist` runs this checkout's CLI, and `node src/cli.ts project <action>` is the same thing spelled out.
The `node src/cli.ts` entry point needs Node 22.18 or newer for native type stripping.
`npm run dispatch` runs this checkout's second published executable, the workspace-preparation driver in `src/dispatch.ts`, under that same requirement; [docs/dispatch.md](dispatch.md) documents what it does.
The package ships TypeScript source directly because Pi loads extensions through jiti, and compiles to `dist/` only for published executables, which Node refuses to type-strip under `node_modules`.

## Checks

| Command | What it proves |
| --- | --- |
| `npm run check` | Types, the import scan, Biome lint and format, and the whole test suite |
| `npm run docs:check` | The generated documents match the sources they are rendered from |
| `npm run imports:check` | Nothing a compiled executable loads imports a Pi package |
| `npm run pack:check` | Prints the tarball's file list, so a packaging mistake is visible before publish |
| `npm run no-pi-install:check` | Every packed and installed executable works with no Pi present |
| `npm run verify` | `check` plus `pack:check`, the gate the release workflow re-runs |
| `npm run quality:static` | Types, the import scan, Biome lint, and the generated documents, with no test run |
| `npm run quality:pre-commit` | Biome checks the exact staged contents |
| `npm run quality:pre-push` | The exact pushed commit passes the comprehensive offline gate in a detached worktree |

Install the repository hooks once with `npm run hooks:install`.
Lefthook only maps Git lifecycle events to the canonical npm scripts, so the same gates can be run directly and from other automation, and `.no-mistakes.yaml` names a script here rather than restating what it runs.

The pre-commit gate materializes staged blobs in a temporary directory and never reads unstaged file contents.
It hands every staged path to Biome and lets Biome decide which of them it can read, so a commit that touches only files Biome does not process passes rather than being refused.
`biome.json` is materialized alongside those blobs and Biome is run from there, because the patterns in `files.includes` are relative and would otherwise match nothing.

The pre-push gate installs from the pushed commit's shrinkwrap with npm's offline mode, then runs `check`, `pack:check`, and `no-pi-install:check` inside a detached temporary worktree.
Nothing on that path reaches the network: the isolated install inside `no-pi-install:check` is offline as well, which the tarball's bundled dependencies make possible.
If the npm cache lacks a pinned package, run `npm ci` while online before retrying the push.

It caches only successful runs, keyed by the pushed commit, platform, architecture, and Node version.
The commit already fixes the shrinkwrap and the gate definitions, so those are not hashed a second time.
A push that ships no commit, whether it is up to date or deletes a branch, runs no gate rather than falling back to whatever HEAD is.
Annotated tags are peeled to their commits before the run, so `git push --follow-tags` validates one tree once.
A commit that defines no `quality:push:worktree`, which is every commit made before these gates existed, is reported as having nothing to run instead of failing on a missing script.
Run where no push is feeding it, `npm run quality:pre-push` validates HEAD, and `npm run quality:pre-push -- <revision>...` validates the revisions named.

AI review remains an explicit targeted command rather than part of either default hook.

The test suite includes real Pi RPC load tests in temporary repositories, so it exercises the extension against Pi rather than only against mocks.

`test/dispatch-driver.test.ts` exercises the resumable runtime through injected roadmap, workspace, merge-evidence, and state-store bindings, including journaled goal-file recovery, then drives the real preparation CLI and Git worktree boundary from temporary repositories.
It verifies that a run reaches `prepared` without any harness configuration, that the preparation limit counts claimed workspaces, and that persisted version 1 session-hosting state is refused rather than silently downgraded.

`npm run imports:check` reads the merged module graph behind every entry in `executableEntryPoints` in `scripts/cli-import-graph.ts` and refuses any runtime import outside Node's builtins and the package's own `dependencies`.
That list is derived from the manifest's `bin` map rather than written by hand: each target is read back to the `src/` file the build emitted it from, and a target that resolves to no source file stops the check instead of being skipped.
Publishing an executable is therefore one `bin` entry, and `test/cli-import-graph.test.ts` holds `tsconfig.build.json`'s `files` to that same derivation so the build cannot silently emit nothing for it.
That is why a Pi type belongs in an `import type` statement rather than an inline `import { type Foo }`: the latter is a runtime import the scan will reject.

`npm run no-pi-install:check` is the slower proof behind it.
It packs the publishable tarball, installs it with no dev dependencies and no Pi packages present, and drives every published executable through the behavior-specific function named in `BIN_EXERCISES`.
The manifest's `bin` map is compared against that exercise map before packing, so a new executable cannot ship without being started from the isolated install.
The project CLI exercise asserts exit codes and `--json` envelopes across `list`, `add`, `show`, `find`, `next`, `ready`, `waves`, `apply-plan --dry-run`, and a guarded mutation.
The dispatch exercise starts the installed driver, prepares a real worktree, and reads its ignored `STEPSTONE_GOAL.md` handoff before checking persisted status; the preparation-only contract needs no agent executable.
The check runs as its own CI job and again before publishing, because this checkout installs every Pi peer as a devDependency and therefore cannot see the failure on its own.

## Generated files

`docs/cli.md`, `.claude/skills/stepstone/SKILL.md`, and the marker-delimited Stepstone block in `AGENTS.md` are generated from `src/cli-contract.ts` by `scripts/generate-docs.ts`.
`docs/ROADMAP.md` is generated by the same script from this repository's own `.worklist/worklist.json`, rendered by `src/roadmap.ts`.
Never hand-edit a fully generated file or the generated block: run `npm run docs` and commit the result, which `npm run docs:check` and the test suite both enforce.
The AGENTS renderer replaces only its one valid marker pair, preserves all authored bytes outside it, and refuses malformed or duplicate markers instead of clobbering prose.

Because the roadmap page is a projection of the goal file, changing a goal makes it stale.
Regenerate it in the same commit that changes the goal, or the check reports the page and the roadmap disagreeing about what this project is doing.

The published package name lives in exactly one place, `CLI_COMMAND_CONTRACT.binary`, which feeds every generated document, the CLI's own diagnostics, and the manifest's `name` and `bin` keys as asserted by the tests, so a rename stays a one-line change.
The goal-file directory names and the environment variable live beside it, so the generated documents and the path resolver cannot drift.

## What the published package carries

The tarball carries what an install reads and nothing else: `src/`, `dist/`, the generated skill, `npm-shrinkwrap.json`, `README.md`, and the `docs/` pages that document the package.

The shrinkwrap pins the runtime dependency tree npm installs for the published package.
It is npm's file to write, so refresh it by running an install rather than by editing it.

This page, [docs/releasing.md](releasing.md), [docs/ROADMAP.md](ROADMAP.md), and `AGENTS.md` are written for this checkout, so the manifest's `files` keeps them out.
They stay on the repository, where a contributor who needs them already is, rather than being downloaded by everyone who runs the CLI once through `npx`.

Add a new page to `docs/` and it ships by default.
A page that belongs to this repository instead has to be named in the manifest's `files` and in `DEVELOPMENT_ONLY_FILES` in `test/compiled-cli.test.ts`, which asks `npm pack` itself what the tarball ended up containing, because whether a pattern keeps a file out of it is npm's answer to give rather than something a reader of the declaration can tell.

Every `npm pack` assertion in the suite lives in that one file, because a pack walks the whole worktree while `npm run build` deletes and rewrites `dist/`, and vitest runs test files in parallel workers.
Inside a single file the two are ordered: the build is awaited in `beforeAll` before any test packs.
`packedFilePaths` in `test/npm-pack.ts` owns both halves and throws rather than pack in a worker that never awaited `buildPackage()`, so an assertion written elsewhere fails immediately instead of passing until it happens to interleave with the rebuild.
`scripts/no-pi-install-check.ts` packs as well and stays where it is, because it runs standalone rather than beside anything vitest scheduled.

Holding a page back also breaks every relative link into it from a page that still ships, which is invisible here because both files are on disk in a checkout.
A packaged page is read out of `node_modules`, so it links to a held-back page by absolute GitHub URL, and the same file resolves every relative link in every packaged page against the tarball's own file list.
`README.md` is the one page exempt: its reader is on GitHub or on npmjs.com's rendered README, where every path in the repository resolves.

## Invariants

`AGENTS.md` is the short list of rules a change here has to respect, and it is worth reading before touching anything under `src/`.
The load-bearing ones:

- Every mutation, from any interface, goes through `WorklistApplicationService` in `src/application-service.ts`, whose writes run through `src/project-mutations.ts` so the cross-process lock and atomic rename apply everywhere.
- Which goal file a repository has comes from `resolveWorklistLocation` in `src/git.ts` and nowhere else, and a long-lived interface holds the locator closure rather than remembering the answer.
- Goal IDs are minted in `src/goal-selection.ts` and frozen; every ID a goal has had stays resolvable through `findGoalByStoredId` and is rewritten by `migrateProjectGoalIds`.
- Dependency edges are stored in one direction only, and `blocked`, dependents, cycles, and the sequencing views are derived in `src/dependencies.ts` rather than stored.
- No project lifecycle path may bypass explicit confirmation.
- The terminal board keeps rendering pure in `src/tui/goal-board.ts` and all I/O in `src/tui/goal-board-runtime.ts`, so frames stay testable without a pseudo-terminal.
- Never add a changelog by hand: the release workflow generates each release's notes from the pull requests merged since the previous tag.

## Releases

Releases are published by CI from a tag push, never by hand; see [docs/releasing.md](releasing.md).
