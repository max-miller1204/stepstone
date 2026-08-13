#!/usr/bin/env bash
# The two repository layouts the guard has to answer differently:
# A bare clone plus worktrees: Git's first worktree record is the Git directory,
# which holds no working tree, so no checkout of it is the roadmap's sole writer.
set -u

SRC="$1"
WORK="$2"
NODE="$(command -v node)"

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
printf ' A bare clone plus worktrees has no sole writer to send anyone to\n'
printf ' stepstone CLI: %s\n' "$SRC/src/cli.ts"
printf ' git %s, node %s\n' "$(git --version | awk '{print $3}')" "$("$NODE" --version)"
printf '===============================================================\n'

# ------------------------------------------------------------------ 1. bare
SOURCE="$WORK/source"
git init -q -b main "$SOURCE"
git -C "$SOURCE" config user.email dev@example.com
git -C "$SOURCE" config user.name Dev
printf 'fixture\n' >"$SOURCE/README.md"
git -C "$SOURCE" add README.md >/dev/null
git -C "$SOURCE" commit -qm initial
"$NODE" "$SRC/src/cli.ts" project add "Ship the worktree guard" --cwd "$SOURCE" >/dev/null
git -C "$SOURCE" add .worklist/worklist.json >/dev/null
git -C "$SOURCE" commit -qm roadmap

printf '\n=== 1. a bare clone plus a worktree: no checkout is the sole writer ===\n'
BARE="$WORK/roadmap.git"
CHECKOUT="$WORK/checkout"
printf '\n$ git clone --bare source roadmap.git && git -C roadmap.git worktree add ../checkout HEAD\n'
git clone -q --bare "$SOURCE" "$BARE"
git -C "$BARE" worktree add "$CHECKOUT" HEAD 2>&1 | sed 's/^/  /'
printf '\n$ git -C %s worktree list --porcelain | head -3\n' 'roadmap.git'
git -C "$BARE" worktree list --porcelain | head -3 | sed 's/^/  /'

run "$CHECKOUT" project list --cwd "$CHECKOUT"
run "$CHECKOUT" project add "Would fork the roadmap" --cwd "$CHECKOUT" --json
printf '\nthe way out it names, taken from this very checkout:\n'
STEPSTONE_WORKLIST="$WORK/scratch/worklist.json" "$NODE" "$SRC/src/cli.ts" project add "Scratch store goal" --cwd "$CHECKOUT"
printf '[exit %d]\n' $?
printf '\nand the other way out, a clone that does have a main worktree:\n'
git clone -q "$BARE" "$WORK/clone"
run "$WORK/clone" project add "Added in a clone with a main worktree" --cwd "$WORK/clone"


printf '\n=== roadmaps afterwards ===\n'
for path in "$CHECKOUT" "$WORK/clone"; do
	printf '\n%s:\n' "${path/#$WORK/…}"
	"$NODE" -e 'const g=require("fs").readFileSync(process.argv[1],"utf8");for(const x of JSON.parse(g).goals)console.log("  - "+x.id)' "$path/.worklist/worklist.json"
done
printf '\nexplicit $STEPSTONE_WORKLIST store written from the bare-clone checkout:\n'
"$NODE" -e 'const g=require("fs").readFileSync(process.argv[1],"utf8");for(const x of JSON.parse(g).goals)console.log("  - "+x.id)' "$WORK/scratch/worklist.json"
