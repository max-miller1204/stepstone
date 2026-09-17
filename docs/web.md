# Local web application

Run the local web application from the repository's main worktree:

```sh
npx -y stepstone@latest project web
```

Stepstone opens the application in your default browser. Use `--no-open` to print the URL without opening a browser. Use `--port <number>` to select a loopback port. Port `0` selects an available port.

The roadmap opens as a Kanban board of unfinished goals, with Ready, In progress, and Blocked columns. The status filter also exposes Completed and Archived columns. Counts summarize the full roadmap, while search and filters narrow the cards. Expand a card’s description to read its details. On small screens, scroll horizontally between columns. Active and claimed goals appear in In progress. Workspace run activity appears below the board, and claimed cards link to their run. The header identifies the repository and roadmap revision. Use Refresh to read changes made by another agent or terminal.

Choose **Prepare workspaces** above the board to open the guided preparation dialog. Select ready goals for immediate preparation, or expand **Include goals for later** to approve blocked goals. Set the maximum number of prepared workspaces for this run, then review the selected titles and how many can be prepared now. Extra or blocked goals wait for a later **Continue run**. Preparation creates and claims a branch and working folder for each ready goal; open that folder in your coding agent to begin. Selections persist while searching or filtering the board, and unavailable goals are removed from the selection on refresh.

The application provides these local workflows:

- View, filter, and search the roadmap.
- Create and edit goals.
- Set sections, links, and dependencies.
- Change the canonical goal order.
- Complete, reopen, archive, or delete a goal after confirmation.
- Release workspace custody or reconcile the run before editing or settling its goal. Goal ordering remains available while the run holds custody.
- View ready, blocked, active, claimed, and settled goals.
- Approve ready goals for immediate workspace preparation.
- Include blocked goals in the approved run. Continue the run after their dependencies settle.
- Copy shell-quoted `cd` commands for prepared workspaces.
- Continue an approved run after dependencies land.
- Reconcile merged pull requests through the existing workspace driver.
- Read the claim assessment, canonical state, and workspace activity before release. Explicitly acknowledge the evidence to release the claim.
- Use CLI inspection and recovery when browser evidence is unavailable. Retry safe cleanup after inspection.

The maximum number of prepared workspaces is 1024. Invalid limits receive a validation error before a run is created.

The advanced CLI remains available for scripts, agents, migrations, forced cleanup, and detailed workspace inspection.

## Security boundary

The server binds only to `127.0.0.1`. It checks the HTTP `Host` header on every request. Each server process creates a random mutation token and puts it in the served page. A mutation must provide this token in a request header and must provide the exact same-origin `Origin` header.

The server accepts bounded JSON request bodies. Browser code does not read or write the goal file. Goal mutations use `WorklistApplicationService`, the cross-process lock, and atomic file replacement. Workspace actions use `DispatchDriver` and its ownership checks. Web and CLI workspace actions share a repository reservation lock. The web application also uses this lock to protect goal edits from active workspace custody.

Run the application only from the main worktree. The web application rejects `--file` and non-empty `STEPSTONE_WORKLIST` overrides. Unset `STEPSTONE_WORKLIST` before starting. The page and persisted workspace runs must use the same canonical repository roadmap. This rule keeps the committed roadmap on its canonical branch. Prepared linked worktrees remain read-only for roadmap mutations.

Stepstone does not expose the server on the network. It does not start agents. It does not create or merge pull requests.
