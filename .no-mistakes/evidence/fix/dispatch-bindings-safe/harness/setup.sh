#!/bin/sh
set -eu
SANDBOX="$1"
SRC="$2"
NODE_BIN="$3"
mkdir -p "$SANDBOX/repo" "$SANDBOX/bin"
cd "$SANDBOX/repo"
git init -q -b main
git config user.email dispatch-demo@example.invalid
git config user.name "Dispatch Demo"
printf 'dispatch demo\n' >README.md
printf '.cache/\n' >.gitignore
git add .
git commit -qm "fixture"
: >"$SANDBOX/events.log"

# Documented `npx -y stepstone@latest ...` reaches the real local CLI.
cat >"$SANDBOX/bin/npx" <<EOF
#!/bin/sh
printf 'npx %s\n' "\$*" >>"\$EVENTS"
shift 2
exec "$NODE_BIN/node" "$SRC/src/cli.ts" "\$@"
EOF

# Herdr is not installed here; this is its public CLI surface, recording calls.
cat >"$SANDBOX/bin/herdr" <<'EOF'
#!/bin/sh
printf 'herdr %s\n' "$*" >>"$EVENTS"
case "$1:$2" in
  pane:split)
    case "${HERDR_SPLIT_RESULT:-ok}" in
      ok) printf '%s\n' '{"result":{"pane":{"pane_id":"pane-1"}}}' ;;
      malformed) printf '%s\n' '{"result":{}}' ;;
      *) printf 'herdr: split failed\n' >&2; exit 1 ;;
    esac ;;
  pane:close) : >"$PANE_CLOSED" ;;
  pane:list)
    if test -f "$PANE_CLOSED"
    then printf '%s\n' '{"result":{"panes":[]}}'
    else printf '%s\n' '{"result":{"panes":[{"pane_id":"pane-1"}]}}'
    fi ;;
  agent:start) test "${HERDR_START_RESULT:-ok}" = ok || { printf 'herdr: agent start failed\n' >&2; exit 1; } ;;
  agent:prompt)
    test "${HERDR_PROMPT_RESULT:-ok}" = ok ||
      { printf 'herdr: no response before the timeout; the prompt may have been delivered\n' >&2; exit 1; } ;;
  agent:wait) : ;;
  *) printf 'herdr: unsupported command\n' >&2; exit 1 ;;
esac
EOF

# Treehouse is not installed here; this stands in for its lease pool and refuses
# an unforced return or a dirty checkout, the way the real one does.
cat >"$SANDBOX/bin/treehouse" <<'EOF'
#!/bin/sh
printf 'treehouse %s\n' "$*" >>"$EVENTS"
case "$1" in
  get) printf '%s\n' "$LEASE_WORKSPACE" ;;
  return)
    status=$(git -C "$2" status --porcelain) || exit 1
    case " $* " in
      *" --force "*)
        test -z "$status" || printf 'treehouse: forced return took back a checkout that still had worker residue\n' ;;
      *)
        test -z "$status" ||
          { printf 'treehouse: this checkout still has changes; return it interactively or force it\n' >&2; exit 1; } ;;
    esac
    git worktree remove --force "$2" || exit 1
    if test -z "$status"
    then printf 'treehouse: lease returned with a clean checkout\n'
    else printf 'treehouse: lease returned with residue still in it\n'
    fi ;;
  *) printf 'treehouse: unsupported command\n' >&2; exit 1 ;;
esac
EOF
chmod +x "$SANDBOX/bin/npx" "$SANDBOX/bin/herdr" "$SANDBOX/bin/treehouse"
