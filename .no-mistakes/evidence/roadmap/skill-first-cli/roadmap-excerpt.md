<!-- Generated from .worklist/worklist.json by scripts/generate-docs.ts. Do not edit manually. -->

# Roadmap

Every Project Goal in this repository, rendered from `.worklist/worklist.json` so the roadmap reads here without a terminal.
Each section is a group goals are filed under, and the goals inside one are in the roadmap's canonical file order.
Every goal states its status, whether the dependency graph has it waiting, and the goals it waits on.
A goal's description is a record of what was decided when it was written rather than a current instruction, so an older one may still name a path, a package, or a directory this project has since renamed.

54 goals: 13 open, 38 done, 3 archived.

## Orchestrator

...

- **[open]** Retire MCP and Claude plugin surfaces - `retire-mcp-and-claude-plugin-surfaces`

  Make the stepstone CLI the sole cross-harness capability transport. Remove the stepstone-mcp executable, MCP server and adapter, protocol metadata, tests, documentation, packaging exercises, and MCP-only runtime dependencies. Retire the Claude Code plugin and its generated skill copy, MCP declaration, and slash commands because the standalone Agent Skill and CLI provide the supported workflow without a client-specific adapter. Preserve the terminal board, Pi extension, shared application service, roadmap format, locking, and confirmation guardrails. No worklist data migration is required.

- **[open, blocked]** Make skill-first onboarding explicit - `make-skill-first-onboarding-explicit`

  Present the Agent Skill as the preferred guidance installation and project init as an alternative fallback for harnesses that read AGENTS.md but do not support skills. Reduce the generated AGENTS block to the canonical storage rule, CLI invocation, JSON-output preference, exact approval guardrails, capture workflow, and project help pointer instead of duplicating the full command and flag manual. Update the README and generated documentation so users are never told to install both surfaces, and reconcile open roadmap descriptions that still assume MCP resources or the Claude plugin. Keep every generated artifact sourced from the command contract.

  Depends on `retire-mcp-and-claude-plugin-surfaces` (open).

## Visibility

