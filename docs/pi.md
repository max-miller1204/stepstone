<!-- markdownlint-disable MD013 -->

# The Pi extension

Pi is one supported harness rather than the product.
Everything on the roadmap side works the same there as anywhere else, through the same application service, cross-process lock, and atomic replacement, so a Pi session and a CLI call may be open on one repository at the same time.

What Pi adds on top is Session Tasks: a branch-aware queue of the concrete chunks in the session at hand, kept separate from the roadmap because a session's next steps and a repository's outcomes are not the same thing.
Session Tasks are supported and documented, and they keep working; they are simply not where the project is heading, so new work goes into Project Goals and the interfaces every harness can reach.

## Install

```sh
pi install npm:stepstone
```

View it in the [Pi package gallery](https://pi.dev/packages/stepstone) or on [npm](https://www.npmjs.com/package/stepstone).

Install directly from GitHub:

```sh
pi install git:github.com/max-miller1204/stepstone
```

Try a checkout without installing it:

```sh
pi -e ./src/extension.ts
```

Every Pi peer dependency is declared optional, which is what lets the same package serve as a dependency-free CLI elsewhere.
How a release reaches npm and the gallery is in [docs/releasing.md](https://github.com/max-miller1204/stepstone/blob/main/docs/releasing.md).

## The dashboard

Run `/tasks` with no arguments to open the dashboard, a two-section view over Session Tasks and Project Goals.
Use Tab to switch lists, Up and Down or `j` and `k` to navigate, and Page Up and Page Down to move through a long list a screenful at a time, keeping one row of the previous screen for context.
The dashboard keeps the selected row in a terminal-height viewport, with counts for the rows above and below whenever the list continues off screen.
Press `f` to cycle the status filter: Session Tasks offer open, done, and all, while Project Goals offer open, done, archived, and all.

In Session Tasks, `a` appends, `i` inserts before the selected task, and Shift+Up or Shift+Down moves the selected task.
Project Goals support `a` to add and the same Shift+Up and Shift+Down to reorder, but not insertion at a position.
A goal moves within its own section, where a section boundary is an end of the list, and the move is written to the file exactly as the board writes it, so one keystroke means the same thing on both surfaces.
On a task or goal in either scope, press Enter to open a detail window, Space to advance status, `e` to edit, `d` to delete, and Escape to close.
Session Task edits change the title, while Project Goal edits can also change the description.

The Project Goals pane reads in the same visual language as the [terminal goal board](board.md), which owns what each treatment means: the active goal keeps its own marker and full contrast, settled goals recede, a goal that has gone stale carries its age, and a goal waiting on work that has not landed is marked blocked.
Goals are filed into headed sections by the rule the board's [sections](board.md#sections) describe, down to a roadmap where nothing is grouped staying a plain list.
Grouped roadmaps open with every section collapsed, just like the board.
Select a section header and press Space to toggle it, Right or Enter to open it, or Left to close it; Enter on an open section steps into its first goal, and Left on a goal inside a section closes that section and selects its header.
A `Goals:` line above the list reports per-status counts across the whole roadmap and says how many match whenever the current filter admits only some of them, counting the goals a collapsed section holds.
Below the list, Project Goals keep a row for the selected goal's description whenever any listed goal has one, so walking past a described goal never resizes the list, and a roadmap that describes nothing spends no row on it.

While the dashboard remains open, every action keeps the interaction state around it: the current list, the active filter, which sections are open, the selected row, and how far the list is scrolled, so a moved row stays selected at its new position and the rows around it hold their place on screen.
When an action leaves the selected row unlisted, by deleting it or by advancing it out of the current filter, the row that took its place is selected, including for a goal inside a section.
Adding an item is the one action that may change the filter or the open sections: when the active filter would hide what was just created, the filter relaxes to All, and the section holding a new goal opens, so the new row comes back on screen and selected rather than as a count that moved.
A new `/tasks` invocation starts again on the compact, collapsed roadmap shape.

The detail window wraps complete descriptions and the metadata it displays instead of truncating them.
Use Up and Down or `j` and `k` to scroll long details, with Page Up and Page Down for larger jumps, then Enter or Escape to return to the dashboard.
For a Project Goal it also spells out the goal's group, branch, dependencies with each target's own status marker and whether it is satisfied, the goals it blocks, its links, and when it was completed, omitting every row the goal has nothing to fill.
For a Session Task associated with a Project Goal, the detail window also shows the goal title, its group, and its full description.

The full-screen [terminal goal board](board.md) is a separate, roadmap-only view that runs outside any session; the dashboard is the one that shows both lists.

## The widget and the prompt

A compact widget marks the active Project Goal with the board's own active marker, reports the roadmap's per-status counts on a line of its own, and lists up to three unfinished Session Tasks, with a `+N more` line when the queue is longer.
It appears whenever the repository has any Project Goals, so a roadmap with no active goal and an empty task queue still reports its shape.
Only the active goal and an intentionally bounded list of incomplete task titles and statuses are added to the current turn's system prompt, preserving their relative queue order, so the session's state is present without the roadmap crowding the context.

## Direct commands

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

Text after `--` is stored as the optional Project Goal description for `add` and `update`.
Session Tasks do not support descriptions.
Session Task `add` accepts either `--before <anchor-id>` or `--after <anchor-id>` and appends when neither is supplied, while `move` requires exactly one of those stable-ID anchors.
An anchor flag and its ID may lead the arguments or trail them, but only one anchor flag is accepted per command.
Project Goal `move` takes the same anchors; Project Goals are appended on `add` and never accept a placement there.

Typing a Project Goal lifecycle command is explicit user intent.
The model-facing tool instead requires `confirm=true`, and its prompt rules prohibit setting that flag without an explicit request.

## The model tool

The `worklist` tool accepts `scope=session|project` and actions including `list`, `add`, `apply-plan`, `move`, `update`, `start`, `set_status`, `set_active`, `complete`, `reopen`, `archive`, and `delete`.
For Session Tasks, `add` optionally accepts exactly one of `beforeId` or `afterId`, while `move` requires exactly one.
Project Goal `move` takes the same anchors and reorders the roadmap; `add` and `update` also accept a `group`, where an empty string clears it, a `dependsOn` array that replaces the goal's edges, and a `links` array of absolute HTTP or HTTPS URLs that replaces its informational links.
Empty arrays clear dependencies or links.
Project Goal `start` is the dispatch claim: it takes exactly one of a `branch` naming what is working on the goal or `clear=true` releasing an abandoned claim, leaves the goal's status alone, and keeps a claimed goal out of the ready frontier until `start` with `clear` or `complete` releases it.
`update`, `start`, `set_active`, `complete`, `reopen`, `archive`, and `delete` also accept `expectedUpdatedAt`, the target goal's exact `updatedAt` from the caller's last read, so a claim or a lifecycle change sent from a stale read returns a typed conflict instead of overwriting a newer one; it is a concurrency precondition and never stands in for `confirm`.
Project Goal mutations return bounded details instead of the complete roadmap: single-goal mutations return `goal`, `delete` returns `deletedGoalId`, and `apply-plan` returns `addedGoals`. The `list` action remains the explicit full collection read.

Moves preserve the task ID, title, status, and Project Goal association.
Self-placement, already-satisfied placement, identical Session Task updates, and repeated status changes succeed without writing another session snapshot.

Session Tasks use concise, self-contained titles without descriptions.
Agents are instructed to split non-trivial work into several concrete, independently completable Session Tasks instead of copying the broad end goal into one task.
Session Task statuses are `todo`, `doing`, and `done`, while Project Goal statuses are `open`, `active`, `done`, and `archived`, and only activation is a non-destructive direct Project Goal status change.

The tool's prompt carries the brainstorm-to-approved-plan capture workflow for Project Goals, rendered from the same command contract as the CLI guide, the generated skill, and the AGENTS block, so the steps stay written once, in [docs/cli.md](cli.md#capture-brainstorms-as-approved-goal-plans).
On this surface the preview they allow is an `apply-plan` call with `dryRun=true`, which is never the user's approval, and an approved batch is applied by exactly one mutating `apply-plan` call rather than a sequence of `add` calls.

The tool's schema uses `StringEnum` for string enums, which keeps it compatible with Google providers.

## Session Task storage

Session Tasks are stored as versioned Pi custom entries in the current session tree, so they survive `/resume` and follow `/tree`, `/fork`, and `/clone`.
A new session starts with an empty Session Task list.
The array order is a canonical queue that supports stable-ID insertion and movement, and completed tasks remain in that order rather than being swept aside.

Each snapshot carries an opaque concurrency token that follows the active branch, and a branch without a snapshot uses the opaque baseline token `0`.
Snapshots written by earlier releases are still loaded, derive their token from the Pi custom entry ID when necessary, retain existing task IDs, and drop legacy descriptions and legacy orchestrator metadata during in-memory migration; the next mutation writes the migrated state as snapshot version 3.
Session Task expected-revision checks run inside the serialized mutation queue and return the active branch token in conflicts, and a semantic no-op leaves the snapshot count and branch token untouched.

Session Tasks are the one part of the tool that a CLI call cannot reach, because they live inside a session tree rather than in the repository; the CLI rejects `session` scope for that reason.
Project Goal storage is documented in [docs/storage.md](storage.md).

## Using the service from another extension

Another Pi extension can drive the same worklist without instantiating its own store or touching the file, by importing the application service through the package's subpath export:

```ts
import { WorklistApplicationService } from "stepstone/src/application-service.ts";
```

Every interface in this package goes through that one service, so an external caller applies identical validation, confirmation, locking, and persistence rules.
Each operation names its `source`, one of `tool`, `command`, `dashboard`, or `cli`, and returns a deterministic envelope: `ok`, the `result`, or a typed `error`, plus a `meta` reporting whether anything changed, whether the mutation was a semantic no-op, which fields moved as JSON Pointer paths, which entity IDs changed, and the resulting revisions.

Errors carry a stable code, `UNAVAILABLE`, `INVALID_REQUEST`, `VALIDATION_FAILED`, `NOT_FOUND`, `DEPENDENCY_CYCLE`, `APPROVAL_REQUIRED`, `CONFLICT`, or `PERSISTENCE_FAILED`, a `retryable` flag, and, for a conflict, details naming whether the file-wide revision or one goal's `updatedAt` moved.
Operations accept an `expectedRevision` and, for a single Project Goal, an `expectedUpdatedAt`, both checked under the same lock that writes, so a caller resuming from a stale read is told rather than allowed to overwrite newer state.
Project operations resolve the goal file through a resolver the host supplies rather than a path captured at startup, so a `migrate_path` elsewhere cannot leave a long-lived caller writing to a file that is no longer the roadmap.
Session Task operations need a session store and report `UNAVAILABLE` without one, which is what a non-Pi host gets.
