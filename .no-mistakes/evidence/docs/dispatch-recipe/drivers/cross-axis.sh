#!/usr/bin/env bash
# The two axes docs/dispatch.md claims are independent, composed the other way
# round from the two documented bindings:
#
#   composition 1: detached process (host from Binding A) + treehouse lease (provider from Binding B)
#   composition 2: herdr pane      (host from Binding B) + git worktree    (provider from Binding A)
#
# Same dispatch contract in both: claim, launch, merge evidence, complete on main.
set -u

STEPSTONE_CLI=${STEPSTONE_CLI:?}
DEMO=${DEMO:-/tmp/ss-dispatch-c}
ROOT="$DEMO/root"
AGENT_COMMAND=${AGENT_COMMAND:-/tmp/ss-dispatch/fake-agent.sh}
HOST_PANE=${HOST_PANE:?}
export XDG_STATE_HOME="$DEMO/state"

ss() { node "$STEPSTONE_CLI" project "$@"; }
say() { printf '\n=== %s\n' "$*"; }

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

cat >"$DEMO/plan.json" <<'PLAN'
[
  { "title": "Detached worker in a leased tree" },
  { "title": "Paned worker in a git worktree" }
]
PLAN
ss apply-plan "$DEMO/plan.json" --json >/dev/null
git add -A && git commit -qm "chore: approved plan" >/dev/null && git push -q origin main

claim() {
	local goal_id=$1 branch=$2
	local updated_at
	updated_at=$(ss show "$goal_id" --json | jq -r '.result.goal.updatedAt')
	ss start "$goal_id" --branch "$branch" --expect-updated-at "$updated_at" >/dev/null
	printf '  claimed %s on %s\n' "$goal_id" "$branch"
}

complete_after_merge() {
	local goal_id=$1 branch=$2
	git fetch -q origin "$branch"
	git checkout -q main
	git merge -q --no-ff -m "Merge pull request from $branch" "origin/$branch"
	git push -q origin main
	git fetch -q origin
	if git merge-base --is-ancestor "origin/$branch" origin/main; then
		printf '  merged-PR evidence for %s\n' "$goal_id"
		local fresh
		fresh=$(ss show "$goal_id" --json | jq -r '.result.goal.updatedAt')
		ss complete "$goal_id" --expect-updated-at "$fresh" --confirm --json |
			jq -c '.result.goal | {id, status, completedAt}'
	fi
}

# --------------------------------------------------------------------------
say "Composition 1: detached process hosting a session inside a treehouse lease"
goal=detached-worker-in-a-leased-tree
branch="stepstone/$goal"
holder="stepstone:$goal"
base=$(git rev-parse HEAD)
workspace=$(treehouse get --lease --lease-holder "$holder" 2>/dev/null)
printf '  leased %s\n' "$workspace"
claim "$goal" "$branch"
git -C "$workspace" checkout -q -b "$branch" "$base"
runtime="$XDG_STATE_HOME/stepstone/dispatch/$goal"
mkdir -p "$runtime"
(
	cd "$workspace" || exit 1
	nohup sh -c 'exec "$@"' sh "$AGENT_COMMAND" "Goal $goal" >"$runtime/agent.log" 2>&1 </dev/null &
	echo $! >"$runtime/agent.pid"
)
pid=$(cat "$runtime/agent.pid")
printf '  detached pid %s working in the leased tree\n' "$pid"
while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
printf '  worker log: %s\n' "$(tail -n 1 "$runtime/agent.log")"
complete_after_merge "$goal" "$branch"
treehouse return "$workspace" --if-lease-holder "$holder" >/dev/null 2>&1
printf '  lease returned\n'

# --------------------------------------------------------------------------
say "Composition 2: herdr pane hosting a session inside a plain git worktree"
goal=paned-worker-in-a-git-worktree
branch="stepstone/$goal"
workspace="$DEMO/ws-$goal"
git worktree add -q -b "$branch" "$workspace" HEAD
printf '  git worktree at %s\n' "$workspace"
claim "$goal" "$branch"
pane_id=$(herdr pane split --pane "$HOST_PANE" --direction right --cwd "$workspace" --no-focus |
	jq -r '.result.pane.pane_id')
printf '  pane %s hosts the session, cwd %s\n' "$pane_id" "$(herdr pane get "$pane_id" | jq -r '.result.pane.cwd')"
herdr pane run "$pane_id" "$AGENT_COMMAND" "Goal $goal" >/dev/null
herdr pane wait-output "$pane_id" --match "agent finished" --source recent-unwrapped --timeout 60000 >/dev/null 2>&1
printf '  pane output: %s\n' \
	"$(herdr pane read "$pane_id" --source recent-unwrapped --lines 40 --format text | grep -F 'agent finished' | tail -1)"
complete_after_merge "$goal" "$branch"
herdr pane close "$pane_id" >/dev/null
git worktree remove "$workspace"
printf '  pane closed, worktree removed\n'

say "Both compositions ran the same contract; roadmap after the loop"
ss list --json | jq -c '[.result.goals[] | {id, status}]'
ss ready --json | jq -c '{ready: [.result.goals[].id]}'
treehouse status
