<!-- Generated from src/cli-contract.ts by scripts/generate-docs.ts. Do not edit manually. -->

# stepstone CLI

Manage repository-wide Project Goals in <git-root>/.worklist/worklist.json through the same application service, cross-process lock, and atomic replacement as a live Pi session. Session Tasks live inside a Pi session and are deliberately out of scope.

## Invocation

Use the explicit `@latest` package specifier so a stale local npx cache cannot select an older CLI build:

```sh
npx -y stepstone@latest project <action> [arguments] [flags]
```

Every `--json` result envelope reports the running package version as `meta.cliVersion`.

## Where the goal file lives

- The goal file is `<git-root>/.worklist/worklist.json`, a directory rather than a bare dotfile so later local state has somewhere to live beside the committed roadmap.
- One resolution order applies everywhere, in the CLI, the board, and a live Pi session: an explicit `--file <path>` or `$STEPSTONE_WORKLIST` first, then `.worklist/worklist.json`, then the legacy `.pi/worklist.json`.
- Reads fall back to the legacy path and writes go to whichever path resolved, so a repository holding only `.pi/worklist.json` keeps using it untouched rather than silently splitting into two roadmaps; a repository with neither file writes `.worklist/worklist.json`.
- When both files exist the current path wins and every command warns, because quietly ignoring a populated `.pi/worklist.json` would look exactly like data loss. Merge them by hand; no command picks a winner for you.
- With `--json` that warning moves into the envelope as `meta.shadowedWorklistPath`, naming the file being passed over, because stderr carries the failure envelope and prose in front of it would leave nothing to parse.
- `--file` and `$STEPSTONE_WORKLIST` are resolved from the process working directory, independently of `--cwd`, which only selects the target Git repository.
- `migrate_path` moves a legacy file to `.worklist/worklist.json` under the same cross-process lock and atomic replacement as any other write, reporting both paths; it is a location change and leaves the goals, their IDs, and the schema version untouched.
- `migrate_path --dry-run` reports the move it would make without writing and without `--confirm`, and it refuses to run against an explicitly overridden path, which names a file rather than a repository to migrate.

## Commands

| Command | Description |
| --- | --- |
| `npx -y stepstone@latest project list` | Show a compact bounded list of project goals |
| `npx -y stepstone@latest project show <id>` | Show one goal with its full description |
| `npx -y stepstone@latest project find <text...>` | List the goals whose title or description contains the text |
| `npx -y stepstone@latest project next` | Show the one goal to start next, the first ready goal in file order |
| `npx -y stepstone@latest project ready` | List every unblocked, unclaimed open goal: the whole parallel frontier |
| `npx -y stepstone@latest project waves` | Print unfinished goals in dependency layers, earliest first |
| `npx -y stepstone@latest project ui` | Open the interactive goal board for a human at the keyboard. Requires a terminal; not for scripts or agents |
| `npx -y stepstone@latest project add <title...> [--description <text> \| -- <description...>]` | Add an open goal |
| `npx -y stepstone@latest project apply-plan <plan.json>` | Validate and atomically add every goal in a JSON plan |
| `npx -y stepstone@latest project update <id> [title...] [--description <text> \| -- <description...>]` | Edit a goal's title or description |
| `npx -y stepstone@latest project move <id> up\|down\|before <id>\|after <id>` | Reorder a goal in the roadmap's canonical file order |
| `npx -y stepstone@latest project set_active <id>` | Make a goal the single active goal |
| `npx -y stepstone@latest project complete <id> --confirm` | Mark a goal done. Requires explicit user confirmation |
| `npx -y stepstone@latest project reopen <id> --confirm` | Reopen a done or archived goal. Requires explicit user confirmation |
| `npx -y stepstone@latest project archive <id> --confirm` | Archive a goal. Requires explicit user confirmation |
| `npx -y stepstone@latest project delete <id> --confirm` | Delete a goal permanently. Requires explicit user confirmation |
| `npx -y stepstone@latest project migrate_ids --confirm` | Rewrite randomly generated goal IDs as title-derived ones. Requires explicit user confirmation |
| `npx -y stepstone@latest project migrate_path --confirm` | Move the goal file from the legacy path to .worklist/worklist.json. Requires explicit user confirmation |
| `npx -y stepstone@latest project help` | Print this help |

## Flags

| Flag | Description |
| --- | --- |
| `--json` | Print the deterministic result envelope as JSON (stdout on success, stderr on failure) |
| `--confirm` | Acknowledge an action that requires confirmation; pass it only for an explicit user request |
| `--cwd <dir>` | Resolve the git root from this directory instead of the working directory |
| `--file <path>` | Read and write this goal file instead of the one the repository resolves to, overriding $STEPSTONE_WORKLIST |
| `--description <text>` | Set the whole description from one argv token; order-independent and preferred for agents and scripts; a new update title must come before it, and an add title must not straddle it; only for project add and update |
| `--append-description <text>` | Add one argv token as a new description paragraph without replacing stored prose; cannot be combined with a title change; only for project update |
| `--append` | Interactive compatibility form that adds the text after -- as a new paragraph; cannot be combined with a title change; only for project update |
| `--group <name>` | Put the goal in a free-form section, such as Foundation; an empty name clears it; only for project add and update |
| `--depends-on <id>` | Require that goal to land first; repeat it to name several, and pass an empty id alone to clear every edge; only for project add and update |
| `--expect-updated-at <timestamp>` | Refuse the change as a conflict unless the goal's updatedAt still matches this value; only for project update, set_active, complete, reopen, archive, and delete |
| `--dry-run` | Validate and report an apply-plan projection, ID migration, or path migration without writing; only for project apply-plan, migrate_ids, and migrate_path |

## Description input

Programmatic callers and agents must use `--description <text>` for a replacement, passing the whole value in one argv token. The flag is order-independent, and its value may itself look like a known flag.
Write a new title before `--description` rather than after its value: on `update`, a trailing word that would become a title is refused with exit code 2 instead of renaming the goal, and on `add` a title split across the value is refused the same way. `add` otherwise folds words after the value into the title rather than failing, so quote the whole description there. `update <id> <title...> --description <text>` still replaces a title and a description at once.
Use `--append-description <text>` to add a paragraph without replaying stored prose. Replacing and appending are mutually exclusive, and an append cannot be combined with a title change.
Reserve `-- <description...>` for a human typing unquoted prose interactively. A standalone known flag after the separator is a usage error with exit code 2; move a real flag before the separator or put flag-looking prose in `--description`.
The legacy `--append -- <text>` interactive form remains supported, while agents and scripts use `--append-description <text>`.
Programmatic callers clear a description with `--description ''`; the interactive `update <id> --` form remains supported.

## JSON plans

- `apply-plan <plan.json>` reads a plain JSON array whose entries allow exactly `title`, `description`, `group`, and `dependsOn`; `title` is a required non-empty string, `description` and `group` are optional strings, and `dependsOn` is an optional array of non-empty strings.
- Each `dependsOn` reference first matches an exact pre-collision slug of a goal in the same batch, then an exact current or former ID of an existing goal; prefixes are not accepted in plans.
- Two batch entries with the same pre-collision slug, an unknown reference, or any dependency cycle are hard validation errors and write nothing.
- Batch-first resolution is deterministic even when a predicted slug is already taken: the batch goal receives a collision suffix, dependents point to that suffixed ID, and `--dry-run` warns that the batch reference shadows the existing goal.
- A non-empty plan appends every goal in document order through one locked atomic replacement and increments the project revision exactly once; an empty plan is a valid no-op.
- `apply-plan --dry-run` performs the same locked validation and ID projection without writing or incrementing the revision; its prediction is advisory after the command exits because another writer may change the worklist before a later apply.
- The plan path is resolved from the process working directory, independently of `--cwd`, which only selects the target Git repository.

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

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | success |
| `1` | error |
| `2` | usage error |
| `3` | confirmation required |
| `4` | conflict |

## Agent guidance

- Prefer --json and read the deterministic result envelope instead of parsing human output.
- Use --description <text> and --append-description <text> for every programmatic description input; reserve the -- separator for a human typing prose interactively.
- Read the CLI's own exit code rather than a shell pipeline's; a known flag after the description separator is a usage error with exit code 2.
- Never run ui: it is an interactive board for a human, it holds the terminal until they quit, and it refuses to start without one.
- Never pass --confirm for complete, reopen, archive, delete, migrate_ids, or migrate_path unless the user explicitly requested that exact action.
- Treat exit code 3 as a request for explicit user confirmation, not as a retryable failure.
- Treat exit code 4 as a concurrent-change conflict: re-read current state before retrying.
- Use list for orientation, find <text> to locate a goal by wording, and show <id> when you need a goal's complete description.
- Ask next for the goal to start, ready for everything that could run in parallel, and waves for how the rest of the roadmap is layered; never pick a goal off list yourself, because list cannot tell you what is blocked or already claimed.
- Treat an empty next or ready as nothing to start rather than an error: it exits 0, so read result.goal or result.goals instead of the exit code.
- Pass a full ID or a prefix long enough to be unique; an ambiguous prefix is refused with candidates rather than resolved by guesswork.
- Run migrate_ids only when the user explicitly asks for it; it rewrites stored IDs, though every old ID keeps resolving afterwards.
- Leave the goal file where it is unless the user asks to move it: a repository still on `.pi/worklist.json` works untouched, and migrate_path is theirs to request.
- Report the two-worklist warning to the user rather than working around it; only stepstone reads the file it names, and merging them is a decision about which goals survive.
- Add a note with --append-description instead of resending a description you did not write, so nothing in the existing text can be lost in transcription.
- Group related goals with --group <name> on add or update, and leave the file order alone unless the user asked for a different sequence.
- Record a real must-land-before relationship with --depends-on <id>, including one that exists only because two goals would collide in the same files; do not add an edge merely to justify the order the file happens to be in.
- Send the complete set of edges on every --depends-on update, because it replaces the stored set rather than adding to it.
- Pass --expect-updated-at with the updatedAt from your own read whenever you change a goal, so your mutation conflicts if the goal changed in the meantime.
- Use apply-plan for an approved JSON goal batch, and run it with --dry-run first when the user needs to review predicted IDs, dependencies, or shadow warnings.
- Broad outcomes belong in Project Goals; do not mirror your internal step-by-step plan into them.
