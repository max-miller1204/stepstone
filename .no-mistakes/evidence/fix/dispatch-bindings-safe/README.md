# Evidence: Make dispatch bindings safe

The product surface this change ships is `docs/dispatch.md`, the packaged dispatch recipe a root
session copies and runs to fan out an approved plan.
So the evidence runs that recipe, not a paraphrase of it: every dispatch step below is the fenced
block extracted verbatim from the shipped document.

How the runs are wired:

- `stepstone` is the real CLI on this branch, reached through the documented
  `npx -y stepstone@latest ...` spelling by an `npx` shim, so the documented command lines and the
  real `--json` envelopes, `--expect-updated-at` guard, and exit codes are what get exercised.
- Git is real: real worktrees, real branches, a real dirty checkout with tracked edits, untracked
  files, and gitignored build output.
- Herdr and Treehouse are not installed on this machine, so each is a small executable standing in
  at its public CLI: JSON envelopes, a pane list, a lease pool that refuses to take back a dirty
  checkout without `--force`.
- Every scenario script runs with stdin closed, so anything that tried to prompt would fail.

## Files

| File | What it shows |
| --- | --- |
| `dispatch-recipe-after.txt` | The recipe as committed, run end to end across seven scenarios. |
| `dispatch-recipe-before.txt` | The same harness against the recipe as documented at the base commit, reproducing each failure this change repairs. |
| `recipe-mutation-sensitivity.txt` | Six single-property mutations of the recipe, each caught by the new suite. |
| `targeted-tests.txt` | `vitest run test/dispatch-docs.test.ts test/cli-contract.test.ts test/roadmap.test.ts`. |
| `harness/` | The scripts that produced the transcripts. |

## Before and after, per requirement

| Requirement | Before (`dispatch-recipe-before.txt`) | After (`dispatch-recipe-after.txt`) |
| --- | --- | --- |
| Detached launch needs a startup handshake | BEFORE 1: an `AGENT_COMMAND` that exits 127 still reports a successful launch; the goal stays claimed on `stepstone/base-dispatch-handshake` with no process behind it and the workspace on disk | Scenario 1: exit 1, the claim is released with its own token, the workspace and branch are gone |
| Every clear uses the `updatedAt` its own claim returned | BEFORE 3: the unguarded clear releases `other-driver/branch`, a claim the abandoning driver never held | Scenario 3: the documented clear exits 4 (conflict) and the other driver keeps custody; Scenario 2 shows a rejected claim issuing no clear at all |
| Dirty-worktree cleanup is non-interactive, explicit, verified | BEFORE 2: `git worktree remove` fails with "use --force to delete it"; worktree and branch leak | Scenarios 4 and 6: the checkout is scrubbed, verified clean, then force-removed; the goal is completed first |
| Herdr prompt submission is bounded and ambiguity keeps custody | BEFORE 4: `herdr agent prompt --wait` with no timeout, and its failure clears the claim and returns the lease while the pane and its agent are still alive | Scenario 5: `--timeout` is passed, the failure exits 1 with "Prompt outcome is ambiguous", and claim, pane, and lease are all preserved |
| Herdr agents and panes close before the lease goes back | BEFORE 4: `treehouse return` runs with `pane_id` `pane-1` still listed | Scenario 6: `pane close` then `pane list` verifying it is gone, then the scrub, then `treehouse return --force --if-lease-holder` |
| Liveness waits are bounded | the documented wait was `herdr agent wait "$pane_id"` | Scenario 7: the documented wait sends `--timeout 300000` with nothing configured |

## Reproducing

```sh
sh harness/setup.sh "$PWD/sandbox" /path/to/stepstone/worktree "$(dirname "$(command -v node)")"
sh harness/demo.sh /path/to/stepstone/worktree "$PWD/sandbox"
```

## Second pass: real Treehouse, a real worker, and the live Herdr contract

Herdr and Treehouse turned out to be installed on this machine after all, so this pass replaces
two of the stand-ins above with the real tools.

| File | What it shows |
| --- | --- |
| `dispatch-recipe-e2e.log` | The recipe run end to end against a real Treehouse lease pool, a real detached worker process, real worktrees, and the real Stepstone CLI. |
| `dispatch-recipe-e2e.sh` | The harness that produced it; it extracts the fenced examples from the shipped document and runs them unmodified. |
| `real-boundary-contracts.log` | The documented flags checked against the live `herdr` and `treehouse` CLIs, including the `close_pane` predicate evaluated against a live pane list. |
| `regression-guard.log` | Four single-property regressions of the shipped recipe, each one failing `test/dispatch-docs.test.ts`, with the document restored afterwards. |
| `dispatch-doc-binding-a.png`, `dispatch-doc-binding-b.png` | The two repaired sections rendered as a reader of the packaged document sees them. |
| `dispatch-doc-rendered.html`, `binding-a.html`, `binding-b.html` | The rendered document behind those screenshots. |

What the end-to-end log demonstrates:

- Scenario 1: the claim returns a token, a real detached worker starts in an isolated worktree and
  survives its startup grace, the log and pid file stay out of the reviewed checkout, the goal is
  completed with the documented command, and the dirty checkout, including gitignored build
  output, is scrubbed and removed without a prompt.
- Scenario 2: a configured agent command that is not executable never launches; the claim is
  released with its own token and the workspace and branch are gone.
- Scenario 2b: the real CLI refuses a clear that carries a pre-claim token with exit code 4 and a
  `CONFLICT` envelope, and accepts the token the claim returned. This is the concrete hazard the
  `--expect-updated-at "$claimed_updated_at"` requirement exists to prevent.
- Scenario 3: an ambiguous prompt outcome leaves the roadmap claim, the pane, and the real
  Treehouse lease all intact, and issues no clear.
- Scenario 4: `pane close`, then `pane list` verifying the pane is gone, then the scrub, then
  `treehouse return --force --if-lease-holder`, which the real Treehouse accepts and reports as
  `available`.

`real-boundary-contracts.log` records that the live `herdr agent prompt --help` says "Without
`--timeout`, the settled-state wait is indefinite" and that `herdr agent wait` waits indefinitely
the same way, which is exactly what the repaired recipe now bounds.
