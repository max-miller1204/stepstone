#!/usr/bin/env bash
# The two ordinary single-checkout layouts whose `.git` is a gitdir link rather
# than a directory, so `git worktree list --porcelain` prints the Git directory
# where a main worktree path is expected:
#
#   A. git init --separate-git-dir=<elsewhere>
#   B. a Git submodule working tree
#
# Neither is anybody's linked worktree, so both must be able to write the
# committed roadmap - and a worktree added beside one of them must still not be.
#
#   $1  source tree at the target commit (guard + gitdir-link fix)
#   $2  source tree at the previous commit (guard without the fix)
#   $3  scratch directory
set -u

FIXED="$1"
PREFIX="$2"
WORK="$3"
NODE="$(command -v node)"

rm -rf "$WORK"
mkdir -p "$WORK"

commit_fixture() {
	git -C "$1" config user.email dev@example.com
	git -C "$1" config user.name Dev
	printf 'fixture\n' >"$1/README.md"
	git -C "$1" add README.md >/dev/null
	git -C "$1" commit -qm initial
}

# Runs `stepstone project add` from $3 using the source tree $2, prints what the
# user sees, and then removes anything it wrote so the next leg starts even.
try() {
	local label="$1" src="$2" cwd="$3" title="$4"
	printf '\n%s $ stepstone project add "%s"\n' "$label" "$title"
	local out
	out="$("$NODE" "$src/src/cli.ts" project add "$title" --cwd "$cwd" 2>&1)"
	local code=$?
	printf '%s\n[exit %d]\n' "$out" "$code"
}

goals() {
	if [ -f "$1" ]; then
		"$NODE" -e 'for(const g of JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).goals)console.log("  - "+g.id)' "$1"
	else
		printf '  (no roadmap file)\n'
	fi
}

printf '===============================================================\n'
printf ' Ordinary main checkouts reached through a gitdir link\n'
printf ' previous commit e1dd6d4 vs target commit %s\n' "$(git -C "$FIXED" rev-parse --short HEAD)"
printf ' git %s, node %s\n' "$(git --version | awk '{print $3}')" "$("$NODE" --version)"
printf '===============================================================\n'

printf '\n=== A. git init --separate-git-dir (named in the goal description) ===\n'
SEP="$WORK/separate"
git init -q --separate-git-dir="$WORK/elsewhere.git" "$SEP"
commit_fixture "$SEP"
printf '\n$ cat separate/.git\n  %s\n' "$(cat "$SEP/.git")"
printf '$ git -C separate rev-parse --absolute-git-dir; ... --git-common-dir; ... --show-toplevel\n'
(cd "$SEP" && git rev-parse --absolute-git-dir && git rev-parse --path-format=absolute --git-common-dir && git rev-parse --show-toplevel) | sed 's/^/  /'
printf '  ^ git-dir equals git-common-dir, so this checkout IS the main worktree.\n'
printf '$ git -C separate worktree list --porcelain | head -1\n'
printf '  %s\n' "$(git -C "$SEP" worktree list --porcelain | head -1)"
printf '  ^ but the listing names the Git directory, not the checkout.\n'
try 'previous commit e1dd6d4' "$PREFIX" "$SEP" "Plan the next release"
rm -rf "$SEP/.worklist"
try 'target commit          ' "$FIXED" "$SEP" "Plan the next release"
printf '\nroadmap in the separate-git-dir checkout:\n'
goals "$SEP/.worklist/worklist.json"

printf '\n--- and a worktree added beside it is still refused ---\n'
git -C "$SEP" add .worklist/worklist.json >/dev/null
git -C "$SEP" commit -qm roadmap
SEPLINKED="$WORK/separate-agent"
printf '\n$ git -C separate worktree add ../separate-agent -b feature/agent\n'
git -C "$SEP" worktree add "$SEPLINKED" -b feature/agent 2>&1 | sed 's/^/  /'
try 'target commit          ' "$FIXED" "$SEPLINKED" "Would fork from a linked worktree"
printf '\n$ git -C separate-agent status --short\n'
if [ -z "$(git -C "$SEPLINKED" status --short)" ]; then
	printf '  (clean - the linked worktree changed nothing)\n'
else
	git -C "$SEPLINKED" status --short | sed 's/^/  /'
fi

printf '\n=== B. a Git submodule working tree ===\n'
CHILD="$WORK/child"
PARENT="$WORK/parent"
git init -q -b main "$CHILD"
commit_fixture "$CHILD"
git init -q -b main "$PARENT"
commit_fixture "$PARENT"
git -C "$PARENT" -c protocol.file.allow=always submodule add -q "$CHILD" sub >/dev/null 2>&1
git -C "$PARENT" commit -qm "add submodule" >/dev/null
printf '\n$ cat parent/sub/.git\n  %s\n' "$(cat "$PARENT/sub/.git")"
printf '$ git -C parent/sub rev-parse --absolute-git-dir; ... --git-common-dir; ... --show-toplevel\n'
(cd "$PARENT/sub" && git rev-parse --absolute-git-dir && git rev-parse --path-format=absolute --git-common-dir && git rev-parse --show-toplevel) | sed 's/^/  /'
printf '  ^ the submodule is the only worktree of its own repository.\n'
printf '$ git -C parent/sub worktree list --porcelain | head -1\n'
printf '  %s\n' "$(git -C "$PARENT/sub" worktree list --porcelain | head -1)"
try 'previous commit e1dd6d4' "$PREFIX" "$PARENT/sub" "Track the submodule work"
rm -rf "$PARENT/sub/.worklist"
try 'target commit          ' "$FIXED" "$PARENT/sub" "Track the submodule work"
printf '\nroadmap in the submodule working tree:\n'
goals "$PARENT/sub/.worklist/worklist.json"
printf 'roadmap in the superproject (must be untouched):\n'
goals "$PARENT/.worklist/worklist.json"
