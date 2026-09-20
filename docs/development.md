<!-- markdownlint-disable MD013 -->

# Development

```sh
git clone https://github.com/max-miller1204/stepstone.git
cd stepstone
mise install
mise exec -- npm ci
mise exec -- npm run check
mise exec -- npm run pack:check
mise exec -- npm run no-pi-install:check
```

The repository `mise.toml` pins Node and npm. Run commands in a mise-activated shell or use `mise exec -- <command>`. This prevents workstation Node and npm versions from changing local results.

`npm run worklist` runs this checkout's CLI, and `node src/cli.ts project <action>` is the same thing spelled out.
The `node src/cli.ts` entry point needs Node 22.18 or newer for native type stripping.
The package ships TypeScript source directly because Pi loads extensions through jiti, and compiles to `dist/` only for published executables, which Node refuses to type-strip under `node_modules`.

## Checks

| Command | What it proves |
| --- | --- |
| `npm run check` | Types, the import scan, Biome lint and format, and the whole test suite with coverage |
| `npm run docs:check` | The generated documents match the sources they are rendered from |
| `npm run imports:check` | Nothing a compiled executable loads imports a Pi package |
| `npm run pack:check` | Prints the tarball's file list, so a packaging mistake is visible before publish |
| `npm run no-pi-install:check` | Every packed and installed executable works with no Pi present |
| `npm run test:coverage` | Unit tests plus the committed per-file coverage ratchet |
| `npm run test:coverage:update` | Raises per-file coverage baselines and adds new source files |
| `npm run test:mutation` | Four targeted dependency mutants must be killed |
| `npm run test:e2e:fast` | Packed CLI initialization, approved plans, conflicts, and packed extension through real Pi RPC |
| `npm run test:e2e` | Full deterministic published-surface tier, including storage, concurrent writers, roadmap generation, and linked-worktree boundaries |
| `npm run verify` | `check`, `pack:check`, and targeted mutation checks, the gate the release workflow re-runs |
| `npm run quality:static` | Types, the import scan, Biome lint, and the generated documents, with no test run |
| `npm run quality:pre-commit` | Biome checks the exact staged contents |
| `npm run quality:pre-push` | The exact pushed commit passes the comprehensive offline gate in a detached worktree |

Install the repository hooks once with `npm run hooks:install`.
Lefthook only maps Git lifecycle events to the canonical npm scripts, so the same gates can be run directly and from other automation, and `.no-mistakes.yaml` names a script here rather than restating what it runs.

The pre-commit gate materializes staged blobs in a temporary directory and never reads unstaged file contents.
It hands every staged path to Biome and lets Biome decide which of them it can read, so a commit that touches only files Biome does not process passes rather than being refused.
`biome.json` is materialized alongside those blobs and Biome is run from there, because the patterns in `files.includes` are relative and would otherwise match nothing.

The pre-push gate installs from the pushed commit's shrinkwrap with npm's offline mode, then runs `check`, `pack:check`, `no-pi-install:check`, and `test:e2e:fast` inside a detached temporary worktree.
Nothing on that path reaches the network: the isolated install inside `no-pi-install:check` is offline as well, which the tarball's bundled dependencies make possible.
If the npm cache lacks a pinned package, run `npm ci` while online before retrying the push.

It caches only successful runs, keyed by the pushed commit, platform, architecture, and Node version.
The commit already fixes the shrinkwrap and the gate definitions, so those are not hashed a second time.
A push that ships no commit, whether it is up to date or deletes a branch, runs no gate rather than falling back to whatever HEAD is.
Annotated tags are peeled to their commits before the run, so `git push --follow-tags` validates one tree once.
A commit that defines no `quality:push:worktree`, which is every commit made before these gates existed, is reported as having nothing to run instead of failing on a missing script.
Run where no push is feeding it, `npm run quality:pre-push` validates HEAD, and `npm run quality:pre-push -- <revision>...` validates the revisions named.

AI review remains an explicit targeted command rather than part of either default hook.

## Unit-test evidence

`npm test` measures every file under `src/` with V8 coverage. It prints a file-level report and compares line, branch, function, and statement percentages with `test/coverage-baseline.json`.
A new source file has no baseline and fails the gate. A lower percentage fails the gate. `npm run test:coverage:update` can add a file or raise a percentage, but it refuses to lower an existing baseline.
The baseline includes executable entry points whose subprocess coverage cannot be merged into the Vitest process. Their zero values stay visible instead of being hidden by exclusions.

Vitest refuses `.only` and requires each test to execute an assertion. The test policy reporter also refuses skipped tests, todo tests, and empty suites.
Do not disable a test for one platform. Put the platform decision in production behavior and assert that behavior directly.

`npm run test:mutation` makes four fixed semantic changes in isolated temporary copies of `src/dependencies.ts`.
The focused tests must fail for every change. CI runs this check for each push and pull request. The release workflow runs it again through `npm run verify`.
The fixed set keeps this gate fast and deterministic. The later adversarial test tier owns broad mutation, property, and stress testing.

The test suite includes real Pi RPC load tests in temporary repositories, so it exercises the extension against Pi rather than only against mocks.

### Published-surface end-to-end tier

`scripts/e2e-check.ts` runs separately from Vitest so its real `npm pack` build cannot race the compiled-package tests.
It installs one tarball offline with optional peers omitted, asserts that the install tree contains no Pi peers, and invokes the executable targets from the installed manifest with Node.
The RPC scenarios launch the pinned development Pi executable with the **installed package** as its extension, with no provider credentials or model requests.
The harness imports only Node APIs and its subprocess helpers; it never imports Stepstone application internals.

`npm run test:e2e:fast` is the representative pre-PR subset: empty reads, first writes, approved-plan preview and application, all-or-nothing invalid plans, lifecycle confirmation, optimistic conflicts, removed workspace command rejection, and Session Task/Project Goal changes through packed Pi RPC.
`npm run test:e2e` adds legacy/current/environment/explicit location precedence, live Pi location changes, held-lock refusal, concurrent batch writers with atomic-file observations, linked-worktree read/no-op/preview/refusal behavior, and generated-roadmap drift and regeneration.
Roadmap generation invokes the repository's real generator script in a disposable source copy because generated `docs/ROADMAP.md` is deliberately excluded from the published package.

The full tier runs on Linux and macOS with Node 22 and 24 in the `published-e2e` CI matrix, on pushes, pull requests, and manual workflow dispatch.
Run either npm command locally after `npm ci --ignore-scripts`, using a current Node version from that matrix that satisfies the pinned Pi engine requirement (`>=22.19.0`).
The harness uses temporary Git repositories and isolated home, Git, npm, and Pi configuration under `artifacts/e2e/run-*`; it requires no GitHub authentication or provider secrets.
Each subprocess has a deadline and its command, working directory, output streams, and exit status are recorded in numbered `logs/*.jsonl` files; RPC logs also record requests and responses.
Successful runs delete their fixtures. Failures print the retained directory, which includes `failure.txt`, the tarball/install, Git repositories (including `.git`), and transcripts with Session Task snapshots.
CI uploads that directory, including hidden files, for seven days. Git worktree pointers contain original absolute paths; the uploaded files remain inspectable, but relocate those pointers before rerunning Git commands from an extracted artifact.
The pre-push gate preserves its detached checkout when E2E failure artifacts are present so its printed local paths and Git registrations remain usable.
Remove a retained gate checkout with `git worktree remove --force <printed-checkout-path>` after inspecting it.

This tier covers representative local published workflows. The deeper real Git/GitHub CLI matrix, remote failures, and platform-specific external-tool edge cases remain owned by `verify-the-remaining-external`.

Shared storage, cross-process locking, and repository-discovery checks remain required after workspace management removal. The CLI unit suite proves that removed interfaces fail without changing existing Git resources or dispatch files.

`npm run imports:check` reads the merged module graph behind every entry in `executableEntryPoints` in `scripts/cli-import-graph.ts` and refuses any runtime import outside Node's builtins and the package's own `dependencies`.
That list is derived from the manifest's `bin` map rather than written by hand: each target is read back to the `src/` file the build emitted it from, and a target that resolves to no source file stops the check instead of being skipped.
Publishing an executable is therefore one `bin` entry, and `test/cli-import-graph.test.ts` holds `tsconfig.build.json`'s `files` to that same derivation so the build cannot silently emit nothing for it.
That is why a Pi type belongs in an `import type` statement rather than an inline `import { type Foo }`: the latter is a runtime import the scan will reject.

`npm run no-pi-install:check` is the slower proof behind it.
It packs the publishable tarball, installs it with no dev dependencies and no Pi packages present, and drives every published executable through the behavior-specific function named in `BIN_EXERCISES`.
The manifest's `bin` map is compared against that exercise map before packing, so a new executable cannot ship without being started from the isolated install.
The project CLI exercise asserts exit codes and `--json` envelopes across `list`, `add`, `show`, `find`, `next`, `ready`, `waves`, `apply-plan --dry-run`, and a guarded mutation.
The project CLI exercise also verifies that removed workspace commands and flags fail.
The check runs as its own CI job and again before publishing, because this checkout installs every Pi peer as a devDependency and therefore cannot see the failure on its own.

The check launches npm with the current Node executable and `npm_execpath`, preserving the npm implementation that started it without resolving an npm shell shim.
When invoked directly without `npm_execpath`, it falls back to `npm` on `PATH`.
The installed executables still run by their command names with the isolated install's `node_modules/.bin` first on `PATH`, so their shims and interpreters are exercised.
On Windows the check fails explicitly before setup: [Node cannot launch `.bat` and `.cmd` shims with `execFile` without a shell](https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows).
The pre-push gate retains this required check and propagates its failure.
Real Windows support is a separate decision that requires Windows CI to validate installed shim execution; invoking the JavaScript targets directly would not prove the same behavior.

## Collaboration protocol proof

See [the collaboration decision](collaboration.md) for server authority, command revisions, idempotency, identity history, and SSE recovery. The wave 4 proof uses a separate store. Use a fresh store or a disposable worklist copy. Do not initialize the committed roadmap as a proof store.

## Authoritative service

See [service operations](service.md) for installation, authentication, database migration, backup, restore, and retention.
Run `npm run test:service -- --coverage` with `STEPSTONE_TEST_DATABASE_URL` set to a disposable PostgreSQL instance.
Run `npm run test:service:operations` with Docker to verify the packed release and restored state.
These checks use separate coverage output and do not require PostgreSQL for the existing file and Pi test suite.

## README screenshots

After a visual change, run:

```sh
npm ci
npm run screenshots:update
```

The screenshot command runs the `src/cli.ts` entry point, which needs Node 22.18 or newer.
Use tmux 3.5 or newer on macOS or Linux.
Install tmux through your package manager. Global packages on this workstation use `dots`.
Pi and the image renderer come from the pinned development dependencies.
No provider login or display server is required.

The command replaces these files:

- `docs/images/stepstone-project-ui.png`
- `docs/images/stepstone-pi-ui.png`

The script starts the real CLI and Pi extension in a separate tmux server.
It captures each pane with `tmux capture-pane` at 116 columns by 40 rows.
It uses fixed dates, task IDs, fonts, colors, and demo data.
The Pi process uses a separate configuration and a dummy API key.
It runs only extension commands. It does not send model requests.
The clock override applies only to screenshot subprocesses.

The board capture expands each section and selects the public beta goal.
The Pi capture shows the Session Tasks tab.
Change the key sequences in `scripts/update-screenshots.ts` to change these views.
The script waits for expected content and a stable pane before it captures an image.
A failed capture stops the command before it replaces either README image.

Inspect the PNGs before you commit them.
The raw ANSI captures, SVGs, and PNG copies are in `artifacts/screenshots`.
The fonts and their licenses are in `scripts/screenshot-assets`.
Repeated runs with the same checkout, dependencies, and tmux version produce identical PNGs.
To check this:

```sh
npm run screenshots:update
shasum -a 256 docs/images/*.png > artifacts/screenshots.sha256
npm run screenshots:update
shasum -a 256 -c artifacts/screenshots.sha256
```

The command recreates `artifacts/screenshots` and `artifacts/stepstone-ui-demo`.
Do not store work in these directories.
It leaves your running tmux server and Pi configuration unchanged.
If the process is killed before cleanup, remove `artifacts/screenshots.lock` before you run it again.
The `artifacts` directory is ignored by Git.

For manual exploration, `npm run demo:screenshots` creates the same demo roadmap and Session Tasks.
It creates `open-pi.sh` and `open-project-ui.sh` in `artifacts/stepstone-ui-demo`.
These manual launchers use your normal environment and current date.

## PR evidence

Use screenshots for visual evidence. Capture actual application output and inspect each image before attaching it to the PR Evidence section. Keep behavior assertions in the unit and end-to-end suites.

## Generated files

`docs/cli.md`, `.claude/skills/stepstone/SKILL.md`, and its `references/guide.md` are generated from `src/cli-contract.ts` by `scripts/generate-docs.ts`.
`docs/ROADMAP.md` is generated by the same script from this repository's own `.worklist/worklist.json`, rendered by `src/roadmap.ts`.
Never hand-edit a generated file. Run `npm run docs` and commit the result, which `npm run docs:check` and the test suite both enforce.

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
