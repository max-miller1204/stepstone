# End-to-end run of the resumable dispatch driver

The published `stepstone-dispatch` binary (`dist/dispatch.js`, built by `npm run build`) was run against a
throwaway repository with a real Git remote, four planned goals, a stand-in agent executable, and a stand-in
`gh` backed by local pull-request fixtures.
Nothing was stubbed inside the product: the driver's own worktree, detached-process, roadmap, and GitHub
merge-evidence bindings did the work.

Full command-by-command output: `dispatch-e2e-transcript.txt`.

Approved plan: `ship-widget`, `polish-widget` (depends on `ship-widget`), `write-docs`, `fix-typo`.

| What the intent asks for | What the run showed |
| --- | --- |
| Executable driver over the documented contract | `stepstone-dispatch start / resume / status / inspect / recover / cleanup` drove the whole plan from the main worktree |
| Selects only ready goals | `polish-widget` was never selected until `ship-widget` was done; the three-goal frontier was read fresh on every pass |
| Bounded parallelism | `--max-parallel 2` staffed two of three ready goals; `fix-typo` stayed ready and unstaffed until a slot freed |
| Claims each branch with optimistic concurrency | Each goal was claimed on `stepstone/<goal-id>` with the ready result's exact `updatedAt`, and that token was persisted as `claimUpdatedAt` |
| Workers get complete goal context | The worker's recorded stdin holds the driver's prompt plus the full stored goal JSON, delivered inside its own checkout |
| Only matching merged PRs complete a goal | A PR merged into another base and a PR merged before the claim were both ignored; the goal stayed `open` and claimed. The matching PR completed it, fast-forwarded `main` to the verified merge commit, and only then staffed the newly unblocked goal from that revision |
| Resumable after interruption | The driver was `SIGKILL`ed mid-pass while launching `fix-typo`. A fresh process read the persisted run: two goals already completed and cleaned, one still running, and `fix-typo` in `launching` with its claim, workspace, and launch token intact |
| Preserves ambiguous custody | `resume` moved the interrupted launch to `ambiguous` and kept the claim; `recover --release` was refused because nothing could prove the launch left no worker |
| Releases on an explicit, recorded verdict | After a process-table inspection found no live worker, `recover --release --confirm-launch-closed` released the exact claim, scrubbed the workspace, deleted the branch, and persisted `custodyOperatorAsserted: true` into the terminal record |
| Canonical roadmap independent of any harness | All roadmap state stayed in `.worklist/worklist.json`; runtime state lived in `.git/stepstone-dispatch/<run-id>.json` and was removed by `cleanup` |

Final state: all four goals `done`, `main` carrying all four merge commits, no dispatch worktree, no
`stepstone/*` branch, no worker process, and `stepstone-dispatch status` reporting `No persisted dispatch runs.`

## The interruption, in the transcript's own words

```
$ stepstone-dispatch resume 4028d83a-6ac7-4b78-bce2-0ae95374d9b4   # killed mid-pass
SIGKILL delivered to driver PID 4060046 while fix-typo was in phase 'launching'
driver exit status: 137 (killed)

$ stepstone-dispatch inspect 4028d83a-6ac7-4b78-bce2-0ae95374d9b4 fix-typo
      "fix-typo": {
        "phase": "launching",
        "branch": "stepstone/fix-typo",
        "claimUpdatedAt": "2026-08-16T18:55:03.579Z",
        "workspace": ".../workspaces/stepstone-fix-typo",
        "message": "Worker launch intent and identity are journaled; no session handle is proven yet."
      }

$ stepstone-dispatch recover 4028d83a-6ac7-4b78-bce2-0ae95374d9b4 fix-typo --release
stepstone-dispatch: Goal fix-typo has an interrupted worker launch identity but no verified session
handle; manual process inspection and --confirm-launch-closed are required

$ find-live-worker f98414f1-bae4-40f3-91af-9a4088fda25d
no live process carries launch identity f98414f1-bae4-40f3-91af-9a4088fda25d

$ stepstone-dispatch recover 4028d83a-6ac7-4b78-bce2-0ae95374d9b4 fix-typo --release --confirm-launch-closed --json
      "fix-typo": {
        "phase": "cleaned",
        "claimUpdatedAt": "2026-08-16T18:55:03.579Z",
        "custodyOperatorAsserted": true,
        "message": "Released and cleaned."
      }
```
