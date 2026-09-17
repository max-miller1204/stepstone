# Local web application

Run the local web application from the repository's main worktree:

```sh
npx -y stepstone@latest project web
```

Stepstone opens the application in your default browser. Use `--no-open` to print the URL without opening a browser. Use `--port <number>` to select a loopback port. Port `0` selects an available port.

The application provides these local workflows:

- View, filter, and search the roadmap.
- Create and edit goals.
- Set sections, links, and dependencies.
- Change the canonical goal order.
- Complete, reopen, archive, or delete a goal after confirmation.
- View ready, blocked, active, claimed, and settled goals.
- Approve ready goals for workspace preparation.
- Copy shell-quoted `cd` commands for prepared workspaces.
- Continue an approved run after dependencies land.
- Reconcile merged pull requests through the existing workspace driver.
- Release inspected claims and retry safe cleanup.

The advanced CLI remains available for scripts, agents, migrations, forced cleanup, and detailed workspace inspection.

## Security boundary

The server binds only to `127.0.0.1`. It checks the HTTP `Host` header on every request. Each server process creates a random mutation token and puts it in the served page. A mutation must provide this token in a request header and must provide the exact same-origin `Origin` header.

The server accepts bounded JSON request bodies. Browser code does not read or write the goal file. Goal mutations use `WorklistApplicationService`, the cross-process lock, and atomic file replacement. Workspace actions use `DispatchDriver` and its ownership checks.

Run the application only from the main worktree. The web application rejects `--file` and non-empty `STEPSTONE_WORKLIST` overrides. Unset `STEPSTONE_WORKLIST` before starting. The page and persisted workspace runs must use the same canonical repository roadmap. This rule keeps the committed roadmap on its canonical branch. Prepared linked worktrees remain read-only for roadmap mutations.

Stepstone does not expose the server on the network. It does not start agents. It does not create or merge pull requests.
