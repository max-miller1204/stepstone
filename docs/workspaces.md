# Migrate from workspace management

Stepstone now tracks Project Goals. It no longer prepares or manages workspaces.
This is a breaking CLI change.

The following interfaces have been removed:

- `project workspace` and all of its actions: `start`, `resume`, `status`, `inspect`, `recover`, and `cleanup`.
- `project start --worktree` and `--workspace-parent`.
- Workspace flags: `--goal`, `--max-parallel`, `--stale-after-hours`, `--release`, `--claim-updated-at`, and `--force`.
- Dispatch runs, custody tracking, local activity inspection, handoff generation, recovery, cleanup, and automatic merged-PR reconciliation.

Removed commands and flags fail with a usage error. Replace scripts that call them with Git or external workspace tools. The browser has no dispatch controls or endpoints.

## Preserved resources

Upgrading leaves existing branches, worktrees, handoff files, ownership markers, and dispatch journals untouched. Stepstone does not read, migrate, resume, or clean these resources.
Goal IDs, historical IDs, branch claims, dependencies, readiness, and recorded pull request links remain available.

Old worktrees can contain `STEPSTONE_GOAL.md` and ignored handoff backing files. Ownership markers use the name `stepstone-dispatch-owner.json`. Dispatch journals remain under `<git-common-dir>/stepstone-dispatch/`. Keep these records until you have inspected the resources they describe.

## Inspect with Git

Run these commands from the repository:

```sh
git worktree list --porcelain
git branch --all --verbose
git rev-parse --path-format=absolute --git-common-dir
```

For each worktree that you want to inspect, use its reported path:

```sh
git -C /absolute/worktree/path status --short --untracked-files=all
git -C /absolute/worktree/path status --short --ignored
git -C /absolute/worktree/path log --oneline --decorate -10
git -C /absolute/worktree/path reflog -10
```

Read existing handoff files and journals with your file viewer. Use Git, your editor, or an external workspace tool to create, open, move, or remove worktrees and branches. Stepstone no longer verifies ownership or cleanup safety for these operations.

## Continue tracking

Record a branch claim from the main worktree after you create the branch with your chosen tool:

```sh
npx -y stepstone@latest project start <id> --branch <branch-name>
npx -y stepstone@latest project show <id> --json
```

An existing claim needs no migration or new claim. `project start <id> --clear` explicitly releases its branch claim without changing Git resources.

A merged pull request does not complete a goal or authorize completion. An approved dispatch plan no longer provides standing consent. Complete a goal only after explicit authorization for that goal through the CLI or API:

```sh
npx -y stepstone@latest project complete <id> --confirm
```

The application service requires explicit confirmation for lifecycle changes. Read [the CLI reference](cli.md) for optimistic checks and other lifecycle commands.
