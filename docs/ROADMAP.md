<!-- Generated from .worklist/worklist.json by scripts/generate-docs.ts. Do not edit manually. -->

# Roadmap

Every Project Goal in this repository, rendered from `.worklist/worklist.json` so the roadmap reads here without a terminal.
Each section is a group goals are filed under, and the goals inside one are in the roadmap's canonical file order.
Every goal states its status, whether the dependency graph has it waiting, and the goals it waits on.
A goal's description is a record of what was decided when it was written rather than a current instruction, so an older one may still name a path, a package, or a directory this project has since renamed.

51 goals: 14 open, 34 done, 3 archived.

## Orchestrator

- **[archived]** Integrate Project Goal launch with pi-orchestrator - `future-start-goal`

  Let the user select a Project Goal from the Worklist dashboard and request orchestration through a versioned capability handshake. Show the action only when pi-orchestrator is available, pass the stable goal ID and current goal revision, preserve explicit approval before execution, and keep retry, cancellation, logs, evidence, and run control in the orchestrator rather than duplicating those controls in pi-worklist.

- **[done]** Add a versioned inter-extension worklist API - `add-a-versioned-inter-extension`

  Expose a machine-oriented integration protocol over Pi's shared pi.events bus so pi-orchestrator can discover capabilities, read the active or selected Project Goal, list Session Tasks, reconcile task projections, and update projected execution state without invoking the model-facing tool, instantiating another SessionStore, editing .pi/worklist.json, or appending snapshots directly. Include protocol versions, request IDs, actor and run correlation metadata, deterministic result envelopes, changed-field and semantic no-op reporting, typed error codes with retryability and conflict details, bounded read projections, timeouts, capability negotiation, and a graceful unavailable or incompatible fallback. Route the tool, command, dashboard, CLI, and inter-extension requests through one mutation service so every interface applies identical validation and persistence rules.

- **[done]** Add atomic Session Task projection reconciliation - `add-atomic-session-task-projection`

  Provide one serialized batch operation that upserts all Session Task projections for an orchestration run by stable external identity, updates existing projections, creates missing projections, preserves unrelated user-created tasks and canonical queue order, and appends exactly one session snapshot. Make reconciliation idempotent across retries, recovery, /tree, /fork, /clone, and /resume so pi-orchestrator can safely rebuild the current session view without duplicating tasks.

- **[done]** Enforce Project Goal association integrity - `enforce-project-goal-association`

  Validate that every orchestrator-managed Session Task goalId refers to an existing Project Goal and reject orchestration of done or archived goals unless the user explicitly reopens them. Return the goal's stable ID and revision or updatedAt value so pi-orchestrator can snapshot the exact goal used for planning and detect edits before approval. Define safe behavior for deletion, archival, reopening, and temporarily orphaned projections without weakening explicit confirmation for destructive Project Goal lifecycle actions.

- **[done]** Publish structured worklist change events - `publish-structured-worklist-change`

  Emit compact versioned events after every successful tool, command, dashboard, or external mutation. Include scope, resulting revision, changed entity IDs, actor, mutation type, timestamp, and optional orchestration run or correlation ID so pi-orchestrator can detect user edits, moves, deletions, and status changes. Keep events live and queryable through current snapshots for initial integration rather than duplicating the orchestrator's durable event journal.

- **[done]** Define managed Session Task override behavior - `define-managed-session-task-override`

  Mark orchestrator-managed Session Tasks clearly while preserving user control over editing, moving, deleting, and changing their status. Emit a divergence event for user overrides, require pi-orchestrator to pause or reconcile instead of silently restoring stale data, define how managed projections detach when a run ends, and retain the rule that successful tasks never automatically complete their associated Project Goal.

- **[done]** Represent orchestrator-managed Session Task projections - `represent-orchestrator-managed-session`

  Add a versioned, branch-aware projection schema containing producer and external identity, orchestration run ID, step ID, approved plan revision, read-only execution state, timestamps, and bounded result or session-contribution references. Preserve todo, doing, and done as the user-facing lifecycle, keep attempts, retries, artifacts, evidence, and recovery canonical in pi-orchestrator, and migrate older snapshots without changing existing IDs or exposing hidden metadata in normal model context.

- **[archived]** Add orchestration-aware Worklist UI - `add-orchestration-aware-worklist-ui`

  Show managed-task badges, projected execution state, failures, and bounded run or result references in the Worklist dashboard and widget. Provide an action that opens the associated pi-orchestrator run while keeping retry, cancellation, logs, artifacts, evidence, and recovery controls in pi-orchestrator.

- **[archived]** Add pi-orchestrator compatibility and cross-extension E2E tests - `add-pi-orchestrator-compatibility-and`

  Exercise capability negotiation, Project Goal selection, atomic projection reconciliation, deterministic result envelopes, typed conflicts, semantic no-ops, user overrides, /tree, /fork, /clone, /resume, session replacement, recovery, absent or incompatible orchestrator versions, and explicit Project Goal completion boundaries in real Pi integration tests.

- **[done]** Add approved Project Goal batch creation - `add-approved-project-goal-batch-creation`

  Expose a versioned inter-extension capability that atomically and idempotently creates a validated batch of Project Goals from an explicitly approved orchestrator roadmap. Require expected-revision checks, stable external roadmap and repository references, bounded provenance, typed conflict results, and explicit user approval for the exact batch. Preserve standalone pi-worklist behavior, reject silent goal rewrites or completion, and keep roadmap dependencies, execution state, artifacts, and evidence canonical in pi-orchestrator.

## Foundation

- **[done]** Add revisions and idempotent external mutations - `add-revisions-and-idempotent-external`

  Add monotonic revisions to Project Worklists and branch-aware concurrency tokens or snapshot entry IDs to Session Task snapshots, support optional expectedRevision checks, and accept idempotency keys for external batch creation and status updates. A semantic no-op must not rewrite .pi/worklist.json, append a Session Task snapshot, increment a revision, or emit a change event. Preserve the existing cross-process lock, atomic rename, branch-aware snapshot semantics, and backward readers while returning explicit typed conflicts instead of allowing a resumed orchestrator to overwrite newer user changes.

- **[done]** Ship a compiled pi-worklist CLI bin - `ship-a-compiled-pi-worklist-cli-bin`

  Publish an executable bin so npx pi-worklist works from the installed npm package. Compile the CLI to JavaScript at build or publish time because Node refuses to type-strip TypeScript under node_modules, while preserving the package's Node >=20 support. Provide compact bounded list output, explicit full-detail reads, deterministic mutation confirmations, stable --json result envelopes, typed errors and exit codes, and CLI, skill, and agent guidance generated from one command contract. Keep the CLI on the same application service as the Pi extension so behavior and validation cannot drift.

- **[done]** Provide bounded list and explicit detail projections - `provide-bounded-list-and-explicit`

  Make model tool, command, and CLI list operations return a compact projection containing ID, title, status, goal association, and lightweight projected execution state. Truncate long descriptions with an explicit show or get --full path, support allow-listed fields, status filters, archived filters, and result limits, and provide complete structured details only when requested. Preserve complete stored data and do not introduce TOON as a dependency.

- **[done]** Add optimistic concurrency and append primitives to project update - `add-optimistic-concurrency-and-append`

  project update replaces the whole description, which is racy and error-prone for external callers: the cross-process lock serializes writes but nothing detects that the caller's baseline was stale, so two sessions that both read then update silently last-writer-clobber, and changing one line means faithfully re-supplying the entire multi-paragraph blob. Add (a) an optimistic-concurrency guard, e.g. --expect-updated-at <timestamp>, rejecting with the existing exit-code-4 conflict semantics when the goal changed after the caller's read, and (b) an additive primitive, e.g. --append-description <text>, so the common add-a-note case never rewrites the blob at all. Motivated 2026-07-31 by an agent session in the colony repo that had to reconstruct a long stage-E goal description just to add a staleness note and one soft-dep token.

- **[done]** Stop npx cache serving a stale CLI that misses the misplaced-flag warning - `stop-npx-cache-serving-a-stale-cli-that`

  The misplaced-flag warning from PR #10 works but never reaches anyone following the generated docs, because npx serves a cached older build.

  Evidence, gathered 2026-08-03 against a warm cache:
  - 'npx -y pi-worklist project add T -- D --json' printed nothing on stderr and stored the description as 'D --json'.
  - 'npx -y pi-worklist@latest ...' with identical arguments printed the warning correctly.
  - ~/.npm/_npx held pi-worklist 0.5.0, 0.6.0 (twice) and 0.8.0; none contain MISPLACED_GLOBAL_FLAG. The registry latest is 0.8.1.
  - The published 0.8.1 tarball DOES contain the fix in both dist/cli.js and src/cli.ts, and 'node src/cli.ts' from a checkout warns correctly. So the fix is sound; only the delivery is broken.
  - '-y' suppresses the install prompt; it does not force a re-resolve when a cache entry already exists.

  This bit a real session: three goal descriptions were silently contaminated with a literal '--json' and had to be found and stripped by hand, which is exactly the failure the warning was written to prevent.

  Fix in src/cli-contract.ts, which generates both docs/cli.md and the agent skill. Lines 245, 270, 286 and 296 all emit the bare 'npx -y ${contract.binary}' form. Emitting 'npx -y pi-worklist@latest' (or a pinned version) makes a stale cache unable to win, and every consumer of the generated skill picks it up on the next regeneration.

  Worth pairing with: put the running version on the result envelope's meta, so 'which build am I actually on' is one command rather than an inference from ~/.npm/_npx directory names.

- **[done]** slug-ids: human-readable goal IDs and CLI prefix matching - `slug-ids-human-readable-goal-ids-and`

  Derive goal IDs from the title at creation (lowercase, hyphens, capped around 40 chars), append -2/-3 on collisions, and freeze the slug afterward so renaming a title never renames the ID. Add unique-prefix ID matching to every CLI id argument, listing candidates on ambiguity. Also add a find <text> action or --match selector over titles and descriptions that returns matching goals with their IDs, absorbing the earlier goal-search goal so external agents stop doing list --json plus client-side grep. Include an optional migrate-ids command that rewrites existing random IDs and every reference to them: SessionTask.goalId now, and dependsOn edges too if it is ever re-run after dependency-graph lands. Decide at migration time whether done and archived goals keep their historical IDs so references in old PR descriptions and evidence files stay valid. Avoid sequential numeric IDs: parallel branches would mint colliding numbers.

- **[done]** schema-fields: group, completedAt, links, and manual ordering - `schema-fields-group-completedat-links`

  One contract churn adding optional ProjectGoal fields: group (free-form section string; a group exists iff some goal names it), completedAt (set on complete, cleared on reopen), links (purely informational URL string array with no machine semantics), and branch (a dedicated string field serving as the dispatch-ledger marker written by project-start; state markers get their own field rather than overloading links with load-bearing heuristics). Make file order canonical for display instead of createdAt sort, add move up/down mutations, and build the goal-board sort cycle here on top of file order (moved out of tui-polish so it is built once instead of reworked one goal later). Backfill the captured plan goals by migrating their prose Group: description lines into the real group field and deleting the migrated prose lines, so prose and fields cannot drift apart. Keep PROJECT_WORKLIST_VERSION at 1; fields are optional and additive. Touch typebox schema, project-mutations validation, canonicalChangedFields, cli-contract docs, and the TUI detail view.

  Depends on `slug-ids-human-readable-goal-ids-and` (done).

- **[done]** dependency-graph: dependsOn edges with cycle checks and blocked state - `dependency-graph-dependson-edges-with`

  Store only the forward direction (dependsOn: string[]) and derive blocks at read time. An edge means must-land-before, whether the reason is logical or file overlap; a dependency is satisfied when its target is done or archived. DFS cycle check at mutation time with a new dependency-cycle error code; reject self references and unknown IDs; strip edges to a deleted goal inside the same atomic mutation. Blocked is a derived display state, not a status: dim blocked goals in the board and warn rather than refuse on set_active. Show depends-on and blocks in project show; repeatable --depends-on flag on add and update. Backfill the captured plan goals by migrating their prose Depends on: description lines into real dependsOn edges and deleting the migrated prose lines, so prose and edges cannot drift apart. Document that file order is presentation and tiebreak while the DAG is the source of truth for what may start; the two are allowed to disagree and neither should be edited to mirror the other.

  Depends on `slug-ids-human-readable-goal-ids-and` (done), `schema-fields-group-completedat-links` (done).

- **[done]** description-flag: order-independent description input and a strict misplaced-flag error - `description-flag-order-independent`

  Remove the ordering hazard in the CLI's description input rather than continuing to warn about it. Today `--` is a terminator, so every token after it is description text and argument order becomes load-bearing: a known flag written after the separator silently becomes prose and only produces a stderr warning with exit 0, which a programmatic caller reading stdout never sees. A blanket refusal is not available as a fix, because flag-looking text in a description is common and legitimate: 10 of this repository's own 35 goal descriptions contain it, one of them quoting 'project add T -- D --json' verbatim. Land the escape hatch first, then the strictness. Phase one adds --description <text> and --append-description <text> as ordinary order-independent flags that carry the whole value in one argv token, keeping `--` for humans typing prose at a shell without quoting, and keeping the existing mutual exclusions between replacing and appending. Phase two upgrades the misplaced-flag warning to a hard usage error with exit code 2, naming --description in the message, which is only safe once prose containing a flag has an unambiguous home. Point the generated skill and agent guidance at --description for every programmatic caller and reserve the separator for interactive use. The change is additive and backwards compatible: no existing invocation stops working, and no stored description needs rewriting.

- **[done]** link-flag: write the reserved links field from add and update - `link-flag-write-the-reserved-links`

  Give the `links` field a writer, so the schema landed by schema-fields stops being unreachable. Today `links` has a type (`ProjectGoal.links?: string[]`), store validation and preservation (`OPTIONAL_GOAL_STRING_ARRAY_FIELDS`), and two readers - `project show` renders a `links:` block and the goal board's detail pane wraps each URL verbatim - but nothing anywhere sets it: `ProjectGoalUpdate` carries only title, description, appendDescription, group, and dependsOn, and no CLI flag or tool argument reaches it. That was deliberate at the time; the schema-fields PR reserved `links` and `branch` "for the goals that own their writers". `branch` has its owner in project-start, which writes it as the dispatch marker; `links` has no such goal, so the field is currently write-only-by-hand, and hand-editing .pi/worklist.json is exactly what the skill forbids because it bypasses the lock, validation, and timestamps. The demand is already real: migrating the colony repository's goals off GitHub Issues left 5 of them carrying their origin issue URL as an `orig: https://...` prose line, because there was nowhere structured to put it, and a 2026-08-05 audit of that worklist found duplicated prose metadata drifting from the fields it shadowed - the same failure mode this field exists to prevent. Add `--link <url>` to add and update, repeatable to name several, mirroring how `--depends-on` threads from cli-contract.ts through ProjectGoalUpdate and application-service.ts into the mutation; on update the flag replaces the whole set, and a single empty value clears it, so the two array fields behave identically and nobody has to remember which is which. Validate each entry as an absolute http or https URL and reject anything else with a usage error: the field's contract is that it carries no machine semantics, which is a rule about not parsing links for state, not a licence to store junk a reader will wrap across three lines. Decide at implementation whether to dedupe and cap the count. Expose it on the same surfaces `--group` reached - the CLI and the model tool - and regenerate docs/cli.md and the skill from the contract rather than editing either by hand. Tests should cover setting, appending by re-passing the full set, clearing, rejection of a non-URL, and round-trip preservation of an existing links array through an unrelated update, which is the regression that would silently drop data. The change is additive: PROJECT_WORKLIST_VERSION stays 1, existing files load unchanged, and the merge-driver goal's plan to union `dependsOn` and `links` on merge keeps working as written. Out of scope: `branch`, whose writer belongs to project-start, and any behavior that reads meaning out of a link.

  Depends on `description-flag-order-independent` (done).

## TUI

- **[done]** tui-polish: quick readability wins in the goal board - `tui-polish-quick-readability-wins-in`

  Pin the active goal to the top with a distinct marker, dim done and archived rows in the all view, add staleness markers for goals untouched for 30+ days, and show per-status counts in the header. Sorting is deliberately out of scope: the sort cycle moved into schema-fields so it is built once on canonical file order instead of shipping on createdAt and being reworked one goal later.

- **[open]** tui-groups: collapsible group sections in the goal board - `tui-groups-collapsible-group-sections`

  Render goals under collapsible section headers with counts; ungrouped goals fall into an implicit last section. Collapse and expand on the header row with ephemeral per-run state initially. CLI: --group on add and update, list --group filter, group shown in project show.

  Depends on `schema-fields-group-completedat-links` (done).

## Capture

- **[done]** apply-plan: atomic batch import of a JSON plan document - `apply-plan-atomic-batch-import-of-a`

  Read a JSON plan (array of goals with title, description, group, dependsOn) and apply it as one atomic mutation with one revision bump. Goals may reference each other and existing goals by slug before they exist. Pin the resolution order: a dependsOn reference matching a batch entry by pre-collision slug resolves to that batch entry deterministically, with a dry-run warning when it shadows an existing goal of the same slug; a reference matching no batch entry resolves against existing goals; a reference matching nothing anywhere, or two batch entries sharing a pre-collision slug, is a hard validation error. Without this rule a batch goal whose predicted slug collides with an existing goal (add-focus-mode becoming add-focus-mode-2) would silently wire its dependents to the wrong target. Validate everything before writing (cycles, unknown refs) and support a dry-run mode. The plan format stays a plain JSON mirror of the goal schema documented in the cli-contract docs; no custom markdown format.

  Depends on `slug-ids-human-readable-goal-ids-and` (done), `schema-fields-group-completedat-links` (done), `dependency-graph-dependson-edges-with` (done).

- **[done]** capture-skill: brainstorm to approved plan to one apply - `capture-skill-brainstorm-to-approved`

  Extend the worklist skill with a capture flow: draft a JSON plan document from a brainstorm session, show it for approval, then apply it with a single apply-plan call. Teach the skill to add a dependsOn edge between goals that will collide on the same modules even without a logical dependency, choosing the more natural order, since edges mean must-land-before.

  Broadened 2026-08-08 by the harness pivot. The flow was scoped to the worklist skill, which is one of several agent-facing renderings rather than the only one. Land the capture guidance in the generated contract so it reaches the skill, the AGENTS.md block, and the MCP tool descriptions from one source, and so an agent in a harness that never reads .claude/skills still knows how to run a brainstorm to an approved plan to one apply.

  Depends on `apply-plan-atomic-batch-import-of-a` (done).

## Workflow

- **[done]** sequencing-commands: project next, ready, and waves - `sequencing-commands-project-next-ready`

  Read commands over the DAG for humans and drivers: ready returns the full parallel frontier of open unblocked goals, excluding goals whose dedicated branch field is set (the dispatch marker written by project-start, never inferred from links); next returns the first entry of ready in file order, by definition, so a goal someone is already working on is never suggested; waves prints topological layers showing what can run in parallel and what each wave unblocks.

  Depends on `schema-fields-group-completedat-links` (done), `dependency-graph-dependson-edges-with` (done).

- **[done]** project-start: mark a goal in flight and record its branch - `project-start-mark-a-goal-in-flight-and`

  Add project start <id> [--branch <name>]: records the branch in the dedicated branch field (not links, which stays purely informational) as the started or dispatched marker and leaves active semantics untouched; single active remains the focus concept, and in-flight only appears when fan-out is used. Create the branch only when asked, since treehouse owns worktree and branch creation in fan-out flows. Define the full marker lifecycle so a claim always has a release: project complete clears the branch field, and a start --clear release action un-claims an abandoned dispatch, so a reopened or orphaned goal never stays invisible to ready forever. Because ready excludes goals with the branch field set, the marker doubles as a crash-safe dispatch ledger.

  Depends on `slug-ids-human-readable-goal-ids-and` (done), `schema-fields-group-completedat-links` (done).

## Harness

- **[done]** no-pi-install: CI proof the CLI runs with zero Pi peers - `no-pi-install-ci-proof-the-cli-runs`

  AGENTS.md asserts that nothing reachable from src/cli.ts, including the terminal board in src/tui/, may import @earendil-works/*, and that the compiled bin has to run with only Node and its declared runtime dependencies. That invariant is now the load-bearing promise of the whole product rather than a tidiness rule, and it is currently enforced by convention and code review rather than by a test. The repository's own node_modules has every Pi peer installed as a devDependency, so a stray import would pass locally and only fail for the users who matter most.

  Add a CI job that packs the tarball, installs it into a scratch directory with no @earendil-works packages present and no dev dependencies, and exercises the real command surface end to end: list, add, show, find, next, ready, waves, apply-plan --dry-run, and a guarded mutation. Assert both the exit codes and the --json envelope shape, so a peer leaking into the CLI path fails the build with a clear message rather than a module-not-found stack. Pair it with a static check that no file in the CLI import graph references @earendil-works, which catches the regression at lint time before the slower install job runs.

- **[done]** harness-identity: rename off the Pi-specific package name - `harness-identity-rename-off-the-pi`

  The package is named pi-worklist, the bin is pi-worklist, package.json says "A Pi extension for session tasks and project goals", and the keywords lead with pi-package and pi. Every one of those tells a Codex, Cursor, or Claude Code user that this tool is not for them, which is now false: the CLI, the goal board, and the generated skill are already Pi-free by rule, and Pi imports survive in only six files (src/extension.ts, src/ui.ts, src/tool.ts, src/schema.ts, src/session-store.ts, src/tui/text.ts).

  Publish under a harness-neutral name and keep pi-worklist as a deprecated alias package that depends on the new one and re-exports the bin, so existing installs and any skill copies already in the wild keep working. Plain `worklist` is taken on npm by an unrelated 0.0.6 package; `agent-worklist`, `repo-worklist`, `worklist-cli`, `git-worklist`, and `agentic-worklist` were all free as of 2026-08-08. Recommendation is agent-worklist: it names the audience rather than the storage location, and repo-worklist or worklist-cli both undersell that this is an extension and MCP server as well as a CLI.

  The rename threads through src/cli-contract.ts as contract.binary, which regenerates docs/cli.md and the agent skill, so nothing may be hand-edited. Treat the npx delivery path as the known hazard: the stop-npx-cache goal already recorded that a stale ~/.npm/_npx entry silently served an old build and contaminated three goal descriptions, so the generated invocation must stay pinned as `npx -y <name>@latest` under the new name too. Also decide whether the GitHub repository is renamed, which changes the `npx skills add max-miller1204/pi-worklist` install line and every badge URL; GitHub redirects the old path, but the README should not keep advertising it. Keep the Pi extension entry points, the `pi.extensions` manifest field, and the optional @earendil-works peer dependencies exactly as they are: Pi stays a first-class supported harness, it just stops being the brand.

  Shipped as stepstone, not the agent-worklist this description recommended: a one-word name reads as a product rather than a category, and stepstone names what the roadmap does, since each goal is reachable only from the one before it. Verified unclaimed on npm along with its hyphenated variants, which npm's similarity guard would otherwise reject. stepstone gets a new GitHub repository at max-miller1204/stepstone rather than a rename of the old one. No pi-worklist alias package ships: the user decided during review to start fresh under the new name rather than carry a forwarder, so anyone still on the old name stays on pi-worklist@0.17.0, max-miller1204/pi-worklist stays published under its own name, and a pointer notice at the top of its README sends them here. stepstone therefore starts its own version line at 0.1.0 rather than continuing from 0.17.0. Three registry-side steps remain and are recorded under 'One-time setup' in the README: create the max-miller1204/stepstone repository, bootstrap the first stepstone publish by hand because Trusted Publishing cannot create a package that does not exist and then add its Trusted Publishers entry, and npm deprecate pi-worklist, which is the only channel that warns someone invoking the old name non-interactively.

- **[done]** worklist-path: move the goal file out of .pi - `worklist-path-move-the-goal-file-out-of`

  The goal file path is hardcoded at src/git.ts:30 as resolve(gitRoot, ".pi", "worklist.json"). A non-Pi user who adopts the worklist gets a committed .pi/ directory in their repository that means nothing to them and collides conceptually with Pi's own project directory. Move the canonical location to <git-root>/.worklist/worklist.json, chosen as a directory rather than a bare .worklist.json dotfile so later local state has somewhere to live that is not the committed goal file: dispatch claims from project-start, per-worktree focus from branch-scoped-active, and ephemeral board state all want a gitignored sibling.

  Define one resolution order and apply it in every interface, since resolution must not drift between the CLI, the board, the Pi extension, and the MCP server: an explicit --file or environment override first, then .worklist/worklist.json, then legacy .pi/worklist.json. Reads fall back to the legacy path so existing Pi repositories keep working untouched with no migration step. Writes go to whichever path resolved, so a repository that has only the legacy file keeps using it rather than silently splitting into two roadmaps. Decide explicitly what happens when both paths exist: the safe answer is to prefer the new path and warn loudly on every command, because silently ignoring a populated .pi/worklist.json would look exactly like data loss.

  Add a migrate-path command modeled on the existing migrate_ids: --confirm guarded, --dry-run capable, moves the file under the same cross-process lock and atomic replacement, and reports the old and new paths in the result envelope. Update the several places that name the path in prose, including the contract description, the skill description, the malformed-worklist error message in src/application-service.ts, and the doc comments in src/cli.ts and src/tui/. PROJECT_WORKLIST_VERSION does not change; this is a location change, not a schema change.

  Depends on `harness-identity-rename-off-the-pi` (done).

- **[done]** positioning: rewrite the docs around the cross-harness product - `positioning-rewrite-the-docs-around-the`

  README currently opens with "pi-worklist gives Pi two deliberately different lists" and presents Session Tasks and Project Goals as equal halves. That framing is now backwards. Project Goals are the product: a repository-scoped roadmap that any coding agent can drive through the CLI, the skill, or MCP. Session Tasks are a Pi extension feature, kept working and documented, but no longer the headline and no longer receiving investment.

  Rewrite the README so the first screen answers "what is this and how do I use it from my harness", with install and quickstart paths per harness, and demote Pi to a clearly labeled section that keeps the extension, widget, dashboard, and inter-extension API documented for the people using them. Do the same to the generated contract prose: the skill description and docs/cli.md intro both currently frame Project Goals as "shared with Pi sessions" and Session Tasks as "deliberately out of scope", phrasing that reads as a Pi tool apologizing for a CLI rather than a general tool that also integrates with Pi.

  Also reconcile the feature list, which advertises "a Pi-free external CLI" as though Pi-free were the exception. Sequence this after the identity rename and the path move so the docs are rewritten once against final names rather than churned twice.

  Lasly, restructure the README so that it only contains the important information. we can make a /docs folder with everything else. Look at this repo as an example: https://github.com/nicobailon/pi-subagents

  Depends on `harness-identity-rename-off-the-pi` (done), `worklist-path-move-the-goal-file-out-of` (done).

- **[done]** mcp-server: expose the worklist over MCP - `mcp-server-expose-the-worklist-over-mcp`

  Expose the WorklistApplicationService over MCP so any agent in any harness can list, add, find, sequence, apply plans, and complete goals through the same contract, the same cross-process lock, and the same confirmation guardrails as the CLI and the Pi extension.

  Promoted out of Later on 2026-08-08 by the harness pivot. The original deferral was conditional on apply-plan and capture-skill proving the workflow first; apply-plan has since landed, and the reason to wait has been replaced by the reason to hurry. MCP is now the universal integration path: it is the one surface Claude Code, Codex, Cursor, and Zed can all consume without a per-harness adapter, and it is the only way an agent reads the worklist without paying npx process startup on every call. That latency matters more than it looks, because the sequencing commands (next, ready, waves) are meant to be polled in a dispatch loop.

  Expose reads as MCP resources and mutations as tools, so an agent can hold the active goal in context without spending a tool call on it. Keep the tool surface generated from src/cli-contract.ts like every other agent-facing artifact, so a fourth renderer cannot drift from the CLI. Preserve the confirmation contract exactly: complete, reopen, archive, and delete stay explicit-intent operations, and MCP must not become the entrance that quietly skips them. Nothing in the MCP path may import @earendil-works, the same rule the CLI already lives under.

  Depends on `apply-plan-atomic-batch-import-of-a` (done).

- **[done]** agents-md: generate a harness-neutral AGENTS.md block - `agents-md-generate-a-harness-neutral`

  The only shipped agent-facing rendering is .claude/skills/worklist/SKILL.md, installed via `npx skills add`. That covers harnesses that scan .claude/skills, and misses the ones that read AGENTS.md instead, which is the convention Codex and several others follow. The command contract in src/cli-contract.ts already generates two targets from one source, so this is a third renderer, not a second source of truth.

  Add a generated AGENTS.md section covering what Project Goals are, where the file lives, the command surface, the confirmation guardrails, and the exit-code contract, compressed harder than the skill because AGENTS.md is always in context rather than loaded on demand. Ship it behind an init command that writes or refreshes the block in the target repository's AGENTS.md between stable marker comments, so re-running it updates in place instead of appending a duplicate, and so a user with existing AGENTS.md content never has it clobbered. The same init command is the natural place to offer skill installation and MCP registration, making one entry point for "set this repository up for my harness".

  Keep the block repository-neutral for the same reason the skill is: one generated artifact serves every checkout. Regeneration must be enforced by npm run docs:check and the test suite exactly as docs/cli.md and the skill already are.

  Depends on `harness-identity-rename-off-the-pi` (done), `worklist-path-move-the-goal-file-out-of` (done).

- **[done]** claude-plugin: ship skill, commands, and MCP as one plugin - `claude-plugin-ship-skill-commands-and`

  Claude Code installation is currently a two-step that installs one of the three useful surfaces: `npx skills add max-miller1204/stepstone --skill worklist -g` brings the skill and nothing else, and the README has to explain why installing the npm package does not install the skill. Package the Claude Code integration as a single installable plugin carrying the generated skill, the MCP server registration, and slash commands for the operations a human runs by hand rather than through the model.

  The commands worth exposing are the read-only ones a user wants without spending a model turn on: the roadmap listing, next, ready, and waves, plus the goal board. Mutations should stay on the model-facing path so the existing confirmation guardrails apply uniformly rather than getting a second entrance. Generate the plugin's skill and command definitions from src/cli-contract.ts like every other agent-facing artifact, and keep `npx skills add` working for users who only want the skill.

  Depends on the MCP server existing, since bundling MCP registration is most of the value over the current skill-only install.

  Depends on `harness-identity-rename-off-the-pi` (done), `mcp-server-expose-the-worklist-over-mcp` (done).

- **[open]** worktree-guard: stop a linked worktree silently forking the roadmap - `worktree-guard-stop-a-linked-worktree`

  The root-session-on-main convention is already the roadmap's answer to branch sessions writing the worklist: merge-driver defers to it explicitly, and root-session-recipe states that worklist mutations happen on main only with the root session as the sole writer. Nothing enforces it. resolveGitRoot calls git rev-parse --show-toplevel (src/git.ts:13), which inside a linked worktree returns that worktree, so an agent running in a treehouse worktree resolves its own checked-out copy of the goal file and writes there. The lock is scoped to the resolved directory (src/project-store.ts:191), so two worktrees hold two independent locks and nothing serializes them against each other.

  The consequence is worse than the merge conflict merge-driver is scoped to prevent. With one copy, two writers collide loudly at merge time. Across worktrees they diverge silently: two goal files, two locks, both valid, drifting until someone notices. This is not hypothetical - ipod-shuffle-linux carries worklist(active) and worklist(done) commits landed on feature branches, because marking a goal started or finished naturally happens while that feature branch is checked out. The convention is hardest to honour in exactly the moments the workflow most wants to write.

  Make a mutation from a linked worktree loud instead of silent, and decide the behaviour explicitly rather than by default: refuse and name the main worktree, warn and proceed, or redirect the write to the main worktree's file under its lock. Refusal is safest and matches the sole-writer rule, but it breaks any adapter that expects project start or project complete to run from inside a dispatched worktree, so root-session-recipe's claim-in-the-worktree, complete-on-main contract must be checked against whichever behaviour is chosen; redirect preserves that contract at the cost of a write crossing directories. Reads stay unrestricted in every case, since only mutations can fork the roadmap. Detect the linked worktree with git worktree list --porcelain, whose first entry is the main worktree, rather than deriving it from --git-common-dir, which under git init --separate-git-dir points outside the working tree entirely and whose parent is then unrelated to the checkout.

  Sequencing against worklist-path: both change the same resolution path, and worklist-path already requires one resolution order shared by the CLI, the board, the Pi extension and the MCP server. If worklist-path is scheduled first, fold this guard into that single resolution rather than landing it separately and rewriting it. Landing this first is still worthwhile if worklist-path is far out, because the divergence hazard goes live the moment a treehouse fan-out runs. Either way the guard covers the committed goal file only: worklist-path's gitignored siblings under .worklist/ are deliberately per-worktree local state for dispatch claims, branch-scoped focus and ephemeral board state, and must keep resolving per-worktree rather than collapsing to one shared directory.

## Visibility

- **[done]** roadmap-md: generate docs/ROADMAP.md from the worklist - `roadmap-md-generate-docs-roadmap-md`

  Render .pi/worklist.json to a committed docs/ROADMAP.md via the existing docs generator pipeline: sections by group, goals in file order, status and dependencies noted, so the roadmap reads on GitHub without the CLI.

  Depends on `schema-fields-group-completedat-links` (done).

- **[open]** project-stats: counts, throughput, and cycle time - `project-stats-counts-throughput-and`

  Add project stats: open, active, done, and archived counts plus throughput and completion timing from createdAt and completedAt. Note the distinction honestly: createdAt to completedAt is lead time including backlog wait, not cycle time; decide at implementation whether to add a startedAt stamp (recorded when the branch marker is first set) so cycle time can measure work-start to done.

  Depends on `schema-fields-group-completedat-links` (done).

## Automation

- **[done]** root-session recipe: harness-neutral dispatch loop over the worklist - `root-session-recipe-herdr-treehouse`

  A skill plus documented recipe implementing the fan-out loop purely as a consumer of the CLI contract; nothing in src/ knows about any particular tool. Loop: apply-plan, then repeatedly read project ready --json, project start each dispatched goal, claim an isolated workspace for it, launch an agent session there with the goal as its prompt, detect completion primarily via PR merge with session liveness as a secondary signal, run project complete on main, and continue until the plan is done. A --max-parallel N knob sets concurrency per run; N=1 is a first-class auto-chain mode for serial projects. Worklist mutations happen on main only; the root session is the sole writer.

  Define the authorization model explicitly instead of quietly bypassing the --confirm guardrail: launching a root session on an approved plan constitutes standing consent to complete the goals of that plan when their PRs merge, scoped to plan goals with merge evidence only, and the CLI docs and worklist skill guardrails are updated to state this exception deliberately.

  Re-scoped 2026-08-10. The loop itself is right, but the earlier write-up mistook one person's tooling for the shape of the contract. Exactly two things vary between setups, and neither of them is the agent harness:

  - Session host: where a dispatched agent session runs and how the root session watches it. tmux, cmux, herdr, zellij, or plain detached background processes.
  - Workspace isolation: how a goal gets its own checkout. Plain git worktrees, a multiplexer's built-in worktree support, treehouse, or a full clone.

  The two axes are independent, so any session host composes with any workspace provider. The agent harness is orthogonal to both: a dispatched session is just a command line the recipe launches, so which agent binary runs is configuration rather than an adapter, and "Claude Code headless" is not a variant to design around.

  The deliverable is therefore a harness-neutral dispatch contract - read ready, claim a goal, run an agent session against it in an isolated workspace, detect completion by merge evidence, complete on main - plus a small binding surface covering only the two axes above. Ship at least two working bindings so the contract is proven rather than fitted to one setup: plain git worktrees driven by detached processes as the zero-dependency baseline, and herdr panes over treehouse worktrees as the richer one. The existing rule that nothing in src/ knows about any of these tools already makes this a scope and documentation change rather than a redesign, and the standing-consent authorization model applies unchanged to whichever bindings run the loop.

  Depends on `apply-plan-atomic-batch-import-of-a` (done), `sequencing-commands-project-next-ready` (done), `project-start-mark-a-goal-in-flight-and` (done).

## Later

- **[open]** context-surface: show the active goal inside each harness - `context-surface-show-the-active-goal`

  Pi sessions get the compact widget showing the active Project Goal and up to three unfinished Session Tasks, so a Pi user never has to ask what they are working on. Every other harness gets nothing, and the agent only learns the active goal if it thinks to run a command. That gap is the last place where Pi is structurally privileged after the pivot.

  Survey what each harness actually offers before building anything: Claude Code has a statusline hook and session-start hooks, some harnesses have persistent context files, and several have no equivalent surface at all. The likely answer is that the MCP server exposes the active goal as a resource, the generated skill and AGENTS.md block tell the agent to read it at session start, and anything richer is a per-harness adapter shipped as an optional extra rather than core. Deliberately deferred until the MCP server lands, because the resource it would expose does not exist yet, and because building per-harness adapters before knowing which harnesses people actually use would be guessing.

  Depends on `mcp-server-expose-the-worklist-over-mcp` (done).

- **[open]** branch-scoped-active: per-worktree featured goal via links - `branch-scoped-active-per-worktree`

  In a worktree, derive the widget and dashboard featured goal from the current git branch matched against the dedicated branch field, falling back to the stored single active goal. Per-worktree focus without changing active semantics.

  Generalized 2026-08-08 by the harness pivot: the original wording scoped this to the Pi widget and dashboard, which are now one surface among several. Derive the featured goal from the branch in every surface that shows one - the CLI, the goal board, whatever the MCP server exposes as the active-goal resource, and the Pi widget and dashboard - resolving it once in shared code rather than per renderer. Branch-derived focus is most valuable in the CLI and board, since that is where a fan-out session actually runs.

  Depends on `schema-fields-group-completedat-links` (done), `project-start-mark-a-goal-in-flight-and` (done).

- **[open]** goal-checklist: acceptance criteria items per goal - `goal-checklist-acceptance-criteria`

  Optional checklist items (text plus done flag) per goal as acceptance criteria, with CRUD subcommands, TUI detail rendering, and contract docs. Gives agent sessions a concrete definition of done.

  Depends on `schema-fields-group-completedat-links` (done).

- **[open]** merge-driver: structural git merge for worklist.json - `merge-driver-structural-git-merge-for`

  Custom git merge driver (pi-worklist merge-file registered via .gitattributes): union goals by ID; within a goal edited on both sides, union the array fields (dependsOn, links) and apply newest-updatedAt only to scalar fields, because goal-level last-writer-wins would drop a concurrent edit to a different aspect of the same goal; revision becomes max plus one. Only needed if branch sessions ever write the worklist; until then the root-session-on-main convention keeps merges conflict-free by construction.

## Pi

- **[open, blocked]** pi-tui-parity: mirror board polish in the Pi widget and dashboard - `pi-tui-parity-mirror-board-polish-in`

  Bring the inline Pi surfaces up to the same visual system as the terminal board so the board does not become the favored child: status dimming and staleness markers in the dashboard goal list, group sections in the dashboard, a counts line and distinct active-goal treatment in the widget, and the new schema fields (group, dependencies, completedAt) surfaced in the dashboard detail view. One visual language, two renderers: keep every treatment consistent with what tui-polish and tui-groups established rather than inventing a second style.

  Re-scoped 2026-08-08 by the harness pivot: this is Pi-surface work. Project Goals are now the cross-harness product and Session Tasks are a Pi extension feature, kept working and documented but no longer receiving investment. The goal stays open because the Pi extension stays supported, but it sits behind the Harness group and behind any goal that serves every harness rather than one.

  Depends on `tui-polish-quick-readability-wins-in` (done), `tui-groups-collapsible-group-sections` (open).

- **[open]** focus-mode: show only Session Tasks linked to the active goal - `focus-mode-show-only-session-tasks`

  Replaces earlier goal future-focus. Show only Session Tasks linked to the active Project Goal via SessionTask.goalId in the widget and dashboard, with a toggle to return to all tasks.

  Re-scoped 2026-08-08 by the harness pivot: this is Pi-surface work. Project Goals are now the cross-harness product and Session Tasks are a Pi extension feature, kept working and documented but no longer receiving investment. The goal stays open because the Pi extension stays supported, but it sits behind the Harness group and behind any goal that serves every harness rather than one.

- **[open]** task-promotion: promote a Session Task into a Project Goal - `task-promotion-promote-a-session-task`

  Replaces earlier goal future-promote. Manually promote a Session Task into a Project Goal, carrying the title and recording promotedFrom provenance on the new goal.

  Re-scoped 2026-08-08 by the harness pivot: this is Pi-surface work. Project Goals are now the cross-harness product and Session Tasks are a Pi extension feature, kept working and documented but no longer receiving investment. The goal stays open because the Pi extension stays supported, but it sits behind the Harness group and behind any goal that serves every harness rather than one.

  Depends on `slug-ids-human-readable-goal-ids-and` (done).

- **[open]** archive-browsing: archived goals in the Pi dashboard - `archive-browsing-archived-goals-in-the`

  Replaces earlier goal future-archive-ui. Re-scoped: the project ui board already has an archived filter, so the remaining gap is browsing archived goals inside the Pi dashboard, or closing this goal if that is not worth building.

  Re-scoped 2026-08-08 by the harness pivot: this is Pi-surface work. Project Goals are now the cross-harness product and Session Tasks are a Pi extension feature, kept working and documented but no longer receiving investment. The goal stays open because the Pi extension stays supported, but it sits behind the Harness group and behind any goal that serves every harness rather than one.

## Audit remediation

- **[done]** Harden generated AGENTS guidance - `harden-generated-agents-guidance`

  Make the always-loaded generated AGENTS block safe as a compact command reference. Pin the frozen marker literals so a package rename cannot orphan blocks already written into other repositories, render or explicitly document the action scopes of listed flags, and extend contract tests so this surface cannot suggest invalid exit-code-2 invocations or silently drift from the canonical command contract.

- **[done]** Complete Pi capture guidance - `complete-pi-capture-guidance`

  Bring the Pi worklist model tool prompt up to the same capture contract as the generated skill, AGENTS block, CLI guide, and MCP metadata. Tell Pi agents to propose broad outcomes, present the exact JSON batch for explicit approval, treat dry-run only as a preview, apply an approved batch in exactly one mutating apply-plan call, and never decompose it into per-goal add calls. Preserve the exact-confirmation guardrails and test the prompt delivered to the registered tool.

- **[done]** Align MCP adapter contracts - `align-mcp-adapter-contracts`

  Make the MCP resources and tools obey the same input and result contracts as the CLI and shared application service. Refuse title changes combined with appendDescription, preserve exact plan dependency-reference validation instead of trimming invalid input, reject blank find queries instead of returning every goal, replace CLI-argv tool titles with MCP-native metadata, keep schema failures and service failures predictably documented, and cover the shared envelope metadata and validation behavior through the real MCP protocol.

- **[open]** Isolate Claude plugin MCP config - `isolate-claude-plugin-mcp-config`

  Stop the plugin's MCP declaration from also registering a broken project-scoped server in this repository. Put the MCP configuration in a plugin-owned location or inline declaration where CLAUDE_PLUGIN_ROOT and CLAUDE_PROJECT_DIR are expanded by Claude Code, preserve generated-artifact and package coverage, and verify both a real plugin install and a contributor checkout without missing-variable diagnostics.

  Depends on `align-mcp-adapter-contracts` (done).

- **[open]** Repair project start semantics - `repair-project-start-semantics`

  Correct the branch-claim lifecycle across the CLI, application service, persistence layer, MCP, and Pi model tool. Clearing a stale branch from an already-done goal must preserve its historical completedAt, project start --json must return a typed JSON failure on detached HEAD or branch lookup failure, and the Pi schema must expose expectedUpdatedAt so claims can use the same optimistic concurrency guard as CLI and MCP. Add observable regressions for each interface and preserve ready-frontier claim behavior.

- **[open, blocked]** Make dispatch bindings safe - `make-dispatch-bindings-safe`

  Repair the packaged dispatch recipe so both bindings launch bounded parallel work without leaking or corrupting claims and workspaces. Herdr prompt submission must not wait indefinitely or interpret an ambiguous wait failure as permission to abandon a submitted worker; every clear must use the updatedAt returned by its own claim; detached launches need an executable startup handshake; Herdr agents and panes must close before returning Treehouse leases; and dirty-worktree cleanup must be non-interactive, explicit, and verified. Exercise the exact documented commands rather than substitute driver commands.

  Depends on `repair-project-start-semantics` (open).
