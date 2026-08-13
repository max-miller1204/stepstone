import sys, pathlib
src = pathlib.Path(sys.argv[2])
doc = src.read_text()
mid = sys.argv[1]

def sub(old, new, count=1):
    global doc
    assert doc.count(old) >= count, f"anchor not found: {old!r}"
    doc = doc.replace(old, new, count)

if mid == "unguarded-clear":
    # abandon() clears without the token its own claim returned
    sub('''  npx -y stepstone@latest project start "$goal_id" --clear \\
    --expect-updated-at "$claimed_updated_at" \\
    --json || exit 1''', '''  npx -y stepstone@latest project start "$goal_id" --clear --json || exit 1''', 2)
elif mid == "no-handshake":
    # detached launch trusts nohup's fork instead of verifying the process survived
    sub('''  printf '%s\\n' "$agent_pid" >"$runtime/agent.pid" &&
    sleep "${AGENT_STARTUP_GRACE_SECONDS:-1}" &&
    kill -0 "$agent_pid" 2>/dev/null''', '''  printf '%s\\n' "$agent_pid" >"$runtime/agent.pid"''')
elif mid == "abandon-on-ambiguous-prompt":
    # ambiguous prompt failure treated as permission to abandon a submitted worker
    sub('''if ! herdr agent prompt "$pane_id" "$goal_prompt" --wait \\
  --timeout "${HERDR_PROMPT_TIMEOUT_MS:-300000}"
then
  printf '%s\\n' "Prompt outcome is ambiguous; claim, pane, and lease are preserved." >&2
  exit 1
fi''', '''herdr agent prompt "$pane_id" "$goal_prompt" --wait || abandon''')
elif mid == "unchecked-worktree-removal":
    # cleanup stops scrubbing and stops forcing removal
    sub('''cleanup_workspace() {
  git -C "$workspace" reset --hard HEAD &&
    git -C "$workspace" clean -fdx &&
    workspace_status=$(git -C "$workspace" status --porcelain) &&
    test -z "$workspace_status" &&
    git worktree remove --force "$workspace" &&
    git branch -D "$branch"
}''', '''cleanup_workspace() {
  git worktree remove "$workspace" &&
    git branch -D "$branch"
}''')
elif mid == "lease-before-pane-close":
    # lease goes back without closing or verifying the pane
    sub('''close_pane || exit 1
cleanup_lease || exit 1''', '''cleanup_lease || exit 1''')
elif mid == "unbounded-wait":
    # documented liveness wait loses its default bound
    sub('''herdr agent wait "$pane_id" --timeout "${HERDR_WAIT_TIMEOUT_MS:-300000}"''',
        '''herdr agent wait "$pane_id"''')
else:
    raise SystemExit(f"unknown mutation {mid}")
src.write_text(doc)
