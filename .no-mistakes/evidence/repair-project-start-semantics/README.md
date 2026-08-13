# Evidence: repair project start semantics

Every transcript below was produced by driving a real product surface - the `stepstone` CLI, the
`stepstone-mcp` stdio server, or the Pi extension through pi's own session lifecycle - against
throwaway git repositories.
The `*-before-fix*` transcripts were produced by the same scripts with `src/` checked out at the base
commit `67975d8`, so each pair is a before/after of the same steps.

| File | Surface | What it shows |
| --- | --- | --- |
| `01-cli-branch-claim-lifecycle.txt` | CLI | A claim, the confirmation guardrail, completion stamping `completedAt`, a merge that leaves a stale claim on the done goal, and the re-run that clears the claim while preserving the historical `completedAt`. Ends with `project next` / `ready` / `waves` showing the ready frontier still hides claimed work. |
| `09-cli-start-clear-on-done-goal.txt` | CLI | The same preservation through `project start <id> --clear` on a goal that is already done. |
| `02-cli-project-start-json-failures.txt` | CLI | `project start --json` returning three distinct typed envelopes: detached HEAD (`VALIDATION_FAILED`, `fields: ["branch"]`), a branch lookup Git refused (`UNAVAILABLE`, `retryable: false`, `gitExitCode: 129`), and one killed before answering (`UNAVAILABLE`, `retryable: true`, `gitSignal: SIGTERM`). |
| `03-cli-project-start-before-fix.txt` | CLI (base commit) | The same three runs before the change: one untyped sentence plus a usage dump, no JSON envelope, even with `--json`. |
| `04-pi-model-tool-expected-updated-at.txt` | Pi model tool | The `expectedUpdatedAt` property in the schema pi advertises, a claim guarded by the timestamp the model read, and a second model's stale claim rejected with a typed `CONFLICT`. |
| `05-pi-model-tool-before-fix.txt` | Pi model tool (base commit) | The same calls before the change: the schema never declares `expectedUpdatedAt`, so it is dropped from the tool call and the stale claim silently overwrites `feat/guarded` with `feat/stale`. |
| `06-mcp-stdio-session.txt` | MCP over stdio | A host connected to a repository Git refuses gets `UNAVAILABLE` / `repair-git-repository` naming Git's own line, recovers on the same connection once the config is repaired, then claims a goal with `expectedUpdatedAt` and sees the stale second claim rejected as `CONFLICT`. |
| `07-pi-session-widget-states.txt` | Pi session widget | The roadmap widget with an active goal and session tasks; a session that starts while Git cannot be run reports the typed availability failure, keeps session work usable, and picks the repository up again once Git returns; a malformed goal file is still announced. |
| `08-pi-session-widget-before-fix.txt` | Pi session widget (base commit) | The same session before the change: "Project goals require a git repository" for the rest of the session, with no recovery after Git returns. |

`scripts/` holds the exact scripts that generated each transcript; each takes the repository path as
its only argument.
