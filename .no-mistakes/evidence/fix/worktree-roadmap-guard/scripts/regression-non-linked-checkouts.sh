#!/usr/bin/env bash
# Two ordinary single-checkout repositories - neither of them a linked worktree -
# that the guard refuses to let anyone write the committed roadmap in.
#
# Both have one thing in common: their `.git` is a gitdir link rather than a
# directory, so `git worktree list --porcelain` prints the Git directory where a
# main worktree path is expected.
#
#   $1  fixed source tree (target commit)
#   $2  base source tree (base commit)
#   $3  scratch directory
set -u

FIXED="$1"
BASE="$2"
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

try() {
	local label="$1" src="$2" cwd="$3"
	printf '\n%s $ stepstone project add "Plan the next release"\n' "$label"
	local out
	out="$("$NODE" "$src/src/cli.ts" project add "Plan the next release" --cwd "$cwd" 2>&1)"
	local code=$?
	printf '%s\n[exit %d]\n' "$out" "$code"
	rm -rf "$cwd/.worklist"
}

printf '===============================================================\n'
printf ' Layouts refused although they are nobody\x27s linked worktree\n'
printf ' git %s, node %s\n' "$(git --version | awk '{print $3}')" "$("$NODE" --version)"
printf '===============================================================\n'

printf '\n=== A. git init --separate-git-dir (named in the goal description) ===\n'
SEP="$WORK/separate"
git init -q --separate-git-dir="$WORK/elsewhere.git" "$SEP"
commit_fixture "$SEP"
printf '\n$ cat separate/.git\n  %s\n' "$(cat "$SEP/.git")"
printf '$ git -C separate rev-parse --git-dir --git-common-dir --show-toplevel\n'
(cd "$SEP" && git rev-parse --absolute-git-dir && git rev-parse --path-format=absolute --git-common-dir && git rev-parse --show-toplevel) | sed 's/^/  /'
printf '  ^ git-dir equals git-common-dir, so this checkout IS the main worktree.\n'
printf '$ git -C separate worktree list --porcelain | head -1\n'
printf '  %s\n' "$(git -C "$SEP" worktree list --porcelain | head -1)"
printf '  ^ but the listing names the Git directory, not the checkout.\n'
try 'base commit e8d90f3  ' "$BASE" "$SEP"
try 'target commit e1dd6d4' "$FIXED" "$SEP"

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
printf '$ git -C parent/sub rev-parse --git-dir --git-common-dir --show-toplevel\n'
(cd "$PARENT/sub" && git rev-parse --absolute-git-dir && git rev-parse --path-format=absolute --git-common-dir && git rev-parse --show-toplevel) | sed 's/^/  /'
printf '  ^ the submodule is the only worktree of its own repository.\n'
printf '$ git -C parent/sub worktree list --porcelain | head -1\n'
printf '  %s\n' "$(git -C "$PARENT/sub" worktree list --porcelain | head -1)"
try 'base commit e8d90f3  ' "$BASE" "$PARENT/sub"
try 'target commit e1dd6d4' "$FIXED" "$PARENT/sub"
