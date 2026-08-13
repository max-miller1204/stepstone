#!/usr/bin/env bash
# A worktree added beside a checkout whose `.git` is a gitdir link.
#
# `git worktree list --porcelain` names the Git directory rather than the
# checkout for such a repository, so a refusal that read only the listing told
# the owner of a repository that has a main checkout that it has none. The
# checkout is recorded in the Git directory itself, and that is the path the
# refusal has to send its reader to.
#
#   A. a Git submodule working tree, which records `core.worktree`
#   B. git init --separate-git-dir, with the checkout recorded
#   C. git init --separate-git-dir, recording nothing at all
#   D. a bare clone, which really has no main checkout
#
#   $1  source tree at the target commit
#   $2  source tree at the previous commit (guard without this fix)
#   $3  scratch directory
set -u

FIXED="$1"
PREV="$2"
WORK="$3"
NODE="$(command -v node)"

rm -rf "$WORK"
mkdir -p "$WORK"

AUTHOR=(-c user.email=dev@example.com -c user.name=Dev)

# Print the command as a user would type it, then run it and print what they see.
run() {
	local src="$1" cwd="$2"
	shift 2
	printf '\n%s $ stepstone %s\n' "${cwd/#$WORK/…}" "$*"
	local out
	out="$(cd "$cwd" && "$NODE" "$src/src/cli.ts" "$@" 2>&1)"
	local code=$?
	[ -n "$out" ] && printf '%s\n' "$out"
	printf '[exit %d]\n' "$code"
}

say() { printf '\n%s\n' "$*"; }

commit_roadmap() {
	git -C "$1" add -A >/dev/null
	git -C "$1" "${AUTHOR[@]}" commit -qm "$2"
}

printf '===============================================================\n'
printf ' A worktree added beside a gitdir-link checkout is sent to that\n'
printf ' checkout, not told its repository has no main worktree\n'
printf ' stepstone CLI: %s/src/cli.ts\n' "$FIXED"
printf ' previous commit: %s/src/cli.ts\n' "$PREV"
printf ' git %s, node %s\n' "$(git --version | awk '{print $3}')" "$("$NODE" --version)"
printf '===============================================================\n'

# ---------------------------------------------------------------- A. submodule
printf '\n\n### A. a submodule working tree, with a worktree added beside it\n'

git init -q "$WORK/vendor-source"
printf 'parser\n' >"$WORK/vendor-source/README.md"
commit_roadmap "$WORK/vendor-source" "seed"

git init -q "$WORK/app"
git -C "$WORK/app" -c protocol.file.allow=always "${AUTHOR[@]}" \
	submodule add -q "$WORK/vendor-source" parser
SUB="$WORK/app/parser"

say "The submodule's .git is a link into the superproject's Git directory:"
printf '  %s/.git: %s\n' "${SUB/#$WORK/…}" "$(cat "$SUB/.git")"
say "so the worktree listing names that Git directory where a checkout is expected:"
git -C "$SUB" worktree list --porcelain | sed 's/^/  /'

say "The submodule is its repository's one main checkout, so it writes its roadmap:"
run "$FIXED" "$SUB" project add "Ship the parser rewrite"
commit_roadmap "$SUB" "roadmap"

say "An agent then takes a worktree of the submodule to work on a goal:"
git -C "$SUB" worktree add -q -b agent/parser "$WORK/parser-agent" HEAD
LINKED="$WORK/parser-agent"

run "$FIXED" "$LINKED" project list

say "-- previous commit ($(basename "$PREV")): refused, but told the repository has no main worktree --"
run "$PREV" "$LINKED" project add "Forked in a worktree" --json

say "-- target commit: refused naming the checkout the Git directory records --"
run "$FIXED" "$LINKED" project add "Forked in a worktree" --json

say "The named checkout can perform the change, so the remedy is one someone can take:"
run "$FIXED" "$SUB" project add "Written where it belongs"
run "$FIXED" "$SUB" project list

say "And the worktree that was refused kept the committed roadmap it had:"
printf '\n%s $ git status --porcelain\n' "${LINKED/#$WORK/…}"
git -C "$LINKED" status --porcelain | sed 's/^/  /'
printf '[clean]\n'

# --------------------------------------------- B. separate git dir, recorded
printf '\n\n### B. git init --separate-git-dir, with the checkout recorded\n'

git init -q --separate-git-dir="$WORK/roadmap.git" "$WORK/separate"
git -C "$WORK/separate" config core.worktree "$WORK/separate"
printf 'fixture\n' >"$WORK/separate/README.md"
commit_roadmap "$WORK/separate" "seed"

say "Its .git is a link too, and the listing names the same way:"
printf '  %s/.git: %s\n' "${WORK/#$WORK/…}/separate" "$(cat "$WORK/separate/.git")"
git -C "$WORK/separate" worktree list --porcelain | sed 's/^/  /'

run "$FIXED" "$WORK/separate" project add "Cut the 1.0 release"
commit_roadmap "$WORK/separate" "roadmap"
git -C "$WORK/separate" worktree add -q -b agent/release "$WORK/separate-agent" HEAD

say "-- previous commit: the same wrong remedy --"
run "$PREV" "$WORK/separate-agent" project add "Forked in a worktree" --json

say "-- target commit --"
run "$FIXED" "$WORK/separate-agent" project add "Forked in a worktree" --json

say "The refused worktree still resolves to its own roadmap, not the main one:"
printf '\n%s $ git rev-parse --show-toplevel\n' "${WORK/#$WORK/…}/separate-agent"
git -C "$WORK/separate-agent" rev-parse --show-toplevel | sed 's/^/  /'

say "And the checkout it names still writes:"
run "$FIXED" "$WORK/separate" project add "Written where it belongs"

# ------------------------------------------ C. separate git dir, recording none
printf '\n\n### C. git init --separate-git-dir that records nothing\n'
printf '\nGit writes the link from the checkout to the Git directory and nothing back,\n'
printf 'so this layout has a main checkout that cannot be named from the Git directory.\n'
printf 'The write is still refused - it would fork the roadmap like any other - and the\n'
printf 'refusal says what is true rather than inventing a path.\n'

git init -q --separate-git-dir="$WORK/silent.git" "$WORK/silent"
printf 'fixture\n' >"$WORK/silent/README.md"
commit_roadmap "$WORK/silent" "seed"
run "$FIXED" "$WORK/silent" project add "Canonical goal"
commit_roadmap "$WORK/silent" "roadmap"
git -C "$WORK/silent" worktree add -q -b agent/silent "$WORK/silent-agent" HEAD

printf '\n%s $ git config core.worktree   (in the Git directory)\n' '…/silent.git'
git -C "$WORK/silent.git" config core.worktree || printf '  (unset)\n'

run "$FIXED" "$WORK/silent-agent" project add "Forked in a worktree" --json

say "The store the message names as a way out is writable from that very worktree:"
printf '\n%s $ STEPSTONE_WORKLIST=%s stepstone project add "Local plan" --json\n' \
	'…/silent-agent' '…/silent-agent/local-plan.json'
out="$(cd "$WORK/silent-agent" && STEPSTONE_WORKLIST="$WORK/silent-agent/local-plan.json" \
	"$NODE" "$FIXED/src/cli.ts" project add "Local plan" 2>&1)"
printf '%s\n[exit %d]\n' "$out" $?

say "and the committed roadmap in that worktree is untouched:"
printf '\n%s $ git status --porcelain\n' '…/silent-agent'
git -C "$WORK/silent-agent" status --porcelain | sed 's/^/  /'

# ------------------------------------------------------------- D. bare clone
printf '\n\n### D. a bare clone, which really has no main checkout\n'
printf '\nThe new lookup must not invent a destination here: a bare Git directory\n'
printf 'records no working tree, and no `git worktree add` gives it one.\n'

git clone -q --bare "$WORK/silent" "$WORK/bare.git"
git -C "$WORK/bare.git" worktree add -q "$WORK/bare-agent" HEAD 2>/dev/null
run "$FIXED" "$WORK/bare-agent" project add "Forked in a worktree" --json

printf '\n===============================================================\n'
printf ' end of transcript\n'
printf '===============================================================\n'
