Where the old README went: relocation coverage, section by section
=================================================================
The 471-line README at a098565 against the 109-line README plus docs/ on this branch.
Part 1 matches whole prose lines verbatim, which finds relocations but not rewrites.
Part 2 spot-checks the topics part 1 reports as reworded, to show they still have a home.

  old section "stepstone": 1/6 lines verbatim in README.md
  old section "Features": 1/20 lines verbatim in README.md
  old section "Install": 2/2 lines verbatim in docs/pi.md
  old section "Usage": 23/27 lines verbatim in docs/pi.md
  old section "Storage semantics": 5/26 lines verbatim in docs/goals.md, docs/storage.md
  old section "Model tool": 7/10 lines verbatim in docs/pi.md
  old section "External CLI": 12/39 lines verbatim in docs/usage.md, docs/cli.md
  old section "JSON goal plans": 6/9 lines verbatim in docs/goals.md
  old section "Goal identifiers": 5/16 lines verbatim in docs/goals.md
  old section "Goal dependencies": 18/21 lines verbatim in docs/dependencies.md
  old section "Goal sequencing": 10/11 lines verbatim in docs/dependencies.md, README.md
  old section "Terminal goal board": 23/26 lines verbatim in docs/board.md
  old section "Agent skill": 5/9 lines verbatim in docs/skill.md, README.md
  old section "Development": 2/6 lines verbatim in README.md, docs/development.md
  old section "Publishing and the Pi gallery": 1/2 lines verbatim in docs/releasing.md
  old section "Future releases": 15/16 lines verbatim in docs/releasing.md
  old section "One-time setup": 9/10 lines verbatim in docs/releasing.md

  145/256 prose lines of the old README appear verbatim in the new documentation;
  the remainder was rewritten rather than copied, so part 2 checks the topics by hand.

Part 2: topics the verbatim pass reported as reworded, and the pages that now carry them

  topic                      pages that state it now
  --confirm                  README.md docs/cli.md docs/goals.md docs/skill.md docs/storage.md docs/usage.md 
  expect-updated-at          docs/cli.md docs/usage.md 
  exit code                  README.md docs/cli.md docs/dependencies.md docs/development.md docs/storage.md docs/usage.md 
  unique prefix              docs/cli.md docs/goals.md docs/usage.md 
  migrate_ids                docs/cli.md docs/goals.md docs/usage.md 
  collision suffix           docs/cli.md docs/goals.md 
  40 characters              docs/goals.md 
  no-pi-install              docs/releasing.md docs/development.md 
  jiti                       docs/development.md 
  RPC                        docs/pi.md docs/development.md 
  pi-package                 docs/releasing.md docs/pi.md 
  megabyte                   README.md docs/usage.md 
  imports:check              docs/development.md 
  Unknown file extension     docs/usage.md 
  apply-plan                 docs/cli.md docs/usage.md docs/development.md docs/pi.md docs/goals.md 

  cross-process lock         README.md docs/cli.md docs/board.md docs/pi.md docs/development.md docs/usage.md docs/storage.md 
  atomic replacement         docs/pi.md README.md docs/storage.md docs/dependencies.md docs/usage.md docs/cli.md docs/goals.md docs/development.md docs/board.md 
  revision                   docs/goals.md README.md docs/cli.md docs/storage.md docs/pi.md docs/usage.md 
  legacy .pi/worklist.json   docs/cli.md docs/storage.md 
  WORKLIST env override      docs/cli.md docs/storage.md docs/usage.md 
  widget                     README.md docs/pi.md 
  /tasks dashboard           README.md docs/pi.md 
  Session Tasks              README.md docs/cli.md docs/goals.md docs/pi.md docs/storage.md 

  The exit-code table itself is deliberately not duplicated: docs/usage.md links the
  generated table in docs/cli.md instead of keeping a hand-maintained copy.
