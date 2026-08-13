#!/bin/sh
# The same harness, run against the dispatch recipe as it was documented BEFORE
# this change (base commit c075336). Same fixture, same fake Herdr/Treehouse,
# same real git and real stepstone CLI - only the recipe text differs.
set -u

SRC="$1"
SANDBOX="$2"
DOC="$SANDBOX/base-dispatch.md"
ROOT="$SANDBOX/repo"
BIN="$SANDBOX/bin"
EVENTS="$SANDBOX/events.log"
export EVENTS STEPSTONE_SRC="$SRC" PATH="$BIN:$PATH"
export XDG_STATE_HOME="$SANDBOX/state" PANE_CLOSED="$SANDBOX/pane-closed"
cd "$ROOT" || exit 1

banner() { printf '\n================ %s ================\n' "$*"; }
say() { printf '\n-- %s\n' "$*"; }
quote() { sed 's/^/   | /'; }
indent() { sed 's/^/   /'; }
extract() { python3 "$SANDBOX/extract.py" "$DOC" "$1" ${2:-}; }

A_WORKSPACE=$(extract 'git worktree add -b')
A_LAUNCH=$(extract 'nohup sh -c')
A_CLEANUP=$(extract 'git worktree remove "$workspace"' --shortest)
B_WORKSPACE=$(extract 'treehouse get --lease')
B_LAUNCH=$(extract 'herdr agent prompt')
DOC_CLEAR=$(extract 'project start "$goal_id" --clear' --shortest)

goal_state() {
  npx -y stepstone@latest project show "$1" --json 2>/dev/null |
    jq -c '.result.goal | {id, status, branch, updatedAt}'
}
show_goal() { printf '   roadmap goal: %s\n' "$(goal_state "$1")"; }
show_worktrees() { printf '   git worktrees:\n'; git worktree list | indent; }
show_path() { printf '   %s: %s\n' "$2" "$(test -e "$1" && echo 'present on disk' || echo 'gone from disk')"; }
mark_events() { EVENT_MARK=$(($(wc -l <"$EVENTS") + 1)); }
show_events() { printf '   external commands the recipe ran:\n'; tail -n +"$EVENT_MARK" "$EVENTS" | indent; }

run_snippets() {
  label="$1"; shift
  : >"$SANDBOX/scenario.sh"
  say "$label"
  for part in "$@"; do printf '%s\n' "$part" >>"$SANDBOX/scenario.sh"; done
  quote <"$SANDBOX/scenario.sh"
  printf '\n   $ sh -u scenario.sh   (stdin closed - nothing may prompt)\n'
  sh -u "$SANDBOX/scenario.sh" </dev/null >"$SANDBOX/scenario.out" 2>&1
  SCENARIO_EXIT=$?
  python3 "$SANDBOX/trim.py" <"$SANDBOX/scenario.out" | indent
  printf '   exit status: %s\n' "$SCENARIO_EXIT"
}

export goal_prompt="Implement the selected goal"
export HERDR_AGENT_KIND=claude

banner "Fixture (identical to the after-run)"
: >"$EVENTS"
for title in "Base dispatch handshake" "Base dispatch cleanup" "Base dispatch clear" "Base dispatch ambiguous"; do
  npx -y stepstone@latest project add "$title" --description "dispatched by the previously documented recipe" --json >/dev/null
done
npx -y stepstone@latest project list | indent
printf '#!/bin/sh\nexit 127\n' >"$BIN/broken-agent"; chmod +x "$BIN/broken-agent"
printf '#!/bin/sh\nexec sleep 45\n' >"$BIN/worker-agent"; chmod +x "$BIN/worker-agent"

########################################################################
banner "BEFORE 1 - Binding A: a worker that never starts leaves the goal claimed"
export goal_id=base-dispatch-handshake
export updated_at=$(goal_state "$goal_id" | jq -r '.updatedAt')
export AGENT_COMMAND=broken-agent
mark_events
run_snippets "previously documented Binding A workspace + launch, AGENT_COMMAND exits 127 immediately" "$A_WORKSPACE" "$A_LAUNCH"
printf '   agent log: %s\n' "$(cat "$XDG_STATE_HOME/stepstone/dispatch/$goal_id/agent.log" 2>/dev/null | tr '\n' ' ')"
printf '   recorded worker pid %s is %s\n' "$(cat "$XDG_STATE_HOME/stepstone/dispatch/$goal_id/agent.pid" 2>/dev/null)" \
  "$(kill -0 "$(cat "$XDG_STATE_HOME/stepstone/dispatch/$goal_id/agent.pid" 2>/dev/null)" 2>/dev/null && echo running || echo 'not running')"
show_goal "$goal_id"
show_path "$SANDBOX/stepstone-$goal_id" "worker workspace"
show_events
printf '   >> the launch reported success, so the goal stays claimed with nobody working it.\n'

########################################################################
banner "BEFORE 2 - Binding A: cleanup refuses a dirty checkout and leaves it behind"
export goal_id=base-dispatch-cleanup
export updated_at=$(goal_state "$goal_id" | jq -r '.updatedAt')
export AGENT_COMMAND=worker-agent
mark_events
run_snippets "previously documented workspace + launch, worker residue, then the previously documented cleanup" \
  "$A_WORKSPACE" "$A_LAUNCH" \
  '
# --- glue: the worker finishes and leaves residue behind ---
kill "$(cat "$XDG_STATE_HOME/stepstone/dispatch/$goal_id/agent.pid")" 2>/dev/null
printf "rewritten by the worker\n" >"$workspace/README.md"
mkdir -p "$workspace/.cache" && : >"$workspace/.cache/build-output" && : >"$workspace/untracked.txt"
# --- end glue ---
' "$A_CLEANUP"
show_path "$SANDBOX/stepstone-$goal_id" "worker workspace"
show_worktrees
printf '   >> the worktree and its branch survive the documented cleanup.\n'
git worktree remove --force "$SANDBOX/stepstone-$goal_id" >/dev/null 2>&1
git branch -D "stepstone/$goal_id" >/dev/null 2>&1

########################################################################
banner "BEFORE 3 - Binding A: abandoning clears whatever claim it finds"
export goal_id=base-dispatch-clear
export updated_at=$(goal_state "$goal_id" | jq -r '.updatedAt')
npx -y stepstone@latest project start "$goal_id" --branch other-driver/branch --json >/dev/null
printf '   another driver holds the goal:\n'; show_goal "$goal_id"
mark_events
run_snippets "previously documented abandon clear" "$DOC_CLEAR"
show_goal "$goal_id"
printf '   >> the other driver lost its claim to an unrelated abandoning driver.\n'

########################################################################
banner "BEFORE 4 - Binding B: an ambiguous prompt drops custody and leaks the pane"
export goal_id=base-dispatch-ambiguous
export updated_at=$(goal_state "$goal_id" | jq -r '.updatedAt')
export LEASE_WORKSPACE="$SANDBOX/pool-base"
rm -f "$PANE_CLOSED"
git worktree add --detach "$LEASE_WORKSPACE" HEAD >/dev/null 2>&1
export HERDR_PROMPT_RESULT=fail
mark_events
run_snippets "previously documented Binding B workspace + launch, prompt --wait fails after submission" "$B_WORKSPACE" "$B_LAUNCH"
show_goal "$goal_id"
show_path "$LEASE_WORKSPACE" "leased workspace"
printf '   panes Herdr still lists: %s\n' "$(herdr pane list | jq -c '.result.panes')"
show_events
printf '   >> the claim is cleared and the lease is back in the pool while the pane, its agent,\n'
printf '      and whatever the prompt started are still alive.\n'
