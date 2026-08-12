# The canonical goal is complete on this repository's own roadmap

Read back through the CLI, in this worktree, at target commit 399ed5a.

```text
$ stepstone project show capture-skill-brainstorm-to-approved
capture-skill-brainstorm-to-approved: capture-skill: brainstorm to approved plan to one apply
status: done
group: Capture
created: 2026-08-04T02:37:25.671Z
updated: 2026-08-12T02:03:00.732Z
completed: 2026-08-12T02:03:00.732Z
former ids: goal-mse1sdnr-21dfc2f0
depends on:
  apply-plan-atomic-batch-import-of-a [done]
description:
Extend the worklist skill with a capture flow: draft a JSON plan document from a brainstorm session, show it for approval, then apply it with a single apply-plan call. Teach the skill to add a dependsOn edge between goals that will collide on the same modules even without a logical dependency, choosing the more natural order, since edges mean must-land-before.

Broadened 2026-08-08 by the harness pivot. The flow was scoped to the worklist skill, which is one of several agent-facing renderings rather than the only one. Land the capture guidance in the generated contract so it reaches the skill, the AGENTS.md block, and the MCP tool descriptions from one source, and so an agent in a harness that never reads .claude/skills still knows how to run a brainstorm to an approved plan to one apply.

$ stepstone project list | grep capture-skill
[done] capture-skill-brainstorm-to-approved: capture-skill: brainstorm to approved plan to one apply
```

The regenerated roadmap page agrees:

```markdown
45 goals: 15 open, 27 done, 3 archived.
- **[done]** capture-skill: brainstorm to approved plan to one apply - `capture-skill-brainstorm-to-approved`
```
