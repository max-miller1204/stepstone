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
This is the narrow exception to the normal rule that an agent must ask immediately before confirming a lifecycle action, and it holds for whichever interface the loop drives the roadmap through: `--confirm` on the CLI, `confirm: true` on the [MCP server](mcp.md#exact-confirmation-guardrails).

Standing consent does not authorize completion based on worker exit, a green unmerged PR, or session silence.
It does not authorize `archive`, `delete`, `reopen`, a goal outside the approved plan, or a later plan.
If a worker is abandoned or its PR closes without merging, release the claim without completing the goal.
Use the `updatedAt` returned by the successful claim rather than re-reading and potentially clearing somebody else's newer claim:

```sh
npx -y stepstone@latest project start "$goal_id" --clear \
  --expect-updated-at "$claimed_updated_at"
```

## Binding A: Git worktrees and detached processes

This baseline needs Git, a shell, a JSON reader, and the configured agent executable.
The root session remains in the default-branch checkout.

Create the isolated workspace and branch:

```sh
# dispatch-example: binding-a-workspace
branch="stepstone/$goal_id"
workspace="../stepstone-$goal_id"
git worktree add -b "$branch" "$workspace" HEAD || exit 1
```

This runs before the claim, so a failure here has nothing to release.
It fails when an earlier attempt on the same goal left `stepstone/$goal_id` behind, which is deliberate: resolve that branch before dispatching the goal again.

Claim the goal from the root checkout, retain the returned concurrency token, and launch only if the claim succeeded.
A failed claim means another driver holds the goal, so the workspace is scrubbed and discarded rather than staffed.
The cleanup is non-interactive and verifies a clean checkout before forcing removal:

```sh
# dispatch-example: binding-a-launch
cleanup_workspace() {
  git -C "$workspace" reset --hard HEAD &&
    git -C "$workspace" clean -fdx &&
    workspace_status=$(git -C "$workspace" status --porcelain) &&
    test -z "$workspace_status" &&
    git worktree remove --force "$workspace" &&
    git branch -D "$branch"
}

if ! claim_json=$(npx -y stepstone@latest project start "$goal_id" \
  --branch "$branch" \
  --expect-updated-at "$updated_at" \
  --json)
then
  cleanup_workspace || exit 1
  exit 1
fi

if ! claimed_updated_at=$(printf '%s\n' "$claim_json" | jq -er '.result.goal.updatedAt')
then
  printf '%s\n' "Claim succeeded but its updatedAt could not be read; custody is preserved." >&2
  exit 1
fi

abandon() {
  npx -y stepstone@latest project start "$goal_id" --clear \
    --expect-updated-at "$claimed_updated_at" \
    --json || exit 1
  cleanup_workspace || exit 1
  exit 1
}

command -v "$AGENT_COMMAND" >/dev/null 2>&1 || abandon
runtime="${XDG_STATE_HOME:-$HOME/.local/state}/stepstone/dispatch/$goal_id"
mkdir -p "$runtime" || abandon
(
  cd "$workspace" || exit 1
  nohup "$AGENT_COMMAND" "$goal_prompt" >"$runtime/agent.log" 2>&1 </dev/null &
  agent_pid=$!
  printf '%s\n' "$agent_pid" >"$runtime/agent.pid" &&
    sleep "${AGENT_STARTUP_GRACE_SECONDS:-1}" &&
    kill -0 "$agent_pid" 2>/dev/null
) || abandon
```

`AGENT_COMMAND` names one executable; pass agent-specific configuration through that executable or its environment.
The `command -v` preflight catches a missing executable before launch.
The bounded startup grace then verifies that the detached process survived long enough to accept custody instead of trusting the successful fork that `nohup` reports before an `exec` failure.

The log and pid file belong to the driver, not to the branch under review.
Keeping them outside `$workspace` leaves the worker's checkout clean, so an agent that stages everything cannot commit its own transcript into the PR.

After the PR merges and the goal is completed on the default branch, scrub and remove the worktree with the same checked cleanup:

```sh
# dispatch-example: binding-a-cleanup
cleanup_workspace || exit 1
```

The forced removal is safe only after merge and completion or after the exact claim has been released.
It prevents ignored build artifacts or other worker residue from opening an interactive cleanup path or retaining a stale worktree.

## Binding B: Herdr panes and Treehouse leases

This binding uses Treehouse only for workspace isolation and Herdr only for session hosting.
Neither tool owns roadmap state.

Acquire a durable workspace lease, and choose the branch name here rather than reading it back from the leased checkout.
A pooled worktree can arrive on a detached HEAD, where `git branch --show-current` prints nothing and the claim below is rejected for a missing branch:

```sh
# dispatch-example: binding-b-workspace
lease_holder="stepstone:$goal_id"
branch="stepstone/$goal_id"
base=$(git rev-parse HEAD) || exit 1
workspace=$(treehouse get --lease --lease-holder "$lease_holder") || exit 1
test -n "$workspace" || exit 1
```

Claim the goal from the root checkout and retain the `updatedAt` returned by that exact claim.
Every safe pre-submission failure closes and verifies any pane, releases the claim with that token, scrubs the checkout, and force-returns the lease.
Once prompt submission has been attempted, a timeout or transport failure is ambiguous, so custody is preserved for inspection instead of assuming no worker is running:

```sh
# dispatch-example: binding-b-launch
pane_id=

cleanup_lease() {
  git -C "$workspace" reset --hard HEAD &&
    git -C "$workspace" clean -fdx &&
    workspace_status=$(git -C "$workspace" status --porcelain) &&
    test -z "$workspace_status" &&
    treehouse return "$workspace" --force --if-lease-holder "$lease_holder"
}

close_pane() {
  test -z "$pane_id" && return 0
  herdr pane close "$pane_id" || return 1
  pane_list=$(herdr pane list) || return 1
  pane_present=$(printf '%s\n' "$pane_list" |
    jq -r --arg pane "$pane_id" 'any(.result.panes[]; .pane_id == $pane)') || return 1
  test "$pane_present" = false || return 1
  pane_id=
}

if ! claim_json=$(npx -y stepstone@latest project start "$goal_id" \
  --branch "$branch" \
  --expect-updated-at "$updated_at" \
  --json)
then
  cleanup_lease || exit 1
  exit 1
fi

if ! claimed_updated_at=$(printf '%s\n' "$claim_json" | jq -er '.result.goal.updatedAt')
then
  printf '%s\n' "Claim succeeded but its updatedAt could not be read; custody is preserved." >&2
  exit 1
fi

abandon() {
  close_pane || exit 1
  npx -y stepstone@latest project start "$goal_id" --clear \
    --expect-updated-at "$claimed_updated_at" \
    --json || exit 1
  cleanup_lease || exit 1
  exit 1
}

git -C "$workspace" checkout -b "$branch" "$base" || abandon
pane_json=$(herdr pane split --current --direction right --cwd "$workspace" --no-focus) ||
  abandon
if ! pane_id=$(printf '%s\n' "$pane_json" | jq -er '.result.pane.pane_id')
then
  printf '%s\n' "A pane may exist but its ID could not be read; custody is preserved." >&2
  exit 1
fi
agent_name=$(printf 'ss-%.18s-%s' "$goal_id" "$(printf %s "$goal_id" | cksum | cut -d' ' -f1)")
herdr agent start "$agent_name" --kind "$HERDR_AGENT_KIND" --pane "$pane_id" || abandon
if ! herdr agent prompt "$pane_id" "$goal_prompt" --wait \
  --timeout "${HERDR_PROMPT_TIMEOUT_MS:-300000}"
then
  printf '%s\n' "Prompt outcome is ambiguous; claim, pane, and lease are preserved." >&2
  exit 1
fi
```

Herdr answers over its socket API in a JSON envelope, so the pane ID is read out of `.result.pane.pane_id`; passing the whole response to `--pane` starts nothing.
If the successful split returns an unreadable envelope, the driver preserves the claim and lease because it cannot prove which pane to close.

Herdr requires an agent name matching `[a-z][a-z0-9_-]{0,31}` and unique among live agents, so the goal ID cannot be the name: most IDs on a real roadmap exceed the 32 characters, and `agent start` would fail every dispatch.
The derived name keeps a readable prefix of the ID inside that limit and appends a checksum of the full ID, which stays unique where truncation alone would collide.
Once the agent is running, Herdr accepts the hosting pane ID wherever it accepts a name, so the calls after `agent start` target `$pane_id` and never depend on that derivation.

`stepstone/$goal_id` is deterministic, and neither `start --clear` nor returning a lease deletes a branch, so re-dispatching a goal whose earlier attempt still has its branch fails at `checkout -b`.
That failure closes any created pane, releases the claim, scrubs the checkout, and returns the lease instead of running the worker on whatever ref the pool handed out, whose PR head would never match the branch stored on the goal.
Delete or rename the stale branch deliberately, once you know whether its commits are still wanted.

Use bounded waits such as `herdr agent wait "$pane_id" --timeout "${HERDR_WAIT_TIMEOUT_MS:-300000}"` and use `herdr agent read "$pane_id"` for liveness and diagnostics.
A wait timeout preserves custody because the request may have reached the agent before the client lost its response.
Those signals never replace merged-PR evidence.

After merge and completion, close the pane, verify that Herdr no longer lists it, scrub the checkout, and only then force-return the lease:

```sh
# dispatch-example: binding-b-cleanup
close_pane || exit 1
cleanup_lease || exit 1
```

Closing the hosting pane ends its Herdr agent.
On abandonment the same verified close happens before claim release and lease return, so Treehouse never receives a checkout still owned by a live pane.

## Invariants for every binding

- Only the root session mutates Project Goals, and it does so from the repository's main worktree, which is the default-branch checkout every binding here leaves it in.
- Workers never edit `.worklist/worklist.json` or run mutating Stepstone commands.
  Stepstone refuses a committed-roadmap mutation from a linked worktree rather than trusting a driver to observe that, so a worker that attempts one is sent to the main worktree instead of forking the roadmap; see [storage.md](storage.md#the-committed-roadmap-has-one-writer).
- Claim before launch, and release every abandoned claim.
- Treat a rejected claim as a stop: release the workspace instead of launching a worker, because the claim is the only thing preventing a second driver from dispatching the same goal.
- Check every step between a successful claim and a running worker, and release both the claim and the workspace only when the failure proves no worker was launched; a claim held with nobody working it keeps the goal out of `ready` until someone notices, while a claim released under a worker that may be running hands the same goal to a second driver.
- Keep the claim, the workspace, and any hosting session when a failure leaves custody ambiguous, and say on stderr what is being held, because an outcome nobody can read is a case for inspection rather than for automatic cleanup.
- Use each goal's `updatedAt` precondition for claim and completion, re-reading it before each one rather than reusing a spent value, and release a claim with the `updatedAt` that same claim returned, because a re-read value may already belong to somebody else's newer claim.
- Scrub a workspace and verify it reports clean before forcing its removal or return, and force only after the goal is completed or its exact claim is released, so cleanup neither stops on an interactive refusal nor discards a checkout somebody still holds.
- Keep the approved plan's goal IDs as the authorization allow-list.
- Match merge evidence to the branch stored on that exact goal.
- Re-read canonical state after every merge instead of caching the ready frontier.
