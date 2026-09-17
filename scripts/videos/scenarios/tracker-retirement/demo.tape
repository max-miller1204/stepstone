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
Type `# Stepstone tracks goals. Git manages existing worktrees.` Enter
Type `stepstone project show guide --json \` Enter
Type `  | jq '.result.goal | {id, status, branch}'` Enter
Sleep 4s
Type `stepstone project workspace status || test "$?" -eq 2` Enter
Sleep 5s
Type `stepstone project start guide --worktree || test "$?" -eq 2` Enter
Sleep 5s
Hide
Type `cmp .worklist/worklist.json "$VIDEO_WORKSPACE/before.json"` Enter
Show
Type `clear` Enter
Type `# Existing resources remain available through Git and files.` Enter
Type `git worktree list` Enter
Type `git -C ../existing status --short` Enter
Type `cat ../existing/STEPSTONE_GOAL.md ../existing/draft.md` Enter
Type `cat .git/stepstone-dispatch/preserved-run.json` Enter
Type `# Compare preserved handoff, journal, and worktree owner bytes.` Enter
Type `owner=$(git -C ../existing rev-parse --absolute-git-dir)` Enter
Type `cmp ../existing/STEPSTONE_GOAL.md ../handoff.before` Enter
Type `cmp .git/stepstone-dispatch/preserved-run.json ../journal.before` Enter
Type `cmp "$owner/stepstone-dispatch-owner.json" ../owner.before` Enter
Sleep 7s
Type `clear` Enter
Type `# Completion requires explicit authorization.` Enter
Type `stepstone project complete guide || test "$?" -eq 3` Enter
Sleep 5s
Type `stepstone project complete guide --confirm` Enter
Sleep 4s
Type `stepstone project ready` Enter
Sleep 5s
Hide
Type `touch "$VIDEO_WORKSPACE/complete"` Enter
Sleep 1s
