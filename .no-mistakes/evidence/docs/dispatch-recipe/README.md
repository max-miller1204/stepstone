# Evidence: harness-neutral dispatch recipe

Every transcript here is a real run of the dispatch contract in `docs/dispatch.md`, driven against the CLI in this branch (`node src/cli.ts project ...`), against real `herdr` panes, and against real `treehouse` leases.
The drivers under `drivers/` are the exact scripts that produced the logs; each one is a plain consumer of the CLI contract, and nothing in `src/` knows about any of the tools they use.

Two things are stood in for, and both are called out where they happen.
There is no code host in this sandbox, so a "merged PR" is a `--no-ff` merge of the claimed branch into `origin/main` in a local bare remote, and merge evidence is then read back the way the recipe requires: `origin/<claimed branch>` is an ancestor of `origin/main`.
The dispatched agent is a stand-in shell script (`drivers/fake-agent.sh`) named by `$AGENT_COMMAND`, which is the point the recipe makes about the agent harness being configuration rather than an adapter.

## Transcripts

| File | What it shows |
| --- | --- |
| `binding-a-parallel.log` | Binding A end to end at `--max-parallel 2`: git worktrees plus detached processes, two goals dispatched at once, then the dependent goal in a second round, then an empty `ready` |
| `binding-a-serial.log` | The same driver at `--max-parallel 1`, the serial auto-chain: one goal per round, the rest left on the frontier, chaining until `ready` is empty |
| `binding-b-herdr-treehouse.log` | Binding B end to end against the running Herdr server and a real Treehouse pool: leases acquired, panes split, the configured command run in each pane, panes closed and leases returned |
| `cross-axis-composition.log` | The two axes composed the other way round: a detached process working in a Treehouse lease, and a Herdr pane hosting a session in a plain git worktree |
| `packaged-dispatch-docs.log` | `npm pack` carrying `docs/dispatch.md` and both skill copies, plus the canonical goal recorded done in this repository's worklist and roadmap |
| `installed-skill-surface.log` | The published tarball unpacked: the skill's "Dispatching approved plans" section and standing-consent guardrail as an installed agent reads them, with `docs/dispatch.md` resolving inside the same install |

## Contract steps the transcripts exercise

- Apply the approved plan once, then read `ready --json` from the default-branch checkout.
- Claim before launch with `start <id> --branch <name> --expect-updated-at <updatedAt>`, and dispatch at most `--max-parallel N` of the frontier.
- A claimed goal leaves `ready`, so a second driver cannot double-staff it.
- A second driver holding the pre-claim `updatedAt` is refused with exit code 4, and its workspace is discarded instead of staffed.
- A worker that exits without a merged PR does not complete its goal; the goal stays claimed.
- The `updatedAt` read in step 2 is spent by the claim, so reusing it on `complete` is a conflict with exit code 4, and the recipe re-reads it first.
- Completion runs on main under standing consent, only for a goal of the approved plan whose branch is merged.
- Abandoned claims are released with `start <id> --clear`, which returns the goal to `ready` without completing it.
- The loop stops when `ready` is empty, with `waves --json` distinguishing a finished roadmap from blocked or claimed work.

## Binding B details that the transcript proves rather than asserts

- A pooled Treehouse worktree arrives on a detached HEAD: `git branch --show-current` prints nothing, and claiming with that empty value is a usage error with exit code 2. That is why the driver chooses the branch name instead of reading it back.
- Herdr rejects `root-session-recipe-herdr-treehouse` as an agent name with `invalid_agent_name`, quoting its own rule of 1 to 32 characters. The derived `ss-root-session-recip-2746030214` clears name validation and fails only on the deliberately nonexistent pane, which is exactly the derivation the recipe documents.
- Re-dispatching a goal whose branch survived an earlier attempt fails at `git checkout -b`, and the guarded path releases both the Stepstone claim and the Treehouse lease rather than running a worker on a ref whose PR head would never match the goal.

## Reproducing

```sh
export STEPSTONE_CLI=<checkout>/src/cli.ts
export HOST_PANE=$(herdr pane current | jq -r '.result.pane.pane_id')   # Binding B and the cross-axis run
bash drivers/binding-a-dispatch.sh                 # git worktrees plus detached processes
MAX_PARALLEL=1 DEMO=/tmp/ss-serial bash drivers/binding-a-dispatch.sh
bash drivers/binding-b-dispatch.sh                 # herdr panes over treehouse leases
bash drivers/cross-axis.sh                         # each host with the other's workspace provider
```

Each driver builds its own scratch repository under `/tmp`, and Binding B and the cross-axis run close every pane and return every lease before they exit.
