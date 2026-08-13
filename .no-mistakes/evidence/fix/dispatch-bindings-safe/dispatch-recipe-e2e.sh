#!/bin/sh
# End-to-end demonstration of the packaged dispatch recipe shipped in docs/dispatch.md.
#
# Every scenario below executes the exact fenced examples from the shipped
# document, extracted by their "# dispatch-example:" markers, with no
# substitute driver commands.
#
# Real boundaries used here:
#   - real git repository, real git worktrees and branches
#   - the real Stepstone CLI, reached through the `npx -y stepstone@latest`
#     invocation the document prescribes (resolved to this working tree)
#   - real Treehouse leases from a pool confined to the sandbox
#   - a real detached worker process for Binding A
#
# Herdr is the one faked boundary: a real `herdr pane split` + `agent start`
# would open a pane and launch a paid coding agent inside the operator's live
# session. Its envelopes match the live `herdr pane list` output captured in
# real-boundary-contracts.log.
set -u

REPO=$(cd "$1" && pwd)
sandbox=$(mktemp -d /tmp/stepstone-dispatch-e2e-XXXXXX)
root="$sandbox/root"
bin="$sandbox/bin"
pool="$sandbox/pool"
examples="$sandbox/examples"
mkdir -p "$root" "$bin" "$pool" "$examples"

EVENTS="$sandbox/herdr-events.log"
PANE_CLOSED="$sandbox/pane-closed"
STEPSTONE_CLI="$REPO/src/cli.ts"
XDG_STATE_HOME="$sandbox/state"
PATH="$bin:$PATH"
export EVENTS PANE_CLOSED STEPSTONE_CLI XDG_STATE_HOME PATH
: >"$EVENTS"

banner() {
	printf '\n\n================================================================\n%s\n================================================================\n' "$1"
}
step() { printf '\n--- %s\n' "$1"; }
run() {
	printf '\n$ %s\n' "$1"
	sh -uc "$1" 2>&1
	printf '[exit %s]\n' "$?"
}

extract() {
	node -e '
const fs = require("fs");
const markdown = fs.readFileSync(process.argv[1], "utf8");
const marker = "# dispatch-example: " + process.argv[2];
for (const match of markdown.matchAll(/```sh\n([\s\S]*?)\n```/g)) {
	if (match[1].includes(marker)) { process.stdout.write(match[1] + "\n"); process.exit(0); }
}
process.exit(1);
' "$REPO/docs/dispatch.md" "$1" >"$examples/$1.sh" || {
		printf 'missing documented example: %s\n' "$1"
		exit 1
	}
}

extract_containing() {
	node -e '
const fs = require("fs");
const markdown = fs.readFileSync(process.argv[1], "utf8");
for (const match of markdown.matchAll(/```sh\n([\s\S]*?)\n```/g)) {
	if (match[1].includes(process.argv[2])) { process.stdout.write(match[1] + "\n"); process.exit(0); }
}
process.exit(1);
' "$REPO/docs/dispatch.md" "$2" >"$examples/$1.sh" || {
		printf 'missing documented block containing: %s\n' "$2"
		exit 1
	}
}

extract binding-a-workspace
extract binding-a-launch
extract binding-a-cleanup
extract binding-b-workspace
extract binding-b-launch
extract binding-b-cleanup
extract_containing completion 'project complete'

# --- fake Herdr, shaped like the live socket API envelopes -------------------
cat >"$bin/herdr" <<'HERDR'
#!/bin/sh
printf 'herdr %s\n' "$*" >>"$EVENTS"
case "$1:$2" in
  pane:split) printf '%s\n' '{"id":"cli:pane:split","result":{"pane":{"pane_id":"wZ:p7"},"type":"pane_split"}}' ;;
  pane:close) : >"$PANE_CLOSED" ;;
  pane:list)
    if test -f "$PANE_CLOSED"
    then printf '%s\n' '{"id":"cli:pane:list","result":{"panes":[],"type":"pane_list"}}'
    else printf '%s\n' '{"id":"cli:pane:list","result":{"panes":[{"pane_id":"wZ:p7","agent_status":"working"}],"type":"pane_list"}}'
    fi
    ;;
  agent:start) test "${HERDR_START_RESULT:-ok}" = ok ;;
  agent:prompt) test "${HERDR_PROMPT_RESULT:-ok}" = ok ;;
  *) exit 95 ;;
esac
HERDR
chmod +x "$bin/herdr"

# --- npx, resolving the documented published CLI to this working tree -------
cat >"$bin/npx" <<'NPX'
#!/bin/sh
if [ "$1" = "-y" ] && [ "$2" = "stepstone@latest" ]; then shift 2; fi
exec node "$STEPSTONE_CLI" "$@"
NPX
chmod +x "$bin/npx"

# --- a real detached worker for Binding A -----------------------------------
cat >"$bin/demo-worker" <<'WORKER'
#!/bin/sh
printf 'worker started in %s with prompt: %s\n' "$(pwd)" "$1"
printf 'worker output\n' >worker-artifact.txt
exec sleep 120
WORKER
chmod +x "$bin/demo-worker"

cd "$root" || exit 1
git init -q -b main
git config user.email dispatch-demo@example.invalid
git config user.name "Dispatch Demo"
printf 'demo project\n' >README.md
printf '.cache/\n' >.gitignore
printf 'max_trees = 2\nroot = "%s"\n' "$pool" >treehouse.toml
git add .
git commit -qm "project fixture"

for title in "Ship binding a worker" "Release binding a claim" "Hold binding b custody" "Close binding b cleanly"; do
	node "$STEPSTONE_CLI" project add "$title" --description "Dispatch demonstration goal." >/dev/null
done

banner "Dispatch contract step 2: read the ready frontier from the root checkout"
run 'npx -y stepstone@latest project ready --json | jq -r ".result.goals[] | \"\(.id)  \(.updatedAt)\""'

select_goal() {
	goal_id="$1"
	updated_at=$(npx -y stepstone@latest project ready --json |
		jq -r --arg id "$goal_id" '.result.goals[] | select(.id == $id) | .updatedAt')
	goal_prompt="Implement $goal_id and open a PR."
	export goal_id updated_at goal_prompt
}

banner "SCENARIO 1  Binding A: claim, launch a real detached worker, complete, scrub"
select_goal ship-binding-a-worker
AGENT_COMMAND="$bin/demo-worker"
AGENT_STARTUP_GRACE_SECONDS=1
export AGENT_COMMAND AGENT_STARTUP_GRACE_SECONDS
printf 'goal_id=%s  updated_at=%s\n' "$goal_id" "$updated_at"

step "running documented examples binding-a-workspace + binding-a-launch, then the documented completion block and binding-a-cleanup"
sh -uc "$(
	cat "$examples/binding-a-workspace.sh"
	printf '\n'
	cat "$examples/binding-a-launch.sh"
	cat <<'INSPECT'

printf '\n[state after launch]\n'
printf 'claim recorded on the roadmap: '
npx -y stepstone@latest project show "$goal_id" --json | jq -c '.result.goal | {id, status, branch, updatedAt}'
printf 'claim token retained by the driver: %s\n' "$claimed_updated_at"
git worktree list
printf 'detached worker pid %s alive: ' "$(cat "$runtime/agent.pid")"
kill -0 "$(cat "$runtime/agent.pid")" && printf 'yes\n'
printf 'worker log: %s' "$(cat "$runtime/agent.log")"
printf '\nworker artifact in the isolated checkout: %s\n' "$(cat "$workspace/worker-artifact.txt")"
printf 'driver log and pid file stay outside the reviewed checkout: %s\n' "$(git -C "$workspace" status --porcelain | grep -c 'agent\.\(log\|pid\)')"

printf '\n[the worker leaves a dirty checkout behind, as a real agent does]\n'
printf 'edited\n' >>"$workspace/README.md"
mkdir -p "$workspace/.cache"
: >"$workspace/.cache/build-artifact"
: >"$workspace/scratch-notes.txt"
git -C "$workspace" status --porcelain --ignored

printf '\n[PR merged; documented completion from the root checkout]\n'
kill "$(cat "$runtime/agent.pid")" 2>/dev/null
INSPECT
	cat "$examples/completion.sh"
	cat <<'AFTER'
printf 'goal after completion: '
npx -y stepstone@latest project show "$goal_id" --json | jq -c '.result.goal | {id, status, branch, completedAt}'

printf '\n[documented cleanup of the dirty workspace]\n'
AFTER
	cat "$examples/binding-a-cleanup.sh"
	cat <<'FINAL'
printf 'cleanup exit: %s\n' "$?"
printf 'worktrees now: '
git worktree list
printf 'branch %s now: [%s]\n' "$branch" "$(git branch --list "$branch")"
printf 'workspace directory still present: %s\n' "$(test -e "$workspace" && echo yes || echo no)"
FINAL
)" 2>&1
printf '[scenario exit %s]\n' "$?"

banner "SCENARIO 2  Binding A: the configured agent command is not executable"
select_goal release-binding-a-claim
AGENT_COMMAND=/definitely/not/installed/coding-agent
export AGENT_COMMAND
printf 'goal_id=%s  AGENT_COMMAND=%s\n' "$goal_id" "$AGENT_COMMAND"
step "running documented examples binding-a-workspace + binding-a-launch"
sh -uc "$(
	cat "$examples/binding-a-workspace.sh"
	printf '\n'
	cat "$examples/binding-a-launch.sh"
)" 2>&1
printf '[scenario exit %s]\n' "$?"

step "state after the abandoned launch"
run 'npx -y stepstone@latest project show release-binding-a-claim --json | jq -c ".result.goal | {id, status, branch, updatedAt}"'
run 'git worktree list'
run 'git branch --list "stepstone/release-binding-a-claim"'
run 'test -e ../stepstone-release-binding-a-claim && echo "workspace still present" || echo "workspace removed"'

banner "SCENARIO 2b  Why the clear must carry the claim's own updatedAt"
step "a stale token from before the claim is refused with the conflict exit code"
run 'stale=$(npx -y stepstone@latest project ready --json | jq -r ".result.goals[] | select(.id == \"release-binding-a-claim\") | .updatedAt")
claim=$(npx -y stepstone@latest project start release-binding-a-claim --branch stepstone/release-binding-a-claim --expect-updated-at "$stale" --json | jq -r ".result.goal.updatedAt")
printf "claimed_updated_at=%s\n" "$claim"
printf "clearing with the pre-claim token %s:\n" "$stale"
npx -y stepstone@latest project start release-binding-a-claim --clear --expect-updated-at "$stale" --json
printf "[exit %s]\n" "$?"
printf "clearing with the token the claim returned:\n"
npx -y stepstone@latest project start release-binding-a-claim --clear --expect-updated-at "$claim" --json | jq -c ".result.goal | {id, status, branch}"'

banner "SCENARIO 3  Binding B: an ambiguous prompt outcome preserves custody"
select_goal hold-binding-b-custody
HERDR_AGENT_KIND=claude
HERDR_PROMPT_RESULT=fail
export HERDR_AGENT_KIND HERDR_PROMPT_RESULT
step "running documented examples binding-b-workspace + binding-b-launch against a real Treehouse lease"
sh -uc "$(
	cat "$examples/binding-b-workspace.sh"
	printf '\n'
	cat "$examples/binding-b-launch.sh"
)" 2>&1
printf '[scenario exit %s]\n' "$?"
unset HERDR_PROMPT_RESULT

step "state after the ambiguous prompt: claim, pane, and lease are all preserved"
run 'npx -y stepstone@latest project show hold-binding-b-custody --json | jq -c ".result.goal | {id, status, branch}"'
run 'treehouse status --json | jq -c ".[] | {path, status, lease_holder}"'
run 'cat "$EVENTS"'
run 'herdr pane list | jq -c ".result.panes"'

step "harness teardown of scenario 3 (not part of the documented recipe)"
run 'workspace=$(treehouse status --json | jq -r ".[] | select(.status == \"leased\") | .path")
npx -y stepstone@latest project start hold-binding-b-custody --clear --json >/dev/null
git -C "$workspace" reset --hard HEAD >/dev/null && git -C "$workspace" clean -fdxq
treehouse return "$workspace" --force --if-lease-holder "stepstone:hold-binding-b-custody"'
: >"$EVENTS"

banner "SCENARIO 4  Binding B: pane closes and is verified before the lease returns"
select_goal close-binding-b-cleanly
printf 'goal_id=%s\n' "$goal_id"
step "running documented examples binding-b-workspace + binding-b-launch, then the documented completion block and binding-b-cleanup"
sh -uc "$(
	cat "$examples/binding-b-workspace.sh"
	printf '\n'
	cat "$examples/binding-b-launch.sh"
	cat <<'INSPECT'

printf '\n[state after a successful bounded prompt]\n'
npx -y stepstone@latest project show "$goal_id" --json | jq -c '.result.goal | {id, status, branch}'
printf 'leased workspace: %s\n' "$workspace"
printf 'workspace branch: %s\n' "$(git -C "$workspace" branch --show-current)"
treehouse status --json | jq -c '.[] | {path, status, lease_holder}'

printf '\n[the worker leaves a dirty checkout behind]\n'
printf 'edited\n' >>"$workspace/README.md"
mkdir -p "$workspace/.cache"
: >"$workspace/.cache/build-artifact"
: >"$workspace/scratch-notes.txt"
git -C "$workspace" status --porcelain --ignored

printf '\n[PR merged; documented completion from the root checkout]\n'
INSPECT
	cat "$examples/completion.sh"
	cat <<'AFTER'
npx -y stepstone@latest project show "$goal_id" --json | jq -c '.result.goal | {id, status, branch, completedAt}'

printf '\n[documented cleanup: close the pane, verify it is gone, scrub, return the lease]\n'
AFTER
	cat "$examples/binding-b-cleanup.sh"
	cat <<'FINAL'
printf 'cleanup exit: %s\n' "$?"
printf 'Herdr calls in order:\n'
cat "$EVENTS"
printf 'lease state now: '
treehouse status --json | jq -c '.[] | {path, status, lease_holder}'
printf 'workspace scrubbed: [%s]\n' "$(git -C "$workspace" status --porcelain --ignored)"
FINAL
)" 2>&1
printf '[scenario exit %s]\n' "$?"

banner "Final roadmap state"
run 'npx -y stepstone@latest project list'

banner "Sandbox teardown"
pool_path=$(treehouse status --json 2>/dev/null | jq -r '.[0].path' | awk -F/ '{NF-=2; print}' OFS=/)
run "treehouse destroy '$pool_path' --all --yes | tail -1"
rm -rf "$sandbox"
printf 'sandbox %s removed: %s\n' "$sandbox" "$(test -e "$sandbox" && echo no || echo yes)"
