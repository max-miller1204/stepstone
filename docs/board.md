<!-- markdownlint-disable MD013 -->

# The terminal goal board

```sh
npx -y stepstone@latest project ui
```

The board is an interactive full-screen view over the same Project Goals, so the roadmap can be read and edited from a shell without starting any particular agent session.
It is for a human at the keyboard: it holds the terminal until they quit, requires a terminal and refuses to start without one, which keeps `list` and `--json` the read path for scripts and agents.

## Layout

The board is a split view: the goal list on the left, the selected goal's status, timestamps, identifier, and complete description on the right.
The detail pane also spells out a goal's group, branch, completion time, dependencies, dependents, and links when present, and omits empty rows entirely.
Each dependency is listed with the target's own status marker, so whether it is still in the way reads in the same visual language as the list.
Below about 76 columns the two panes stack instead, and the layout stays aligned for titles containing wide or combined characters.

## Order, filtering, and emphasis

`o` cycles the order through file, status, and recent, and the header names the current one.
File order is the default and is the roadmap's canonical order, so the board shows exactly what the file says and `K` and `J`, or Shift+Up and Shift+Down, rearrange it against the neighbouring visible row.
Reordering is refused outside file order, where the rows are not where the file puts them and a move would edit an arrangement the screen is not showing.
Status and recent are views over that same order, which stays their tiebreak, so an arrangement survives a trip through them.
Those two views lift the active goal above every other row and give it a marker of its own, so the work in flight is the first thing the list says.

The status line names the active goal in full in every order, which keeps it readable while the list is filtered to something else or scrolled past it.
When a repository holds two worklists, the warning about them stands above that line for as long as that stays true, because the board owns the whole screen and a warning printed before it opened sits on a buffer nobody can see.
It wraps on word boundaries across up to four rows of its own, because the file being ignored and the merge that resolves it both sit past one line's worth of an absolute path.
Those rows stay reserved while the condition holds, so a passing message takes the status line without clearing the warning off the screen and without shifting the list and detail panes; a terminal with no rows to spare falls back to the warning taking that line itself, truncated.

In the all view, done and archived rows recede so live work stays legible beside them, and a goal waiting on work that has not landed recedes in every view for the same reason; the selected row always keeps full contrast.
A goal still in play that has gone untouched for 30 days or more carries its age at the right edge of its row when at least 12 cells remain for the title, and the detail pane spells that age out under `UPDATED`.
Settled goals are never aged: a done or archived goal is finished rather than neglected.
The header shows per-status totals across the whole roadmap, so a filtered list still reports its overall shape; on narrow terminals, those counts yield first to the filter and shown-of-total labels.

## Key map

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

## Sharing the file

Every change routes through the same application service, cross-process lock, and atomic replacement as the CLI and every other interface, so another process may be open on the same repository at the same time.
The board reloads automatically when another process writes the file, and a low-frequency re-read keeps that true where filesystem watches cannot be created or silently drop events.
Every reload also asks again where the goal file is and retargets those watches when it moved, so a `migrate_path` run in another terminal leaves the board reading and writing the migrated file instead of the path it opened on.
The two-worklist warning is re-derived by the same reload, so it appears when a second worklist shows up while the board is open and clears once the files are merged.

Completing, reopening, archiving, and deleting each ask for confirmation first, and only an explicit `y` proceeds; that answer is the explicit user intent the application service requires.
The board is drawn with no runtime dependencies, so the compiled bin needs nothing installed but Node.
