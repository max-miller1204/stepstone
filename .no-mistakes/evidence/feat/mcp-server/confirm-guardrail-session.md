# Confirmation guardrails as a client sees them, against a Pi-free install

Every frame below is raw newline-delimited JSON-RPC exchanged with the `stepstone-mcp` executable installed from the publishable tarball.
No MCP SDK client, in-memory transport, or source import is involved.
This transcript re-verifies the corrected statement in docs/mcp.md: the shipped schemas declare `confirm` as an **optional** boolean, and the guardrail is enforced by the application service, so an omitted `confirm` returns the actionable `APPROVAL_REQUIRED` envelope instead of a guidance-free protocol validation error.

## 1. Pi-free install of the published tarball

```console
$ npm pack                      -> stepstone-0.2.3.tgz
$ npm install <tarball> --omit=dev --omit=peer
$ ls node_modules/.bin          -> node-which, stepstone, stepstone-mcp
$ grep -c @earendil-works       -> 0 Pi packages in the installed tree
```

## 2. Handshake with the installed bin

```jsonrpc
-> {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"confirm-evidence-client","version":"1.0.0"}}}
<- {"result":{"protocolVersion":"2025-06-18","capabilities":{"resources":{"listChanged":true},"tools":{"listChanged":true}},"serverInfo":{"name":"stepstone-mcp","version":"0.2.3"}},"jsonrpc":"2.0","id":1}
-> {"jsonrpc":"2.0","method":"notifications/initialized"}
```

## 3. The published schemas for the four guarded tools

`required` never lists `confirm`, and `confirm` is an optional boolean carrying its own description.
The tool metadata still advertises `confirmRequired: true`:

```json
{
  "complete": {
    "required": [
      "id"
    ],
    "properties.confirm": {
      "description": "Explicit confirmation that the user requested this exact action for this exact goal",
      "type": "boolean"
    },
    "_meta": {
      "confirmRequired": true
    }
  },
  "reopen": {
    "required": [
      "id"
    ],
    "properties.confirm": {
      "description": "Explicit confirmation that the user requested this exact action for this exact goal",
      "type": "boolean"
    },
    "_meta": {
      "confirmRequired": true
    }
  },
  "archive": {
    "required": [
      "id"
    ],
    "properties.confirm": {
      "description": "Explicit confirmation that the user requested this exact action for this exact goal",
      "type": "boolean"
    },
    "_meta": {
      "confirmRequired": true
    }
  },
  "delete": {
    "required": [
      "id"
    ],
    "properties.confirm": {
      "description": "Explicit confirmation that the user requested this exact action for this exact goal",
      "type": "boolean"
    },
    "_meta": {
      "confirmRequired": true
    }
  }
}
```

The full published schema for `complete`:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "minLength": 1,
      "description": "A complete goal ID or unique ID prefix"
    },
    "confirm": {
      "description": "Explicit confirmation that the user requested this exact action for this exact goal",
      "type": "boolean"
    },
    "expectedUpdatedAt": {
      "description": "The target goal's updatedAt value from the caller's last read",
      "type": "string",
      "minLength": 1
    }
  },
  "required": [
    "id"
  ],
  "additionalProperties": false
}
```

## 4. Seed goal

```jsonrpc
-> {"name":"add","id":"guarded-by-exact-confirmation"}
<- {"result":{"content":[{"type":"text","text":"{\"ok\":true,\"scope\":\"project\",\"action\":\"add\",\"result\":{\"scope\":\"project\",\"action\":\"add\",\"goal\":{\"id\":\"guarded-by-exact-confirmation\",\"title\":\"Guarded by exact confirmation\",\"description\":\"Subject of the confirmation checks.\",\"status\":\"open\",\"createdAt\":\"2026-08-11T23:32:46.317Z\",\"updatedAt\":\"2026-08-11T23:32:46.317Z\"},\"goals\":[{\"id\":\"guarded-by-exact-confirmation\",\"title\":\"Guarded by exact confirmation\",\"description\":\"Subject of the confirmation checks.\",\"status\":\"open\",\"createdAt\":\"2026-08-11T23:32:46.317Z\",\"updatedAt\":\"2026-08-11T23:32:46.317Z\"}]},\"meta\":{\"changed\":true,\"semanticNoOp\":false,\"changedFields\":[\"/goals\"],\"changedEntities\":{\"projectGoalIds\":[\"guarded-by-exact-confirmation\"],\"sessionTaskIds\":[]},\"revisions\":{\"project\":\"1\"}}}"}],"structuredContent":{"ok":true,"scope":"project","action":"add","result":{"scope":"project","action":"add","goal":{"id":"guarded-by-exact-confirmation","title":"Guarded by exact confirmation","description":"Subject of the confirmation checks.","status":"open","createdAt":"2026-08-11T23:32:46.317Z","updatedAt":"2026-08-11T23:32:46.317Z"},"goals":[{"id":"guarded-by-exact-confirmation","title":"Guarded by exact confirmation","description":"Subject of the confirmation checks.","status":"open","createdAt":"2026-08-11T23:32:46.317Z","updatedAt":"2026-08-11T23:32:46.317Z"}]},"meta":{"changed":true,"semanticNoOp":false,"changedFields":["/goals"],"changedEntities":{"projectGoalIds":["guarded-by-exact-confirmation"],"sessionTaskIds":[]},"revisions":{"project":"1"}}},"isError":false},"jsonrpc":"2.0","id":3}
```

## 5.1 `complete`

Omitted `confirm` - reaches the service and is refused, with the roadmap file untouched:

```jsonrpc
-> {"jsonrpc":"2.0","method":"tools/call","params":{"name":"complete","arguments":{"id":"guarded-by-exact-confirmation"}}}
<- {"result":{"content":[{"type":"text","text":"{\"ok\":false,\"scope\":\"project\",\"action\":\"complete\",\"error\":{\"code\":\"APPROVAL_REQUIRED\",\"message\":\"Project complete requires explicit confirmation.\",\"retryable\":false,\"details\":{\"confirmation\":\"confirm=true\",\"resolution\":\"request-explicit-user-confirmation\"}},\"meta\":{\"changed\":false,\"semanticNoOp\":false,\"changedFields\":[]}}"}],"structuredContent":{"ok":false,"scope":"project","action":"complete","error":{"code":"APPROVAL_REQUIRED","message":"Project complete requires explicit confirmation.","retryable":false,"details":{"confirmation":"confirm=true","resolution":"request-explicit-user-confirmation"}},"meta":{"changed":false,"semanticNoOp":false,"changedFields":[]}},"isError":true},"jsonrpc":"2.0","id":4}
```

```json
{
  "schema rejected the call": false,
  "isError": true,
  "error.code": "APPROVAL_REQUIRED",
  "error.details": {
    "confirmation": "confirm=true",
    "resolution": "request-explicit-user-confirmation"
  },
  "meta.changed": false,
  "roadmap sha256 before": "174351fd06689e55",
  "roadmap sha256 after": "174351fd06689e55",
  "file untouched": true
}
```

`confirm: false`, a non-boolean `confirm`, then the approved call:

```json
{
  "confirm: false": {
    "error.code": "APPROVAL_REQUIRED",
    "file untouched": true
  },
  "confirm: \"true\" (a string, which the boolean schema rejects)": {
    "isError": true,
    "schema rejected the call before the service ran": true,
    "client sees": "MCP error -32602: Input validation error: Invalid arguments for tool complete: Invalid input: expected boolean, received string at confirm",
    "file untouched": true
  },
  "confirm: true": {
    "ok": true,
    "meta.changed": true,
    "meta.changedFields": [
      "/goals"
    ],
    "status now": "done",
    "file changed": true
  }
}
```

The approved call's raw frame:

```jsonrpc
<- {"result":{"content":[{"type":"text","text":"{\"ok\":true,\"scope\":\"project\",\"action\":\"complete\",\"result\":{\"scope\":\"project\",\"action\":\"complete\",\"goal\":{\"id\":\"guarded-by-exact-confirmation\",\"title\":\"Guarded by exact confirmation\",\"description\":\"Subject of the confirmation checks.\",\"status\":\"done\",\"createdAt\":\"2026-08-11T23:32:46.317Z\",\"updatedAt\":\"2026-08-11T23:32:46.328Z\",\"completedAt\":\"2026-08-11T23:32:46.328Z\"},\"goals\":[{\"id\":\"guarded-by-exact-confirmation\",\"title\":\"Guarded by exact confirmation\",\"description\":\"Subject of the confirmation checks.\",\"status\":\"done\",\"createdAt\":\"2026-08-11T23:32:46.317Z\",\"updatedAt\":\"2026-08-11T23:32:46.328Z\",\"completedAt\":\"2026-08-11T23:32:46.328Z\"}]},\"meta\":{\"changed\":true,\"semanticNoOp\":false,\"changedFields\":[\"/goals\"],\"changedEntities\":{\"projectGoalIds\":[\"guarded-by-exact-confirmation\"],\"sessionTaskIds\":[]},\"revisions\":{\"project\":\"2\"}}}"}],"structuredContent":{"ok":true,"scope":"project","action":"complete","result":{"scope":"project","action":"complete","goal":{"id":"guarded-by-exact-confirmation","title":"Guarded by exact confirmation","description":"Subject of the confirmation checks.","status":"done","createdAt":"2026-08-11T23:32:46.317Z","updatedAt":"2026-08-11T23:32:46.328Z","completedAt":"2026-08-11T23:32:46.328Z"},"goals":[{"id":"guarded-by-exact-confirmation","title":"Guarded by exact confirmation","description":"Subject of the confirmation checks.","status":"done","createdAt":"2026-08-11T23:32:46.317Z","updatedAt":"2026-08-11T23:32:46.328Z","completedAt":"2026-08-11T23:32:46.328Z"}]},"meta":{"changed":true,"semanticNoOp":false,"changedFields":["/goals"],"changedEntities":{"projectGoalIds":["guarded-by-exact-confirmation"],"sessionTaskIds":[]},"revisions":{"project":"2"}}},"isError":false},"jsonrpc":"2.0","id":7}
```

## 5.2 `reopen`

Omitted `confirm` - reaches the service and is refused, with the roadmap file untouched:

```jsonrpc
-> {"jsonrpc":"2.0","method":"tools/call","params":{"name":"reopen","arguments":{"id":"guarded-by-exact-confirmation"}}}
<- {"result":{"content":[{"type":"text","text":"{\"ok\":false,\"scope\":\"project\",\"action\":\"reopen\",\"error\":{\"code\":\"APPROVAL_REQUIRED\",\"message\":\"Project reopen requires explicit confirmation.\",\"retryable\":false,\"details\":{\"confirmation\":\"confirm=true\",\"resolution\":\"request-explicit-user-confirmation\"}},\"meta\":{\"changed\":false,\"semanticNoOp\":false,\"changedFields\":[]}}"}],"structuredContent":{"ok":false,"scope":"project","action":"reopen","error":{"code":"APPROVAL_REQUIRED","message":"Project reopen requires explicit confirmation.","retryable":false,"details":{"confirmation":"confirm=true","resolution":"request-explicit-user-confirmation"}},"meta":{"changed":false,"semanticNoOp":false,"changedFields":[]}},"isError":true},"jsonrpc":"2.0","id":8}
```

```json
{
  "schema rejected the call": false,
  "isError": true,
  "error.code": "APPROVAL_REQUIRED",
  "error.details": {
    "confirmation": "confirm=true",
    "resolution": "request-explicit-user-confirmation"
  },
  "meta.changed": false,
  "roadmap sha256 before": "1dc5cfd80022aa03",
  "roadmap sha256 after": "1dc5cfd80022aa03",
  "file untouched": true
}
```

`confirm: false`, a non-boolean `confirm`, then the approved call:

```json
{
  "confirm: false": {
    "error.code": "APPROVAL_REQUIRED",
    "file untouched": true
  },
  "confirm: \"true\" (a string, which the boolean schema rejects)": {
    "isError": true,
    "schema rejected the call before the service ran": true,
    "client sees": "MCP error -32602: Input validation error: Invalid arguments for tool reopen: Invalid input: expected boolean, received string at confirm",
    "file untouched": true
  },
  "confirm: true": {
    "ok": true,
    "meta.changed": true,
    "meta.changedFields": [
      "/goals"
    ],
    "status now": "open",
    "file changed": true
  }
}
```

The approved call's raw frame:

```jsonrpc
<- {"result":{"content":[{"type":"text","text":"{\"ok\":true,\"scope\":\"project\",\"action\":\"reopen\",\"result\":{\"scope\":\"project\",\"action\":\"reopen\",\"goal\":{\"id\":\"guarded-by-exact-confirmation\",\"title\":\"Guarded by exact confirmation\",\"description\":\"Subject of the confirmation checks.\",\"status\":\"open\",\"createdAt\":\"2026-08-11T23:32:46.317Z\",\"updatedAt\":\"2026-08-11T23:32:46.331Z\"},\"goals\":[{\"id\":\"guarded-by-exact-confirmation\",\"title\":\"Guarded by exact confirmation\",\"description\":\"Subject of the confirmation checks.\",\"status\":\"open\",\"createdAt\":\"2026-08-11T23:32:46.317Z\",\"updatedAt\":\"2026-08-11T23:32:46.331Z\"}]},\"meta\":{\"changed\":true,\"semanticNoOp\":false,\"changedFields\":[\"/goals\"],\"changedEntities\":{\"projectGoalIds\":[\"guarded-by-exact-confirmation\"],\"sessionTaskIds\":[]},\"revisions\":{\"project\":\"3\"}}}"}],"structuredContent":{"ok":true,"scope":"project","action":"reopen","result":{"scope":"project","action":"reopen","goal":{"id":"guarded-by-exact-confirmation","title":"Guarded by exact confirmation","description":"Subject of the confirmation checks.","status":"open","createdAt":"2026-08-11T23:32:46.317Z","updatedAt":"2026-08-11T23:32:46.331Z"},"goals":[{"id":"guarded-by-exact-confirmation","title":"Guarded by exact confirmation","description":"Subject of the confirmation checks.","status":"open","createdAt":"2026-08-11T23:32:46.317Z","updatedAt":"2026-08-11T23:32:46.331Z"}]},"meta":{"changed":true,"semanticNoOp":false,"changedFields":["/goals"],"changedEntities":{"projectGoalIds":["guarded-by-exact-confirmation"],"sessionTaskIds":[]},"revisions":{"project":"3"}}},"isError":false},"jsonrpc":"2.0","id":11}
```

## 5.3 `archive`

Omitted `confirm` - reaches the service and is refused, with the roadmap file untouched:

```jsonrpc
-> {"jsonrpc":"2.0","method":"tools/call","params":{"name":"archive","arguments":{"id":"guarded-by-exact-confirmation"}}}
<- {"result":{"content":[{"type":"text","text":"{\"ok\":false,\"scope\":\"project\",\"action\":\"archive\",\"error\":{\"code\":\"APPROVAL_REQUIRED\",\"message\":\"Project archive requires explicit confirmation.\",\"retryable\":false,\"details\":{\"confirmation\":\"confirm=true\",\"resolution\":\"request-explicit-user-confirmation\"}},\"meta\":{\"changed\":false,\"semanticNoOp\":false,\"changedFields\":[]}}"}],"structuredContent":{"ok":false,"scope":"project","action":"archive","error":{"code":"APPROVAL_REQUIRED","message":"Project archive requires explicit confirmation.","retryable":false,"details":{"confirmation":"confirm=true","resolution":"request-explicit-user-confirmation"}},"meta":{"changed":false,"semanticNoOp":false,"changedFields":[]}},"isError":true},"jsonrpc":"2.0","id":12}
```

```json
{
  "schema rejected the call": false,
  "isError": true,
  "error.code": "APPROVAL_REQUIRED",
  "error.details": {
    "confirmation": "confirm=true",
    "resolution": "request-explicit-user-confirmation"
  },
  "meta.changed": false,
  "roadmap sha256 before": "28cfd0ecc6813951",
  "roadmap sha256 after": "28cfd0ecc6813951",
  "file untouched": true
}
```

`confirm: false`, a non-boolean `confirm`, then the approved call:

```json
{
  "confirm: false": {
    "error.code": "APPROVAL_REQUIRED",
    "file untouched": true
  },
  "confirm: \"true\" (a string, which the boolean schema rejects)": {
    "isError": true,
    "schema rejected the call before the service ran": true,
    "client sees": "MCP error -32602: Input validation error: Invalid arguments for tool archive: Invalid input: expected boolean, received string at confirm",
    "file untouched": true
  },
  "confirm: true": {
    "ok": true,
    "meta.changed": true,
    "meta.changedFields": [
      "/goals"
    ],
    "status now": "archived",
    "file changed": true
  }
}
```

The approved call's raw frame:

```jsonrpc
<- {"result":{"content":[{"type":"text","text":"{\"ok\":true,\"scope\":\"project\",\"action\":\"archive\",\"result\":{\"scope\":\"project\",\"action\":\"archive\",\"goal\":{\"id\":\"guarded-by-exact-confirmation\",\"title\":\"Guarded by exact confirmation\",\"description\":\"Subject of the confirmation checks.\",\"status\":\"archived\",\"createdAt\":\"2026-08-11T23:32:46.317Z\",\"updatedAt\":\"2026-08-11T23:32:46.377Z\"},\"goals\":[{\"id\":\"guarded-by-exact-confirmation\",\"title\":\"Guarded by exact confirmation\",\"description\":\"Subject of the confirmation checks.\",\"status\":\"archived\",\"createdAt\":\"2026-08-11T23:32:46.317Z\",\"updatedAt\":\"2026-08-11T23:32:46.377Z\"}]},\"meta\":{\"changed\":true,\"semanticNoOp\":false,\"changedFields\":[\"/goals\"],\"changedEntities\":{\"projectGoalIds\":[\"guarded-by-exact-confirmation\"],\"sessionTaskIds\":[]},\"revisions\":{\"project\":\"4\"}}}"}],"structuredContent":{"ok":true,"scope":"project","action":"archive","result":{"scope":"project","action":"archive","goal":{"id":"guarded-by-exact-confirmation","title":"Guarded by exact confirmation","description":"Subject of the confirmation checks.","status":"archived","createdAt":"2026-08-11T23:32:46.317Z","updatedAt":"2026-08-11T23:32:46.377Z"},"goals":[{"id":"guarded-by-exact-confirmation","title":"Guarded by exact confirmation","description":"Subject of the confirmation checks.","status":"archived","createdAt":"2026-08-11T23:32:46.317Z","updatedAt":"2026-08-11T23:32:46.377Z"}]},"meta":{"changed":true,"semanticNoOp":false,"changedFields":["/goals"],"changedEntities":{"projectGoalIds":["guarded-by-exact-confirmation"],"sessionTaskIds":[]},"revisions":{"project":"4"}}},"isError":false},"jsonrpc":"2.0","id":15}
```

## 5.4 `delete`

Omitted `confirm` - reaches the service and is refused, with the roadmap file untouched:

```jsonrpc
-> {"jsonrpc":"2.0","method":"tools/call","params":{"name":"delete","arguments":{"id":"guarded-by-exact-confirmation"}}}
<- {"result":{"content":[{"type":"text","text":"{\"ok\":false,\"scope\":\"project\",\"action\":\"delete\",\"error\":{\"code\":\"APPROVAL_REQUIRED\",\"message\":\"Project delete requires explicit confirmation.\",\"retryable\":false,\"details\":{\"confirmation\":\"confirm=true\",\"resolution\":\"request-explicit-user-confirmation\"}},\"meta\":{\"changed\":false,\"semanticNoOp\":false,\"changedFields\":[]}}"}],"structuredContent":{"ok":false,"scope":"project","action":"delete","error":{"code":"APPROVAL_REQUIRED","message":"Project delete requires explicit confirmation.","retryable":false,"details":{"confirmation":"confirm=true","resolution":"request-explicit-user-confirmation"}},"meta":{"changed":false,"semanticNoOp":false,"changedFields":[]}},"isError":true},"jsonrpc":"2.0","id":16}
```

```json
{
  "schema rejected the call": false,
  "isError": true,
  "error.code": "APPROVAL_REQUIRED",
  "error.details": {
    "confirmation": "confirm=true",
    "resolution": "request-explicit-user-confirmation"
  },
  "meta.changed": false,
  "roadmap sha256 before": "91cf47c011622581",
  "roadmap sha256 after": "91cf47c011622581",
  "file untouched": true
}
```

`confirm: false`, a non-boolean `confirm`, then the approved call:

```json
{
  "confirm: false": {
    "error.code": "APPROVAL_REQUIRED",
    "file untouched": true
  },
  "confirm: \"true\" (a string, which the boolean schema rejects)": {
    "isError": true,
    "schema rejected the call before the service ran": true,
    "client sees": "MCP error -32602: Input validation error: Invalid arguments for tool delete: Invalid input: expected boolean, received string at confirm",
    "file untouched": true
  },
  "confirm: true": {
    "ok": true,
    "meta.changed": true,
    "meta.changedFields": [
      "/goals"
    ],
    "status now": "<goal removed>",
    "file changed": true
  }
}
```

The approved call's raw frame:

```jsonrpc
<- {"result":{"content":[{"type":"text","text":"{\"ok\":true,\"scope\":\"project\",\"action\":\"delete\",\"result\":{\"scope\":\"project\",\"action\":\"delete\",\"goals\":[]},\"meta\":{\"changed\":true,\"semanticNoOp\":false,\"changedFields\":[\"/goals\"],\"changedEntities\":{\"projectGoalIds\":[\"guarded-by-exact-confirmation\"],\"sessionTaskIds\":[]},\"revisions\":{\"project\":\"5\"}}}"}],"structuredContent":{"ok":true,"scope":"project","action":"delete","result":{"scope":"project","action":"delete","goals":[]},"meta":{"changed":true,"semanticNoOp":false,"changedFields":["/goals"],"changedEntities":{"projectGoalIds":["guarded-by-exact-confirmation"],"sessionTaskIds":[]},"revisions":{"project":"5"}}},"isError":false},"jsonrpc":"2.0","id":19}
```

## 6. Roadmap after the four approved mutations

```jsonrpc
-> {"jsonrpc":"2.0","method":"resources/read","params":{"uri":"stepstone://worklist/list"}}
<- {"result":{"contents":[{"uri":"stepstone://worklist/list","mimeType":"application/json","text":"{\"ok\":true,\"scope\":\"project\",\"action\":\"list\",\"result\":{\"scope\":\"project\",\"action\":\"list\",\"goals\":[]},\"meta\":{\"changed\":false,\"semanticNoOp\":false,\"changedFields\":[],\"revisions\":{\"project\":\"5\"}}}"}]},"jsonrpc":"2.0","id":20}
```
```json
{
  "ok": true,
  "scope": "project",
  "action": "list",
  "result": {
    "scope": "project",
    "action": "list",
    "goals": []
  },
  "meta": {
    "changed": false,
    "semanticNoOp": false,
    "changedFields": [],
    "revisions": {
      "project": "5"
    }
  }
}
```

On-disk roadmap file the server wrote:

```json
{
  "version": 1,
  "revision": 5,
  "goals": [],
  "retiredIds": [
    "guarded-by-exact-confirmation"
  ]
}
```

Bytes the server wrote to stderr: 0. Frames exchanged on stdout: 20, every one a JSON-RPC message.
