# Stepstone agent notes

## Extension APIs

- Read Pi's installed `docs/extensions.md` and `docs/tui.md` before you change an extension API.
- Read Pi's installed `docs/packages.md` and `docs/session-format.md` before you change an extension API.

## Worklist data

- Treat Session Tasks as canonical, versioned, and branch-aware custom-entry snapshots.
- Store canonical Project Goals in `<git-root>/.worklist/worklist.json`.
- Send every Project Goal mutation through `WorklistApplicationService` in `src/application-service.ts`.
- Make `WorklistApplicationService` write through `src/project-mutations.ts`.
- Preserve the cross-process lock and atomic rename for every write.
- Use this mutation path for all tools, commands, dashboards, boards, CLIs, and dispatch drivers.
- Require explicit confirmation for every project lifecycle action.

## Worklist location

- Resolve the worklist file only with `resolveWorklistLocation` in `src/git.ts`.
- Use this location order:
  1. An explicit `--file` value or `$STEPSTONE_WORKLIST` value.
  2. `.worklist/worklist.json`.
  3. The legacy `.pi/worklist.json`.
- Use `createWorklistLocator` for an interface that outlives one location resolution.
- Ask the locator for the path on every read.
- Do not cache or construct the worklist path.

## Goal IDs and dependencies

- Derive a Goal ID from its title in `src/goal-selection.ts`.
- Freeze the Goal ID when you create the goal.
- Keep all current and former IDs of a live goal resolvable and reserved.
- Keep all IDs of a deleted goal reserved but not resolvable.
- Resolve every new live-reference Goal ID with `findGoalByStoredId`.
- Rewrite every new Goal ID reference field with `migrateProjectGoalIds`.
- Store dependency edges only in `dependsOn` on the goal that waits.
- Derive blocked goals, dependents, cycles, `next`, `ready`, and `waves` in `src/dependencies.ts`.
- Do not store derived dependency state.

## Published executables

- Do not import `@earendil-works/*` from code that a published executable can reach.
- Run compiled executables with only Node and declared runtime dependencies.
- Use `import type` for Pi types.
- Do not use inline `import { type Foo }` syntax for Pi types.
- Add each executable to the manifest `bin` map.
- Derive executable entry points and build inputs from the `bin` map.
- Keep `BIN_EXERCISES` in `scripts/no-pi-install-check.ts` aligned with the `bin` map.
- Run `npm run imports:check` to verify the source graph.
- Run `npm run no-pi-install:check` to verify all installed bins without Pi.

## Terminal UI and schemas

- Keep board rendering pure in `src/tui/goal-board.ts`.
- Keep board I/O in `src/tui/goal-board-runtime.ts`.
- Keep the widget compact and width-safe.
- Use `StringEnum` for model-facing string enums.

## Releases

- Publish releases only through CI after a `v*.*.*` tag push.
- Run `npm version <bump>`.
- Push the release with `git push --follow-tags`.
- Never run `npm publish`.
- Follow [docs/releasing.md](docs/releasing.md#choosing-the-version-bump) to select the version bump.
- Use a minor bump for a breaking change while the package is below 1.0.
- Treat removal of a `bin`, documented integration, or `--json` field as a breaking change.
- Keep the tag version equal to the version in `package.json`.
- Keep the release workflow at `.github/workflows/release.yml` unless you also update npm Trusted Publishing.
- Before release, run these checks:
  1. `npm run check`
  2. `npm audit`
  3. `npm run pack:check`
  4. `npm run no-pi-install:check`
  5. The real Pi RPC test

## Generated files

- Do not edit `docs/cli.md`, `.claude/skills/stepstone/SKILL.md`, or `docs/ROADMAP.md` by hand.
- Run `npm run docs` to update generated files.
- Commit generated files with their source changes.
- Regenerate `docs/ROADMAP.md` in the same commit that changes `.worklist/worklist.json`.
- Follow [docs/development.md](docs/development.md#generated-files) for generation rules.

## Documentation

- Keep the introduction and harness setup in `README.md`.
- Put longer explanations in linked pages under `docs/`.
- Treat Project Goals as the product and Pi as one supported harness.
- Put Pi-specific material in `docs/pi.md`.
- Make authored documentation pass `test/cli-contract.test.ts`.
- Keep `docs/ROADMAP.md` out of the authored-document checks.
- Check roadmap prose with `test/roadmap.test.ts`.
- Use contract values for package names, environment variables, and published paths.
- Add an intentional third-party value to the contract assertion's `allowed` list.
- Do not bypass the contract assertion.

## Published identity

- Define the published name only in `CLI_COMMAND_CONTRACT.binary` in `src/cli-contract.ts`.
- Read the published name from that contract in generated text, diagnostics, and manifest assertions.
- Derive the companion executable name with `DISPATCH_BINARY`.
- Keep these persistent dispatch namespaces unchanged during a package rename:
  - `stepstone/<goal-id>` branches
  - `stepstone-<goal-id>` worktrees
  - `stepstone:<goal-id>` Treehouse lease holders
  - The `stepstone-dispatch` state directory
  - The `stepstone-dispatch-owner.json` ownership marker

## Published package contents

- Include only files that an installation needs in the published tarball.
- Keep `AGENTS.md`, `docs/development.md`, `docs/releasing.md`, and `docs/ROADMAP.md` out of the tarball.
- Ship new `docs/` pages by default.
- Keep all `npm pack` assertions in `test/compiled-cli.test.ts`.
- Follow [docs/development.md](docs/development.md#what-the-published-package-carries) for package-content rules.

## Changelog

- Do not add a changelog by hand.
