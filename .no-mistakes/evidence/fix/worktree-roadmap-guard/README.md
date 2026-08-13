# worktree-guard: end-to-end evidence

Base commit `e8d90f3`, target commit `d2ee9e8`, git 2.43.0, node v24.18.1.
Every transcript drives the real published surface: `stepstone` from `src/cli.ts`, or `stepstone-mcp` over stdio.
The `scripts/` directory holds the exact scripts that produced each log, so any of them can be re-run.
Every log except the two marked "history" was regenerated at the target commit.

## Transcripts

| Evidence | What it shows |
| --- | --- |
| [`cli-linked-worktree-BEFORE-fix.log`](cli-linked-worktree-BEFORE-fix.log) | The reported failure, reproduced at the base commit: two `project add` calls and a `project update` from a linked worktree all succeed, and the linked worktree ends with `M .worklist/worklist.json` and two goals the main worktree never sees. The roadmap forked silently. |
| [`cli-linked-worktree-AFTER-fix.log`](cli-linked-worktree-AFTER-fix.log) | The same script at the target commit. `project list` and `project apply-plan --dry-run` still answer at exit 0, a semantic no-op `project move` still succeeds, and `project add` and `project update` are refused at exit 1 with `UNAVAILABLE` / `retryable: false` / `resolution: run-from-main-worktree`, naming the main worktree. `--file` outside the committed locations still writes, the main worktree still writes, and the linked worktree's `git status` is clean. |
| [`gitdir-link-linked-worktrees.log`](gitdir-link-linked-worktrees.log) | The round-2 report, before and after, plus the two layouts that must not change. A worktree added beside a submodule working tree, and one added beside a `git init --separate-git-dir` checkout whose Git directory records `core.worktree`, were both refused at the previous commit `75b662d` with "the repository … has no main worktree"; at the target commit each is refused with `resolution: run-from-main-worktree` naming the ordinary main checkout, and the transcript then performs the write there. A `--separate-git-dir` repository that records nothing keeps the honest `provide-main-worktree` refusal, and so does a bare clone: the new lookup invents no destination. |
| [`gitdir-link-main-checkouts.log`](gitdir-link-main-checkouts.log) | The round-1 regression, before and after. A `git init --separate-git-dir` checkout and a Git submodule working tree - both ordinary sole checkouts whose `.git` is a gitdir link, so `git worktree list --porcelain` prints the Git directory where a checkout is expected - are refused at commit `e1dd6d4` and write their roadmap normally at the target commit. A worktree added beside the separate-git-dir checkout is still refused, and the submodule's write leaves the superproject's roadmap absent. |
| [`legacy-pi-roadmap.log`](legacy-pi-roadmap.log) | The legacy committed location. A repository whose roadmap is `.pi/worklist.json`: the linked worktree reads it, `project add` and `project migrate_path --confirm` are both refused with `resolution: run-from-main-worktree` naming the legacy path, `$STEPSTONE_WORKLIST` outside both committed locations still writes, and the linked worktree stays clean. |
| [`mcp-linked-worktree.log`](mcp-linked-worktree.log) | The same rule through a second interface. The MCP server is spawned over stdio with its cwd in a linked worktree: the `list` resource reads fine, the `add` tool comes back `isError: true` with the same typed envelope, and the same tool on the main worktree writes normally. The guard sits under the shared mutation path rather than in the CLI. |
| [`bare-clone-no-main-worktree.log`](bare-clone-no-main-worktree.log) | A bare clone plus `git worktree add`. Reads work; a write is refused with the distinct `resolution: provide-main-worktree`, naming the Git directory rather than a checkout nobody can walk into. Both remedies the message names are then taken in the transcript: `$STEPSTONE_WORKLIST` writes from that very checkout, and a clone that does have a main worktree writes its roadmap. |
| [`REGRESSION-non-linked-checkouts-refused.log`](REGRESSION-non-linked-checkouts-refused.log) | History: the round-1 report. Superseded by `gitdir-link-main-checkouts.log`. |

## The one layout that still gets the imprecise remedy

Section C of `gitdir-link-linked-worktrees.log` is a `git init --separate-git-dir` repository that Git leaves recording nothing: the `.git` file points from the checkout to the Git directory, and `git config core.worktree` in that Git directory is unset.
A worktree added beside it is refused with `provide-main-worktree` - "the repository … has no main worktree" - even though the checkout beside it exists.
This is the fallback the fix was asked to keep for a missing or invalid `core.worktree`: `git worktree list --porcelain` in this layout prints only the Git directory and the linked worktree, and the Git directory records no way back, so nothing names the checkout.
The write is refused either way, the roadmap does not fork, and the transcript shows the `$STEPSTONE_WORKLIST` way out the message names being taken from that very worktree.
