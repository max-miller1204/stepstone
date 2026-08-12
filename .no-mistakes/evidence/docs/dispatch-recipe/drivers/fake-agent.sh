#!/usr/bin/env bash
# A stand-in for whatever $AGENT_COMMAND names in a real dispatch run.
# It receives the goal as its single prompt argument, works in the isolated
# checkout it was launched in, and pushes its branch. It never touches the
# roadmap: workers are not roadmap writers.
set -eu

prompt=$1
branch=$(git rev-parse --abbrev-ref HEAD)
slug=${branch#stepstone/}

git config user.email "agent@example.com"
git config user.name "dispatched agent"

{
	printf '# %s\n\n' "$slug"
	printf 'Implemented from this prompt:\n\n'
	printf '%s\n' "$prompt"
} >"$slug.md"

git add "$slug.md"
git commit -qm "feat: $slug"
git push -q -u origin "$branch"

printf 'agent finished %s on %s; worklist untouched: %s\n' \
	"$slug" "$branch" "$(git status --porcelain .worklist 2>/dev/null | wc -l) worklist changes"
