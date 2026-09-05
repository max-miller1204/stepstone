---
name: stepstone
description: "Manage stepstone Project Goals (the roadmap committed in a repo's .worklist/worklist.json) from any agent session. Use when the user asks to add, list, find, update, activate, complete, reopen, archive, or delete a project goal; apply a JSON goal plan; migrate goal IDs; capture brainstormed ideas or future goals on a project's worklist or roadmap; prepare and claim isolated workspaces for an approved plan; or ask what to work on next, what is ready or unblocked, what can run in parallel, or how the roadmap's dependency order or waves look."
---

<!-- Generated from src/cli-contract.ts by scripts/generate-docs.ts. Do not edit manually. -->

# Managing stepstone Project Goals

## Guidance installation

- Install the Agent Skill as the preferred guidance surface when the harness supports skills: `npx skills add max-miller1204/stepstone --skill stepstone -g`.
- If the harness does not support skills but reads AGENTS.md, use `npx -y stepstone@latest project init` as the alternative fallback.
- Use one guidance surface for a repository. Do not install the Agent Skill and the generated AGENTS.md block together.

Project Goals are a repository-wide roadmap stored in `<git-root>/.worklist/worklist.json` and committed with the code, so every agent and every human working in that repository reads and edits one list.
Never edit that file directly: another process may hold the cross-process lock, and direct edits bypass validation, ID generation, and timestamps.
Always go through the stepstone CLI, which routes every mutation through the same application service, cross-process lock, and atomic replacement as every other interface onto that file.

## Invoking the CLI

The published package ships a compiled `stepstone` bin (Node 20 or newer), usable from any repository without installing anything first:

```sh
npx -y stepstone@latest project <action> [arguments] [flags]
```

Run it from inside the target repository, or pass `--cwd <repo-root>` to target another one.
Inside a stepstone development checkout, prefer the TypeScript entry point so unreleased changes apply: `node <checkout>/src/cli.ts project <action>` (needs Node 22.18 or newer for native type stripping).

Actions:

```text
init
list
show <id>
find <text...>
next
ready
waves
ui
add <title...> [--description <text> | -- <description...>]
apply-plan <plan.json>
update <id> [title...] [--description <text> | -- <description...>]
move <id> up|down|before <id>|after <id>
start <id> [--branch <name> | --clear]
set_active <id>
complete <id> --confirm
reopen <id> --confirm
archive <id> --confirm
delete <id> --confirm
migrate_ids --confirm
migrate_path --confirm
help
```

Flags:

- `--json` - Print the deterministic result envelope as JSON (stdout on success, stderr on failure).
- `--confirm` - Acknowledge an action that requires confirmation; pass it only for an explicit user request.
- `--cwd <dir>` - Resolve the git root from this directory instead of the working directory.
- `--file <path>` - Read and write this goal file instead of the one the repository resolves to, overriding $STEPSTONE_WORKLIST; ignored by init, whose target is always the repository root's AGENTS.md.
- `--description <text>` - Set the whole description from one argv token; order-independent and preferred for agents and scripts; a new update title must come before it, and an add title must not straddle it; only for project add and update.
- `--append-description <text>` - Add one argv token as a new description paragraph without replacing stored prose; cannot be combined with a title change; only for project update.
- `--append` - Interactive compatibility form that adds the text after -- as a new paragraph; cannot be combined with a title change; only for project update.
- `--group <name>` - Filter list to one free-form section, or put an added or updated goal in that section; names match exactly and are case sensitive, an empty name selects ungrouped goals for list and clears the field for update, and it may be provided only once; only for project list, add, and update.
- `--depends-on <id>` - Require that goal to land first; repeat it to name several, and pass an empty id alone to clear every edge; only for project add and update.
- `--link <url>` - Store an informational absolute HTTP or HTTPS URL; repeat it to name several, and pass an empty URL alone to clear every link; only for project add and update.
- `--branch <name>` - Record the branch working on a goal; project start defaults to the current Git branch; only for project start.
- `--clear` - Release the branch claim on a goal; only for project start.
- `--expect-updated-at <timestamp>` - Refuse the change as a conflict unless the goal's updatedAt still matches this value; only for project update, start, set_active, complete, reopen, archive, and delete.
- `--dry-run` - Validate and report an apply-plan projection, ID migration, or path migration without writing; only for project apply-plan, migrate_ids, and migrate_path.

Prefer `--json` whenever you need to read IDs, statuses, or errors back rather than parsing human output.
`list` output is compact and omits descriptions; use `show <id>` when you need a goal's complete description.
Programmatic callers and agents must use `--description <text>` for a replacement, passing the whole value in one argv token. The flag is order-independent, and its value may itself look like a known flag.
Write a new title before `--description` rather than after its value: on `update`, a trailing word that would become a title is refused with exit code 2 instead of renaming the goal, and on `add` a title split across the value is refused the same way. `add` otherwise folds words after the value into the title rather than failing, so quote the whole description there. `update <id> <title...> --description <text>` still replaces a title and a description at once.
Use `--append-description <text>` to add a paragraph without replaying stored prose. Replacing and appending are mutually exclusive, and an append cannot be combined with a title change.
Reserve `-- <description...>` for a human typing unquoted prose interactively. A standalone known flag after the separator is a usage error with exit code 2; move a real flag before the separator or put flag-looking prose in `--description`.
The legacy `--append -- <text>` interactive form remains supported, while agents and scripts use `--append-description <text>`.
Programmatic callers clear a description with `--description ''`; the interactive `update <id> --` form remains supported.
`--expect-updated-at <updatedAt>`, copied from your own `show` of that goal, refuses the change when someone edited the goal after you read it.
Pass it on every change you make to a goal you did not just create: without it, your mutation proceeds even if the goal changed after you read it.

Examples:

```sh
npx -y stepstone@latest project list --json
npx -y stepstone@latest project add Support goal templates --description "Let teams share reusable goal outlines"
npx -y stepstone@latest project apply-plan plan.json --dry-run --json
npx -y stepstone@latest project apply-plan plan.json --json # only after explicit approval of this exact plan
npx -y stepstone@latest project find templates --json
npx -y stepstone@latest project next --json
npx -y stepstone@latest project ready --json
npx -y stepstone@latest project waves --json
npx -y stepstone@latest project show support-goal-templates --json
npx -y stepstone@latest project update support-goal-templates --description "Replace only the description"
npx -y stepstone@latest project update support-goal-templates Support shared goal templates
npx -y stepstone@latest project update support-goal-templates --append-description "Blocked on the template schema until it lands"
npx -y stepstone@latest project update support-goal-templates --expect-updated-at 2026-05-04T09:12:31.004Z --append-description "Reviewed and still current"
npx -y stepstone@latest project update support-goal-templates --group Foundation
npx -y stepstone@latest project add Retire the legacy importer --depends-on support-goal-templates --depends-on ship-the-new-parser
npx -y stepstone@latest project update retire-the-legacy-importer --depends-on support-goal-templates
npx -y stepstone@latest project update retire-the-legacy-importer --depends-on ''
npx -y stepstone@latest project move support-goal-templates up
npx -y stepstone@latest project move support-goal-templates before retire-the-legacy-importer
npx -y stepstone@latest project set_active support-goal-templates
```

The full generated command reference lives in the package's `docs/cli.md`, rendered from the same contract as this skill.

## Result envelopes

- Collection reads return the collection they explicitly request: `list`, `find`, and `ready` use `result.goals`, while `waves` uses `result.waves`.
- Project mutations return bounded receipts instead of the complete post-mutation roadmap. Single-goal mutations use `result.goal`, `delete` uses `result.deletedGoalId`, and `apply-plan` uses `result.addedGoals`.
- Mutation receipts keep change status, changed entity IDs, and the resulting revision in `meta`; run an explicit read only when later work needs current roadmap state.
- Do not run `list` only to verify a successful mutation. The mutation receipt is the confirmation and returns the exact created, updated, moved, or deleted goal ID.

## Where the goal file lives

- The goal file is `<git-root>/.worklist/worklist.json`, a directory rather than a bare dotfile so later local state has somewhere to live beside the committed roadmap.
- One goal-file resolution order applies in every roadmap interface, in the CLI, the board, and a live Pi session: an explicit `--file <path>` or `$STEPSTONE_WORKLIST` first, then `.worklist/worklist.json`, then the legacy `.pi/worklist.json`.
- Reads fall back to the legacy path and writes go to whichever path resolved, so a repository holding only `.pi/worklist.json` keeps using it untouched rather than silently splitting into two roadmaps; a repository with neither file writes `.worklist/worklist.json`.
- Linked worktrees may read either committed roadmap, but a mutation that would change `.worklist/worklist.json` or `.pi/worklist.json` is refused with the main worktree path; dry runs and semantic no-ops remain allowed because they cannot fork the roadmap.
- A repository whose main worktree holds no checkout, which every worktree of a bare clone is, has no sole writer to send anyone to, so a committed roadmap change there is refused naming the Git directory; no `git worktree add` gives such a repository a main worktree, so the ways out are restoring one that was removed, working in a clone that has one, or keeping that roadmap in a `--file` or `$STEPSTONE_WORKLIST` store.
- An explicit `--file` or `$STEPSTONE_WORKLIST` path outside those two committed roadmap locations remains writable from a linked worktree.
- When both files exist the current path wins and every goal operation warns, because quietly ignoring a populated `.pi/worklist.json` would look exactly like data loss. Merge them by hand; no command picks a winner for you.
- With `--json` that warning moves into the envelope as `meta.shadowedWorklistPath`, naming the file being passed over, because stderr carries the failure envelope and prose in front of it would leave nothing to parse.
- `--file` and `$STEPSTONE_WORKLIST` are resolved from the process working directory, independently of `--cwd`, for goal operations. `init` ignores both overrides and always writes `<git-root>/AGENTS.md` in the repository selected by `--cwd`.
- `migrate_path` moves a legacy file to `.worklist/worklist.json` under the same cross-process lock and atomic replacement as any other write, reporting both paths; it is a location change and leaves the goals, their IDs, and the schema version untouched.
- `migrate_path --dry-run` reports the move it would make without writing and without `--confirm`, and it refuses to run against an explicitly overridden path, which names a file rather than a repository to migrate.

## JSON plans

- `apply-plan <plan.json>` reads a plain JSON array whose entries allow exactly `title`, `description`, `group`, and `dependsOn`; `title` is a required non-empty string, `description` and `group` are optional strings, and `dependsOn` is an optional array of non-empty strings.
- Each `dependsOn` reference first matches an exact pre-collision slug of a goal in the same batch, then an exact current or former ID of an existing goal; prefixes are not accepted in plans.
- Two batch entries with the same pre-collision slug, an unknown reference, or any dependency cycle are hard validation errors and write nothing.
- Batch-first resolution is deterministic even when a predicted slug is already taken: the batch goal receives a collision suffix, dependents point to that suffixed ID, and `--dry-run` warns that the batch reference shadows the existing goal.
- A non-empty plan appends every goal in document order through one locked atomic replacement and increments the project revision exactly once; an empty plan is a valid no-op.
- `apply-plan --dry-run` performs the same locked validation and ID projection without writing or incrementing the revision; its prediction is advisory after the command exits because another writer may change the worklist before a later apply.
- The plan path is resolved from the process working directory, independently of `--cwd`, which only selects the target Git repository.

## Capture brainstorms as approved goal plans

1. Brainstorm broad outcomes for the roadmap rather than internal implementation steps.
2. Draft the exact plain JSON array that represents the complete proposed goal batch.
3. When a later, naturally ordered goal would collide with an earlier goal in the same modules or files, add the earlier goal's pre-collision slug to the later goal's `dependsOn` array even when no logical dependency exists.
4. Present that exact JSON array to the user and wait for explicit approval before making any mutation.
5. An optional dry-run is only a preview of validation, projected IDs, dependencies, and warnings; it is never approval and never replaces the explicit approval step.
6. After explicit approval, perform exactly one mutating `apply-plan` call for the entire approved array; never turn the batch into per-goal `add` calls.

## Goal IDs

- A goal's ID is derived from its title when the goal is created and frozen from then on, so it reads as words and a later rename never invalidates a reference written down elsewhere.
- A title-derived ID never uses the legacy random-ID shape, so `migrate_ids` can identify generated IDs without consulting a title that may have changed.
- Read an ID back from `list`, `find`, or `add` instead of deriving it from a title yourself: truncation and collision suffixes make a guessed slug unreliable.
- Every `<id>` argument also accepts a unique prefix of an ID, or an ID the goal answered to before `migrate_ids` renamed it.
- An ambiguous prefix is refused with the goals it matched instead of resolved by guesswork, so widen the prefix rather than retrying it.
- Deleting a goal permanently retires its current and former IDs: they stop resolving, but no later goal can claim them and inherit stale references.
- `find <text>` searches titles and descriptions, so locating a goal never needs `list --json` plus client-side filtering.

## Goal order and grouping

- Goals are stored and listed in one canonical order: `add` appends to the end, and `move` is the only action that rearranges them.
- `move <id> up` and `move <id> down` step one place, while `move <id> before <anchor>` and `move <id> after <anchor>` land the goal beside a named one.
- A move changes the roadmap's order without touching the moved goal's `updatedAt`, so rearranging the list never reads as editing the goals on it.
- Reordering needs no confirmation, because it names no new state for a goal, only a new position among the others.
- `--group <name>` on `add` and `update` files a goal under a free-form section; a group exists exactly when some goal names it, and `--group ''` clears the field.

## Dependencies

- `--depends-on <id>` on `add` and `update` records that the named goal must land before this one; repeat the flag to name several, and `--depends-on ''` on its own clears every edge.
- An `update` replaces the whole set rather than adding to it, so name every edge the goal should end up with, not just the new one.
- `--link <url>` on `add` and `update` stores an informational absolute HTTP or HTTPS URL; repeat it for the complete set, and use `--link ''` alone to clear every link.
- An update replaces the whole link set, matching `--depends-on`; links carry no machine semantics.
- An edge means must-land-before whatever its reason, so a logical prerequisite and two goals that would collide in the same files are recorded the same way.
- A dependency is satisfied once its target is done or archived, and a goal with an unsatisfied dependency is blocked.
- Blocked is derived from the edges on every read and never stored: there is no blocked status, and `set_active` warns about a blocked goal instead of refusing it.
- Only the forward direction is stored, and `show <id>` derives what the goal blocks, so an edge is written once and the two directions cannot drift apart.
- An update that would form a cycle, including an existing goal naming itself, is refused with `DEPENDENCY_CYCLE`.
- Add resolves dependencies before minting the new goal's ID, so an edge naming a guessed future slug is refused with `NOT_FOUND`, like any ID that names no existing goal.
- Deleting a goal drops the edges naming it in the same atomic change.
- File order is presentation and a tiebreak while the dependency graph is the source of truth for what may start; the two are allowed to disagree, and neither should be edited to mirror the other.

## Sequencing

- `ready` lists every open goal whose dependencies have all landed and that nobody has claimed, in canonical file order, so the whole parallel frontier is visible at once.
- A goal is claimed when it is active or carries a `branch`, and a claimed goal is left out of `ready` so work already in flight is never handed out twice.
- `next` is the first entry of `ready` by definition, so a driver asking for one goal and a human reading the frontier can never be told two different things.
- An empty frontier is reported at exit code 0, because a roadmap with nothing to start is an answer rather than a failure; read `result.goal` or `result.goals` to tell it from a goal.
- `waves` prints every unfinished goal in the earliest layer it could start in: wave 1 is the unblocked frontier, and each later wave is exactly what the wave before it releases.
- `waves` keeps claimed goals in their layer and marks them, because a wave shows the shape of the remaining work rather than what is free to pick up.
- A goal whose dependencies can never all land, through a hand-edited cycle or an edge naming no goal, is reported as unreachable instead of being dropped from the layers.
- `waves --json` reports the layers as `result.waves`, an array of goal arrays whose position is the wave number, and adds `result.unreachableGoals` only when some goal is unreachable, so an absent field means every unfinished goal found a layer.
- All three are reads derived from the stored edges the same way `blocked` is, so nothing is cached and no command has to be re-run to refresh them.

## Dispatching approved plans

- Start an approved preparation run with `npx -y -p stepstone@latest stepstone-dispatch start --goal <id>...`; repeated goal IDs are the immutable authorization allow-list.
- The published driver selects only allow-listed goals returned by a fresh ready frontier, prepares an isolated workspace, claims each exact `updatedAt`, and limits how many prepared claims it may hold at once.
- Each newly prepared workspace contains an ignored `STEPSTONE_GOAL.md` at its root with the goal ID, title, description, snapshot time, prepared branch, dependencies, links, and linked-worktree boundary; read that file before starting work.
- Stepstone never starts, prompts, or supervises an agent; after preparation, open the reported workspace with whichever harness or terminal you choose.
- The root session is the sole roadmap writer and runs every mutation from the repository's main worktree; work inside an isolated workspace must not mutate the worklist.
- Only a merged PR whose head exactly matches the stored claimed branch is completion evidence; a closed terminal, silence, or an unmerged green PR never proves the goal landed.
- Starting a preparation run for an explicitly approved plan grants standing consent to complete only an allow-listed goal after its matching PR merged.
- Local runtime state under the Git common directory preserves claim tokens, workspace custody, configuration, and outcomes across `resume`, while canonical roadmap state remains harness-neutral.
- Ambiguous workspace or claim outcomes preserve custody until inspection and explicit `recover <run-id> <goal-id> --release`.
- Use `status` and `inspect` without mutation, `resume` to reconcile merges and refill preparation capacity, and `cleanup` only after completion or exact release.

Git workspace preparation, recovery, and cleanup rules are documented in the package's `docs/dispatch.md`.

## Guardrails

- `complete`, `reopen`, `archive`, `delete`, `migrate_ids`, and `migrate_path` are reserved for explicit user intent.
  Pass `--confirm` only for the exact action the user requested and, when the action names a goal, only for that exact goal.
  Never pass it because a goal merely looks finished or stale.
  A dispatch loop the user approved is the one narrow exception, and only for completing a goal of that plan once its matching PR merged.
- `migrate_ids` names no goal and rewrites every generated ID in the repository at once, so it needs an explicit request of its own.
  `--dry-run` reports the rewrites it would make without writing them and without `--confirm`; prefer it when you are showing the user what would change.
- `migrate_path` names no goal either and moves the whole repository's goal file, so it needs its own explicit request and has the same `--dry-run`.
- Exit code 3 (confirmation required) means the command needs `--confirm`; stop and ask the user instead of retrying with the flag.
- Exit code 4 (conflict) means a concurrent change conflicted with yours; re-read current state with `list` or `show` before retrying.
  A conflicting change wrote nothing at all, so rebuild it against the goal you just re-read and pass that goal's new `updatedAt`.
- `init`, `list`, `show`, `find`, `next`, `ready`, `waves`, `add`, `update`, `move`, `start`, and `set_active` are safe to run whenever they serve the user's request.
- `apply-plan --dry-run` is safe for preview; a mutating `apply-plan` is safe only after explicit approval of that exact plan.
- `ui` opens a full-screen board for the human at the keyboard, not for you.
  Never run it: it holds the terminal until the user quits, and it exits with an error when stdin or stdout is not a terminal.
  Suggest `npx -y stepstone@latest project ui` when the user wants to browse or edit goals themselves; read state with `list` and `show` instead.
- Session Tasks are a Pi extension feature that lives inside a Pi session, so the CLI rejects `session` scope.
  For your own in-session tracking, use your normal task tools instead.

## Failure modes

- Exit code 1 (error) with a "Malformed" message means the goal file the repository resolved to is corrupt; the message names it, so report it to the user and never rewrite the file by hand.
- Exit code 1 with a "git repository" message means the working directory is outside a repo; rerun with `--cwd <repo-root>`.
  With `--json`, that failure also arrives as the deterministic result envelope on stderr.
- Exit code 2 (usage error) means the action or its flags were not recognized; re-read the action list above instead of guessing.
- If `npx -y stepstone@latest` cannot resolve the package, check network access to the npm registry; a local development checkout remains a fallback.
- Read `meta.cliVersion` from any `--json` result envelope when you need to verify which published build ran.
  This reports the package's runtime version directly instead of requiring inspection of the npx cache.
