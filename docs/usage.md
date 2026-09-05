<!-- markdownlint-disable MD013 -->

# Running the CLI

The CLI is the primary way to manage Project Goals, from a shell, a script, or a coding agent of any kind.
[docs/cli.md](cli.md) is the complete command reference, generated from `src/cli-contract.ts`; this page is the narrative behind it.

## Invocation

```sh
npx -y stepstone@latest project <action> [arguments] [flags]
```

The explicit `@latest` specifier prevents a stale local npx cache from selecting an older CLI build, which has silently happened before and is invisible while it does.
Run the command from inside the target repository, or pass `--cwd <dir>` to resolve the Git root from another directory.
`--file <path>`, and the `$STEPSTONE_WORKLIST` environment variable, name a goal file outright instead of letting the repository resolve one; see [docs/storage.md](storage.md).

The CLI ships as a compiled bin in the published package, so it needs Node 20 or newer and nothing else.
The compiled bin loads no Pi peer, so `npx -y stepstone@latest` runs with no Pi installation.
That is enforced by import scans over every executable module graph and by a CI job that packs the tarball and drives every installed bin in a scratch directory with no Pi present; see [docs/development.md](https://github.com/max-miller1204/stepstone/blob/main/docs/development.md).

## Running from a checkout

In a development checkout, `node src/cli.ts project <action>` runs the same CLI against unreleased changes.
Running the TypeScript entry point directly needs Node 22.18 or newer, which strips types natively.
On older versions, including this package's own floor, that entry point fails with an `Unknown file extension ".ts"` error while the compiled bin has no such requirement.

## `AGENTS.md` fallback

The [Agent Skill](skill.md) is the preferred guidance surface.
Use `project init` instead only when the harness does not support skills but reads `AGENTS.md`:

```sh
npx -y stepstone@latest project init
```

Choose one guidance surface for a repository; do not install the skill and generate the Stepstone `AGENTS.md` block together.

`init` writes or refreshes only the generated Stepstone block between stable markers in `<git-root>/AGENTS.md`.
If the file has no block, the command appends one; if exactly one marker pair exists, it replaces that pair while preserving every outside byte.
Incomplete, reversed, or duplicate markers are refused without a write, and an already current block is not rewritten.
The read, marker validation, and atomic replacement run under a cross-process repository lock, so concurrent initializers serialize rather than append duplicate blocks.

Run `init` inside the target repository or pass `--cwd <dir>`.
`--file <path>` and `$STEPSTONE_WORKLIST` affect goal-file resolution for other actions but never the `AGENTS.md` target.
The command reports only the fallback block it managed and does not install or recommend another guidance surface.

## Reading the roadmap

```sh
npx -y stepstone@latest project list
npx -y stepstone@latest project show <id>
npx -y stepstone@latest project find templates
npx -y stepstone@latest project next
npx -y stepstone@latest project ready
npx -y stepstone@latest project waves
```

`list` output is deliberately compact and omits descriptions, so orientation stays readable in a terminal and cheap in an agent's context; `show <id>` prints one goal in full detail.
`find <text>` lists the goals whose title or description contains the text, so locating one never needs `list --json` plus a client-side filter.
`next`, `ready`, and `waves` read the dependency graph rather than the file order, so a driver never has to decide for itself which goal is startable; they are specified in [docs/dependencies.md](dependencies.md).

Every `<id>` argument accepts a full ID, a unique prefix of one, or an ID the goal answered to before a migration renamed it, and refuses an ambiguous prefix with the goals it matched.

## Changing the roadmap

```sh
npx -y stepstone@latest project add Support goal templates \
  --description "Let teams share reusable goal outlines"
npx -y stepstone@latest project update <id> Replace the title \
  --description "Replace the description"
npx -y stepstone@latest project update <id> --append-description "Add a note as a new paragraph"
npx -y stepstone@latest project update <id> --group Foundation
npx -y stepstone@latest project update <id> --depends-on <other-id> --depends-on <third-id>
npx -y stepstone@latest project update <id> --link https://example.com/spec --link https://example.com/issue
npx -y stepstone@latest project move <id> up
npx -y stepstone@latest project move <id> before <anchor-id>
npx -y stepstone@latest project set_active <id>
npx -y stepstone@latest project start <id>
npx -y stepstone@latest project start <id> --branch feat/parser
npx -y stepstone@latest project start <id> --clear
npx -y stepstone@latest project apply-plan plan.json --dry-run --json
npx -y stepstone@latest project apply-plan plan.json --json
```

`add` appends to the roadmap's canonical order and `move` is the only action that rearranges it; `move <id> up|down` steps one place and `move <id> before|after <anchor-id>` lands beside a named goal, and a move that would change nothing succeeds without writing.
`--group <name>` files a goal under a free-form section and `--group ''` clears it; a group exists exactly when some goal names it, so there is no separate list to keep in step.
`--depends-on <id>` records a goal that must land first and may be repeated, `--depends-on ''` alone clears every edge, and an update replaces the stored set rather than adding to it.
`--link <url>` stores an informational absolute HTTP or HTTPS URL such as the issue or design a goal came from, behaves the same way - repeatable, replaced whole by an update, cleared by `--link ''` alone - and rejects anything that is not an absolute HTTP or HTTPS URL, so the field never accumulates text a reader cannot follow.
`start` records which branch is working on a goal, as a dispatch claim rather than a status change: the goal keeps whatever status it had, and `--branch <name>` names the branch while an omitted flag uses the current Git branch, which is read and never created, so a run on a detached HEAD asks for `--branch` instead of guessing.
`--json` keeps the two reasons a claim has no branch apart: a detached HEAD is a `VALIDATION_FAILED` envelope naming the `branch` field, while a Git that could not answer the lookup at all is an `UNAVAILABLE` envelope carrying Git's own diagnostic, marked retryable only when the command was killed rather than refused.
A claimed goal drops out of `ready` and `next`, which is the point - see [docs/dependencies.md](dependencies.md#sequencing-reads) - so every claim needs a release: `start <id> --clear` un-claims an abandoned dispatch and `complete` clears the branch on its way to done.
A settled goal refuses a new claim, though `--clear` still releases one it is already holding; see [docs/goals.md](goals.md#statuses).
The published `stepstone-dispatch` executable prepares and claims approved goal workspaces, writes each goal into an ignored root `STEPSTONE_GOAL.md`, persists workspace custody for restart, and exposes resume, status, inspection, recovery, and cleanup operations without starting or prompting an agent; see [docs/dispatch.md](dispatch.md).
`apply-plan` adds an approved batch of goals through one locked mutation; the plan schema is in [docs/goals.md](goals.md#json-goal-plans).
A `--dry-run` is a preview rather than the user's approval, and the brainstorm-to-approved-plan workflow an agent runs before that single mutating call is in [docs/cli.md](cli.md#capture-brainstorms-as-approved-goal-plans).

### Description input

Agents and scripts use the order-independent `--description <text>` flag for a replacement, passing the complete value in one argv token, and `--append-description <text>` to add a paragraph without replaying stored prose.
Appending resolves against the stored text under the lock, so an added note composes with a concurrent edit rather than overwriting it.

A new title goes before `--description` rather than after its single argv token.
On `update`, a trailing word that would become a title exits with code 2 instead of renaming the goal; on `add`, prose that spills past the value and splits the title across it exits the same way, so quote the whole description.

The `-- <description...>` separator, and the legacy `--append -- <text>` form, remain available for a human typing unquoted prose interactively.
A standalone known flag after that separator is a usage error with exit code 2, because flag-looking description text belongs in `--description`.

## Lifecycle actions

```sh
npx -y stepstone@latest project complete <id> --confirm
npx -y stepstone@latest project reopen <id> --confirm
npx -y stepstone@latest project archive <id> --confirm
npx -y stepstone@latest project delete <id> --confirm
```

`complete`, `reopen`, `archive`, `delete`, `migrate_ids`, and `migrate_path` require `--confirm`, mirroring the explicit-intent rule every other interface applies.
An omitted flag exits with code 3 and changes nothing, which an agent should treat as a request to ask the user rather than as a retryable failure.

## Result envelopes and exit codes

`--json` prints a deterministic, operation-shaped result envelope and adds the running package version in `meta.cliVersion`: on stdout for success, on stderr for failure.
Collection reads return the collection they request: `list`, `find`, and `ready` use `result.goals`, while `waves` uses `result.waves`. Project mutations return bounded receipts instead of the complete post-mutation roadmap: single-goal mutations return `result.goal`, `delete` returns `result.deletedGoalId`, and `apply-plan` returns `result.addedGoals`. Migration receipts retain their operation data: `migrate_ids` returns `result.migrations`, while `migrate_path` returns `result.worklistPath` and, when it moves the file, `result.previousWorklistPath`.
`meta` also reports whether anything changed, whether the mutation was a semantic no-op, which fields moved, the changed entity IDs, and the resulting revision, so a caller never has to diff the file to find out.
Do not run `list` only to verify a successful mutation. Run an explicit read only when later work needs current roadmap state.

The exit codes are tabulated in [docs/cli.md](cli.md#exit-codes) and printed by `project help`, both rendered from the contract itself rather than restated here.
Two of them are decisions rather than failures: code 3 means the command needs `--confirm`, which is a question for the user, and code 4 means a concurrent change conflicted with yours.
An empty `next` or `ready` is not among them: it exits 0, because a roadmap with nothing to start is an answer, so read `result.goal` or `result.goals` instead of the exit code.

## Concurrency and conflicts

The CLI routes every mutation through the same application service, cross-process lock, and atomic replacement as every other interface, so physical writes are serialized and atomic even with a board open and a Pi session running on the same repository.

That serializes writes without tracking what a caller read, so a mutation built on a stale read otherwise proceeds unreported, and a full description replacement can overwrite newer prose.
`--expect-updated-at <timestamp>`, carrying the goal's `updatedAt` from your own `show`, closes that gap on `update`, `start`, `set_active`, and the lifecycle actions.
Pass it on every change to a goal you did not just create.

Exit code 4 reports a concurrent-change conflict, whether the file-wide revision or a single goal's timestamp moved.
Nothing is written in that case, so re-read current state, rebuild the change against it, and retry with the new baseline.
