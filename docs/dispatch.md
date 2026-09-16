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

Each `start` and `resume` result includes a `pass` summary. It reports one of these outcomes:

- `no-ready-work` when no allow-listed goal can start;
- `capacity-full` when prepared custody fills the configured limit;
- `prepared` when every attempted goal was prepared;
- `refused` when no attempted goal was prepared; or
- `mixed` when a pass prepared some goals and refused others.

The summary also lists the attempted, prepared, and refused goal IDs. An empty ready frontier is a successful `no-ready-work` pass. A refused preparation is a successful state-machine pass with a durable refused entry. These results are distinct in JSON and human-readable output.

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

The handoff is local preparation state, not repository content. Stepstone first journals a deterministic SHA-256 content receipt in `pending` state, then records a unique ownership ID and the filesystem identity of an exclusively created ignored backing entry before creating the public path as an exclusive hard link. Once the exact identity and bytes are verified, the receipt becomes `written`. Resume repeats those checks; it leaves any conflicting file or symlink untouched and refuses to claim the goal. An exact byte-identical ignored regular file can be adopted into the same ownership protocol without overwriting it. Earlier version-2 written receipts are adopted only after the same no-overwrite content check. A legacy pending receipt with an ownership-derived backing but no persisted backing identity remains ambiguous because its creator cannot be proven. Stepstone verifies that Git ignores all handoff state and reports the public file's absolute path, so it remains visible without making `git status` dirty or leaking into a commit. Cleanup removes it with the workspace.

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

A refused preparation stores its first boundary failure in `preparationFailure`. This record includes the stage, classification, message, and time. A typed roadmap failure also keeps its code, retryability, conflict, and details. The entry `message` continues to report the latest lifecycle state. Release and cleanup can replace that message, but they do not replace the original preparation failure. Read both fields through `status --json` or `inspect --json` after recovery.

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

Completed or exactly released entries are cleaned automatically only when Git safety checks pass. Retry a pending cleanup with:

```sh
npx -y -p stepstone@latest stepstone-dispatch cleanup <run-id> [goal-id] --json
```

Without a goal ID, cleanup processes all eligible entries and removes the run record after every entry is `cleaned`. It refuses while an entry still owns a prepared claim.

Before deleting a workspace or its branch, cleanup verifies:

- There are no staged, unstaged, untracked, or ignored changes. Only the unchanged goal handoff and backing file authenticated by the run's receipt are exempt. Submodule changes, in-progress Git operations, and index flags that hide changes also prevent cleanup.
- Every commit beyond the workspace's acquisition base is reachable from refreshed remote refs. Failed remote inspection refuses cleanup. An unchanged workspace needs no remote because it contains no new commits.
- The workspace tip is an ancestor of the run's named target branch in the canonical repository. A missing target or an unmerged tip refuses cleanup. Squash or rebase merges that do not preserve this ancestry require explicit override after inspection.

Cleanup preserves these identity guards even under override:

- Git worktrees must still match the recorded repository, path, branch, Git directory, and ownership marker.
- Branch deletion uses the exact journaled ref value so a reused branch name cannot be deleted accidentally.
- A failed cleanup remains `cleanup-pending` and retains its workspace record for retry.

Read the exact refusal reason in the entry's `message` through `cleanup`, `status`, or `inspect` (including `--json`). Cleanup never resets or scrubs changes to make a safety check pass. Interrupted cleanup retains the exact commit in detached HEAD and rechecks Git safety on retry.

To intentionally discard an inspected workspace's uncommitted, unpushed, or unmerged work, explicitly name the goal and pass `--force`:

```sh
npx -y -p stepstone@latest stepstone-dispatch cleanup <run-id> <goal-id> --force --json
```

This override applies only to that invocation and goal. It is not accepted by `recover` or `resume`, cannot bypass a prepared claim or workspace identity checks, and is never persisted for an automatic retry. Successful forced cleanup records the override in the entry's message.

## State compatibility

Preparation-only runs use dispatch state version 2. The goal-file receipt is an additive optional field so a version 2 run created before handoffs existed remains readable; `resume` writes and journals the missing handoff before inspecting merge evidence or making another canonical roadmap mutation for that prepared workspace.

Version 1 belonged to the removed session-hosting driver and may contain live process or pane custody. Current Stepstone refuses that state rather than silently dropping launch metadata or attempting to control somebody else's session. Inspect or recover a version 1 run with the Stepstone release that created it before upgrading.
