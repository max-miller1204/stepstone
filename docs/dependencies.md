<!-- markdownlint-disable MD013 -->

# Dependencies and sequencing

A goal may record the goals that must land before it, and everything about what to start next is derived from those edges.

```sh
npx -y stepstone@latest project add Add the dependency graph \
  --depends-on slug-ids --depends-on schema-fields
npx -y stepstone@latest project update <id> --depends-on <other-id>
npx -y stepstone@latest project update <id> --depends-on ''
```

An `update` replaces the whole set rather than adding to it, so name every edge the goal should end up with, not just the new one.

## What an edge means

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

## Validation

Edges are validated under the same lock that writes them.
On update, a depth-first check from the changed goal refuses anything that would close a cycle, including an existing goal that depends on itself, and reports every goal on the loop; the failure carries the `DEPENDENCY_CYCLE` error code.
On add, dependency IDs resolve before the new goal's ID is minted, so an edge naming a guessed future slug is refused with `NOT_FOUND`; read the ID back from `add` rather than deriving it from the title.

An edge naming no goal is refused, an edge is stored under its target's current ID whatever name the caller used, and deleting a goal drops the edges naming it inside the same atomic change so a dangling edge never reaches the file.
An ID migration rewrites stored edges too, because a former ID would still resolve but would leave the file disagreeing with itself.

## File order is not the graph

File order and the dependency graph answer two different questions and are allowed to disagree.
File order is presentation and a tiebreak, arranged by whoever cares how the roadmap reads; the graph is the source of truth for what may start.

Neither should be edited to mirror the other.
Re-sorting the file to match the edges throws away an arrangement someone chose, and adding an edge to justify the file's order records a constraint that does not exist.

## Sequencing reads

Three read commands answer what to work on, over the same edges everything else derives `blocked` from:

```sh
npx -y stepstone@latest project next
npx -y stepstone@latest project ready
npx -y stepstone@latest project waves
```

`ready` is the parallel frontier: every open goal whose dependencies have all landed and that nobody has claimed, in canonical file order.
`next` is the first entry of `ready`, by definition rather than by a second calculation, so a driver taking one goal and a human reading the whole frontier can never be told two different things.

A goal is claimed when it is `active` or carries a `branch`.
Both are dedicated fields somebody set deliberately, never a heuristic over prose, and a claimed goal is left out of `ready` because handing the same work to a second driver is the one mistake a dispatch read exists to prevent.

`waves` lays the unfinished goals out in the earliest layer each could start in.
Wave 1 is everything unblocked today, and each later wave is exactly what the wave before it releases, so the layers read as a schedule: how much can run in parallel, and what finishing this round opens up.
A wave shows the shape of the remaining work rather than what is free to pick up, so a claimed goal keeps its place in the layers and is marked with the branch that took it; the frontier is wave 1 with those removed.
A goal waiting on a hand-edited cycle, or on an edge that names no goal, can never be released by any wave and is reported as unreachable rather than dropped, because a goal missing from the schedule is a goal nobody notices is stuck.

With `--json`, `waves` reports the layers as `result.waves`, an array of goal arrays whose position is the wave number, and adds `result.unreachableGoals` only when some goal is unreachable, so an absent field means every unfinished goal found a layer.

An empty frontier exits 0 and says which kind of empty it is: an empty roadmap, a finished one, or one where everything left is blocked or already claimed.
Nothing to start is an answer rather than a failure, so read `result.goal` or `result.goals` from `--json` instead of the exit code.

Nothing here is cached, because all three are derived from the stored edges the same way `blocked` is; no command has to be re-run to refresh them.
