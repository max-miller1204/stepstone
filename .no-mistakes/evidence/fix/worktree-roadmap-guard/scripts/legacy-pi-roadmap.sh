#!/usr/bin/env bash
# The legacy committed roadmap location, `.pi/worklist.json`, gets the same rule
# as `.worklist/worklist.json`: a linked worktree may read it, may not change it,
# and may not migrate it either, while a store outside both locations stays open.
#
#   $1  source tree the CLI is run from (src/cli.ts)
#   $2  scratch directory
set -u

SRC="$1"
WORK="$2"
NODE="$(command -v node)"

MAIN="$WORK/legacy"
LINKED="$WORK/legacy-agent"

rm -rf "$WORK"
mkdir -p "$WORK"

run() {
	local cwd="$1"
	shift
	printf '\n%s $ stepstone %s\n' "${cwd/#$WORK/…}" "$*"
	local out
	out="$("$NODE" "$SRC/src/cli.ts" "$@" 2>&1)"
	local code=$?
	[ -n "$out" ] && printf '%s\n' "$out"
	printf '[exit %d]\n' "$code"
}

printf '===============================================================\n'
printf ' The legacy .pi/worklist.json roadmap has the same sole writer\n'
printf ' stepstone CLI: %s\n' "$SRC/src/cli.ts"
printf ' git %s, node %s\n' "$(git --version | awk '{print $3}')" "$("$NODE" --version)"
printf '===============================================================\n'

git init -q -b main "$MAIN"
git -C "$MAIN" config user.email dev@example.com
git -C "$MAIN" config user.name Dev
printf 'fixture\n' >"$MAIN/README.md"
git -C "$MAIN" add README.md >/dev/null
git -C "$MAIN" commit -qm initial

printf '\n--- a repository whose roadmap still lives at .pi/worklist.json ---\n'
run "$MAIN" project add "Legacy roadmap goal" --file "$MAIN/.pi/worklist.json" --cwd "$MAIN"
git -C "$MAIN" add .pi/worklist.json >/dev/null
git -C "$MAIN" commit -qm "roadmap: legacy location"
printf '\n$ git worktree add ../legacy-agent -b feature/agent-b\n'
git -C "$MAIN" worktree add "$LINKED" -b feature/agent-b 2>&1 | sed 's/^/  /'

printf '\n--- the linked worktree resolves and reads the legacy file ---\n'
run "$LINKED" project list --cwd "$LINKED"

printf '\n--- changing it from the linked worktree is refused ---\n'
run "$LINKED" project add "Forked legacy goal" --cwd "$LINKED" --json

printf '\n--- so is migrating it, the other mutation interface ---\n'
run "$LINKED" project migrate_path --confirm --cwd "$LINKED"

printf '\n--- a store outside both committed locations still writes ---\n'
printf '\n%s $ STEPSTONE_WORKLIST=…/scratch/worklist.json stepstone project add "Scratch store goal"\n' '…/legacy-agent'
STEPSTONE_WORKLIST="$WORK/scratch/worklist.json" "$NODE" "$SRC/src/cli.ts" project add "Scratch store goal" --cwd "$LINKED" 2>&1
printf '[exit %d]\n' $?

printf '\n--- the main worktree is still the sole writer ---\n'
run "$MAIN" project add "Added from the main worktree" --cwd "$MAIN"

printf '\n=== afterwards ===\n'
printf '\nlegacy roadmap in the main worktree:\n'
"$NODE" -e 'for(const g of JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).goals)console.log("  - "+g.id)' "$MAIN/.pi/worklist.json"
printf '\nlegacy roadmap in the linked worktree:\n'
"$NODE" -e 'for(const g of JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).goals)console.log("  - "+g.id)' "$LINKED/.pi/worklist.json"
printf '\n$ git -C …/legacy-agent status --short\n'
if [ -z "$(git -C "$LINKED" status --short)" ]; then
	printf '  (clean - nothing was written or migrated here)\n'
else
	git -C "$LINKED" status --short | sed 's/^/  /'
fi
printf '\n$STEPSTONE_WORKLIST store written from the linked worktree:\n'
"$NODE" -e 'for(const g of JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).goals)console.log("  - "+g.id)' "$WORK/scratch/worklist.json"
