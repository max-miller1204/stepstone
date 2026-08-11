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

The CLI's published bin is compiled, so it needs Node 20 or newer and nothing else.
Every Pi peer dependency is optional, and neither compiled bin loads one, so `npx -y stepstone@latest` runs with no Pi installation.
That is enforced by import scans over both module graphs and by a CI job that packs the tarball and drives both installed bins in a scratch directory with no Pi present; see [docs/development.md](https://github.com/max-miller1204/stepstone/blob/main/docs/development.md).

## Running from a checkout

In a development checkout, `node src/cli.ts project <action>` runs the same CLI against unreleased changes.
Running the TypeScript entry point directly needs Node 22.18 or newer, which strips types natively.
On older versions, including this package's own floor, that entry point fails with an `Unknown file extension ".ts"` error while the compiled bin has no such requirement.

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
npx -y stepstone@latest project move <id> up
npx -y stepstone@latest project move <id> before <anchor-id>
npx -y stepstone@latest project set_active <id>
npx -y stepstone@latest project apply-plan plan.json --dry-run --json
npx -y stepstone@latest project apply-plan plan.json --json
```

`add` appends to the roadmap's canonical order and `move` is the only action that rearranges it; `move <id> up|down` steps one place and `move <id> before|after <anchor-id>` lands beside a named goal, and a move that would change nothing succeeds without writing.
`--group <name>` files a goal under a free-form section and `--group ''` clears it; a group exists exactly when some goal names it, so there is no separate list to keep in step.
`--depends-on <id>` records a goal that must land first and may be repeated, `--depends-on ''` alone clears every edge, and an update replaces the stored set rather than adding to it.
`apply-plan` adds an approved batch of goals through one locked mutation; the plan schema is in [docs/goals.md](goals.md#json-goal-plans).

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

`--json` prints a deterministic result envelope, preserving the full application result and adding the running package version in `meta.cliVersion`: on stdout for success, on stderr for failure.
`meta` also reports whether anything changed, whether the mutation was a semantic no-op, which fields moved, and the resulting revision, so a caller never has to diff the file to find out.

The exit codes are tabulated in [docs/cli.md](cli.md#exit-codes) and printed by `project help`, both rendered from the contract itself rather than restated here.
Two of them are decisions rather than failures: code 3 means the command needs `--confirm`, which is a question for the user, and code 4 means a concurrent change conflicted with yours.
An empty `next` or `ready` is not among them: it exits 0, because a roadmap with nothing to start is an answer, so read `result.goal` or `result.goals` instead of the exit code.

## Concurrency and conflicts

The CLI routes every mutation through the same application service, cross-process lock, and atomic replacement as every other interface, so physical writes are serialized and atomic even with a board open and a Pi session running on the same repository.

That serializes writes without tracking what a caller read, so a mutation built on a stale read otherwise proceeds unreported, and a full description replacement can overwrite newer prose.
`--expect-updated-at <timestamp>`, carrying the goal's `updatedAt` from your own `show`, closes that gap on `update`, `set_active`, and the lifecycle actions.
Pass it on every change to a goal you did not just create.

Exit code 4 reports a concurrent-change conflict, whether the file-wide revision or a single goal's timestamp moved.
Nothing is written in that case, so re-read current state, rebuild the change against it, and retry with the new baseline.
