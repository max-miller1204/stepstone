<!-- markdownlint-disable MD013 -->

# The goal model

A Project Goal is a broad outcome for the repository: the kind of thing a pull request description or a release note would name.
The concrete steps toward one belong in whatever task list the agent working on it already has, not in the roadmap.

## Fields

Every goal carries a title, a status, a frozen ID, a `createdAt`, and an `updatedAt`, plus an optional description.
Beyond that it may carry:

- `group`, a free-form section name such as `Foundation`, which exists exactly when some goal names it.
- `completedAt`, stamped by `complete` and cleared by `reopen`.
- `links`, an informational array.
- `branch`, naming where the work is happening, which also marks the goal as claimed.
- `dependsOn`, the goals that must land first, documented in [docs/dependencies.md](dependencies.md).

Every one of those fields is optional and additive, so the schema version stays at 1 and older files keep loading unchanged.
A goal completed before `completedAt` existed simply has none, because that moment is genuinely unknown and inventing one would be worse than admitting it.

## Statuses

A goal is `open`, `active`, `done`, or `archived`.
Exactly one goal is active, so `set_active` is the answer to what is in flight rather than a label anybody can spread across the list.

Activation is the only non-destructive direct status change.
Completing, reopening, archiving, and deleting a goal all require explicit user intent: `--confirm` on the CLI, `confirm=true` on the model tool, a typed command, or a keystroke a person pressed in a board.
No interface may add a path around that, and an agent must never pass the flag because a goal merely looks finished or stale.

`archived` settles a goal without claiming it was delivered, which is why an archived dependency satisfies the goals waiting on it just as a done one does.

## Goal identifiers

A goal's ID is derived from its title when the goal is created: lowercase, hyphenated, and capped near 40 characters at a word boundary.
`Support goal templates` becomes `support-goal-templates`, so an ID reads as words in a shell, a commit message, or a PR description instead of as `goal-ms6gwxrg-56c1bde6`.
A truncated title keeps whatever word the cap left at the end, so `add-pi-orchestrator-compatibility-and` is accepted rather than tidied; trimming those tails was tried and abandoned, because no word list separates the words that merely shorten a name from the ones that reverse it.
`-2` and `-3` suffixes distinguish slugs that are already taken, and a title that would produce the old random-ID shape gets a collision suffix so new slugs and legacy IDs stay permanently distinguishable.

The slug is frozen once minted.
Renaming a goal never renames its ID, so a reference recorded anywhere else stays valid and keeps naming the goal it was written for even after the title has moved on.
Read an ID back from `add`, `list`, or `find` rather than deriving it from a title yourself, because truncation and collision suffixes make a guessed slug unreliable.

Every `<id>` argument, in the CLI and in the model tool, accepts a full ID, a unique prefix of one, or an ID the goal answered to before a migration renamed it.
An exact match always beats a prefix, so `support-goal-templates` still names its own goal once `support-goal-templates-2` exists.
An ambiguous prefix is refused with the goals it matched rather than resolved by guesswork, because a guess the caller cannot see is a change applied to a goal they did not mean.

### Migrating legacy IDs

```sh
npx -y stepstone@latest project migrate_ids --confirm
npx -y stepstone@latest project migrate_ids --dry-run
```

`migrate_ids` rewrites the randomly generated IDs in an existing worklist, and needs an explicit request of its own because it names no goal and touches every one at once.
Only generated IDs are rewritten: new slugs cannot use the legacy generator's shape, so migration classifies IDs without comparing them to a title that may have changed.

Each rewritten goal records its old ID in `previousIds`, which keeps that ID both resolvable and reserved.
That is what makes migrating a done or archived goal safe rather than a judgment call: a Session Task's `goalId`, an evidence file, and an old PR description all keep resolving to the same goal, and no later goal can claim a name still in use.
Deleting a goal retires its current and former IDs permanently: they stop resolving, but no later goal can claim one and silently inherit a stale reference.

`--dry-run` reports the rewrites without writing them and without `--confirm`, which is the form to use when showing someone what would change.

## Order and grouping

The goal array's order is canonical rather than incidental.
`add` appends, `move` is the only action that rearranges it, and every reader displays that order unless it was explicitly asked for another one.

A move rewrites the order without touching any goal's `updatedAt`, so rearranging the roadmap never reads as editing the goals on it and never invalidates a baseline nobody's edit conflicts with.
Reordering needs no confirmation either, because it names no new state for a goal, only a new position among the others.

`--group <name>` on `add` and `update` files a goal under a section, and `--group ''` clears the field.
Groups are free-form and derived from the goals themselves, so there is no group list to create, delete, or keep in step.

File order and the dependency graph answer two different questions and are allowed to disagree; see [docs/dependencies.md](dependencies.md).

## JSON goal plans

`project apply-plan <plan.json>` adds an approved batch of goals through one locked mutation, one atomic file replacement, and one revision increment.
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

Everything the plan claims is validated before anything is written, so a rejected plan leaves the worklist byte-identical.
`--dry-run` reports the predicted IDs and any such shadowed reference without writing at all, though its prediction is advisory once the command exits, because another writer may change the worklist before a later apply.

The plan schema, reference resolution, validation failures, and dry-run guarantees are specified in [docs/cli.md](cli.md#json-plans), generated from the same contract as the CLI help.
