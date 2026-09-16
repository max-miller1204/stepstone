# Run Stepstone work through Symphony

Symphony watches the Stepstone project in Linear and runs Codex in one isolated
workspace for each eligible issue.

## Linear workflow

Use these issue states:

1. Keep unapproved work in `Backlog`.
2. Move approved work to `Todo`.
3. Symphony starts the issue and Codex moves it to `In Progress`.
4. Codex implements the issue, validates it, and opens a pull request.
5. Codex moves the issue to `Human Review` after all local and remote checks
   pass.
6. Move the issue to `Rework` when the implementation needs a new attempt.
7. Move the issue to `Merging` after approval.
8. Codex lands the pull request and moves the issue to `Done`.

A `Todo` issue does not start until each Linear `blockedBy` issue reaches a
terminal state.

The configured Linear project is:

```text
https://linear.app/stepstone-project/project/stepstone-4cab340c3aca
```

## Start the service

Authenticate the 1Password CLI, then run:

```sh
./scripts/run-symphony.sh
```

Open the dashboard at:

```text
http://localhost:4000
```

The launcher reads `LINEAR_API_KEY` from the `Linear - Stepstone Symphony` item
in the Personal vault. It does not write the credential to the repository.

Symphony stores workspaces in:

```text
~/.local/share/symphony/stepstone/workspaces
```

Symphony stores logs in:

```text
~/.local/state/symphony/stepstone/logs
```

## Create work

Create the issue in the Stepstone Linear project. Include these sections when
they apply:

- Acceptance criteria
- Validation
- Test plan

Add Linear blocker relations before moving the issue to `Todo`. Symphony uses
those relations to delay blocked work.

Start with one issue at a time. `WORKFLOW.md` sets
`agent.max_concurrent_agents` to `1`.

## Human review

`Human Review` is not an active Symphony state. Symphony pauses work there.
Move the issue to one of these states:

- `Rework` to start a clean implementation attempt.
- `Merging` to authorize the agent to land the pull request.

Do not move an issue directly to `Done`. The workflow uses a confirmed GitHub
merge as the completion gate.
