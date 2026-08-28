# Prepare approved goal workspaces

`stepstone-dispatch` prepares isolated workspaces for an explicitly approved set of Project Goals. It claims each goal on the canonical roadmap, persists enough workspace custody to resume after interruption, and can complete a goal only after finding a matching merged pull request.

It does **not** run an agent harness. It never starts a process or pane, submits a prompt, chooses an agent kind, or supervises a session. After preparation, a human or a root agent opens the reported workspace using whichever terminal and coding harness they prefer. The workspace already contains its goal in `STEPSTONE_GOAL.md`; no prompt transport is needed.

## Start a preparation run

Run the driver from the repository's main worktree:

```sh
npx -y -p stepstone@latest stepstone-dispatch start \
  --goal first-approved-goal \
  --goal second-approved-goal \
  --max-parallel 2 \
  --json
```

Repeated `--goal` values are the immutable authorization allow-list. The driver still reads a fresh `project ready` frontier before every preparation pass, so an allow-listed goal is prepared only when its dependencies have landed and no other claim exists.

`--max-parallel` is the maximum number of goals the run may keep claimed and prepared at once. It does not describe running agents: Stepstone starts none. The default is 1.

A successful entry reports:

- `phase: "prepared"`
- the deterministic `stepstone/<goal-id>` branch
- the exact claim token in `claimUpdatedAt`
- the absolute workspace path
- `goalFile`, the absolute path to the workspace's `STEPSTONE_GOAL.md` handoff
- a message confirming where the goal was written and that no agent was launched or prompted

The run must start in the main worktree because it is the sole roadmap writer. Work performed in a prepared checkout must not edit `.worklist/worklist.json` or run roadmap mutations from that checkout.

## Goal handoff file

Every newly prepared workspace has `STEPSTONE_GOAL.md` at its root. Read it before starting work. It records:

- the goal ID, title, description, group, and snapshot timestamp;
- the exact prepared branch;
- dependencies and informational links; and
- the rule that canonical roadmap mutations belong in the main worktree.

The handoff is local preparation state, not repository content. Stepstone adds the root path to the repository's local Git exclude file, creates the handoff without overwriting an existing path, verifies that Git ignores it, and reports its absolute path. It therefore remains visible to a person or agent opening the workspace without making `git status` dirty or leaking into a commit. Cleanup removes it with the workspace.

The goal snapshot is written before the canonical claim. If writing or ignoring the handoff cannot be proven, preparation does not claim the goal and preserves the workspace as an ambiguous acquisition for inspection rather than handing out context it cannot verify.

## Git workspaces

Preparation needs no tool beyond Git:

```sh
npx -y -p stepstone@latest stepstone-dispatch start \
  --goal approved-goal \
  --workspace-parent /absolute/workspace/parent \
  --json
```

Without `--workspace-parent`, the checkout is created beside the repository as `stepstone-<goal-id>`. The driver creates `stepstone/<goal-id>` from the run's recorded target revision and authenticates the exact worktree and Git administrative directory before claiming the goal. There is no provider or harness selector.

## Open the workspace yourself

Read the workspace and `goalFile` paths from the JSON result, then enter or open the checkout through your normal environment. For example:

```sh
cd /path/reported/in/result
cat STEPSTONE_GOAL.md
```

What happens next is outside Stepstone. A terminal, editor, multiplexer, or coding harness may use the checkout and read the handoff, but no harness command or prompt is part of the dispatch configuration or persisted run state.

## Resume and completion

Runtime state is stored under the repository's Git common directory at `stepstone-dispatch/<run-id>.json`. It is outside the canonical roadmap and shared by the main checkout across restarts.

Resume after a restart or after prepared work lands:

```sh
npx -y -p stepstone@latest stepstone-dispatch resume <run-id> --json
```

A resume pass:

1. reconciles interrupted workspace and claim mutations;
2. verifies every persisted workspace it still owns;
3. asks GitHub for a merged pull request whose head is the exact claimed branch, whose base is the run's target branch, and whose creation and merge both postdate the claim;
4. fast-forwards the target to that merge commit;
5. completes the exact claimed goal under the approved run's standing consent;
6. cleans the completed workspace; and
7. prepares newly ready allow-listed goals until the persisted preparation limit is full.

A closed terminal, an exited agent, silence, or an unmerged pull request is never completion evidence. Stepstone has no session liveness to inspect.

## Status and inspection

These actions only read persisted state:

```sh
npx -y -p stepstone@latest stepstone-dispatch status --json
npx -y -p stepstone@latest stepstone-dispatch status <run-id> --json
npx -y -p stepstone@latest stepstone-dispatch inspect <run-id> <goal-id> --json
```

`status` summarizes paths and phases. `inspect` includes the complete persisted goal and workspace custody record.

## Recovery

An interrupted workspace acquisition, claim mutation, merge inspection, completion, release, or cleanup can leave an entry `ambiguous`. Ambiguity preserves the claim and workspace rather than guessing that custody is safe to discard.

After inspection, explicitly release an abandoned prepared claim:

```sh
npx -y -p stepstone@latest stepstone-dispatch recover <run-id> <goal-id> --release --json
```

If a claim reached the roadmap but its response was lost before the exact token was journaled, supply the `updatedAt` verified from the current claimed goal:

```sh
npx -y -p stepstone@latest stepstone-dispatch recover <run-id> <goal-id> \
  --release \
  --claim-updated-at <timestamp> \
  --json
```

Recovery never checks or terminates a process or pane. Stepstone did not start one and carries no launch identity. Releasing is therefore an operator decision about the canonical claim and owned workspace, not a claim that a hosted session was closed.

A journaled completion outcome cannot be released through recovery. Use `resume` so the exact merged result is reconciled instead.

## Cleanup

Completed or exactly released entries are cleaned automatically. Retry a pending cleanup with:

```sh
npx -y -p stepstone@latest stepstone-dispatch cleanup <run-id> [goal-id] --json
```

Without a goal ID, cleanup processes all eligible entries and removes the run record after every entry is `cleaned`. It refuses while an entry still owns a prepared claim.

Workspace cleanup is identity guarded:

- Git worktrees must still match the recorded repository, path, branch, Git directory, and ownership marker.
- Branch deletion uses the exact journaled ref value so a reused branch name cannot be deleted accidentally.
- A failed cleanup remains `cleanup-pending` and retains its workspace record for retry.

## State compatibility

Preparation-only runs use dispatch state version 2. The goal-file receipt is an additive optional field so a version 2 run created before handoffs existed remains readable; `resume` writes and journals the missing handoff before it next reconciles that prepared workspace.

Version 1 belonged to the removed session-hosting driver and may contain live process or pane custody. Current Stepstone refuses that state rather than silently dropping launch metadata or attempting to control somebody else's session. Inspect or recover a version 1 run with the Stepstone release that created it before upgrading.
