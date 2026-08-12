# MCP adapter contract alignment - before/after evidence

Both columns come from the same harness (`mcp-parity-harness.mjs`), which spawns the real stdio MCP
server (`node src/mcp.ts`) in a fresh git repository, talks to it with the MCP SDK client, and runs
the equivalent `stepstone project ... --json` CLI command against the same repository.

- Full transcripts: [`before.txt`](before.txt) (base `6d4b0ff`), [`after.txt`](after.txt) (target `f80556e`).

## 1. Catalog titles an MCP client displays

| Primitive | Before (argv usage string) | After (human-readable title) |
| --- | --- | --- |
| `stepstone://worklist/list` | `list` | `List project goals` |
| `stepstone://worklist/show/{id}` | `show <id>` | `Show project goal` |
| `stepstone://worklist/find/{query}` | `find <text...>` | `Find project goals` |
| tool `add` | `add <title...> [--description <text> \| -- <description...>]` | `Add project goal` |
| tool `update` | `update <id> [title...] [--description <text> \| -- <description...>]` | `Update project goal` |
| tool `apply-plan` | `apply-plan <plan.json>` | `Apply project goal plan` |
| tool `move` | `move <id> up\|down\|before <id>\|after <id>` | `Move project goal` |

Every resource, template, and tool now carries a prose title instead of CLI argv syntax; the full
lists are in section 1 of each transcript.

## 2. Refusals the CLI already made, now made by MCP too

| Request | MCP before | MCP after | CLI (unchanged) |
| --- | --- | --- | --- |
| `update {id, title, appendDescription}` | `ok: true` - renamed the goal *and* appended | `isError: true`, `VALIDATION_FAILED`, `details.fields: ["appendDescription","title"]` | usage error: `project update cannot change the title while appending to the description` |
| `apply-plan [{dependsOn: [" alpha-goal "]}]` | `ok: true` - schema trimmed the reference and created the dependency | `isError: true`, `VALIDATION_FAILED`, `fields: ["plan/0/dependsOn"]`, `resolution: remove-surrounding-reference-whitespace` | same envelope, byte-identical apart from `meta.cliVersion` |
| read `stepstone://worklist/find/%20%20` | `ok: true` - returned **every** goal | `ok: false`, `VALIDATION_FAILED`, `fields: ["query"]`, `resolution: provide-non-blank-search-text` | usage error: `project find requires search text` |
| read `stepstone://worklist/show/missing` | `NOT_FOUND` with meta missing `revisions` | `NOT_FOUND` with `meta.revisions.project: "1"`, the snapshot the read was answered from | `NOT_FOUND` |

Roadmap state after all four requests (section 8 of each transcript):

- Before: `alpha-goal | title: Renamed goal | dependsOn: []` + a second goal `dependent-goal | dependsOn: ["alpha-goal"]`, description `"New context."` - the two silent acceptances wrote.
- After: `alpha-goal | title: Alpha goal | dependsOn: []`, description `""` - every refusal happened before any write.

## 3. Schema failures stay distinguishable from service failures

`update {id, links: ["not-a-url"]}` (unchanged behavior, now documented in `docs/mcp.md`):

```
isError: true | structuredContent present: false
content: [{"type":"text","text":"MCP error -32602: Input validation error: Invalid arguments for tool update: Invalid URL at links[0]"}]
```

A service-level failure, by contrast, keeps `structuredContent` and the typed envelope (section 3/4
of the after transcript), so a client can tell "fix your field types" from "the roadmap refused this".
