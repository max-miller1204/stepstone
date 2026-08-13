#!/usr/bin/env bash
# Drives the stepstone CLI exactly the way a user would: one repository with a
# committed roadmap, one linked worktree added with `git worktree add`, and an
# agent session in each of them.
#
#   $1  source tree the CLI is run from (src/cli.ts)
#   $2  scratch directory for the fixture repositories
#   $3  label printed at the top of the transcript
set -u

SRC="$1"
WORK="$2"
LABEL="$3"
NODE="$(command -v node)"

MAIN="$WORK/roadmap"
LINKED="$WORK/roadmap-agent-a"

rm -rf "$WORK"
mkdir -p "$WORK"

say() { printf '\n%s\n' "$*"; }

# Print the command as a user would type it, then run it and print what they see.
run() {
	local cwd="$1"
	shift
	printf '\n%s $ stepstone %s\n' "${cwd/#$WORK/…}" "$*"
	local out
	out="$("$NODE" "$SRC/src/cli.ts" "$@" 2>&1)"
	local code=$?
	[ -n "$out" ] && printf '%s\n' "$out"
	printf '[exit %d]\n' "$code"
	return $code
}

printf '===============================================================\n'
printf ' %s\n' "$LABEL"
printf ' stepstone CLI: %s\n' "$SRC/src/cli.ts"
printf ' git %s, node %s\n' "$(git --version | awk '{print $3}')" "$("$NODE" --version)"
printf '===============================================================\n'

say '--- setup: a repository whose roadmap is committed -------------'
git init -q -b main "$MAIN"
git -C "$MAIN" config user.email dev@example.com
git -C "$MAIN" config user.name Dev
printf 'stepstone fixture\n' >"$MAIN/README.md"
git -C "$MAIN" add README.md >/dev/null
git -C "$MAIN" commit -qm "initial"
cd "$MAIN" || exit 1
run "$MAIN" project add "Ship the worktree guard" --cwd "$MAIN"
git -C "$MAIN" add .worklist/worklist.json >/dev/null
git -C "$MAIN" commit -qm "roadmap: capture the first goal"
printf '\n%s $ git worktree add ../roadmap-agent-a -b feature/agent-a\n' "…/roadmap"
git -C "$MAIN" worktree add "$LINKED" -b feature/agent-a 2>&1 | sed 's/^/  /'

say '--- in the linked worktree: reads still work -------------------'
run "$LINKED" project list --cwd "$LINKED"

say '--- in the linked worktree: a dry run still previews -----------'
cat >"$WORK/plan.json" <<'PLAN'
[{"title": "Previewed only"}]
PLAN
run "$LINKED" project apply-plan "$WORK/plan.json" --dry-run --cwd "$LINKED"

say '--- in the linked worktree: a semantic no-op still succeeds ----'
run "$LINKED" project move ship-the-worktree-guard up --cwd "$LINKED"

say '--- in the linked worktree: a real mutation is refused ---------'
run "$LINKED" project add "Silently forked goal" --cwd "$LINKED"
run "$LINKED" project add "Silently forked goal" --cwd "$LINKED" --json

say '--- in the linked worktree: another mutation interface ---------'
run "$LINKED" project update ship-the-worktree-guard --description "edited from the linked worktree" --cwd "$LINKED"

say '--- in the linked worktree: an explicit --file store is fine ---'
run "$LINKED" project add "Scratch store goal" --file "$WORK/scratch/worklist.json" --cwd "$LINKED"

say '--- in the main worktree: the sole writer still writes ---------'
run "$MAIN" project add "Added from the main worktree" --cwd "$MAIN"

say '--- did the roadmap fork? -------------------------------------'
printf '\ngoals committed roadmap sees in the main worktree:\n'
"$NODE" -e 'const g=require("fs").readFileSync(process.argv[1],"utf8");for(const x of JSON.parse(g).goals)console.log("  - "+x.id)' "$MAIN/.worklist/worklist.json"
printf '\ngoals committed roadmap sees in the linked worktree:\n'
"$NODE" -e 'const g=require("fs").readFileSync(process.argv[1],"utf8");for(const x of JSON.parse(g).goals)console.log("  - "+x.id)' "$LINKED/.worklist/worklist.json"
printf '\n$ git -C %s status --short\n' '…/roadmap-agent-a'
git -C "$LINKED" status --short | sed 's/^/  /'
if git -C "$LINKED" diff --quiet -- .worklist/worklist.json; then
	printf '\nRESULT: the linked worktree left the committed roadmap byte-for-byte unchanged.\n'
else
	printf '\nRESULT: the linked worktree FORKED the committed roadmap (uncommitted divergence above).\n'
fi
printf '\nexplicit --file store written from the linked worktree:\n'
if [ -f "$WORK/scratch/worklist.json" ]; then
	"$NODE" -e 'const g=require("fs").readFileSync(process.argv[1],"utf8");for(const x of JSON.parse(g).goals)console.log("  - "+x.id)' "$WORK/scratch/worklist.json"
else
	printf '  (nothing written)\n'
fi
