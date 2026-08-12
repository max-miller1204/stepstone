# The MCP `links` argument accepts a URL however a caller spells it

A real MCP client speaking to `createStepstoneMcpServer` over a linked transport,
exactly as Claude Code or any other model host drives it. Nothing below is stubbed.

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

### a bare origin, an uppercase scheme, and an accented path are accepted and stored canonically

```json
// -> tools/call add {"title":"Track the upstream tracker","links":["https://example.com","HTTPS://example.com/spec","https://example.com/spéc"]}
// <- isError: false
{
  "ok": true,
  "action": "add",
  "goal": {
    "id": "track-the-upstream-tracker",
    "links": [
      "https://example.com/",
      "https://example.com/spec",
      "https://example.com/sp%C3%A9c"
    ]
  }
}
```

### two spellings of one address name one link, so the set stores it once

```json
// -> tools/call update {"id":"track","links":["https://example.com","https://example.com/"]}
// <- isError: false
{
  "ok": true,
  "action": "update",
  "goal": {
    "id": "track-the-upstream-tracker",
    "links": [
      "https://example.com/"
    ]
  }
}
```

### an unrelated update leaves the links alone

```json
// -> tools/call update {"id":"track","group":"Foundation"}
// <- isError: false
{
  "ok": true,
  "action": "update",
  "goal": {
    "id": "track-the-upstream-tracker",
    "links": [
      "https://example.com/"
    ]
  }
}
```

### a URL that is not absolute HTTP(S) is still refused

```json
// -> tools/call update {"id":"track","links":["github.com/example/colony"]}
// <- isError: true
MCP error -32602: Input validation error: Invalid arguments for tool update: Invalid URL at links[0]
```

### an empty array still clears every link

```json
// -> tools/call update {"id":"track","links":[]}
// <- isError: false
{
  "ok": true,
  "action": "update",
  "goal": {
    "id": "track-the-upstream-tracker",
    "links": null
  }
}
```

### The goal the session leaves behind, read straight off disk

```json
{
  "id": "track-the-upstream-tracker",
  "title": "Track the upstream tracker",
  "status": "open",
  "createdAt": "2026-08-12T05:45:31.120Z",
  "updatedAt": "2026-08-12T05:45:31.130Z",
  "group": "Foundation",
  "hasLinksKey": false
}
```

