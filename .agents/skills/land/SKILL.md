---
name: land
description:
  Land a pull request after synchronizing main, resolving feedback, and waiting
  for required checks. Use this skill when a Linear issue enters Merging.
---

# Land

## Preconditions

- `gh auth status` succeeds.
- The working tree is clean.
- The current branch has an open pull request.
- A human moved the Linear issue to `Merging`.

## Steps

1. Read `AGENTS.md` and inspect the pull request, branch, and working tree.
2. Collect all feedback channels:
   - Top-level pull request comments.
   - Inline review comments.
   - Review summaries and states.
3. Resolve each actionable comment. Reply in its original thread with the
   intended action before changing code. Use `[codex]` at the start of every
   agent-authored GitHub comment.
4. Check mergeability. If the pull request conflicts with `main`, use the
   `pull` skill, resolve the conflicts, and run the complete validation:

   ```sh
   npm run verify
   npm run no-pi-install:check
   ```

5. Commit with the `commit` skill and publish with the `push` skill when the
   branch changed.
6. Wait for all GitHub checks on the current head to pass:

   ```sh
   gh pr checks --watch
   ```

7. If a check fails, inspect its logs. Fix the cause, validate, commit, push,
   and wait for the new checks.
8. Refresh comments, reviews, checks, and mergeability. Do not merge while
   actionable feedback, failed checks, or conflicts remain.
9. Preserve this repository's merge-commit history:

   ```sh
   pr_title=$(gh pr view --json title -q .title)
   pr_body=$(gh pr view --json body -q .body)
   gh pr merge --merge --subject "$pr_title" --body "$pr_body"
   ```

10. Confirm that GitHub reports the pull request as merged.
11. Move the Linear issue to `Done` only after the merge is confirmed.

## Rules

- Keep working until the pull request merges or a true external blocker stops
  progress.
- Do not bypass a failed test or unresolved correctness concern.
- Do not enable auto-merge.
- Do not run `npm publish`. Releases publish only through CI.
- Do not delete a branch until GitHub confirms the merge.
