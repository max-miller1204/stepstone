#!/usr/bin/env bash
# `stepstone project start --json` failure envelopes: detached HEAD vs a Git
# branch lookup that failed. Run against whatever source tree is checked out, so
# the same script produces the "before" and "after" transcripts.
set -u

REPO_SRC="$1"
CLI="$REPO_SRC/src/cli.ts"
WORK="$(cd "$(mktemp -d /tmp/stepstone-evidence-start-XXXXXX)" && pwd -P)"
cd "$WORK" || exit 1

git init -q .
git config user.email evidence@example.com
git config user.name Evidence
node "$CLI" project add "Claim target" > /dev/null
git commit -q --allow-empty -m root

# A Git that resolves the repository the way the real one does and then fails the
# branch lookup however the caller wrote it.
fake_git() {
	local bin
	bin="$(mktemp -d /tmp/stepstone-evidence-fakegit-XXXXXX)"
	{
		printf '#!/bin/sh\n'
		printf 'if [ "$1" = "rev-parse" ]; then\n  printf "%%s\\n" "$PWD"\n  exit 0\nfi\n'
		printf '%s\n' "$@"
	} > "$bin/git"
	chmod +x "$bin/git"
	printf '%s' "$bin"
}

run() {
	printf '$ stepstone %s\n' "$*"
	node "$CLI" "$@" 2>&1
	printf '  [exit %s]\n\n' "$?"
}

run_with_git() {
	local bin="$1"
	shift
	printf '$ PATH=<fake-git>:$PATH stepstone %s\n' "$*"
	PATH="$bin:$PATH" node "$CLI" "$@" 2>&1
	printf '  [exit %s]\n\n' "$?"
}

echo "=== 1. Detached HEAD: a request that simply omitted --branch ==="
git checkout -q --detach
printf '$ git branch --show-current\n%s\n\n' "$(git branch --show-current)"
run project start claim-target --json
run project start claim-target

echo "=== 2. Git refused the branch lookup (too old for --show-current) ==="
UNSUPPORTED="$(fake_git "printf '%s\\n' \"error: unknown option \\\`show-current'\" >&2" "exit 129")"
run_with_git "$UNSUPPORTED" project start claim-target --json
run_with_git "$UNSUPPORTED" project start claim-target

echo "=== 3. The branch lookup never finished (killed before Git answered) ==="
KILLED="$(fake_git "kill -TERM \$\$")"
run_with_git "$KILLED" project start claim-target --json

echo "=== 4. --branch is the way through in every one of them ==="
run project start claim-target --branch feat/explicit --json

printf 'Scratch repository: %s\n' "$WORK"
