<!-- markdownlint-disable MD013 -->

# pi-worklist

[![npm version](https://img.shields.io/npm/v/pi-worklist.svg)](https://www.npmjs.com/package/pi-worklist)
[![CI](https://github.com/max-miller1204/pi-worklist/actions/workflows/ci.yml/badge.svg)](https://github.com/max-miller1204/pi-worklist/actions/workflows/ci.yml)
[![Release](https://github.com/max-miller1204/pi-worklist/actions/workflows/release.yml/badge.svg)](https://github.com/max-miller1204/pi-worklist/actions/workflows/release.yml)
[![Pi package](https://img.shields.io/badge/Pi-package-8a76b5)](https://pi.dev/packages/pi-worklist)

`pi-worklist` gives Pi two deliberately different lists.
Session Tasks track the concrete work in the current coding session.
Project Goals track the larger outcomes shared by every Pi session in a Git repository.

## Features

- Branch-aware Session Tasks survive `/resume` and follow `/tree`, `/fork`, and `/clone`.
- Session Tasks stay intentionally small and title-only, so they represent executable chunks rather than broad outcomes.
- Session Task array order is a canonical queue that supports stable-ID insertion and movement.
- A new Pi session starts with an empty Session Task list.
- Project Goals persist at `<git-root>/.pi/worklist.json` and can be committed with the repository.
- Goal IDs are readable slugs derived from the title and frozen afterwards, and every Project Goal ID argument accepts a unique prefix or a former ID.
- Project Goal file order is canonical: goals are appended and rearranged only by an explicit move, so a roadmap reads in the sequence someone chose for it.
- Project Goals carry optional `group`, `completedAt`, `links`, `branch`, and `dependsOn` fields alongside the description.
- Project Goal dependencies are stored in one direction and checked for cycles at mutation time, so blocked work is derived rather than tracked by hand.
- `next`, `ready`, and `waves` read that graph for humans and dispatch loops: the one goal to start, the whole parallel frontier, and the layers behind it.
- `/tasks` opens an interactive two-section dashboard.
- A compact widget shows the active Project Goal and up to three unfinished Session Tasks.
- The `worklist` model tool manages both scopes through one consistent API.
- A Pi-free external CLI lets scripts and other agents manage Project Goals without a running Pi session.
- `npx -y pi-worklist@latest project ui` opens a dependency-free terminal board for browsing and editing Project Goals outside Pi.
- An installable agent skill, generated from the same command contract as the CLI, teaches coding agents to drive that CLI in any repository.
- Project Goal completion, reopening, archival, and deletion require explicit user intent.
- Cross-process locking and atomic replacement serialize writes and prevent project-file corruption; optional goal baselines detect stale mutations.

## Install

Install the published package from npm:

```sh
pi install npm:pi-worklist
```

View it in the [Pi package gallery](https://pi.dev/packages/pi-worklist) or on [npm](https://www.npmjs.com/package/pi-worklist).

Install directly from GitHub:

```sh
pi install git:github.com/max-miller1204/pi-worklist
```

Try a checkout without installing it:

```sh
pi -e ./src/extension.ts
```

## Usage

Run `/tasks` with no arguments to open the dashboard.
Use Tab to switch lists and arrow keys to navigate.
In Session Tasks, `a` appends, `i` inserts before the selected task, and Shift+Up or Shift+Down moves the selected task.
Project Goals support `a` to add and the same Shift+Up and Shift+Down to reorder, but not insertion at a position.
In either scope, press Enter to open a detail window, Space to advance status, `e` to edit, `d` to delete, and Escape to close.
The detail window wraps complete descriptions and the metadata it displays instead of truncating them.
Use Up and Down or `j` and `k` to scroll long details, with Page Up and Page Down for larger jumps, then Enter or Escape to return to the dashboard.
For a Session Task associated with a Project Goal, the detail window also shows the goal title and full description.
The dashboard keeps the current list and the selected task across each action, so a moved task stays selected at its new position.
Session Task edits change the title, while Project Goal edits can also change the description.

Direct commands are useful in RPC mode and scripts:

```text
/tasks session list
/tasks session add Write RPC regression tests
/tasks session add --before <anchor-id> Reproduce the failure first
/tasks session add --after <anchor-id> Verify the dashboard behavior
/tasks session add Verify the dashboard behavior --after <anchor-id>
/tasks session move <task-id> --before <anchor-id>
/tasks session move <task-id> --after <anchor-id>
/tasks session update <id> Replace the task title
/tasks session status <id> doing
/tasks project list
/tasks project add Replace legacy authentication -- Migrate every supported client
/tasks project update <id> -- Replace the goal description
/tasks project move <goal-id> --before <anchor-id>
/tasks project set_active <id>
/tasks project complete <id>
```

Text after `--` is stored as the optional Project Goal description for `add` and `update` commands.
Session Tasks do not support descriptions.
Session Task `add` accepts either `--before <anchor-id>` or `--after <anchor-id>` and appends when neither is supplied.
Session Task `move` requires exactly one of those stable-ID anchors.
An anchor flag and its ID may lead the arguments or trail them, but only one anchor flag is accepted per command.
Project Goal `move` takes the same anchors; Project Goals are appended on `add` and never accept a placement there.
Typing a Project Goal lifecycle command is explicit user intent.
The model-facing tool instead requires `confirm=true`, and its prompt rules prohibit setting that flag without an explicit request.

## Storage semantics

Session Tasks are stored as versioned Pi custom entries in the current session tree.
Each snapshot carries an opaque concurrency token that follows the active `/tree`, `/fork`, `/clone`, or resumed branch.
Snapshots written by earlier releases are still loaded, derive their token from the Pi custom entry ID when necessary, retain existing task IDs, and drop legacy descriptions and legacy orchestrator metadata during in-memory migration.
The next Session Task mutation writes the migrated state as snapshot version 3.
A branch without a snapshot uses the opaque baseline token `0`.
Completed tasks remain in canonical queue order.
Only the active goal and an intentionally bounded list of incomplete task titles and statuses are added to the current turn's system prompt, preserving their relative queue order.

Project Goals use a schema-versioned JSON file at `.pi/worklist.json` in the canonical Git root.
The goal array order is canonical rather than incidental: `add` appends, `move` is the only action that rearranges it, and every reader displays that order unless it was explicitly asked for another one.
A move rewrites the order without touching any goal's `updatedAt`, so rearranging the roadmap never reads as editing the goals on it and never invalidates a baseline nobody's edit conflicts with.
Beyond the description, a goal may carry an optional free-form `group`, a `completedAt` stamped by `complete` and cleared by `reopen`, an informational `links` array, a `branch` naming where the work is happening, and a `dependsOn` array of goals that must land first.
Every one of those fields is optional and additive, so the schema version stays at 1 and older files keep loading unchanged; a goal completed before `completedAt` existed simply has none, because that moment is genuinely unknown.
The file carries a monotonic numeric revision, while application callers receive that revision as an opaque string.
Legacy files without a revision remain readable at revision `0` and gain revision `1` on their next mutation.
Optional expected-revision checks run under the same cross-process lock as persistence and return a typed conflict without rewriting stale state.
A Project Goal mutation can also carry the target goal's `updatedAt` as a precondition, checked under that same lock, which guards exactly one goal where the file-wide revision would reject every unrelated concurrent change instead.
Appending to a description resolves against the stored text under the lock, so an added note composes with a concurrent edit rather than replaying the caller's baseline over it.
Session Task expected-revision checks run inside the serialized mutation queue and return the active branch token in conflicts.
A semantic no-op preserves the Project Worklist file bytes, Project Goal timestamps, Project Worklist revision, Session Task snapshot count, and Session Task branch token.
The file is human-readable and suitable for version control.
A malformed or unsupported file is reported and never overwritten automatically.
Project Goal operations are unavailable outside a Git repository, while Session Tasks continue to work normally.

## Model tool

The `worklist` tool accepts `scope=session|project` and actions including `list`, `add`, `apply-plan`, `move`, `update`, `set_status`, `set_active`, `complete`, `reopen`, `archive`, and `delete`.
For Session Tasks, `add` optionally accepts exactly one of `beforeId` or `afterId`, while `move` requires exactly one.
Project Goal `move` takes the same anchors and reorders the roadmap; `add` and `update` also accept a `group`, where an empty string clears it, and a `dependsOn` array that replaces the goal's edges, where an empty array clears them.
Moves preserve the task ID, title, status, and Project Goal association.
Self-placement, already-satisfied placement, identical Session Task updates, and repeated status changes succeed without writing another session snapshot.
Session Tasks use concise, self-contained titles without descriptions.
Agents are instructed to split non-trivial work into several concrete, independently completable Session Tasks instead of copying the broad end goal into one task.
Session Task statuses are `todo`, `doing`, and `done`.
Project Goal statuses are `open`, `active`, `done`, and `archived`.
Only activation is a non-destructive direct Project Goal status change.

## External CLI

External agents and scripts can manage Project Goals without a running Pi session.
The published package ships a compiled `pi-worklist` bin, so no development checkout is needed:

```sh
npx -y pi-worklist@latest project list
npx -y pi-worklist@latest project find templates
npx -y pi-worklist@latest project show <id>
npx -y pi-worklist@latest project next
npx -y pi-worklist@latest project ready
npx -y pi-worklist@latest project waves
npx -y pi-worklist@latest project add Support goal templates --description "Let teams share reusable goal outlines"
npx -y pi-worklist@latest project apply-plan plan.json --dry-run --json
npx -y pi-worklist@latest project apply-plan plan.json --json
npx -y pi-worklist@latest project update <id> Replace the title --description "Replace the description"
npx -y pi-worklist@latest project update <id> --description "Replace only the description"
npx -y pi-worklist@latest project update <id> Replace the title -- Replace the description
npx -y pi-worklist@latest project update <id> --append-description "Add a note as a new paragraph"
npx -y pi-worklist@latest project update <id> --expect-updated-at <updatedAt> --append-description "Add it only if nobody edited first"
npx -y pi-worklist@latest project update <id> --group Foundation
npx -y pi-worklist@latest project update <id> --depends-on <other-id> --depends-on <third-id>
npx -y pi-worklist@latest project move <id> up
npx -y pi-worklist@latest project move <id> before <anchor-id>
npx -y pi-worklist@latest project set_active <id>
npx -y pi-worklist@latest project complete <id> --confirm
```

The CLI routes every mutation through the same service, cross-process lock, and atomic replacement as a live Pi session, so physical writes are serialized and atomic.
`list` output is deliberately compact without descriptions; `show <id>` prints one goal in full detail.
`find <text>` lists the goals whose title or description contains the text, so locating one never needs `list --json` plus a client-side filter.
`next`, `ready`, and `waves` read the dependency graph rather than the file order, so a driver never has to decide for itself which goal is startable.
`move <id> up|down` steps one place and `move <id> before|after <anchor-id>` lands beside a named goal; both resolve their arguments through the same selector as every other command, and a move that would change nothing succeeds without writing.
`--group <name>` on `add` and `update` files a goal under a free-form section, and `--group ''` clears it; a group exists exactly when some goal names it, so there is no separate list to keep in step.
`--depends-on <id>` on `add` and `update` records a goal that must land first and may be repeated, `--depends-on ''` alone clears every edge, and an update replaces the stored set rather than adding to it.
Lifecycle actions (`complete`, `reopen`, `archive`, `delete`) require `--confirm`, mirroring the model tool's explicit-intent rule; an omitted flag exits with code 3 and changes nothing.
External agents and scripts use the order-independent `--description <text>` replacement flag, passing the complete value in one argv token, and use `--append-description <text>` to add a paragraph without replaying stored prose.
A new title goes before `--description` rather than after its single argv token: on `update` a trailing word that would become a title exits with code 2 instead of renaming the goal, and on `add` prose that spills past the value and splits the title across it exits the same way, so quote the whole description.
The `-- <description...>` separator and legacy `--append -- <text>` form remain available for a human typing unquoted prose interactively.
A standalone known flag after that separator is a usage error with exit code 2; flag-looking description text belongs in `--description`.
`--expect-updated-at <timestamp>` carries the goal's `updatedAt` from the caller's own read, and applies to `update`, `set_active`, and the lifecycle actions.
Without it, a mutation built on a stale read proceeds unreported; a full description replacement can silently overwrite newer prose because the cross-process lock serializes writes without tracking the caller's baseline.
Exit code 4 reports a concurrent-change conflict, whether the file-wide revision or a single goal moved; nothing is written, so re-read current state, rebuild the change on it, and retry.
The explicit `@latest` package specifier prevents a stale local npx cache from selecting an older CLI build.
`--json` prints a deterministic CLI result envelope, preserving the full application result while adding the running package version in `meta.cliVersion`, on stdout for success and stderr for failure; `--cwd <dir>` resolves the Git root from another directory.
The complete command reference in [docs/cli.md](docs/cli.md) is generated from `src/cli-contract.ts`, the same contract that renders the CLI help and agent guidance.
In a development checkout, `node src/cli.ts project <action>` runs the same CLI; running the TypeScript entry point directly requires Node 22.18 or newer (for example Node 24), which strips types natively.
On older Node versions, including the Node 20 floor of the package's `engines` range, the TypeScript entry point fails with an `Unknown file extension ".ts"` error, while the compiled bin has no such requirement.
Session Tasks are intentionally unavailable here because they live inside a Pi session tree.

Nothing the bin loads imports a Pi package, and every Pi peer is declared optional, so `npx -y pi-worklist@latest` installs under a megabyte and runs with no Pi installation at all.
That is enforced rather than promised: `npm run imports:check` reads the module graph behind `src/cli.ts` and refuses any runtime import outside Node's builtins and the package's own `dependencies`, and a CI job packs the tarball, installs it alone in a scratch directory, and drives the whole command surface against the installed bin.

## JSON goal plans

`project apply-plan <plan.json>` adds an approved batch of Project Goals through one locked mutation, one atomic file replacement, and one revision increment.
The `worklist` model tool exposes the same operation as project action `apply-plan`, with the parsed array in `plan` and optional `dryRun=true`.
The document is a plain JSON array whose entries allow exactly `title`, `description`, `group`, and `dependsOn`:

```json
[
  {
    "title": "Add shared parser",
    "description": "Build the parser before its consumers.",
    "group": "Foundation"
  },
  {
    "title": "Adopt shared parser",
    "group": "Workflow",
    "dependsOn": ["add-shared-parser", "existing-goal-id"]
  }
]
```

A `dependsOn` reference names either the pre-collision slug of another entry in the same batch or an existing goal, so a plan may point forward as well as backward.
Batch entries are matched first, which keeps a collision from wiring an edge to the wrong goal: if `add-focus-mode` already exists, a batch goal with the same predicted slug is minted as `add-focus-mode-2`, and another entry naming `add-focus-mode` depends on that new goal rather than the existing one.
Everything the plan claims is validated before anything is written, so a rejected plan leaves the worklist byte-identical, and `--dry-run` reports the predicted IDs and any such shadowed reference without writing at all.

The plan schema, reference resolution, validation failures, and dry-run guarantees are specified in [docs/cli.md](docs/cli.md#json-plans), generated from the same contract as the CLI help.

## Goal identifiers

A Project Goal's ID is derived from its title when the goal is created: lowercase, hyphenated, and capped near 40 characters at a word boundary.
A truncated title keeps whatever word the cap left at the end, so `add-pi-orchestrator-compatibility-and` is accepted rather than tidied; trimming those tails was tried and abandoned, because no word list separates the words that merely shorten a name from the ones that reverse it.
`-2` and `-3` suffixes distinguish slugs that are already taken.
`Support goal templates` becomes `support-goal-templates`, so an ID reads as words in a shell, a commit message, or a PR description instead of as `goal-ms6gwxrg-56c1bde6`.
If a title would produce the old random-ID shape, minting adds a collision suffix so new slugs and legacy IDs remain permanently distinguishable.

The slug is frozen once minted.
Renaming a goal never renames its ID, so a reference recorded anywhere else stays valid, and the ID keeps naming the goal it was written for even after the title has moved on.

Every Project Goal `<id>` argument, in the CLI and in the model tool, accepts a full ID, a unique prefix of one, or an ID the goal answered to before a migration renamed it.
An exact match always beats a prefix, so `support-goal-templates` still names its own goal once `support-goal-templates-2` exists.
An ambiguous prefix is refused with the goals it matched rather than resolved by guesswork, because a guess a caller cannot see is a change applied to a goal they did not mean.

`npx -y pi-worklist@latest project migrate_ids --confirm` rewrites the randomly generated IDs in an existing worklist.
Only generated IDs are rewritten: new slugs cannot use the legacy generator's shape, so migration can classify IDs without comparing them to a title that may have changed.
Each rewritten goal records its old ID in `previousIds`, which keeps that ID both resolvable and reserved.
That is what makes migrating a done or archived goal safe rather than a judgment call: a Session Task's `goalId`, an evidence file, and an old PR description all keep resolving to the same goal, and no later goal can claim a name still in use.
Deleting a goal retires its current and former IDs permanently.
Those IDs no longer resolve, but a later goal cannot claim one and silently inherit a stale reference intended for the deleted goal.
`--dry-run` reports the rewrites without writing them and without `--confirm`.

## Goal dependencies

A Project Goal may record the goals that must land before it:

```sh
npx -y pi-worklist@latest project add Add the dependency graph --depends-on slug-ids --depends-on schema-fields
npx -y pi-worklist@latest project update <id> --depends-on <other-id>
npx -y pi-worklist@latest project update <id> --depends-on ''
```

An edge means must-land-before, whatever its reason.
A logical prerequisite and two goals that would collide in the same files are recorded the same way, because the consequence is identical: one of them has to go first.
A dependency is satisfied once its target is `done` or `archived`, since an archived goal settles the question the edge was waiting on just as finishing it would.

Only the forward direction is stored.
What a goal blocks is derived from everyone else's edges on every read, so an edge is written once and the two halves cannot drift apart.
`show <id>` prints both, and marks an edge naming no goal as missing rather than listing it as though something will eventually finish it.

Blocked is a derived display state rather than a status.
Nothing is ever left marked blocked after the goal holding it up was finished, because the reading is recomputed from the graph every time it is shown.
The terminal board dims a blocked row for the same reason it dims settled work, and its detail pane names the edges holding the goal so the dimming is never unexplained.
`set_active` warns about a blocked goal and activates it anyway: someone who says a goal is the one in flight may know something the edges do not.

Edges are validated under the same lock that writes them.
On update, a depth-first check from the changed goal refuses anything that would close a cycle, including an existing goal that depends on itself, and reports every goal on the loop; the failure carries the `DEPENDENCY_CYCLE` error code.
On add, dependency IDs resolve before the new goal's ID is minted, so an edge naming a guessed future slug is refused with `NOT_FOUND`; read the ID back from add rather than deriving it from the title.
An edge naming no goal is refused, an edge is stored under its target's current ID whatever name the caller used, and deleting a goal drops the edges naming it inside the same atomic change so a dangling edge never reaches the file.
An ID migration rewrites stored edges too, because a former ID would still resolve but would leave the file disagreeing with itself.

File order and the dependency graph answer two different questions and are allowed to disagree.
File order is presentation and a tiebreak, arranged by whoever cares how the roadmap reads; the graph is the source of truth for what may start.
Neither should be edited to mirror the other: re-sorting the file to match the edges throws away an arrangement someone chose, and adding an edge to justify the file's order records a constraint that does not exist.

## Goal sequencing

Three read commands answer what to work on, reading the same edges everything else derives `blocked` from:

```sh
npx -y pi-worklist@latest project next
npx -y pi-worklist@latest project ready
npx -y pi-worklist@latest project waves
```

`ready` is the parallel frontier: every open goal whose dependencies have all landed and that nobody has claimed, in canonical file order.
`next` is the first entry of `ready`, by definition rather than by a second calculation, so a driver taking one goal and a human reading the whole frontier can never be told two different things.

A goal is claimed when it is `active` or carries a `branch`.
Both are dedicated fields somebody set deliberately, never a heuristic over prose, and a claimed goal is left out of `ready` because handing the same work to a second driver is the one mistake a dispatch read exists to prevent.

`waves` lays the unfinished goals out in the earliest layer each could start in.
Wave 1 is everything unblocked today, and each later wave is exactly what the wave before it releases, so the layers read as a schedule: how much can run in parallel, and what finishing this round opens up.
A wave shows the shape of the remaining work rather than what is free to pick up, so a claimed goal keeps its place in the layers and is marked with the branch that took it; the frontier is wave 1 with those removed.
A goal waiting on a hand-edited cycle, or on an edge that names no goal, can never be released by any wave and is reported as unreachable rather than dropped, because a goal missing from the schedule is a goal nobody notices is stuck.

An empty frontier exits 0 and says which kind of empty it is: an empty roadmap, a finished one, or one where everything left is blocked or already claimed.
Nothing to start is an answer rather than a failure, so read `result.goal` or `result.goals` from `--json` instead of the exit code.

## Terminal goal board

`npx -y pi-worklist@latest project ui` opens an interactive board over the same Project Goals, so the roadmap can be read and edited from a shell without starting a Pi session:

```sh
npx -y pi-worklist@latest project ui
```

The board is a split view: the goal list on the left, the selected goal's status, timestamps, identifier, and complete description on the right.
The detail pane also spells out a goal's group, branch, completion time, dependencies, dependents, and links when present, and omits empty rows entirely.
Each dependency is listed with the target's own status marker, so whether it is still in the way reads in the same visual language as the list.
Below about 76 columns the two panes stack instead, and the layout stays aligned for titles containing wide or combined characters.

`o` cycles the order through file, status, and recent, and the header names the current one.
File order is the default and is the roadmap's canonical order, so the board shows exactly what the file says and `K` and `J`, or Shift+Up and Shift+Down, rearrange it against the neighbouring visible row.
Reordering is refused outside file order, where the rows are not where the file puts them and a move would edit an arrangement the screen is not showing.
Status and recent are views over that same order, which stays their tiebreak, so an arrangement survives a trip through them.
Those two views lift the active goal above every other row and give it a marker of its own, so the work in flight is the first thing the list says.
The status line names the active goal in full in every order, which keeps it readable while the list is filtered to something else or scrolled past it.
In the all view, done and archived rows recede so live work stays legible beside them, and a goal waiting on work that has not landed recedes in every view for the same reason; the selected row always keeps full contrast.
A goal still in play that has gone untouched for 30 days or more carries its age at the right edge of its row when at least 12 cells remain for the title, and the detail pane spells that age out under `UPDATED`.
Settled goals are never aged: a done or archived goal is finished rather than neglected.
The header shows per-status totals across the whole roadmap, so a filtered list still reports its overall shape; on narrow terminals, those counts yield first to the filter and shown-of-total labels.

| Key | Action |
| --- | --- |
| `↑` `↓` or `j` `k` | Move the selection, or scroll the detail pane once it has focus |
| `←` `→` or Tab | Move focus between the list and the detail pane |
| `g` `G`, Page Up, Page Down | Jump to the ends, or page through either pane |
| Space | Advance: an open goal activates, the active goal completes, a settled goal reopens |
| `s` | Make the selected open goal the single active goal |
| `a`, `e` | Add a goal, or rename the selected one |
| `E` | Edit the selected goal's description in `$VISUAL` or `$EDITOR` |
| `c` `r` `x` `d` | Complete, reopen, archive, or delete the selected goal |
| `f`, `o` | Cycle the status filter, or the order: file, status, recent |
| `K` `J` or Shift+Up, Shift+Down | Move the selected goal up or down, in file order only |
| `/` | Search titles and descriptions |
| `R`, `?`, `q` | Reload from disk, show the key map, or quit |

The key map scrolls, so a short terminal cannot hide the binding that closes it; any other key returns to the board.

Every change routes through the same application service, cross-process lock, and atomic replacement as `/tasks` and the rest of the CLI, so a Pi session may be open on the same repository at the same time.
The board reloads automatically when another process writes the file, and a low-frequency re-read keeps that true where filesystem watches cannot be created or silently drop events.
Completing, reopening, archiving, and deleting each ask for confirmation first, and only an explicit `y` proceeds; that answer is the explicit user intent the application service requires.
The board is drawn with no runtime dependencies, so the compiled bin needs nothing installed but Node.
It requires a terminal and refuses to start without one, which keeps `list` and `--json` the read path for scripts and agents.

## Agent skill

A skill in `.claude/skills/worklist/` teaches coding agents to drive the CLI under the same guardrails, so a session manages goals correctly without being walked through it each time.
Install it for every project:

```sh
npx skills add max-miller1204/pi-worklist --skill worklist -g
```

Drop `-g` to install it for the current project only, or add `-a claude-code` to target one agent instead of choosing interactively.
The [`skills` CLI](https://github.com/vercel-labs/skills) reads `.claude/skills/` directly from this repository, symlinks it into each agent's skill directory, and refreshes it later with `npx skills update`.
Installing the npm package does not install the skill: the tarball carries `.claude/skills/worklist/SKILL.md` so the published package stays self-describing, but `node_modules` is not a directory agents scan for skills.

`SKILL.md` is generated from `src/cli-contract.ts` by `scripts/generate-docs.ts`, the same contract that renders the CLI help and [docs/cli.md](docs/cli.md).
Never hand-edit it; run `npm run docs` and commit the result, which `npm run docs:check` and the test suite both enforce.
The generated skill is deliberately repository-neutral and invokes the CLI as `npx -y pi-worklist@latest`, so a single file serves every checkout without letting a stale npx cache select an older build.
Working on the skill itself is the one case for symlinking `.claude/skills/worklist` into `~/.claude/skills/`, which makes the installed skill track your working tree.

## Development

```sh
git clone https://github.com/max-miller1204/pi-worklist.git
cd pi-worklist
npm install
npm run check
npm run pack:check
npm run no-pi-install:check
```

The test suite includes real Pi RPC load tests in temporary repositories.
The package uses TypeScript source directly because Pi loads extensions through jiti.

`npm run check` includes `npm run imports:check`, the source-level scan that keeps Pi out of the CLI's module graph.
`npm run no-pi-install:check` is the slower proof behind it: it packs the publishable tarball, installs it with no dev dependencies and no Pi packages present, and asserts the exit codes and `--json` envelopes of the installed bin across `list`, `add`, `show`, `find`, `next`, `ready`, `waves`, `apply-plan --dry-run`, and a guarded mutation.
It runs as its own CI job and again before publishing, because this checkout installs every Pi peer as a devDependency and therefore cannot see the failure on its own.

## Publishing and the Pi gallery

The package is published to npm and listed in the [Pi package gallery](https://pi.dev/packages/pi-worklist).
The `pi-package` npm keyword and `pi.extensions` manifest let the gallery discover releases automatically without a separate submission process.

### Future releases

Publishing runs in CI, not from a maintainer's machine.
Pushing a `v*.*.*` tag is what publishes; a commit or merge to `main` never does.

Start from a clean, current `main` branch:

```sh
git switch main
git pull --ff-only
```

Optionally run the release checks locally, the same `npm run verify` and `npm run no-pi-install:check` the release workflow runs, but with faster feedback than waiting on CI:

```sh
npm ci
npm run verify
npm run no-pi-install:check
```

Create the release commit and tag with the appropriate semantic version bump:

```sh
npm version patch
# Use `npm version minor` or `npm version major` when appropriate.
```

Push the version commit and its tag, which is the step that publishes:

```sh
git push origin main --follow-tags
```

That tag push runs [`.github/workflows/release.yml`](.github/workflows/release.yml), which re-runs `npm run verify` and `npm run no-pi-install:check` against the tagged commit, publishes to npm, and creates a GitHub Release with notes generated from the pull requests merged since the previous tag.
It refuses to publish when the tag disagrees with `package.json`, which is the mistake that would otherwise ship the wrong version under the right name.

Authentication is npm Trusted Publishing over OIDC, so the repository stores no `NPM_TOKEN` and a release needs no local `npm login`.
npm attaches build provenance to every tarball published this way, letting an installer verify the package was built from this repository at that commit.
The trust relationship is configured once on npm, under the package's Trusted Publishers settings, naming this repository and the `release.yml` workflow filename; a workflow renamed or moved needs that entry updated or every publish will be rejected.

Verify npm, Pi installation, and the gallery after the workflow finishes:

```sh
npm view pi-worklist version
pi update npm:pi-worklist
```

Each npm version is immutable, so bump the version before every subsequent publication.
A run that failed before `npm publish` published nothing, so delete the tag, fix the cause, and tag again.
A run that failed after it cannot be retried on the same version, because npm already has it; finish the remaining steps by hand or release the fix as a new version.
The Pi gallery may take a short time to refresh after npm accepts a release.

## License

MIT
