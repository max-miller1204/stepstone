---
name: push
description:
  Push the current branch and create or update its pull request. Use this skill
  when changes are ready for remote review.
---

# Push

## Preconditions

- `gh auth status` succeeds.
- The current branch is not `main`.
- The intended changes are committed.

## Steps

1. Read `AGENTS.md` and inspect the current branch, status, and diff.
2. Run the complete local validation:

   ```sh
   npm run verify
   npm run no-pi-install:check
   ```

3. Push the branch with upstream tracking:

   ```sh
   git push -u origin HEAD
   ```

4. If Git rejects a non-fast-forward push, use the `pull` skill. Validate again
   before retrying the push. Do not rewrite history unless the current task
   explicitly requires it. Use only `--force-with-lease` after a deliberate
   history rewrite.
5. Create a pull request if none exists. Update the existing pull request when
   one is open. Do not reuse a branch tied to a closed or merged pull request.
6. Use a conventional title that describes the outcome.
7. Write a complete pull request body with these sections:
   - `## What Changed`
   - `## How to reproduce`
   - `## Testing`
   - `## Evidence`
8. Put `<!-- reviewed-pr:start -->` before the body and
   `<!-- reviewed-pr:end -->` after it.
9. Add the `symphony` label.
10. Return the pull request URL.

## Rules

- Run validation before every push.
- Keep the title and body aligned with the complete branch diff.
- Report test results accurately. Do not claim remote CI passed until it did.
- Never run `npm publish`. Releases publish only through CI.
- Stop and report authentication or permission failures. Do not change remotes
  or authentication methods to hide the failure.
