#!/usr/bin/env bash
# Binding A of docs/dispatch.md, executed for real:
#   session host      = detached process (nohup)
#   workspace provider = plain git worktree
#   agent harness      = whatever $AGENT_COMMAND names (configuration, not an adapter)
#
# The only stand-in is the code host: there is no GitHub in this sandbox, so a
# "PR merge" is a --no-ff merge of the claimed branch into origin/main performed
# by a separate reviewer script. Merge evidence is then read back from the
# remote exactly as the recipe requires: the claimed branch is an ancestor of
# the default branch.
set -u

STEPSTONE_CLI=${STEPSTONE_CLI:?set STEPSTONE_CLI to the stepstone cli entrypoint}
DEMO=${DEMO:-/tmp/ss-dispatch/demo}
MAX_PARALLEL=${MAX_PARALLEL:-2}
export AGENT_COMMAND=${AGENT_COMMAND:-/tmp/ss-dispatch/fake-agent.sh}
export XDG_STATE_HOME=${XDG_STATE_HOME:-/tmp/ss-dispatch/state}

ROOT="$DEMO/root"
ss() { node "$STEPSTONE_CLI" project "$@"; }

say() { printf '\n=== %s\n' "$*"; }
run() {
	printf '\n$ %s\n' "$*"
	"$@"
	local status=$?
	printf '[exit %s]\n' "$status"
	return $status
}

# Echo the command, then render its envelope through a jq filter without
# putting jq in a pipeline the CLI would see as a closed stdout.
runq() {
	local filter=$1
	shift
	printf '\n$ %s\n' "$*"
	local out status
	out=$("$@" 2>&1)
	status=$?
	if [ -n "$out" ]; then
		printf '%s\n' "$out" | jq -c "$filter" 2>/dev/null || printf '%s\n' "$out"
	fi
	printf '[exit %s]\n' "$status"
	return $status
}

# ---------------------------------------------------------------------------
# Scenario setup: a bare "origin" plus the root-session checkout on main.
# ---------------------------------------------------------------------------
rm -rf "$DEMO" "$XDG_STATE_HOME/stepstone"
mkdir -p "$DEMO"
git init -q --bare -b main "$DEMO/origin.git"
git init -q -b main "$ROOT"
git -C "$ROOT" config user.email root@example.com
git -C "$ROOT" config user.name "root session"
git -C "$ROOT" remote add origin "$DEMO/origin.git"
printf 'demo project\n' >"$ROOT/README.md"
git -C "$ROOT" add -A
git -C "$ROOT" commit -qm "chore: init"
git -C "$ROOT" push -q -u origin main

cat >"$DEMO/plan.json" <<'PLAN'
[
  { "title": "Add greeting module", "group": "Foundation" },
  { "title": "Add farewell module", "group": "Foundation" },
  {
    "title": "Wire greetings into the CLI",
    "group": "Workflow",
    "dependsOn": ["add-greeting-module", "add-farewell-module"]
  }
]
PLAN

cd "$ROOT" || exit 1

say "Contract step 1: apply the approved plan once, from the root checkout on main"
runq '.result.goals[] | {id, title, dependsOn}' ss apply-plan "$DEMO/plan.json" --json
git -C "$ROOT" add -A
git -C "$ROOT" commit -qm "chore: approved plan"
git -C "$ROOT" push -q origin main
PLAN_IDS=$(ss list --json | jq -r '.result.goals[].id')
say "Approved plan is the authorization allow-list: $(echo "$PLAN_IDS" | tr '\n' ' ')"

# ---------------------------------------------------------------------------
# Helpers implementing the documented steps.
# ---------------------------------------------------------------------------
claim_and_launch() {
	local goal_id=$1 updated_at=$2 goal_prompt=$3
	local branch="stepstone/$goal_id"
	local workspace="$DEMO/ws-$goal_id"

	printf '\n$ git worktree add -b %s %s HEAD\n' "$branch" "$workspace"
	git worktree add -b "$branch" "$workspace" HEAD >/dev/null 2>&1 || return 1

	printf '$ stepstone project start %s --branch %s --expect-updated-at %s\n' "$goal_id" "$branch" "$updated_at"
	if ! ss start "$goal_id" --branch "$branch" --expect-updated-at "$updated_at" >/dev/null 2>&1; then
		printf '  claim rejected (exit %s) -> discard the workspace, do not staff it\n' "$?"
		git worktree remove "$workspace" >/dev/null 2>&1
		git branch -D "$branch" >/dev/null 2>&1
		return 1
	fi
	printf '  claimed: branch %s recorded on the goal\n' "$branch"

	local runtime="${XDG_STATE_HOME:-$HOME/.local/state}/stepstone/dispatch/$goal_id"
	mkdir -p "$runtime" || {
		abandon "$goal_id" "$workspace" "$branch"
		return 1
	}
	(
		cd "$workspace" || exit 1
		nohup sh -c 'exec "$@"' sh "$AGENT_COMMAND" "$goal_prompt" \
			>"$runtime/agent.log" 2>&1 </dev/null &
		echo $! >"$runtime/agent.pid"
	) || {
		abandon "$goal_id" "$workspace" "$branch"
		return 1
	}
	printf '  launched %s detached in %s (pid %s, log %s)\n' \
		"$AGENT_COMMAND" "$workspace" "$(cat "$runtime/agent.pid")" "$runtime/agent.log"
}

abandon() {
	local goal_id=$1 workspace=$2 branch=$3
	ss start "$goal_id" --clear >/dev/null 2>&1
	git worktree remove --force "$workspace" >/dev/null 2>&1
	git branch -D "$branch" >/dev/null 2>&1
}

merged_into_default_branch() {
	local branch=$1
	git fetch -q origin
	git merge-base --is-ancestor "origin/$branch" origin/main 2>/dev/null
}

# Stands in for a reviewer merging the goal's PR on the code host.
merge_pull_request() {
	local branch=$1
	git fetch -q origin "$branch"
	git checkout -q main
	git merge -q --no-ff -m "Merge pull request from $branch" "origin/$branch"
	git push -q origin main
}

# ---------------------------------------------------------------------------
# The loop.
# ---------------------------------------------------------------------------
round=0
while :; do
	round=$((round + 1))
	say "Round $round, contract step 2: read the ready frontier from main"
	READY=$(ss ready --json)
	echo "$READY" | jq -c '.result.goals[] | {id, title, updatedAt}'
	COUNT=$(echo "$READY" | jq '.result.goals | length')
	if [ "$COUNT" -eq 0 ]; then
		say "ready is empty: contract step 9 says stop"
		runq '{waves: [.result.waves[] | map(.id)], unreachable: (.result.unreachableGoals // [])}' ss waves --json
		break
	fi

	say "Round $round, contract steps 3-5: dispatch at most --max-parallel $MAX_PARALLEL of $COUNT ready goals"
	DISPATCHED=()
	BRANCHES=()
	for row in $(echo "$READY" | jq -r ".result.goals[:$MAX_PARALLEL][] | @base64"); do
		goal_id=$(echo "$row" | base64 -d | jq -r '.id')
		updated_at=$(echo "$row" | base64 -d | jq -r '.updatedAt')
		title=$(echo "$row" | base64 -d | jq -r '.title')
		prompt=$(ss show "$goal_id" --json | jq -r '.result.goal | "Goal \(.id): \(.title)\n\n\(.description // "")"')
		printf '\n--- dispatching %s (%s)\n' "$goal_id" "$title"
		if claim_and_launch "$goal_id" "$updated_at" "$prompt"; then
			DISPATCHED+=("$goal_id")
			BRANCHES+=("stepstone/$goal_id")
		fi
	done
	if [ "$COUNT" -gt "$MAX_PARALLEL" ]; then
		printf '\n%s ready goal(s) left undispatched this round by --max-parallel %s\n' \
			"$((COUNT - MAX_PARALLEL))" "$MAX_PARALLEL"
	fi

	say "Claimed goals leave the ready frontier, so a second driver reading ready cannot double-staff them"
	runq '{stillReady: [.result.goals[].id]}' ss ready --json
	runq '[.result.goals[] | select(.branch != null) | {id, branch, status}]' ss list --json

	if [ "$round" -eq 1 ]; then
		say "A second driver holding the pre-claim updatedAt is refused (exit 4), and its workspace is discarded"
		stale=$(echo "$READY" | jq -r '.result.goals[0].updatedAt')
		first=${DISPATCHED[0]}
		run ss start "$first" --branch stepstone/second-driver --expect-updated-at "$stale"
	fi

	say "Round $round: wait for the detached workers, then check merge evidence, not process exit"
	for goal_id in "${DISPATCHED[@]}"; do
		runtime="$XDG_STATE_HOME/stepstone/dispatch/$goal_id"
		pid=$(cat "$runtime/agent.pid")
		while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
		printf '  %s: worker pid %s exited; log tail: %s\n' "$goal_id" "$pid" "$(tail -n 1 "$runtime/agent.log")"
	done

	if [ "$round" -eq 1 ]; then
		goal_id=${DISPATCHED[0]}
		say "Worker exit is not completion evidence: the PR for $goal_id has not merged yet"
		if merged_into_default_branch "stepstone/$goal_id"; then
			echo "  UNEXPECTED: branch already merged"
		else
			echo "  stepstone/$goal_id is not an ancestor of origin/main -> no completion, goal stays claimed"
			runq '.result.goal | {id, status, branch}' ss show "$goal_id" --json
		fi
	fi

	say "Round $round: reviewer merges each PR (stand-in for the code host), then the root session verifies the merge"
	for goal_id in "${DISPATCHED[@]}"; do
		merge_pull_request "stepstone/$goal_id"
		if merged_into_default_branch "stepstone/$goal_id"; then
			printf '  %s: origin/stepstone/%s is an ancestor of origin/main -> merged-PR evidence\n' "$goal_id" "$goal_id"
		else
			printf '  %s: NO MERGE EVIDENCE\n' "$goal_id"
		fi
	done

	say "Round $round, contract step 7: complete on main under standing consent, with a freshly read precondition"
	for goal_id in "${DISPATCHED[@]}"; do
		if ! echo "$PLAN_IDS" | grep -qx "$goal_id"; then
			echo "  $goal_id is outside the approved plan: standing consent does not cover it"
			continue
		fi
		if [ "$round" -eq 1 ] && [ "$goal_id" = "${DISPATCHED[0]}" ]; then
			stale=$(echo "$READY" | jq -r --arg id "$goal_id" '.result.goals[] | select(.id==$id) | .updatedAt')
			say "The updatedAt read in step 2 was spent by the claim: reusing it is a conflict (exit 4)"
			run ss complete "$goal_id" --expect-updated-at "$stale" --confirm
		fi
		fresh=$(ss show "$goal_id" --json | jq -r '.result.goal.updatedAt')
		runq '.result.goal | {id, status, completedAt, branch}' ss complete "$goal_id" --expect-updated-at "$fresh" --confirm --json
	done
	git add -A
	git commit -qm "chore: complete round $round"
	git push -q origin main

	say "Round $round, contract step 8: release each workspace"
	for goal_id in "${DISPATCHED[@]}"; do
		run git worktree remove "$DEMO/ws-$goal_id"
	done
done

say "Abandonment path: claim a goal, then release it with start --clear instead of completing it"
runq '.result.goal | {id, status}' ss reopen "${DISPATCHED[0]:-add-greeting-module}" --confirm --json
released=$(ss ready --json | jq -r '.result.goals[0].id')
released_at=$(ss ready --json | jq -r '.result.goals[0].updatedAt')
runq '.result.goal | {id, branch}' ss start "$released" --branch stepstone/abandoned --expect-updated-at "$released_at" --json
runq '{readyWhileClaimed: [.result.goals[].id]}' ss ready --json
runq '.result.goal | {id, branch, status}' ss start "$released" --clear --json
runq '{readyAfterClear: [.result.goals[].id]}' ss ready --json

say "Final roadmap state"
runq '[.result.goals[] | {id, status}]' ss list --json
