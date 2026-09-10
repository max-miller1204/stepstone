<!-- markdownlint-disable MD013 -->

# How Stepstone works

A Project Goal is a broad outcome with a title, an optional description, a status, and a slug ID.
Stepstone derives the ID from the title and then freezes it.
A reference in a commit message or pull request stays valid after a rename.

Statuses are `open`, `active`, `done`, and `archived`.
At most one goal is active.
The `set_active` action demotes the previous active goal.
Completing, reopening, archiving, or deleting a goal always requires explicit user intent from a `--confirm` flag or a keystroke that a person pressed.

Dependency edges state which goals must land first.
Stepstone derives blocked state from those edges on every read instead of storing it.
This prevents stale blocked state after the required work is complete.
The `ready` command returns the parallel frontier.
The `next` command returns its first goal.
The `waves` command puts unfinished goals in the earliest layer where each goal can start.

Every interface writes through one application service, one cross-process lock, and one atomic file replacement.
A CLI call, an open board, and a live Pi session can share a repository without corrupting the file or losing an edit.
Optional preconditions use a file-wide revision or one goal's `updatedAt` value.
They report a stale read as a conflict instead of silently overwriting newer work.

The published executable graphs do not import a Pi package at runtime.
The CLI and workspace-preparation driver therefore run without Pi installed.
A prepared checkout carries its goal in an ignored root `STEPSTONE_GOAL.md` file.
This lets a person or harness continue the work without Stepstone launching it or transporting a prompt.
Source-level import scans and a CI job enforce this rule by installing the packed package and running every executable without Pi.

See [goals.md](goals.md) for the goal model.
See [dependencies.md](dependencies.md) for dependency sequencing.
See [storage.md](storage.md) for persistence and concurrency.
See [dispatch.md](dispatch.md) for prepared workspaces.
