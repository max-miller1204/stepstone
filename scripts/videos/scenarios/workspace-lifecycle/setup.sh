#!/usr/bin/env bash
set -euo pipefail
: "${VIDEO_WORKSPACE:?Run through npm run videos:check or videos:render}"
: "${VIDEO_REPOSITORY:?Missing repository root}"
demo="$VIDEO_WORKSPACE"
mkdir -p "$demo/repo" "$demo/workspaces"
git init --quiet --bare "$demo/origin.git"
git -C "$demo/repo" init --quiet --initial-branch=main
git -C "$demo/repo" config user.name "Stepstone Demo"
git -C "$demo/repo" config user.email "demo@stepstone.local"
git -C "$demo/repo" remote add origin "$demo/origin.git"
node "$VIDEO_REPOSITORY/dist/cli.js" project add "Guide" --description "Document the workspace commands." --cwd "$demo/repo" --json > "$demo/goal.json"
test "$(jq -r .result.goal.id "$demo/goal.json")" = guide
git -C "$demo/repo" add .
git -C "$demo/repo" commit --quiet -m "chore: seed workspace demo"
git -C "$demo/repo" push --quiet --set-upstream origin main
