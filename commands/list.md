---
description: "Show a compact bounded list of project goals"
---

<!-- Generated from src/cli-contract.ts by scripts/generate-docs.ts. Do not edit manually. -->

Read the bundled Stepstone MCP resource `stepstone://worklist/list`, which performs the deterministic read-only `stepstone project list` action for the current repository.
Return the resource's result without changing its order or selecting a different project action.
This command is read-only.
Do not call an MCP tool, run a mutating Stepstone action, or modify the worklist file directly.
