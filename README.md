<!-- markdownlint-disable MD013 -->

# stepstone

[![npm version](https://img.shields.io/npm/v/stepstone.svg)](https://www.npmjs.com/package/stepstone)
[![CI](https://github.com/max-miller1204/stepstone/actions/workflows/ci.yml/badge.svg)](https://github.com/max-miller1204/stepstone/actions/workflows/ci.yml)
[![Release](https://github.com/max-miller1204/stepstone/actions/workflows/release.yml/badge.svg)](https://github.com/max-miller1204/stepstone/actions/workflows/release.yml)

stepstone keeps a repository's roadmap inside the repository.
Project Goals are a list committed alongside the code, which any coding agent and any human at a terminal reads and changes through the same CLI.
Goals carry dependency edges, so `next`, `ready`, and `waves` answer what to start, what can run in parallel, and what each finished goal unblocks.

## Install

**Any shell, script, or coding agent.**
There is nothing to install: the CLI runs from npm on demand, in any Git repository, with nothing present but Node.

```sh
npx -y stepstone@latest project list
```

**Claude Code, and other agents the [`skills` CLI](https://github.com/vercel-labs/skills) supports.**
Install the [agent skill](docs/skill.md), which teaches that CLI and its guardrails:

```sh
npx skills add max-miller1204/stepstone --skill stepstone -g
```

**[Pi](https://pi.dev).**
Install the [extension](docs/pi.md), which adds `/tasks`, a session widget, a model-facing tool, and Session Tasks:

```sh
pi install npm:stepstone
```

Installing the npm package does not install the skill, and installing the skill does not install a copy of the CLI.
The skill is guidance that invokes the published CLI; see [docs/skill.md](docs/skill.md).

## Try it

```sh
npx -y stepstone@latest project add Replace legacy authentication \
  --description "Migrate every supported client first"
# Added project goal replace-legacy-authentication: Replace legacy authentication

npx -y stepstone@latest project add Retire the legacy auth service \
  --depends-on replace-legacy-authentication

npx -y stepstone@latest project waves
# Wave 1 (1 goal):
#   [open] replace-legacy-authentication: Replace legacy authentication
# Wave 2 (1 goal):
#   [open] retire-the-legacy-auth-service: Retire the legacy auth service

npx -y stepstone@latest project set_active replace-legacy-authentication
```

`add` prints the ID it minted from the title, and that is the name every other command takes; the ID is frozen, so renaming the goal later never invalidates a reference to it.
`waves` reads the dependency edge rather than the file order, which is why retiring the old service sits in a later layer than replacing it, and `next` names the one goal to start right now.
All of it lands in `.worklist/worklist.json` at the repository root, which is meant to be committed.

Add `--json` to any command for a deterministic result envelope instead of prose, which is how agents and scripts should read it.
Run `npx -y stepstone@latest project ui` for a full-screen [terminal board](docs/board.md) over the same goals.

## How it works

A goal is a broad outcome with a title, an optional description, a status, and a slug ID derived from its title and frozen afterwards, so a reference written in a commit message or a PR stays valid after a rename.
Statuses are `open`, `active`, `done`, and `archived`; at most one goal is active, because `set_active` demotes whichever goal held it, and completing, reopening, archiving, or deleting one always requires explicit user intent, from a `--confirm` flag or a keystroke a person pressed.

Dependency edges say which goals must land first, and blocked is derived from those edges on every read rather than stored, so nothing is ever left marked blocked after the work holding it up finished.
`ready` is the whole parallel frontier, `next` is its first entry, and `waves` lays the unfinished goals out in the earliest layer each could start in.

Every interface writes through one application service, one cross-process lock, and one atomic file replacement, so a CLI call, an open board, and a live Pi session can share a repository without corrupting the file or losing an edit.
Optional preconditions, a file-wide revision and a single goal's `updatedAt`, turn a stale read into a reported conflict instead of a silent overwrite.

Nothing the CLI loads imports a Pi package, so `npx -y stepstone@latest` installs under a megabyte and runs with no Pi installation at all.
That is enforced by a source-level import scan and by a CI job that packs the tarball and drives the installed bin with no Pi present, rather than promised in prose.

## Documentation

| Document | Contents |
| --- | --- |
| [docs/usage.md](docs/usage.md) | Running the CLI: reads, writes, `--json` envelopes, exit codes, conflicts |
| [docs/cli.md](docs/cli.md) | Generated command reference: every action, flag, and rule |
| [docs/goals.md](docs/goals.md) | The goal model: fields, statuses, IDs, order, groups, JSON plans |
| [docs/dependencies.md](docs/dependencies.md) | Dependency edges and the sequencing reads behind `next`, `ready`, and `waves` |
| [docs/storage.md](docs/storage.md) | Where the goal file lives, its schema, locking, revisions, and migrations |
| [docs/board.md](docs/board.md) | The terminal goal board and its key map |
| [docs/skill.md](docs/skill.md) | The generated agent skill, and how to install it |
| [docs/pi.md](docs/pi.md) | The Pi extension: Session Tasks, `/tasks`, the widget, the model tool, the module API |
| [docs/development.md](docs/development.md) | Working on stepstone: checks, generated files, and the invariants behind them |
| [docs/releasing.md](docs/releasing.md) | How a release is published, and the one-time registry setup |

## Pi extension

Pi is one supported harness rather than the product.
In a Pi session, stepstone adds Session Tasks: a branch-aware queue of the concrete chunks in the session at hand, kept separate from the roadmap because a session's next steps and a repository's outcomes are not the same thing.
It also adds the `/tasks` dashboard over both lists, a compact widget naming the active goal and the next unfinished tasks, and a model-facing `worklist` tool.

Session Tasks are documented and kept working, but they are not where the project is heading: new work goes into Project Goals and the interfaces every harness can reach.
[docs/pi.md](docs/pi.md) covers installation, the dashboard, the direct commands, Session Task storage, the model tool, and importing the application service from another extension.

## Development

```sh
git clone https://github.com/max-miller1204/stepstone.git
cd stepstone
npm install
npm run check
```

[docs/development.md](docs/development.md) covers the rest, including the generated files that must never be hand-edited.

## Formerly pi-worklist

stepstone was published as `pi-worklist` through 0.17.0, which is frozen and no longer updated.
Everything continues here, under a name that does not imply the tool only serves one coding agent.

## License

MIT
