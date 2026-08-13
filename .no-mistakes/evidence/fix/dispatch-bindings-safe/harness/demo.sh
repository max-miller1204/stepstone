#!/bin/sh
# End-to-end exercise of the packaged dispatch recipe in docs/dispatch.md.
#
# Every dispatch step is the verbatim snippet extracted from the shipped document.
# stepstone is the real local CLI, reached through the documented
# `npx -y stepstone@latest ...` spelling. Git worktrees are real. Only Herdr and
# Treehouse - tools this machine does not have - are faked at their public CLI.
set -u

SRC="$1"
SANDBOX="$2"
DOC="$SRC/docs/dispatch.md"
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

extract_marked() {
  awk -v marker="# dispatch-example: $1" '
    $0 == "```sh" { inb = 1; buf = ""; next }
    $0 == "```" && inb { if (index(buf, marker) > 0) { printf "%s", buf; exit } ; inb = 0; buf = ""; next }
    inb { buf = buf $0 "\n" }
  ' "$DOC"
}
extract_containing() {
  awk -v needle="$1" '
    $0 == "```sh" { inb = 1; buf = ""; next }
    $0 == "```" && inb { if (index(buf, needle) > 0) { printf "%s", buf; exit } ; inb = 0; buf = ""; next }
    inb { buf = buf $0 "\n" }
  ' "$DOC"
}
extract_inline() { grep -o '`[^`]*'"$1"'[^`]*`' "$DOC" | head -1 | tr -d '`'; }

A_WORKSPACE=$(extract_marked binding-a-workspace)
A_LAUNCH=$(extract_marked binding-a-launch)
A_CLEANUP=$(extract_marked binding-a-cleanup)
B_WORKSPACE=$(extract_marked binding-b-workspace)
B_LAUNCH=$(extract_marked binding-b-launch)
B_CLEANUP=$(extract_marked binding-b-cleanup)
DOC_CLEAR=$(extract_containing 'claimed_updated_at')
DOC_WAIT=$(extract_inline 'herdr agent wait')
DOC_COMPLETE=$(extract_containing 'project complete')

goal_state() {
  npx -y stepstone@latest project show "$1" --json 2>/dev/null |
    jq -c '.result.goal | {id, status, branch, updatedAt}'
}
show_goal() { printf '   roadmap goal: %s\n' "$(goal_state "$1")"; }
show_worktrees() { printf '   git worktrees:\n'; git worktree list | indent; }
show_branches() { printf '   git branches: %s\n' "$(git branch --format='%(refname:short)' | tr '\n' ' ')"; }
show_path() { printf '   %s: %s\n' "$2" "$(test -e "$1" && echo 'present on disk' || echo 'gone from disk')"; }
mark_events() { EVENT_MARK=$(($(wc -l <"$EVENTS") + 1)); }
show_events() { printf '   external commands the recipe ran:\n'; tail -n +"$EVENT_MARK" "$EVENTS" | indent; }

run_snippets() {
  label="$1"; shift
  : >"$SANDBOX/scenario.sh"
  say "$label"
  for part in "$@"; do
    printf '%s\n' "$part" >>"$SANDBOX/scenario.sh"
    first=$(printf '%s\n' "$part" | sed -n '1p')
    case "$first" in
      "# dispatch-example: "*)
        printf '   | <<< %s snippet from docs/dispatch.md, verbatim - printed in full above >>>\n' \
          "${first#\# dispatch-example: }" ;;
      *) printf '%s\n' "$part" | quote ;;
    esac
  done
  printf '\n   $ sh -u scenario.sh   (stdin closed - nothing may prompt)\n'
  sh -u "$SANDBOX/scenario.sh" </dev/null >"$SANDBOX/scenario.out" 2>&1
  SCENARIO_EXIT=$?
  { printf '### %s\n' "$label"; cat "$SANDBOX/scenario.out"; } >>"$SANDBOX/raw-output.log"
  python3 "$SANDBOX/trim.py" <"$SANDBOX/scenario.out" | indent
  printf '   exit status: %s\n' "$SCENARIO_EXIT"
}

export goal_prompt="Implement the selected goal"
export HERDR_AGENT_KIND=claude

banner "The documented recipe under test"
printf 'docs/dispatch.md, extracted verbatim by fenced-block marker:\n'
for name in binding-a-workspace binding-a-launch binding-a-cleanup binding-b-workspace binding-b-launch binding-b-cleanup; do
  printf '\n'; extract_marked "$name" | quote
done
printf '\nthe documented abandon clear:\n'; printf '%s\n' "$DOC_CLEAR" | quote
printf '\nthe documented completion step:\n'; printf '%s\n' "$DOC_COMPLETE" | quote
printf '\nthe documented liveness wait:\n'; printf '%s\n' "$DOC_WAIT" | quote

banner "Fixture"
: >"$EVENTS"
printf 'npx on PATH is a shim onto the real local CLI at %s/src/cli.ts, so the documented\n' "$SRC"
printf '`npx -y stepstone@latest ...` command lines run this branch of stepstone unchanged.\n'
command -v npx | sed 's/^/   npx resolves to: /'
command -v herdr | sed 's/^/   herdr resolves to: /'
command -v treehouse | sed 's/^/   treehouse resolves to: /' 
printf 'real git repository:\n'; git log --oneline | indent
printf 'real stepstone roadmap, seeded through the documented CLI:\n'
for title in "Demo dispatch handshake" "Demo dispatch clear" "Demo dispatch cleanup" "Demo dispatch ambiguous" "Demo dispatch pane"; do
  npx -y stepstone@latest project add "$title" --description "dispatched by the documented recipe" --json >/dev/null
done
npx -y stepstone@latest project list | indent

########################################################################
banner "Scenario 1 - Binding A: the detached agent dies at startup"
export goal_id=demo-dispatch-handshake
export updated_at=$(goal_state "$goal_id" | jq -r '.updatedAt')
printf '#!/bin/sh\nexit 127\n' >"$BIN/broken-agent"; chmod +x "$BIN/broken-agent"
export AGENT_COMMAND=broken-agent
mark_events
run_snippets "documented Binding A workspace + launch, with an AGENT_COMMAND that exits 127 immediately" "$A_WORKSPACE" "$A_LAUNCH"
show_goal "$goal_id"
show_path "$SANDBOX/stepstone-$goal_id" "worker workspace"
show_worktrees
show_branches
show_events

########################################################################
banner "Scenario 2 - Binding A: a rejected claim discards the workspace and clears nothing"
export goal_id=demo-dispatch-handshake
export updated_at="2026-01-01T00:00:00.000Z"
printf '   another driver already moved this goal, so the token this driver read is stale: %s\n' "$updated_at"
export AGENT_COMMAND=broken-agent
mark_events
run_snippets "documented Binding A workspace + launch, with a claim that loses the race" "$A_WORKSPACE" "$A_LAUNCH"
show_goal "$goal_id"
show_path "$SANDBOX/stepstone-$goal_id" "worker workspace"
show_worktrees
show_branches
show_events

########################################################################
banner "Scenario 3 - Binding A: abandoning never clears somebody else's newer claim"
export goal_id=demo-dispatch-clear
export updated_at=$(goal_state "$goal_id" | jq -r '.updatedAt')
printf '#!/bin/sh\nexec sleep 45\n' >"$BIN/worker-agent"; chmod +x "$BIN/worker-agent"
export AGENT_COMMAND=worker-agent
mark_events
run_snippets "documented Binding A workspace + launch, with a worker that survives the startup handshake" "$A_WORKSPACE" "$A_LAUNCH"
show_goal "$goal_id"
show_worktrees
worker_pid=$(cat "$XDG_STATE_HOME/stepstone/dispatch/$goal_id/agent.pid")
printf '   detached worker pid %s: %s\n' "$worker_pid" "$(ps -o args= -p "$worker_pid" 2>/dev/null || echo 'not running')"
printf '   worker log/pid live outside the checkout: %s\n' "$(ls "$XDG_STATE_HOME/stepstone/dispatch/$goal_id" | tr '\n' ' ')"
printf '   worker checkout stays clean for review: %s\n' "$(git -C "$SANDBOX/stepstone-$goal_id" status --porcelain | wc -l | tr -d ' ') changed files"
export claimed_updated_at=$(goal_state "$goal_id" | jq -r '.updatedAt')
printf '   token returned by this driver'\''s own claim: %s\n' "$claimed_updated_at"

say "meanwhile another driver takes the goal over"
npx -y stepstone@latest project start "$goal_id" --clear --json >/dev/null
npx -y stepstone@latest project start "$goal_id" --branch other-driver/branch --json >/dev/null
show_goal "$goal_id"

mark_events
run_snippets "documented abandon clear, using the updatedAt returned by this driver's own claim" "$DOC_CLEAR"
printf '   documented clear exit status %s (4 = conflict), the other driver keeps custody:\n' "$SCENARIO_EXIT"
show_goal "$goal_id"
kill "$worker_pid" 2>/dev/null
git worktree remove --force "$SANDBOX/stepstone-$goal_id" >/dev/null 2>&1
git branch -D "stepstone/$goal_id" >/dev/null 2>&1
npx -y stepstone@latest project start "$goal_id" --clear --json >/dev/null

########################################################################
banner "Scenario 4 - Binding A: dirty workspace cleanup is non-interactive and verified"
export goal_id=demo-dispatch-cleanup
export updated_at=$(goal_state "$goal_id" | jq -r '.updatedAt')
export AGENT_COMMAND=worker-agent
mark_events
run_snippets "documented workspace + launch, worker residue, the documented completion step, then the documented cleanup" \
  "$A_WORKSPACE" "$A_LAUNCH" \
  '
# --- glue: the worker finishes and leaves residue behind ---
kill "$(cat "$XDG_STATE_HOME/stepstone/dispatch/$goal_id/agent.pid")" 2>/dev/null
printf "rewritten by the worker\n" >"$workspace/README.md"
mkdir -p "$workspace/.cache" && : >"$workspace/.cache/build-output" && : >"$workspace/untracked.txt"
echo "worker residue before cleanup:"
git -C "$workspace" status --porcelain --ignored
# --- end glue ---
' "$DOC_COMPLETE" "$A_CLEANUP"
show_path "$SANDBOX/stepstone-$goal_id" "worker workspace"
show_worktrees
show_branches
show_goal "$goal_id"
mark_events

########################################################################
banner "Scenario 5 - Binding B: an ambiguous bounded prompt keeps custody"
export goal_id=demo-dispatch-ambiguous
export updated_at=$(goal_state "$goal_id" | jq -r '.updatedAt')
export LEASE_WORKSPACE="$SANDBOX/pool-1"
git worktree add --detach "$LEASE_WORKSPACE" HEAD >/dev/null 2>&1
printf '   Treehouse hands out a pooled worktree on a detached HEAD: %s\n' "$(git -C "$LEASE_WORKSPACE" rev-parse --abbrev-ref HEAD)"
export HERDR_PROMPT_RESULT=fail HERDR_PROMPT_TIMEOUT_MS=250
mark_events
run_snippets "documented Binding B workspace + launch, where 'herdr agent prompt --wait' fails after submission" "$B_WORKSPACE" "$B_LAUNCH"
show_goal "$goal_id"
show_path "$LEASE_WORKSPACE" "leased workspace"
printf '   pane still open (never closed): %s\n' "$(herdr pane list | jq -c '.result.panes')"
show_events
unset HERDR_PROMPT_RESULT HERDR_PROMPT_TIMEOUT_MS
git worktree remove --force "$LEASE_WORKSPACE" >/dev/null 2>&1
npx -y stepstone@latest project start "$goal_id" --clear --json >/dev/null

########################################################################
banner "Scenario 6 - Binding B: pane closes and is verified before the lease goes back"
export goal_id=demo-dispatch-pane
export updated_at=$(goal_state "$goal_id" | jq -r '.updatedAt')
export LEASE_WORKSPACE="$SANDBOX/pool-2"
rm -f "$PANE_CLOSED"
git worktree add --detach "$LEASE_WORKSPACE" HEAD >/dev/null 2>&1
mark_events
run_snippets "documented Binding B workspace + launch, worker residue, the documented completion step, then the documented cleanup" \
  "$B_WORKSPACE" "$B_LAUNCH" \
  '
# --- glue: the worker leaves residue in the leased checkout ---
echo "pane hosting the agent:"
herdr pane list | jq -c ".result.panes"
printf "rewritten by the worker\n" >"$workspace/README.md"
mkdir -p "$workspace/.cache" && : >"$workspace/.cache/build-output" && : >"$workspace/untracked.txt"
echo "worker residue before cleanup:"
git -C "$workspace" status --porcelain --ignored
# --- end glue ---
' "$DOC_COMPLETE" "$B_CLEANUP"
show_goal "$goal_id"
show_path "$LEASE_WORKSPACE" "leased workspace"
printf '   panes Herdr still lists: %s\n' "$(herdr pane list | jq -c '.result.panes')"
show_worktrees
show_events

########################################################################
banner "Scenario 7 - the documented liveness wait is bounded by default"
mark_events
export pane_id=pane-1
say "documented command, with HERDR_WAIT_TIMEOUT_MS unset"
printf '%s\n' "$DOC_WAIT" | quote
sh -u -c "$DOC_WAIT" </dev/null
printf '   exit status: %s\n' "$?"
show_events

banner "Final roadmap state"
npx -y stepstone@latest project list | indent
printf '\ngit worktrees left behind by the demo:\n'; git worktree list | indent
printf 'git branches left behind by the demo: %s\n' "$(git branch --format='%(refname:short)' | tr '\n' ' ')"
