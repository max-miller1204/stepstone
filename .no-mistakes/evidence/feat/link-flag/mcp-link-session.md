# Stepstone MCP `links` end-to-end session

A real MCP client speaking JSON-RPC over stdio to `node src/mcp.ts`, exactly as
Claude Code or any other model host drives it. Nothing below is stubbed.

## The `links` argument the tool schema advertises to the model

```json
{
  "tool": "add",
  "links": {
    "type": "array",
    "items": {
      "type": "string",
      "format": "uri"
    }
  }
}
```

```json
{
  "tool": "update",
  "links": {
    "type": "array",
    "items": {
      "type": "string",
      "format": "uri"
    }
  }
}
```

## Session

### add stores the set and drops the duplicate entry

```json
// -> tools/call add {"title":"Migrate the colony goals off GitHub Issues","links":["https://github.com/example/colony/issues/17","https://example.com/audit/2026-08-05","https://github.com/example/colony/issues/17"]}
// <- isError: false
{
  "ok": true,
  "action": "add",
  "goal": {
    "id": "migrate-the-colony-goals-off-github",
    "title": "Migrate the colony goals off GitHub Issues",
    "links": [
      "https://github.com/example/colony/issues/17",
      "https://example.com/audit/2026-08-05"
    ]
  }
}
```

### an unrelated update leaves the links untouched

```json
// -> tools/call update {"id":"migrate","group":"Foundation"}
// <- isError: false
{
  "ok": true,
  "action": "update",
  "goal": {
    "id": "migrate-the-colony-goals-off-github",
    "title": "Migrate the colony goals off GitHub Issues",
    "links": [
      "https://github.com/example/colony/issues/17",
      "https://example.com/audit/2026-08-05"
    ],
    "group": "Foundation"
  }
}
```

### a non-absolute URL is refused by the tool contract before anything is written

```json
// -> tools/call update {"id":"migrate","links":["not-a-url"]}
// <- isError: true
MCP error -32602: Input validation error: Invalid arguments for tool update: Invalid URL at links[0]
Invalid input at links[0]
```

### so is a non-HTTP scheme

```json
// -> tools/call update {"id":"migrate","links":["ftp://example.com/spec.pdf"]}
// <- isError: true
MCP error -32602: Input validation error: Invalid arguments for tool update: Invalid input at links[0]
```

### an update replaces the whole set rather than adding to it

```json
// -> tools/call update {"id":"migrate","links":["https://example.com/audit/2026-08-05","https://github.com/example/colony/pull/58"]}
// <- isError: false
{
  "ok": true,
  "action": "update",
  "goal": {
    "id": "migrate-the-colony-goals-off-github",
    "title": "Migrate the colony goals off GitHub Issues",
    "links": [
      "https://example.com/audit/2026-08-05",
      "https://github.com/example/colony/pull/58"
    ],
    "group": "Foundation"
  }
}
```

### an empty array clears every link

```json
// -> tools/call update {"id":"migrate","links":[]}
// <- isError: false
{
  "ok": true,
  "action": "update",
  "goal": {
    "id": "migrate-the-colony-goals-off-github",
    "title": "Migrate the colony goals off GitHub Issues",
    "links": null,
    "group": "Foundation"
  }
}
```

### The goal the session leaves behind, read back through the read-only resource

```json
// -> resources/read stepstone://worklist/show/migrate
{
  "id": "migrate-the-colony-goals-off-github",
  "title": "Migrate the colony goals off GitHub Issues",
  "status": "open",
  "createdAt": "2026-08-12T05:21:04.294Z",
  "updatedAt": "2026-08-12T05:21:04.347Z",
  "group": "Foundation",
  "hasLinksKey": false
}
```
