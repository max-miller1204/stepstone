#!/usr/bin/env bash
# Binding B of docs/dispatch.md, executed against the real tools:
#   session host       = herdr panes (herdr pane split / run / read / close)
#   workspace provider = treehouse leases (treehouse get --lease / return)
#   agent harness      = whatever $AGENT_COMMAND names
#
# Two substitutions, both called out in the transcript:
#   * `herdr agent start --kind ... && herdr agent prompt --wait` is the recipe's
#     line when AGENT_COMMAND is one of herdr's supported agent kinds. Launching a
#     real LLM agent is not something a test run should do, so the configured
#     command is started in the same pane with `herdr pane run` instead; the pane
#     is still the session host, which is the axis this binding proves.
#   * There is no code host here, so a "PR merge" is a --no-ff merge of the
#     claimed branch into origin/main, and merge evidence is read back from the
#     remote exactly as the recipe requires.
set -u

STEPSTONE_CLI=${STEPSTONE_CLI:?set STEPSTONE_CLI to the stepstone cli entrypoint}
DEMO=${DEMO:-/tmp/ss-dispatch-b}
ROOT="$DEMO/root"
export AGENT_COMMAND=${AGENT_COMMAND:-/tmp/ss-dispatch/fake-agent.sh}
HOST_PANE=${HOST_PANE:?set HOST_PANE to the pane the root session splits from}

ss() { node "$STEPSTONE_CLI" project "$@"; }
say() { printf '\n=== %s\n' "$*"; }
run() {
	printf '\n$ %s\n' "$*"
	"$@"
	local status=$?
	printf '[exit %s]\n' "$status"
	return $status
}
runq() {
	local filter=$1
	shift
	printf '\n$ %s\n' "$*"
	local out status
	out=$("$@" 2>&1)
	status=$?
	[ -n "$out" ] && { printf '%s\n' "$out" | jq -c "$filter" 2>/dev/null || printf '%s\n' "$out"; }
	printf '[exit %s]\n' "$status"
	return $status
}

# Reset the scratch repository and its pool so a re-run starts from one plan.
if [ -d "$DEMO/pool/.treehouse" ]; then
	for leased in $(treehouse status 2>/dev/null | awk '/leased/ {print $3}'); do
		treehouse return "$leased" --force >/dev/null 2>&1
	done
	treehouse destroy "$DEMO/pool" --all --include-unlanded --include-in-use --yes >/dev/null 2>&1
fi
rm -rf "$DEMO"
mkdir -p "$DEMO"
git init -q --bare -b main "$DEMO/origin.git"
git init -q -b main "$ROOT"
git -C "$ROOT" config user.email root@example.com
git -C "$ROOT" config user.name "root session"
git -C "$ROOT" remote add origin "$DEMO/origin.git"
printf 'demo project\n' >"$ROOT/README.md"
printf 'max_trees = 4\nroot = "%s/pool"\n' "$DEMO" >"$ROOT/treehouse.toml"
git -C "$ROOT" add -A
git -C "$ROOT" commit -qm "chore: init"
git -C "$ROOT" push -q -u origin main

cd "$ROOT" || exit 1

say "Scenario: root session on main, treehouse pool configured for this repo"
run cat "$ROOT/treehouse.toml"

cat >"$DEMO/plan.json" <<'PLAN'
[
  { "title": "Extract config loader", "group": "Foundation" },
  { "title": "Cache config lookups", "group": "Foundation" }
]
PLAN

say "Contract step 1: apply the approved plan"
runq '.result.goals[] | {id, title}' ss apply-plan "$DEMO/plan.json" --json
git add -A && git commit -qm "chore: approved plan" >/dev/null && git push -q origin main
PLAN_IDS=$(ss list --json | jq -r '.result.goals[].id')

say "Why the branch name is chosen by the driver and not read back from the leased checkout"
probe=$(treehouse get --lease --lease-holder "stepstone:probe" 2>/dev/null)
printf 'leased %s\n' "$probe"
printf 'git -C <leased> branch --show-current -> [%s] (pooled worktree arrives detached)\n' \
	"$(git -C "$probe" branch --show-current)"
printf '$ stepstone project start %s --branch "" (what reading it back would send)\n' "$(echo "$PLAN_IDS" | head -1)"
probe_out=$(ss start "$(echo "$PLAN_IDS" | head -1)" --branch "" 2>&1)
probe_status=$?
printf '%s\n[exit %s]\n' "$(printf '%s' "$probe_out" | head -2)" "$probe_status"
treehouse return "$probe" --if-lease-holder "stepstone:probe" >/dev/null 2>&1

say "Herdr's real agent-name rule, and why the goal ID cannot be the agent name"
long_id="root-session-recipe-herdr-treehouse"
printf '$ herdr agent start "%s" --kind claude --pane <pane>\n' "$long_id"
herdr agent start "$long_id" --kind claude --pane "wX:pNOPE" 2>&1 | jq -c '.error' 2>/dev/null
derived=$(printf 'ss-%.18s-%s' "$long_id" "$(printf %s "$long_id" | cksum | cut -d' ' -f1)")
printf 'derived name for that goal: %s (%s chars)\n' "$derived" "${#derived}"
printf '$ herdr agent start "%s" --kind claude --pane <nonexistent pane>\n' "$derived"
herdr agent start "$derived" --kind claude --pane "wX:pNOPE" 2>&1 | jq -c '.error' 2>/dev/null
printf '  -> the derived name clears name validation and fails only on the pane\n'

# ---------------------------------------------------------------------------
PANES=()
LEASES=()
DISPATCHED=()

abandon() {
	local goal_id=$1 workspace=$2 holder=$3
	ss start "$goal_id" --clear >/dev/null 2>&1
	treehouse return "$workspace" --if-lease-holder "$holder" >/dev/null 2>&1
}

merged_into_default_branch() {
	git fetch -q origin
	git merge-base --is-ancestor "origin/$1" origin/main 2>/dev/null
}

merge_pull_request() {
	git fetch -q origin "$1"
	git checkout -q main
	git merge -q --no-ff -m "Merge pull request from $1" "origin/$1"
	git push -q origin main
}

say "Contract step 2: read the ready frontier"
READY=$(ss ready --json)
echo "$READY" | jq -c '.result.goals[] | {id, title, updatedAt}'

say "Contract steps 3-5: lease a workspace, claim, split a pane, run the configured agent in it"
for row in $(echo "$READY" | jq -r '.result.goals[] | @base64'); do
	goal_id=$(echo "$row" | base64 -d | jq -r '.id')
	updated_at=$(echo "$row" | base64 -d | jq -r '.updatedAt')
	prompt=$(ss show "$goal_id" --json | jq -r '.result.goal | "Goal \(.id): \(.title)"')
	lease_holder="stepstone:$goal_id"
	branch="stepstone/$goal_id"
	base=$(git rev-parse HEAD)

	printf '\n--- dispatching %s\n' "$goal_id"
	printf '$ treehouse get --lease --lease-holder %s\n' "$lease_holder"
	workspace=$(treehouse get --lease --lease-holder "$lease_holder" 2>/dev/null)
	printf '  leased %s\n' "$workspace"

	printf '$ stepstone project start %s --branch %s --expect-updated-at %s\n' "$goal_id" "$branch" "$updated_at"
	if ! ss start "$goal_id" --branch "$branch" --expect-updated-at "$updated_at" >/dev/null 2>&1; then
		printf '  claim rejected -> return the lease, launch nothing\n'
		treehouse return "$workspace" --if-lease-holder "$lease_holder" >/dev/null 2>&1
		continue
	fi
	printf '  claimed\n'

	printf '$ git -C <leased> checkout -b %s %s\n' "$branch" "$base"
	git -C "$workspace" checkout -q -b "$branch" "$base" || {
		abandon "$goal_id" "$workspace" "$lease_holder"
		continue
	}

	printf '$ herdr pane split --pane %s --direction right --cwd <leased> --no-focus\n' "$HOST_PANE"
	pane_id=$(herdr pane split --pane "$HOST_PANE" --direction right --cwd "$workspace" --no-focus |
		jq -r '.result.pane.pane_id')
	case "$pane_id" in "" | null)
		printf '  no pane id -> abandon\n'
		abandon "$goal_id" "$workspace" "$lease_holder"
		continue
		;;
	esac
	printf '  pane %s hosts the session, cwd %s\n' "$pane_id" \
		"$(herdr pane get "$pane_id" | jq -r '.result.pane.cwd')"

	agent_name=$(printf 'ss-%.18s-%s' "$goal_id" "$(printf %s "$goal_id" | cksum | cut -d' ' -f1)")
	printf '  derived herdr agent name: %s (%s chars)\n' "$agent_name" "${#agent_name}"
	printf '$ herdr pane run %s %s "<goal prompt>"   # stands in for `herdr agent start/prompt`\n' "$pane_id" "$AGENT_COMMAND"
	herdr pane run "$pane_id" "$AGENT_COMMAND" "$prompt" >/dev/null || {
		abandon "$goal_id" "$workspace" "$lease_holder"
		continue
	}

	DISPATCHED+=("$goal_id")
	PANES+=("$pane_id")
	LEASES+=("$workspace")
done

say "Two goals are claimed, each in its own leased worktree, each hosted by its own pane"
runq '{stillReady: [.result.goals[].id]}' ss ready --json
runq '[.result.goals[] | select(.branch != null) | {id, branch}]' ss list --json
run treehouse status

say "Contract step 6: watch the panes, but take only merge evidence as completion"
for i in "${!DISPATCHED[@]}"; do
	goal_id=${DISPATCHED[$i]}
	pane=${PANES[$i]}
	herdr pane wait-output "$pane" --match "agent finished" --source recent-unwrapped --timeout 60000 >/dev/null 2>&1
	printf '\n--- pane %s (%s), read back from the session host:\n' "$pane" "$goal_id"
	herdr pane read "$pane" --source recent-unwrapped --lines 40 --format text |
		grep -v '^[[:space:]]*$' | tail -3 | sed 's/^/  | /'
done

first=${DISPATCHED[0]}
say "The worker is done in its pane, but $first has no merged PR yet"
if merged_into_default_branch "stepstone/$first"; then
	echo "  UNEXPECTED: already merged"
else
	echo "  origin/stepstone/$first is not an ancestor of origin/main -> no completion"
	runq '.result.goal | {id, status, branch}' ss show "$first" --json
fi

say "Reviewer merges both PRs, root session verifies, then completes on main"
for goal_id in "${DISPATCHED[@]}"; do
	merge_pull_request "stepstone/$goal_id"
	if merged_into_default_branch "stepstone/$goal_id" && echo "$PLAN_IDS" | grep -qx "$goal_id"; then
		printf '  %s: merged into origin/main and inside the approved plan -> standing consent applies\n' "$goal_id"
		fresh=$(ss show "$goal_id" --json | jq -r '.result.goal.updatedAt')
		runq '.result.goal | {id, status, completedAt, branch}' ss complete "$goal_id" --expect-updated-at "$fresh" --confirm --json
	fi
done
git add -A && git commit -qm "chore: complete dispatched goals" >/dev/null && git push -q origin main

say "Contract step 8: close each pane, return each lease"
for i in "${!DISPATCHED[@]}"; do
	run herdr pane close "${PANES[$i]}"
	run treehouse return "${LEASES[$i]}" --if-lease-holder "stepstone:${DISPATCHED[$i]}"
done
run treehouse status

say "Re-dispatching a goal whose branch survives: checkout -b fails, and the guard releases claim and lease"
stale_goal=${DISPATCHED[0]}
runq '.result.goal | {id, status}' ss reopen "$stale_goal" --confirm --json
updated_at=$(ss show "$stale_goal" --json | jq -r '.result.goal.updatedAt')
lease_holder="stepstone:$stale_goal"
workspace=$(treehouse get --lease --lease-holder "$lease_holder" 2>/dev/null)
printf 'leased %s\n' "$workspace"
ss start "$stale_goal" --branch "stepstone/$stale_goal" --expect-updated-at "$updated_at" >/dev/null 2>&1
printf 'claimed %s\n' "$stale_goal"
printf '$ git -C <leased> checkout -b stepstone/%s <base>\n' "$stale_goal"
if git -C "$workspace" checkout -q -b "stepstone/$stale_goal" "$(git rev-parse HEAD)" 2>&1; then
	echo "  UNEXPECTED: stale branch was reused"
else
	echo "  checkout -b refused the existing branch -> abandon()"
	abandon "$stale_goal" "$workspace" "$lease_holder"
fi
runq '.result.goal | {id, status, branch}' ss show "$stale_goal" --json
run treehouse status

say "Final roadmap state"
runq '[.result.goals[] | {id, status}]' ss list --json
