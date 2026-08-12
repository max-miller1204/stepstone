# One contract-owned capture workflow, as each agent-facing surface renders it

The workflow is declared once, on the `apply-plan` action in `src/cli-contract.ts`.
Every block below was produced by calling the renderers at target commit 399ed5a, so this is the text an agent actually receives.

## Generated skill (`.claude/skills/stepstone/SKILL.md`)

```markdown
## Capture brainstorms as approved goal plans

1. Brainstorm broad outcomes for the roadmap rather than internal implementation steps.
2. Draft the exact plain JSON array that represents the complete proposed goal batch.
3. When a later, naturally ordered goal would collide with an earlier goal in the same modules or files, add the earlier goal's pre-collision slug to the later goal's `dependsOn` array even when no logical dependency exists.
4. Present that exact JSON array to the user and wait for explicit approval before making any mutation.
5. An optional dry-run is only a preview of validation, projected IDs, dependencies, and warnings; it is never approval and never replaces the explicit approval step.
6. After explicit approval, perform exactly one mutating `apply-plan` call for the entire approved array; never turn the batch into per-goal `add` calls.
```

## Marker-managed AGENTS.md block (`renderAgentsMarkdownBlock()`)

```markdown
Capture plan entry shape: `{"title":"required broad outcome","description":"optional context","group":"optional section","dependsOn":["optional goal reference"]}`. No other fields are accepted.

Capture workflow: Brainstorm broad outcomes for the roadmap rather than internal implementation steps. Draft the exact plain JSON array that represents the complete proposed goal batch. When a later, naturally ordered goal would collide with an earlier goal in the same modules or files, add the earlier goal's pre-collision slug to the later goal's `dependsOn` array even when no logical dependency exists. Present that exact JSON array to the user and wait for explicit approval before making any mutation. An optional dry-run is only a preview of validation, projected IDs, dependencies, and warnings; it is never approval and never replaces the explicit approval step. After explicit approval, perform exactly one mutating `apply-plan` call for the entire approved array; never turn the batch into per-goal `add` calls.
```

## Generated CLI guide (`docs/cli.md`)

```markdown
## Capture brainstorms as approved goal plans

1. Brainstorm broad outcomes for the roadmap rather than internal implementation steps.
2. Draft the exact plain JSON array that represents the complete proposed goal batch.
3. When a later, naturally ordered goal would collide with an earlier goal in the same modules or files, add the earlier goal's pre-collision slug to the later goal's `dependsOn` array even when no logical dependency exists.
4. Present that exact JSON array to the user and wait for explicit approval before making any mutation.
5. An optional dry-run is only a preview of validation, projected IDs, dependencies, and warnings; it is never approval and never replaces the explicit approval step.
6. After explicit approval, perform exactly one mutating `apply-plan` call for the entire approved array; never turn the batch into per-goal `add` calls.
```

## MCP `apply-plan` tool description (`tools/list`)

```text
Validate and atomically add every goal in a JSON plan. Brainstorm broad outcomes for the roadmap rather than internal implementation steps. Draft the exact plain JSON array that represents the complete proposed goal batch. When a later, naturally ordered goal would collide with an earlier goal in the same modules or files, add the earlier goal's pre-collision slug to the later goal's `dependsOn` array even when no logical dependency exists. Present that exact JSON array to the user and wait for explicit approval before making any mutation. An optional dry-run is only a preview of validation, projected IDs, dependencies, and warnings; it is never approval and never replaces the explicit approval step. After explicit approval, perform exactly one mutating `apply-plan` call for the entire approved array; never turn the batch into per-goal `add` calls.
```

## Guardrail change: the mutating call left the unconditional safe list

Before this change the skill's guardrails read:

```markdown
- `init`, `list`, `show`, `find`, `next`, `ready`, `waves`, `add`, `apply-plan`, `update`, `move`, and `set_active` are safe to run whenever they serve the user's request.
```

It now reads:

```markdown
- `init`, `list`, `show`, `find`, `next`, `ready`, `waves`, `add`, `update`, `move`, and `set_active` are safe to run whenever they serve the user's request.
- `apply-plan --dry-run` is safe for preview; a mutating `apply-plan` is safe only after explicit approval of that exact plan.
```
