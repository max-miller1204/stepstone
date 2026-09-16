Output frames/
Require bash
Require node
Require git
Require jq
Set Shell "bash"
Set FontFamily "monospace"
Set FontSize 28
Set LetterSpacing 0
Set Width 1600
Set Height 1000
Set Padding 40
Set Framerate 30
Set Theme "Dracula"
Set TypingSpeed 25ms

Hide
Type `set -euo pipefail` Enter
Type `cd "$VIDEO_WORKSPACE/repo"` Enter
Type `export PS1='$ '; unset PROMPT_COMMAND` Enter
Type `clear` Enter
Sleep 1s
Show
Type `# Stepstone: a real workspace lifecycle` Enter
Type `stepstone project ready` Enter
Sleep 4s
Type `stepstone project workspace start --goal guide --workspace-parent ../workspaces` Enter
Sleep 6s

Type `clear` Enter
Type `# Read the run ID from the CLI. No journal edits.` Enter
Type `run=$(stepstone project workspace status --json | jq -r '.result[0].id')` Enter
Sleep 1s
Type `stepstone project workspace status "$run" --json | jq '.result[0].entries.guide'` Enter
Sleep 7s

Type `clear` Enter
Type `# The workspace includes the goal. Git ignores the handoff.` Enter
Type `cd ../workspaces/stepstone-guide` Enter
Type `head -n 22 STEPSTONE_GOAL.md` Enter
Sleep 5s
Type `git status --short` Enter
Type `git check-ignore STEPSTONE_GOAL.md` Enter
Sleep 4s
Type `cd ../../repo` Enter

Type `clear` Enter
Type `# Inspect the actual claim. Display selected evidence fields.` Enter
Type `stepstone project workspace inspect "$run" guide --json \` Enter
Type `  | jq '.result.claimEvidence | {assessment, claimAgeHours, canonical}'` Enter
Sleep 7s

Type `clear` Enter
Type `# Add unfinished work to the prepared checkout.` Enter
Type `printf 'Unfinished release notes\n' > ../workspaces/stepstone-guide/draft.md` Enter
Type `git -C ../workspaces/stepstone-guide status --short` Enter
Sleep 4s
Type `stepstone project workspace inspect "$run" guide --json \` Enter
Type `  | jq '.result.claimEvidence.workspace | {state, hasUncommittedChanges}'` Enter
Sleep 6s

Type `clear` Enter
Type `# Explicit release does not authorize deleting the draft.` Enter
Type `stepstone project workspace recover "$run" guide --release` Enter
Sleep 7s
Type `cat ../workspaces/stepstone-guide/draft.md` Enter
Hide
Type `test "$(cat ../workspaces/stepstone-guide/draft.md)" = "Unfinished release notes"` Enter
Sleep 500ms
Show
Sleep 5s

Type `clear` Enter
Type `# Remove only the disposable draft, then retry safe cleanup.` Enter
Type `rm ../workspaces/stepstone-guide/draft.md` Enter
Type `stepstone project workspace cleanup "$run" guide` Enter
Sleep 5s
Hide
Type `test ! -e ../workspaces/stepstone-guide` Enter
Sleep 500ms
Show
Type `git worktree list` Enter
Sleep 4s
Type `stepstone project ready` Enter
Sleep 5s

Type `clear` Enter
Type `# Remove the finished run record.` Enter
Type `stepstone project workspace cleanup "$run"` Enter
Sleep 3s
Type `stepstone project workspace status --json` Enter
Sleep 7s
Hide
Type `touch "$VIDEO_WORKSPACE/complete"` Enter
Sleep 1s
