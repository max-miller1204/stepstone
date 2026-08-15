#!/bin/bash
# Repro used to produce startup-grace-race.txt.
#
# Runs the REAL documented Binding A snippets out of docs/dispatch.md against a
# doomed agent whose exec+exit takes ~300ms (standing in for the fork/exec/exit
# scheduling delay a loaded CI runner adds), once with the pre-fix 0.05s grace
# and once with the documented 1s default. Observable outcome asserted: does the
# snippet notice the agent died, release the claim and scrub the workspace?
REPO=${1:?pass the stepstone checkout as $1}

extract() {
  node -e '
const fs = require("fs");
const md = fs.readFileSync(process.argv[1], "utf8");
const marker = `# dispatch-example: ${process.argv[2]}`;
for (const m of md.matchAll(/```sh\n([\s\S]*?)\n```/g)) {
  if (m[1].includes(marker)) { process.stdout.write(m[1]); process.exit(0); }
}
process.exit(1);' "$REPO/docs/dispatch.md" "$1"
}

trial() {
  local grace="$1"
  local sandbox; sandbox=$(mktemp -d /tmp/grace-race-XXXXXX)
  local root="$sandbox/root" bin="$sandbox/bin"
  mkdir -p "$root" "$bin"
  git init -q -b main "$root"
  git -C "$root" config user.email t@example.invalid
  git -C "$root" config user.name T
  echo fixture > "$root/README.md"
  git -C "$root" add . && git -C "$root" commit -qm fixture

  cat > "$bin/npx" <<'EOF'
#!/bin/sh
printf "npx:%s\n" "$*" >>"$EVENTS"
case " $* " in
  *" --clear "*) printf '%s\n' '{"result":{"goal":{"updatedAt":"cleared-at"}}}' ;;
  *) printf '%s\n' '{"result":{"goal":{"updatedAt":"claimed-at"}}}' ;;
esac
EOF
  # A doomed agent: it execs, lives ~300ms, then dies without doing any work.
  cat > "$bin/slow-doomed-agent" <<'EOF'
#!/bin/sh
sleep 0.3
exit 127
EOF
  chmod +x "$bin/npx" "$bin/slow-doomed-agent"

  local out code
  out=$(cd "$root" && env \
    PATH="$bin:$PATH" \
    EVENTS="$sandbox/events.log" \
    XDG_STATE_HOME="$sandbox/state" \
    AGENT_COMMAND=slow-doomed-agent \
    AGENT_STARTUP_GRACE_SECONDS="$grace" \
    goal_id=safe-dispatch \
    goal_prompt="Implement the selected goal" \
    updated_at=ready-at \
    sh -u -c "$(extract binding-a-workspace)
$(extract binding-a-launch)" 2>&1)
  code=$?

  printf 'AGENT_STARTUP_GRACE_SECONDS=%s\n' "$grace"
  printf '  snippet exit code ......... %s (1 = agent death detected and custody released)\n' "$code"
  if grep -q -- ' --clear ' "$sandbox/events.log" 2>/dev/null; then
    printf '  claim released ............ yes\n'
  else
    printf '  claim released ............ NO - goal stays claimed by a dead agent\n'
  fi
  if [ -d "$sandbox/stepstone-safe-dispatch" ]; then
    printf '  workspace scrubbed ........ NO - %s left behind\n' "$sandbox/stepstone-safe-dispatch"
  else
    printf '  workspace scrubbed ........ yes\n'
  fi
  if [ -n "$(git -C "$root" branch --list stepstone/safe-dispatch)" ]; then
    printf '  branch deleted ............ NO - stepstone/safe-dispatch left behind\n'
  else
    printf '  branch deleted ............ yes\n'
  fi
  [ -n "$out" ] && printf '  snippet output ............ %s\n' "$(echo "$out" | tr '\n' ' ')"
  echo
  rm -rf "$sandbox"
}

echo "Documented Binding A launch vs a doomed agent that takes ~300ms to die"
echo
trial 0.05
trial 1
