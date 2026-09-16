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
7. Codex creates a fresh branch and workpad, then moves the issue to `In Progress`. Later turns continue that attempt without another reset.
8. Move the issue to `Merging` after approval.
9. Codex lands the pull request and moves the issue to `Done`.

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

Codex starts with only `HOME` and `PATH` from the host environment. Its shell
policy permits only those inherited variables. Login shells and shell snapshots
are disabled so they do not reload the host shell environment. Host tokens,
including `GH_TOKEN`, `NPM_TOKEN`, and AWS credentials, are not passed to Codex.

GitHub commands use the existing macOS Keychain login through `gh`. No GitHub
token is read from 1Password or added to the agent environment. Verify access
without environment tokens:

```sh
env -i HOME="$HOME" PATH="$PATH" gh auth status
env -i HOME="$HOME" PATH="$PATH" gh api user --jq 'has("login")'
```

The first command must report an active keyring login. The second must print
`true`. Git HTTPS operations use the existing `osxkeychain` credential helper.
Verify it with `git config --get-all credential.helper`. Stop if authentication
fails; do not inject another token. Record a concise blocker brief in the issue
workpad and move the issue to `Human Review`. Include the missing access, its
impact, and the action needed to restore it. `HOME` preserves the local Codex login and GitHub CLI
configuration. `PATH` locates the installed tools.

This environment policy prevents inherited-token exposure. It does not isolate
host files or deny access to the user's Keychain.

Codex runs with `danger-full-access`. The narrower `workspace-write` sandbox
blocks writes to `.git`, which prevents fetch, branch, commit, and push
operations. Unrestricted access lets the agent complete the Git workflow. It
also lets agent commands read or change any file available to the current user.
Run Symphony only for trusted repositories and issues.

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
Codex also uses this state for verified access blockers or missing required
product decisions. The workpad must contain a concise blocker brief with the
exact action or decision needed. Record a missing decision before returning
the issue to an active state.

Move the issue to one of these states:

- `Rework` to start a clean implementation attempt. Codex resets the branch and workpad once, then moves the issue to `In Progress`.
- `Merging` to authorize the agent to land the pull request.

Do not move an issue directly to `Done`. The workflow uses a confirmed GitHub
merge as the completion gate.

## Missing Linear access

If neither Linear MCP nor the injected `linear_graphql` tool is available,
Codex stops without trying to change Linear. Its final session output reports
the issue identifier, missing access, and unchanged issue state. No workpad
update or state transition is possible through the agent in this case.

The operator must pause Symphony and move the issue to `Human Review` until
Linear access returns. Restore access before resuming the service and returning
the issue to an active state. Do not give the agent a raw Linear token.
