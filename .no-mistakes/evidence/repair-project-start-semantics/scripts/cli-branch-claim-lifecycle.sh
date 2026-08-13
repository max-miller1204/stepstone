#!/usr/bin/env bash
# End-to-end CLI walkthrough of the repaired branch-claim lifecycle.
# Uses the real `stepstone` CLI entrypoint against a throwaway git repository.
set -u

REPO_SRC="$1"
CLI="$REPO_SRC/src/cli.ts"
WORK="$(mktemp -d /tmp/stepstone-evidence-lifecycle-XXXXXX)"
cd "$WORK" || exit 1

git init -q .
git config user.email evidence@example.com
git config user.name Evidence

run() {
	printf '$ stepstone %s\n' "$*"
	node "$CLI" "$@" 2>&1
	printf '  [exit %s]\n\n' "$?"
}

show() {
	printf '$ cat .worklist/worklist.json\n'
	cat .worklist/worklist.json
	printf '\n'
}

echo "=== A goal is claimed on the branch it is worked on ==="
run project add "Ship the 1.0 release"
git switch -q -c feat/ship-1-0
printf '$ git branch --show-current\n%s\n\n' "$(git branch --show-current)"
run project start ship-the-1-0-release
run project list

echo "=== Lifecycle guardrail: completion still needs an explicit confirmation ==="
run project complete ship-the-1-0-release --json

echo "=== Completing the goal stamps completedAt and releases the claim ==="
run project complete ship-the-1-0-release --confirm --json
show
COMPLETED_AT="$(node -e 'console.log(JSON.parse(require("node:fs").readFileSync(".worklist/worklist.json","utf8")).goals[0].completedAt)')"

echo "=== A merge of two roadmaps leaves a stale claim on the finished goal ==="
node -e '
const fs = require("node:fs");
const file = ".worklist/worklist.json";
const worklist = JSON.parse(fs.readFileSync(file, "utf8"));
worklist.goals[0].branch = "feat/ship-1-0";
fs.writeFileSync(file, `${JSON.stringify(worklist, null, 2)}\n`);
'
show

echo "=== Clearing the stale claim keeps the historical completedAt ==="
run project complete ship-the-1-0-release --confirm --json
show

node -e '
const fs = require("node:fs");
const goal = JSON.parse(fs.readFileSync(".worklist/worklist.json", "utf8")).goals[0];
const first = process.argv[1];
console.log(`historical completedAt : ${first}`);
console.log(`completedAt now        : ${goal.completedAt}`);
console.log(`preserved              : ${goal.completedAt === first}`);
console.log(`updatedAt now          : ${goal.updatedAt}`);
console.log(`updatedAt moved past it: ${goal.updatedAt > goal.completedAt}`);
console.log(`stale branch cleared   : ${goal.branch === undefined}`);
' "$COMPLETED_AT"

echo
echo "=== The ready frontier still hides work someone has already claimed ==="
run project add "Draft the migration"
run project add "Update the docs"
node -e '
const fs = require("node:fs");
const file = ".worklist/worklist.json";
const worklist = JSON.parse(fs.readFileSync(file, "utf8"));
worklist.goals.find((goal) => goal.id === "draft-the-migration").branch = "feat/migration";
fs.writeFileSync(file, `${JSON.stringify(worklist, null, 2)}\n`);
'
printf '(draft-the-migration is claimed on feat/migration by another agent)\n\n'
run project next --json
run project ready --json
run project waves

printf 'Scratch repository: %s\n' "$WORK"
