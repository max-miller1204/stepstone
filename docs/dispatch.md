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
7. Pull the default branch, re-read the goal, then complete it from the root checkout:

```sh
npx -y stepstone@latest project complete "$goal_id" \
  --expect-updated-at "$updated_at" \
  --confirm
```

8. Release the workspace and read `ready --json` again.
9. Stop when `ready` is empty.
Read `waves --json` to distinguish a finished roadmap from goals that are blocked or already claimed.

`--max-parallel N` is a driver policy, not stored roadmap state.
Dispatch at most $N$ entries from each ready result.
With $N=1$, the same loop is a serial auto-chain.

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
git worktree add -b "$branch" "$workspace" HEAD
```

Claim the goal from the root checkout, then launch the configured command with standard output captured for inspection:

```sh
npx -y stepstone@latest project start "$goal_id" \
  --branch "$branch" \
  --expect-updated-at "$updated_at"

(
  cd "$workspace"
  nohup sh -c 'exec "$@"' sh "$AGENT_COMMAND" "$goal_prompt" \
    >.stepstone-agent.log 2>&1 </dev/null &
  echo $! >.stepstone-agent.pid
)
```

`AGENT_COMMAND` is configuration.
It may name Pi, Claude Code, Codex, Cursor, or another CLI.
The dispatch contract does not parse its output or infer completion from its process state.

After the PR merges and the goal is completed on the default branch, remove the worktree:

```sh
git worktree remove "$workspace"
```

If the run is abandoned, release the Stepstone claim before removing the worktree.

## Binding B: Herdr panes and Treehouse leases

This binding uses Treehouse only for workspace isolation and Herdr only for session hosting.
Neither tool owns roadmap state.

Acquire a durable workspace lease and discover its checkout:

```sh
lease_holder="stepstone:$goal_id"
workspace=$(treehouse get --lease --lease-holder "$lease_holder")
branch=$(git -C "$workspace" branch --show-current)
```

Claim the goal from the root checkout.
Create a Herdr pane in the leased checkout, start the configured supported agent, and submit the goal prompt:

```sh
npx -y stepstone@latest project start "$goal_id" \
  --branch "$branch" \
  --expect-updated-at "$updated_at"

pane_id=$(herdr pane split --current --direction right --cwd "$workspace" --no-focus)
agent_name="stepstone-$goal_id"
herdr agent start "$agent_name" --kind "$HERDR_AGENT_KIND" --pane "$pane_id"
herdr agent prompt "$agent_name" "$goal_prompt" --wait
```

Use `herdr agent wait "$agent_name"` and `herdr agent read "$agent_name"` for liveness and diagnostics.
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
- Use each goal's `updatedAt` precondition for claim and completion.
- Keep the approved plan's goal IDs as the authorization allow-list.
- Match merge evidence to the branch stored on that exact goal.
- Re-read canonical state after every merge instead of caching the ready frontier.
