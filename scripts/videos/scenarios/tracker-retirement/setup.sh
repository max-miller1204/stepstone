#!/usr/bin/env bash
set -euo pipefail
: "${VIDEO_WORKSPACE:?Run through npm run videos:check or videos:render}"
: "${VIDEO_REPOSITORY:?Missing repository root}"
demo="$VIDEO_WORKSPACE"
mkdir -p "$demo/repo"
git -C "$demo/repo" init --quiet --initial-branch=main
git -C "$demo/repo" config user.name "Stepstone Demo"
git -C "$demo/repo" config user.email "demo@stepstone.local"
node "$VIDEO_REPOSITORY/dist/cli.js" project add "Guide" --cwd "$demo/repo"
node "$VIDEO_REPOSITORY/dist/cli.js" project add "Publish" --depends-on guide --cwd "$demo/repo"
node "$VIDEO_REPOSITORY/dist/cli.js" project start guide --branch feature/guide --cwd "$demo/repo"
git -C "$demo/repo" add .
git -C "$demo/repo" commit --quiet -m "Seed tracker demo"
git -C "$demo/repo" worktree add --quiet -b feature/guide ../existing
printf 'Existing handoff\n' > "$demo/existing/STEPSTONE_GOAL.md"
printf 'Unfinished draft\n' > "$demo/existing/draft.md"
mkdir -p "$demo/repo/.git/stepstone-dispatch/workspaces"
printf '{"version":2,"id":"preserved-run"}\n' > "$demo/repo/.git/stepstone-dispatch/preserved-run.json"
printf '{"marker":"preserved-owner"}\n' > "$demo/repo/.git/stepstone-dispatch/workspaces/preserved-owner.json"
cp "$demo/repo/.worklist/worklist.json" "$demo/before.json"
worktree_gitdir=$(git -C "$demo/existing" rev-parse --absolute-git-dir)
printf '{"runId":"preserved-run","goalId":"guide"}\n' > "$worktree_gitdir/stepstone-dispatch-owner.json"
cp "$demo/existing/STEPSTONE_GOAL.md" "$demo/handoff.before"
cp "$demo/repo/.git/stepstone-dispatch/preserved-run.json" "$demo/journal.before"
cp "$worktree_gitdir/stepstone-dispatch-owner.json" "$demo/owner.before"
