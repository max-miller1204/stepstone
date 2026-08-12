<!-- markdownlint-disable MD013 -->

# Dispatching an approved plan

A root session can fan out an explicitly approved Project Goal plan without making Stepstone depend on an agent harness, terminal multiplexer, or worktree manager.

The root session owns the roadmap.
Workers own implementation branches and PRs.

## Dispatch contract

1. Apply the exact approved plan once.
2. Read `project ready --json` from the default-branch checkout.
3. For each selected goal, create or acquire an isolated checkout and choose its branch name.
4. Claim the goal before launching work:

```sh
npx -y stepstone@latest project start "$goal_id" \
  --branch "$branch" \
  --expect-updated-at "$updated_at"
```

5. Launch the configured agent command in that checkout with the full goal as its prompt.
6. Observe the worker, but treat only a merged PR from the claimed branch as completion evidence.
7. Pull the default branch, re-read the goal, then complete it from the root checkout.
   The claim in step 4 stored the branch on the goal and bumped its `updatedAt`, so the value read in step 2 is already spent; reusing it fails the completion with exit code 4.

```sh
updated_at=$(npx -y stepstone@latest project show "$goal_id" --json | jq -r '.result.goal.updatedAt')
npx -y stepstone@latest project complete "$goal_id" \
  --expect-updated-at "$updated_at" \
  --confirm
```

8. Release the workspace and read `ready --json` again.
9. Stop when `ready` is empty.
Read `waves --json` to distinguish a finished roadmap from goals that are blocked or already claimed.

The snippets below read envelopes with `jq`, but any JSON reader works: every value they take comes from a documented `result` field.

`--max-parallel N` is a driver policy, not stored roadmap state.
Dispatch at most `N` entries from each ready result.
With `--max-parallel 1`, the same loop is a serial auto-chain.

## Authorization boundary

Explicit approval of a plan plus an explicit request to run its dispatch loop grants standing consent to complete a goal from that plan only after the goal's matching PR merges.
This is the narrow exception to the normal rule that an agent must ask immediately before passing `--confirm`.

Standing consent does not authorize completion based on worker exit, a green unmerged PR, or session silence.
It does not authorize `archive`, `delete`, `reopen`, a goal outside the approved plan, or a later plan.
If a worker is abandoned or its PR closes without merging, release the claim without completing the goal:

```sh
npx -y stepstone@latest project start "$goal_id" --clear
```

## Binding A: Git worktrees and detached processes

This baseline needs Git, a shell, and the configured agent executable.
The root session remains in the default-branch checkout.

Create the isolated workspace and branch:

```sh
branch="stepstone/$goal_id"
workspace="../stepstone-$goal_id"
git worktree add -b "$branch" "$workspace" HEAD || exit 1
```

This runs before the claim, so a failure here has nothing to release.
It fails when an earlier attempt on the same goal left `stepstone/$goal_id` behind, which is deliberate: resolve that branch before dispatching the goal again.

Claim the goal from the root checkout, and launch only if the claim succeeded.
A failed claim means another driver holds the goal, so the workspace is discarded rather than staffed:

```sh
if ! npx -y stepstone@latest project start "$goal_id" \
  --branch "$branch" \
  --expect-updated-at "$updated_at"
then
  git worktree remove "$workspace"
  git branch -D "$branch"
  exit 1
fi

abandon() {
  npx -y stepstone@latest project start "$goal_id" --clear
  git worktree remove "$workspace"
  git branch -D "$branch"
  exit 1
}

runtime="${XDG_STATE_HOME:-$HOME/.local/state}/stepstone/dispatch/$goal_id"
mkdir -p "$runtime" || abandon
(
  cd "$workspace" || exit 1
  nohup sh -c 'exec "$@"' sh "$AGENT_COMMAND" "$goal_prompt" \
    >"$runtime/agent.log" 2>&1 </dev/null &
  echo $! >"$runtime/agent.pid"
) || abandon
```

The subshell's `exit` only leaves the subshell, so the launch is gated on the subshell's status from outside it; a guard that returned no status to the parent could not release anything.
`mkdir -p` is checked for the same reason: the redirect that captures the worker's output fails when the runtime directory is missing, and an unchecked failure there leaves the goal claimed with nobody working it.
Because that check runs first, the only failure left inside the subshell is the `cd`, which happens before anything launches.

The log and pid file belong to the driver, not to the branch under review.
Keeping them outside `$workspace` leaves the worker's checkout clean, so an agent that stages everything cannot commit its own transcript into the PR and the worktree stays removable.

`AGENT_COMMAND` is configuration.
It may name Pi, Claude Code, Codex, Cursor, or another CLI.
The dispatch contract does not parse its output or infer completion from its process state.

After the PR merges and the goal is completed on the default branch, remove the worktree:

```sh
git worktree remove "$workspace"
```

That removal refuses to discard a checkout holding modified or untracked files.
When the worker left build artifacts behind and its branch is already merged, re-run it with `--force`.

If the run is abandoned, release the Stepstone claim before removing the worktree.

## Binding B: Herdr panes and Treehouse leases

This binding uses Treehouse only for workspace isolation and Herdr only for session hosting.
Neither tool owns roadmap state.

Acquire a durable workspace lease, and choose the branch name here rather than reading it back from the leased checkout.
A pooled worktree can arrive on a detached HEAD, where `git branch --show-current` prints nothing and the claim below is rejected for a missing branch:

```sh
lease_holder="stepstone:$goal_id"
branch="stepstone/$goal_id"
base=$(git rev-parse HEAD)
workspace=$(treehouse get --lease --lease-holder "$lease_holder")
```

Claim the goal from the root checkout, returning the lease if another driver claimed it first.
Every step between a successful claim and a running worker can still fail, and each one leaves the goal claimed with nobody working it, so they share one release path:

```sh
if ! npx -y stepstone@latest project start "$goal_id" \
  --branch "$branch" \
  --expect-updated-at "$updated_at"
then
  treehouse return "$workspace" --if-lease-holder "$lease_holder"
  exit 1
fi

abandon() {
  npx -y stepstone@latest project start "$goal_id" --clear
  treehouse return "$workspace" --if-lease-holder "$lease_holder"
  exit 1
}

git -C "$workspace" checkout -b "$branch" "$base" || abandon
pane_id=$(herdr pane split --current --direction right --cwd "$workspace" --no-focus \
  | jq -r '.result.pane.pane_id')
case "$pane_id" in "" | null) abandon ;; esac
agent_name=$(printf 'ss-%.18s-%s' "$goal_id" "$(printf %s "$goal_id" | cksum | cut -d' ' -f1)")
herdr agent start "$agent_name" --kind "$HERDR_AGENT_KIND" --pane "$pane_id" || abandon
herdr agent prompt "$pane_id" "$goal_prompt" --wait || abandon
```

Herdr answers over its socket API in a JSON envelope, so the pane ID is read out of `.result.pane.pane_id`; passing the whole response to `--pane` starts nothing.
A failed `pane split` writes its error to stderr and exits 1, but the pipeline reports `jq`'s status rather than Herdr's, and `jq` succeeds with empty output; the pane ID is therefore checked for a value rather than the pipeline for a status.

Herdr requires an agent name matching `[a-z][a-z0-9_-]{0,31}` and unique among live agents, so the goal ID cannot be the name: most IDs on a real roadmap exceed the 32 characters, and `agent start` would fail every dispatch.
The derived name keeps a readable prefix of the ID inside that limit and appends a checksum of the full ID, which stays unique where truncation alone would collide.
Once the agent is running, Herdr accepts the hosting pane ID wherever it accepts a name, so the calls after `agent start` target `$pane_id` and never depend on that derivation.

`stepstone/$goal_id` is deterministic, and neither `start --clear` nor returning a lease deletes a branch, so re-dispatching a goal whose earlier attempt still has its branch fails at `checkout -b`.
That failure releases the claim and the lease instead of running the worker on whatever ref the pool handed out, whose PR head would never match the branch stored on the goal.
Delete or rename the stale branch deliberately, once you know whether its commits are still wanted.

Use `herdr agent wait "$pane_id"` and `herdr agent read "$pane_id"` for liveness and diagnostics.
Those signals never replace merged-PR evidence.

After merge and completion, close or reuse the pane according to local Herdr policy, then return the lease safely:

```sh
treehouse return "$workspace" --if-lease-holder "$lease_holder"
```

On abandonment, run `project start "$goal_id" --clear` before returning the lease.

## Invariants for every binding

- Only the root session mutates Project Goals, and it does so from the default-branch checkout.
- Workers never edit `.worklist/worklist.json` or run mutating Stepstone commands.
- Claim before launch, and release every abandoned claim.
- Treat a rejected claim as a stop: release the workspace instead of launching a worker, because the claim is the only thing preventing a second driver from dispatching the same goal.
- Check every step between a successful claim and a running worker, and release both the claim and the workspace when one fails; a claim held with nobody working it keeps the goal out of `ready` until someone notices.
- Use each goal's `updatedAt` precondition for claim and completion, re-reading it before each one rather than reusing a spent value.
- Keep the approved plan's goal IDs as the authorization allow-list.
- Match merge evidence to the branch stored on that exact goal.
- Re-read canonical state after every merge instead of caching the ready frontier.
