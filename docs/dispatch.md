<!-- markdownlint-disable MD013 -->

# Dispatching an approved plan

A root session can fan out an explicitly approved Project Goal plan without making Stepstone depend on an agent harness, terminal multiplexer, or worktree manager.

The root session owns the roadmap.
Workers own implementation branches and PRs.

## Published driver

`stepstone-dispatch` is the executable form of the root-session contract.
Run it from the repository's main worktree after the exact Project Goal plan and its dispatch have been explicitly approved:

```sh
npx -y -p stepstone@latest stepstone-dispatch start \
  --goal first-approved-goal \
  --goal second-approved-goal \
  --max-parallel 2 \
  --workspace worktree \
  --session process \
  --agent-command my-agent \
  --agent-arg run \
  --json
```

The package also installs `stepstone-dispatch`, so an installed package can run the same command directly:

```sh
stepstone-dispatch start \
  --goal first-approved-goal \
  --max-parallel 1 \
  --agent-command my-agent
```

Repeated `--goal` values are the run's immutable authorization allow-list, and `start` refuses an ID that names no goal, so an approved plan is applied before the run that dispatches it.
Repeated `--agent-arg` values are passed verbatim to a process session's executable, including option-shaped values such as `--model`; a Herdr session carries no such arguments and a run that persisted them under one is rejected.
The second form names no binding, so it takes the defaults `--workspace worktree --session process`.
`--agent-command` is required by process sessions and `--agent-kind` by Herdr sessions.
`--cwd <repository>` selects the repository an action runs against and defaults to the current directory.
Whichever repository that is, every action refuses a linked worktree, the read-only ones included, so a run is only ever started, resumed, and inspected from the checkout that owns the roadmap.
`--workspace-parent <path>` chooses where the worktree workspace creates its `stepstone-<goal-id>` checkouts, defaulting to the repository's parent directory; the Treehouse workspace takes placement from its lease pool and ignores the flag.
`--startup-grace-ms <milliseconds>` bounds the wait that proves a spawned process-session worker survived its own startup, and defaults to 1000.
`--prompt-timeout-ms <milliseconds>` bounds Herdr prompt submission, and defaults to 300000.
`stepstone-dispatch --help` prints that same surface as a flag list.
`--json` prints a `{"ok": true, "result": ...}` envelope on stdout, and puts a failed action's `{"ok": false, "error": {"message": ...}}` envelope there as well rather than on stderr, where the same message goes without the flag.
Every failure exits 1, so a caller reads that envelope rather than the graded exit codes the `project` CLI returns.
The driver reads the canonical ready frontier and launches only allow-listed goals that are open, unblocked, and unclaimed.
It creates or acquires each workspace before claiming the goal, claims with the selected ready result's exact `updatedAt`, and never exceeds `--max-parallel`.
The worker's prompt is the complete stored goal as JSON under the driver's own standing instructions: implement it in the provided isolated checkout, leave the roadmap to the root session rather than editing `.worklist/worklist.json` or running mutating `project` commands, and open a pull request whose head is the claimed branch, which is the only evidence that ever completes the goal.
The configured agent therefore needs no dispatch-specific prompt configuration of its own.
That prompt is submitted over standard input for process sessions and through a private mode-0600 prompt file for Herdr sessions, never as a process argument.

Workspace isolation and session hosting are independent selections.
`--workspace worktree --session process` uses detached process groups in ordinary Git worktrees and is supported only on Linux, where `/proc` permits exact session-token ownership checks before signaling.
The driver rejects process-session runs on other operating systems instead of accepting custody it cannot later verify and close.
`--workspace treehouse --session herdr --agent-kind <kind>` uses Treehouse leases and Herdr panes.
Either workspace provider can compose with either session host.
The core and executable import graphs do not import Herdr, Treehouse, an agent harness, or Pi peers; selected external tools are invoked only at their CLI boundaries.

The start result names a run ID.
`start` takes the run's target branch and revision from the main worktree's own checkout, so it refuses a detached HEAD there.
Runtime state is stored under the repository's Git common directory at `stepstone-dispatch/<run-id>.json`, outside the canonical roadmap and shared by the main checkout across process restarts.
The record includes the selected target branch and revision, exact claim tokens, canonical completion and release receipts, transition intent, binding configuration, and workspace and session custody.
Every record is validated against the run schema on each read and before each write, so a hand-edited or otherwise inconsistent state file is refused by name rather than acted on; that schema is also what caps `--startup-grace-ms` at 300000, `--prompt-timeout-ms` at 86400000, and `--max-parallel` at 1024, so a larger value fails when the run is persisted rather than when the flag is parsed.
Each acquired workspace also has a private ownership marker in `stepstone-dispatch/workspaces/` and a unique owner token inside that worktree's resolved Git administrative directory.
Each dispatched goal gets a private mode-0700 `stepstone-dispatch/sessions/<goal-id>/` directory holding its launch receipt, a process session's `agent.log` capturing that worker's own standard output and error, and a Herdr session's prompt file.
`status` and `inspect` print the entry's session metadata, which names those paths, so reading `agent.log` is how a process-session worker is observed; cleanup removes the receipt and prompt file but keeps that log, which therefore outlives even a deleted run record.
Immediately before deleting a Git branch, cleanup journals its exact tip in that marker, atomically deletes only that unchanged ref while the authenticated owned worktree is still registered as its checkout, then journals the completed branch deletion before removing the worktree.
A retry may finish removing that same authenticated worktree once branch deletion is journaled.
After a workspace is absent or unregistered, cleanup never deletes a branch automatically, even when a same-tip branch exists elsewhere; an incomplete deletion journal fails closed for manual recovery.
Cleanup validates the custody records against the binding, exact path, branch, base revision, and current worktree identity before it may scrub or delete anything, then records verified removal so an interrupted cleanup is idempotent.
Deleting the whole completed run removes its cleanup receipts.
Process sessions reserve their launch-token receipt before anything can spawn, journal the PID into it immediately after spawn and before prompt submission, and observe process exit before any asynchronous prompt work, so restarted recovery can prove whether an otherwise unjournaled worker is still live without scanning unrelated processes.
Both session hosts write that receipt before the first step that could create a worker, so an absent receipt is proof that an interrupted launch never started one and explicit recovery may release its claim.
A reserved receipt whose PID was never journaled names a launch nothing can check, so it preserves custody until `--confirm-launch-closed` carries an operator's process-table verdict.
Resume after a worker or PR changes state:

```sh
stepstone-dispatch resume <run-id> --json
```

Resume reconciles journaled acquisition, claim, and release transitions before doing new work.
It preserves an interrupted acquisition when no local result proves what was acquired, retries an interrupted claim only while canonical state still shows its journaled baseline unclaimed, and finishes an interrupted release whose canonical state either still carries this run's exact claim or already committed that release before local state persistence.
It does not relaunch a persisted worker session.
Merged PR evidence must name the stored head and target branches, must postdate the current claim, and must provide a merge commit reachable from the freshly fetched target.
That evidence is read at the GitHub CLI boundary, so `resume` needs `gh` installed and authenticated for this repository, and the reachability check fetches the target branch from `origin`.
The driver persists that evidence and its completion intent before the canonical mutation.
If completion commits but its response is lost, resume accepts only the resulting canonical done transition tied to that journaled intent rather than completing twice or guessing from a branch name.
The canonical target checkout is fast-forwarded to that verified revision before a newly unblocked goal receives a workspace, which needs the main worktree still on the run's target branch; a root session that moved it preserves custody instead.
Only then does the driver complete the goal, persist its canonical completion receipt, clean custody, and refill free parallel slots from a freshly read ready frontier.
Run resume again as later PRs merge.

Inspection does not mutate the roadmap:

```sh
stepstone-dispatch status --json
stepstone-dispatch status <run-id> --json
stepstone-dispatch inspect <run-id> <goal-id> --json
```

A `launching` entry with a persisted launch token but no verified session handle is never releasable automatically.
After inspecting the process table or Herdr agent, `--confirm-launch-closed` asks the selected binding to prove that no worker still carries the persisted launch identity before recovery may release the claim.
A binding that positively identifies a live worker behind that launch identity refuses the release no matter what the flag says; the flag decides only the cases the binding cannot check at all, such as a reserved receipt with no PID, a recycled PID whose process group survives, or a Herdr daemon that cannot be asked.
The same verdict settles a recorded session handle the binding cannot prove closed either, which is how a worker that exited leaving a background child in its process group is released, and how a Herdr pane that no agent record authenticates is released; the flag never signals that group or closes that pane, because the binding cannot tell either from an unrelated one that reused the identifier.
An entry released on that verdict carries a persisted `custodyOperatorAsserted` marker that outlives the transitional messages and reaches its terminal record, so `status` and `inspect` distinguish custody a binding proved closed from custody an operator asserted was closed.
Cleanup asks the same binding for the same proof before scrubbing a workspace whose launch identity outlived its session handle, so a goal completed from merged evidence holds its parallel slot in `cleanup-pending` until no worker can still be using that checkout.
An interrupted workspace acquisition, any outcome after a process has spawned, a prompt submission timeout, an unreadable Herdr response, a merge-inspection failure, or a concurrency conflict preserves custody in the run record.
`cleanup-pending` entries whose worker session has not been proven closed continue to consume parallel capacity.
After inspecting that custody and proving no worker should retain it, release it explicitly:

```sh
stepstone-dispatch recover <run-id> <goal-id> --release --json
stepstone-dispatch recover <run-id> <goal-id> --release \
  --claim-updated-at <verified-current-updated-at> --json
stepstone-dispatch recover <run-id> <goal-id> --release --confirm-launch-closed --json
```

Recovery clears only the claim whose `updatedAt` was returned by this run's successful claim.
Recovery first closes and verifies the recorded worker session while the claim still blocks redispatch, journals the release before mutating canonical state, clears the exact claim, and only then scrubs the workspace.
Closing a recorded session handle is not the launch-identity refusal above: a worker the binding still positively identifies there is ended rather than preserved, by one `SIGTERM` to the process session's whole process group or by closing the Herdr pane, and the scrub that follows resets that checkout and deletes its `stepstone/<goal-id>` branch, so recovering a goal somebody is still working on discards whatever that worker never pushed.
The process binding never escalates past that one signal, so a process group still alive about two seconds later fails the recovery with custody intact.
A changed canonical token makes recovery fail closed instead of releasing somebody else's custody.
Recovery is limited to live claim phases and rejects completed, released, cleaned, and cleanup-only entries before closing a session or mutating state.
It also refuses an entry whose completion intent or merged evidence is already journaled, whatever phase that entry now holds, so a completion interrupted after its intent was recorded is settled by `resume` rather than released by hand.
Destructive cleanup requires a persisted canonical completion or release receipt, so changing only a phase cannot turn live claimed custody into cleanup work.
If a claim mutation committed but its response was lost before the returned token could be journaled, the driver does not infer ownership from the deterministic branch name.
After independently verifying that interrupted claim, an operator can provide the exact current token with `--claim-updated-at`; recovery checks the same branch and token again before releasing it.
An acquisition interrupted before its workspace result was persisted has no exact claim to release and remains inspection-only rather than guessing that no checkout was acquired.
Releasing settles a goal for this run rather than requeuing it: the released entry stays in the run's record, and each pass dispatches only an approved goal that has no entry yet, so a goal recovered this way is picked up by a later run instead of by the next `resume`.
Cleanup likewise refuses an entry that still owns canonical custody:

```sh
stepstone-dispatch cleanup <run-id> [goal-id] --json
stepstone-dispatch cleanup <run-id> <goal-id> --confirm-launch-closed --json
```

Cleanup persists verified session closure before touching the workspace, and its worktree, branch deletion, and guarded Treehouse return steps are idempotent across partial failures and restarts.
`--confirm-launch-closed` carries the same inspected verdict here that it carries for recovery, for an entry already past its canonical mutation whose reserved launch identity or recorded session handle nothing can check.
That verdict names one inspected goal, so cleanup refuses the flag without a goal ID rather than spending one process-table inspection on every entry in the run.
With no goal ID it removes the noncanonical run record only after every entry is cleaned.

The executable performs one reconciliation and scheduling pass per invocation rather than becoming a daemon.
This keeps restart behavior explicit and lets any scheduler, root session, or human decide when another `resume` pass should run.
`resume`, `recover`, and `cleanup` hold a cross-process lock on the run for that whole pass, and `start` holds it for its own scheduling pass, so overlapping invocations serialize instead of interleaving.
Each record is replaced atomically under the state directory's own lock, so a concurrent `status` or `inspect` reads a whole record rather than a partial write.

## Dispatch contract

1. Apply the exact approved plan once.
2. Start a driver run with exactly that plan's approved goal IDs and the canonical target branch and revision.
3. Select only goals from a fresh ready frontier, up to the persisted parallel limit, counting every unverified session.
4. Journal intent, then acquire an isolated workspace and deterministic `stepstone/<goal-id>` branch.
5. Journal and claim through the shared application service with the ready goal's `updatedAt`.
6. Launch the selected session host with the full stored goal as context.
7. Preserve custody whenever acquisition, launch, observation, release, or completion has an ambiguous outcome.
8. Accept only a current-claim PR merged into the stored target whose merge commit is reachable from the updated target revision.
9. Re-read canonical state, complete with standing consent, then close and scrub custody.
10. Read the ready frontier again only after the target is current, and stop when the approved run has nothing ready or held.

`--max-parallel N` is driver runtime policy and never canonical roadmap state.
With `--max-parallel 1`, its default, repeated resume passes form a serial chain.

## Authorization boundary

Explicit approval of a plan plus an explicit request to start its driver run grants standing consent to complete a goal from that run only after the goal's matching PR merges.
This is the narrow exception to the normal rule that an agent must ask immediately before confirming a lifecycle action.
The driver records the approved IDs before dispatch and cannot extend that consent during resume.

Standing consent does not authorize completion based on worker exit, a green unmerged PR, or session silence.
It does not authorize `archive`, `delete`, `reopen`, a goal outside the approved run, or a later plan.
If a worker is abandoned or its PR closes without merging, inspect the persisted custody and use explicit `recover --release`.
The driver passes the `updatedAt` returned by its successful claim rather than re-reading and potentially clearing somebody else's newer claim.

## Executable binding contracts

The recipes below remain executable behavioral contracts in the documentation test suite.
They spell out the same failure boundaries as the published driver without becoming imports or runtime dependencies.

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

`AGENT_COMMAND` names one executable; the published driver passes agent-specific configuration through repeatable `--agent-arg` values.
The command preflight resolves and fingerprints that executable before persisting a run, and the driver refuses to spawn a worker whose executable identity changed.
Resume reconciles merged PRs, journals canonical completion, and cleans custody first, and only then refuses, so an agent upgraded mid-run neither strands a run that needs reconciliation nor consumes an approved goal that was never dispatched.
An entry already holding a claim when the identity changed keeps that claim and its workspace in `claimed` rather than releasing them, because a release would drop the goal from this run's allow-list for a failure that proves nothing about the goal.
A run's fingerprint is fixed at `start` and no command re-authorizes it, so that deferred entry launches on a later resume only if the authorized executable is restored; otherwise it holds its custody until `recover <run-id> <goal-id> --release` retires it, and adopting an upgraded agent means starting a new run for the goals that remain.
The binding checks the same fingerprint again at the spawn boundary, so no worker is ever started from an executable the run did not authorize.
The documented shell binding's bounded startup grace verifies that the detached process survived long enough to accept custody instead of trusting the successful fork that `nohup` reports before an `exec` failure.

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
lease_json=$(treehouse get --lease --lease-holder "$lease_holder" --json) || exit 1
workspace=$(printf '%s\n' "$lease_json" | jq -er '.path') || exit 1
lease_id=$(printf '%s\n' "$lease_json" | jq -er '.lease_id') || exit 1
returned_holder=$(printf '%s\n' "$lease_json" | jq -er '.lease_holder') || exit 1
test "$returned_holder" = "$lease_holder" || exit 1
```

Claim the goal from the root checkout and retain the `updatedAt` returned by that exact claim.
Every safe pre-submission failure closes and verifies any pane, releases the claim with that token, and force-returns the lease, whose guarded return scrubs the checkout under Treehouse's lease lock.
Once prompt submission has been attempted, a timeout or transport failure is ambiguous, so custody is preserved for inspection instead of assuming no worker is running:

```sh
# dispatch-example: binding-b-launch
pane_id=
runtime_dir="${XDG_STATE_HOME:-$HOME/.local/state}/stepstone/dispatch/$goal_id"
umask 077
mkdir -p "$runtime_dir" || exit 1
prompt_file="$runtime_dir/prompt.txt"

verify_lease() {
  lease_status=$(treehouse status --json) || return 1
  lease_matches=$(printf '%s\n' "$lease_status" |
    jq -er --arg path "$workspace" '[.[] | select(.path == $path)] | length') || return 1
  test "$lease_matches" = 1 || return 1
  current_lease_id=$(printf '%s\n' "$lease_status" |
    jq -er --arg path "$workspace" '.[] | select(.path == $path) | .lease_id') || return 1
  current_holder=$(printf '%s\n' "$lease_status" |
    jq -er --arg path "$workspace" '.[] | select(.path == $path) | .lease_holder') || return 1
  current_status=$(printf '%s\n' "$lease_status" |
    jq -er --arg path "$workspace" '.[] | select(.path == $path) | .status') || return 1
  test "$current_status" = leased &&
    test "$current_lease_id" = "$lease_id" &&
    test "$current_holder" = "$lease_holder"
}

cleanup_lease() {
  treehouse return "$workspace" --force \
    --if-lease-id "$lease_id" \
    --if-lease-holder "$lease_holder"
}

close_pane() {
  if test -n "$pane_id"
  then
    herdr pane close "$pane_id" || return 1
    pane_list=$(herdr pane list) || return 1
    pane_present=$(printf '%s\n' "$pane_list" |
      jq -r --arg pane "$pane_id" 'any(.result.panes[]; .pane_id == $pane)') || return 1
    test "$pane_present" = false || return 1
    pane_id=
  fi
  rm -f "$prompt_file" || return 1
}

verify_lease || exit 1

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
printf '%s' "$goal_prompt" >"$prompt_file" || abandon

git -C "$workspace" checkout -b "$branch" "$base" || abandon
verify_lease || abandon
pane_json=$(herdr pane split --current --direction right --cwd "$workspace" --no-focus) ||
  abandon
if ! pane_id=$(printf '%s\n' "$pane_json" | jq -er '.result.pane.pane_id')
then
  printf '%s\n' "A pane may exist but its ID could not be read; custody is preserved." >&2
  exit 1
fi
agent_name=$(printf 'ss-%.18s-%s' "$goal_id" "$(printf %s "$goal_id" | cksum | cut -d' ' -f1)")
herdr agent start "$agent_name" --kind "$HERDR_AGENT_KIND" --pane "$pane_id" || abandon
agent_json=$(herdr agent get "$agent_name") || abandon
owned_pane=$(printf '%s\n' "$agent_json" | jq -er '.result.agent.pane_id') || abandon
owned_cwd=$(printf '%s\n' "$agent_json" | jq -er '.result.agent.cwd') || abandon
test "$owned_pane" = "$pane_id" && test "$owned_cwd" = "$workspace" || abandon
if ! herdr agent prompt "$pane_id" \
  "Read the complete Stepstone goal context from $prompt_file and follow it exactly." \
  --wait --timeout "${HERDR_PROMPT_TIMEOUT_MS:-300000}"
then
  printf '%s\n' "Prompt outcome is ambiguous; claim, pane, and lease are preserved." >&2
  exit 1
fi
```

Herdr answers over its socket API in a JSON envelope, so the pane ID is read out of `.result.pane.pane_id`; passing the whole response to `--pane` starts nothing.
The full prompt is written to a private mode-0600 file, and only an instruction containing that path appears in process arguments.
The published driver snapshots pane identities before split and persists that snapshot plus the derived agent name.
If split returns an unreadable envelope, recovery never trusts a pane ID inferred only from the snapshot difference.
It closes a post-launch pane only when `herdr agent get` independently maps the persisted derived agent name to that pane and exact workspace; otherwise it preserves ambiguous custody, while no post-launch pane is already safe.
Herdr requires an agent name matching `[a-z][a-z0-9_-]{0,31}` and unique among live agents, so the goal ID cannot be the name: most IDs on a real roadmap exceed the 32 characters, and `agent start` would fail every dispatch.
The derived name keeps a readable prefix of the ID inside that limit and appends a checksum of the full ID, which stays unique where truncation alone would collide.
Once the agent is running, Herdr accepts the hosting pane ID wherever it accepts a name, so the calls after `agent start` target `$pane_id` and never depend on that derivation.

`stepstone/$goal_id` is deterministic, and neither `start --clear` nor returning a lease deletes a branch, so re-dispatching a goal whose earlier attempt still has its branch fails at `checkout -b`.
That failure closes any created pane, releases the claim, and force-returns the lease so Treehouse scrubs the checkout, instead of running the worker on whatever ref the pool handed out, whose PR head would never match the branch stored on the goal.
Delete or rename the stale branch deliberately, once you know whether its commits are still wanted.

Use bounded waits such as `herdr agent wait "$pane_id" --timeout "${HERDR_WAIT_TIMEOUT_MS:-300000}"` and use `herdr agent read "$pane_id"` for liveness and diagnostics.
A wait timeout preserves custody because the request may have reached the agent before the client lost its response.
Those signals never replace merged-PR evidence.

After merge and completion, close the pane, verify that Herdr no longer lists it, then ask Treehouse to atomically verify the exact lease identity, scrub the checkout under its lease lock, and return it:

```sh
# dispatch-example: binding-b-cleanup
close_pane || exit 1
cleanup_lease || exit 1
```

The published Treehouse binding records the immutable lease ID returned by `treehouse get --json` and verifies both that ID and the holder immediately before claim and launch.
Cleanup delegates all destructive reset work to `treehouse return --force --if-lease-id ... --if-lease-holder ...`, whose lease precondition and reset share Treehouse's state lock.
A changed lease therefore fails before any Git scrub, while a retry after a successful guarded return records local cleanup without touching the now-available pooled worktree.
Because the leased checkout shares this repository's ref store, cleanup still owns the branch it created: under the verified lease it journals that branch's exact tip, force-detaches the leased checkout onto the recorded base, atomically deletes only that unchanged ref, and journals the deletion before returning the lease.
The detach is forced because an abandoned worker's uncommitted edits would otherwise abort it, and the guarded return that follows resets the pooled checkout regardless.
Deleting the ref the binding created is what keeps `stepstone/<goal-id>` dispatchable again; leaving it behind would fail every later `checkout -b` for that goal.

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
- Reset a workspace before forcing its removal or return, by scrubbing and verifying it clean where the binding owns the removal or by delegating that reset to a provider whose guarded return performs it under its own lock, and force only after the goal is completed or its exact claim is released, so cleanup neither stops on an interactive refusal nor discards a checkout somebody still holds.
- Keep the approved plan's goal IDs as the authorization allow-list.
- Match merge evidence to the branch stored on that exact goal.
- Re-read canonical state after every merge instead of caching the ready frontier.
