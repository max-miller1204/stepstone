# stepstone-mcp: stdio MCP session against a Pi-free install

Every frame below is the raw newline-delimited JSON-RPC that crossed the pipe between an MCP client and the `stepstone-mcp` executable installed from the publishable tarball. No test harness, in-memory transport, or source import is involved.


## 1. Install the published package with no dev dependencies and no Pi

```console
$ npm pack                      -> stepstone-0.2.3.tgz
$ npm install <tarball> --omit=dev --omit=peer
$ ls node_modules/.bin          -> node-which, stepstone, stepstone-mcp
$ grep -c @earendil-works       -> 0 Pi packages in the installed tree
```

The client's `cwd` is a scratch Git repository with no roadmap file yet, matching the `"cwd": "/absolute/path/to/repository"` field documented in docs/mcp.md.


## 2. Handshake

```jsonrpc
-> {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"evidence-client","version":"1.0.0"}}}
<- {"result":{"protocolVersion":"2025-06-18","capabilities":{"resources":{"listChanged":true},"tools":{"listChanged":true}},"serverInfo":{"name":"stepstone-mcp","version":"0.2.3"}},"jsonrpc":"2.0","id":1}
-> {"jsonrpc":"2.0","method":"notifications/initialized"}
```

Server identity and advertised capabilities:
```json
{
  "protocolVersion": "2025-06-18",
  "capabilities": {
    "resources": {
      "listChanged": true
    },
    "tools": {
      "listChanged": true
    }
  },
  "serverInfo": {
    "name": "stepstone-mcp",
    "version": "0.2.3"
  }
}
```


## 3. Contract-derived resources, templates, and tools

```jsonrpc
-> {"jsonrpc":"2.0","id":2,"method":"resources/list"}
<- {"result":{"resources":[{"uri":"stepstone://worklist/list","name":"list","title":"list","description":"Show a compact bounded list of project goals","mimeType":"application/json"},{"uri":"stepstone://worklist/next","name":"next","title":"next","description":"Show the one goal to start next, the first ready goal in file order","mimeType":"application/json"},{"uri":"stepstone://worklist/ready","name":"ready","title":"ready","description":"List every unblocked, unclaimed open goal: the whole parallel frontier","mimeType":"application/json"},{"uri":"stepstone://worklist/waves","name":"waves","title":"waves","description":"Print unfinished goals in dependency layers, earliest first","mimeType":"application/json"}]},"jsonrpc":"2.0","id":2}
```

Fixed resources:
```json
[
  {
    "uri": "stepstone://worklist/list",
    "title": "list"
  },
  {
    "uri": "stepstone://worklist/next",
    "title": "next"
  },
  {
    "uri": "stepstone://worklist/ready",
    "title": "ready"
  },
  {
    "uri": "stepstone://worklist/waves",
    "title": "waves"
  }
]
```

Templated resources:
```json
[
  {
    "uriTemplate": "stepstone://worklist/show/{id}",
    "title": "show <id>"
  },
  {
    "uriTemplate": "stepstone://worklist/find/{query}",
    "title": "find <text...>"
  }
]
```

Tools, with the confirmation metadata carried from the command contract:
```json
[
  {
    "name": "add",
    "title": "add <title...> [--description <text> | -- <description...>]",
    "required": [
      "title"
    ],
    "confirmRequired": false
  },
  {
    "name": "apply-plan",
    "title": "apply-plan <plan.json>",
    "required": [
      "plan"
    ],
    "confirmRequired": false
  },
  {
    "name": "update",
    "title": "update <id> [title...] [--description <text> | -- <description...>]",
    "required": [
      "id"
    ],
    "confirmRequired": false
  },
  {
    "name": "move",
    "title": "move <id> up|down|before <id>|after <id>",
    "required": [
      "id"
    ],
    "confirmRequired": false
  },
  {
    "name": "set_active",
    "title": "set_active <id>",
    "required": [
      "id"
    ],
    "confirmRequired": false
  },
  {
    "name": "complete",
    "title": "complete <id> --confirm",
    "required": [
      "id"
    ],
    "confirmRequired": true
  },
  {
    "name": "reopen",
    "title": "reopen <id> --confirm",
    "required": [
      "id"
    ],
    "confirmRequired": true
  },
  {
    "name": "archive",
    "title": "archive <id> --confirm",
    "required": [
      "id"
    ],
    "confirmRequired": true
  },
  {
    "name": "delete",
    "title": "delete <id> --confirm",
    "required": [
      "id"
    ],
    "confirmRequired": true
  }
]
```

The published JSON Schema for one guarded tool, `complete`:
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


## 4. Read the empty roadmap, then add a goal

```jsonrpc
-> {"jsonrpc":"2.0","id":5,"method":"resources/read","params":{"uri":"stepstone://worklist/list"}}
<- {"result":{"contents":[{"uri":"stepstone://worklist/list","mimeType":"application/json","text":"{\"ok\":true,\"scope\":\"project\",\"action\":\"list\",\"result\":{\"scope\":\"project\",\"action\":\"list\",\"goals\":[]},\"meta\":{\"changed\":false,\"semanticNoOp\":false,\"changedFields\":[],\"revisions\":{\"project\":\"0\"}}}"}]},"jsonrpc":"2.0","id":5}
```

Envelope inside the `application/json` body:
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
      "project": "0"
    }
  }
}
```

```jsonrpc
-> {"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"add","arguments":{"title":"Expose the worklist over MCP","description":"Reads are resources, mutations are tools.","group":"Harness"}}}
<- {"result":{"content":[{"type":"text","text":"{\"ok\":true,\"scope\":\"project\",\"action\":\"add\",\"result\":{\"scope\":\"project\",\"action\":\"add\",\"goal\":{\"id\":\"expose-the-worklist-over-mcp\",\"title\":\"Expose the worklist over MCP\",\"description\":\"Reads are resources, mutations are tools.\",\"group\":\"Harness\",\"status\":\"open\",\"createdAt\":\"2026-08-11T23:21:55.050Z\",\"updatedAt\":\"2026-08-11T23:21:55.050Z\"},\"goals\":[{\"id\":\"expose-the-worklist-over-mcp\",\"title\":\"Expose the worklist over MCP\",\"description\":\"Reads are resources, mutations are tools.\",\"group\":\"Harness\",\"status\":\"open\",\"createdAt\":\"2026-08-11T23:21:55.050Z\",\"updatedAt\":\"2026-08-11T23:21:55.050Z\"}]},\"meta\":{\"changed\":true,\"semanticNoOp\":false,\"changedFields\":[\"/goals\"],\"changedEntities\":{\"projectGoalIds\":[\"expose-the-worklist-over-mcp\"],\"sessionTaskIds\":[]},\"revisions\":{\"project\":\"1\"}}}"}],"structuredContent":{"ok":true,"scope":"project","action":"add","result":{"scope":"project","action":"add","goal":{"id":"expose-the-worklist-over-mcp","title":"Expose the worklist over MCP","description":"Reads are resources, mutations are tools.","group":"Harness","status":"open","createdAt":"2026-08-11T23:21:55.050Z","updatedAt":"2026-08-11T23:21:55.050Z"},"goals":[{"id":"expose-the-worklist-over-mcp","title":"Expose the worklist over MCP","description":"Reads are resources, mutations are tools.","group":"Harness","status":"open","createdAt":"2026-08-11T23:21:55.050Z","updatedAt":"2026-08-11T23:21:55.050Z"}]},"meta":{"changed":true,"semanticNoOp":false,"changedFields":["/goals"],"changedEntities":{"projectGoalIds":["expose-the-worklist-over-mcp"],"sessionTaskIds":[]},"revisions":{"project":"1"}}},"isError":false},"jsonrpc":"2.0","id":6}
```

Tool envelope (also returned verbatim as `structuredContent`):
```json
{
  "ok": true,
  "scope": "project",
  "action": "add",
  "result": {
    "scope": "project",
    "action": "add",
    "goal": {
      "id": "expose-the-worklist-over-mcp",
      "title": "Expose the worklist over MCP",
      "description": "Reads are resources, mutations are tools.",
      "group": "Harness",
      "status": "open",
      "createdAt": "2026-08-11T23:21:55.050Z",
      "updatedAt": "2026-08-11T23:21:55.050Z"
    },
    "goals": [
      {
        "id": "expose-the-worklist-over-mcp",
        "title": "Expose the worklist over MCP",
        "description": "Reads are resources, mutations are tools.",
        "group": "Harness",
        "status": "open",
        "createdAt": "2026-08-11T23:21:55.050Z",
        "updatedAt": "2026-08-11T23:21:55.050Z"
      }
    ]
  },
  "meta": {
    "changed": true,
    "semanticNoOp": false,
    "changedFields": [
      "/goals"
    ],
    "changedEntities": {
      "projectGoalIds": [
        "expose-the-worklist-over-mcp"
      ],
      "sessionTaskIds": []
    },
    "revisions": {
      "project": "1"
    }
  }
}
```


## 5. apply-plan: dry run writes nothing, then the real batch lands

```jsonrpc
-> {"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"apply-plan","arguments":{"plan":[{"title":"Document client setup","dependsOn":["expose-the-worklist-over-mcp"]},{"title":"Ship the compiled bin","dependsOn":["document-client-setup"]}],"dryRun":true}}}
<- {"result":{"content":[{"type":"text","text":"{\"ok\":true,\"scope\":\"project\",\"action\":\"apply-plan\",\"result\":{\"scope\":\"project\",\"action\":\"apply-plan\",\"dryRun\":true,\"addedGoals\":[{\"id\":\"document-client-setup\",\"title\":\"Document client setup\",\"dependsOn\":[\"expose-the-worklist-over-mcp\"],\"status\":\"open\",\"createdAt\":\"2026-08-11T23:21:55.054Z\",\"updatedAt\":\"2026-08-11T23:21:55.054Z\"},{\"id\":\"ship-the-compiled-bin\",\"title\":\"Ship the compiled bin\",\"dependsOn\":[\"document-client-setup\"],\"status\":\"open\",\"createdAt\":\"2026-08-11T23:21:55.054Z\",\"updatedAt\":\"2026-08-11T23:21:55.054Z\"}],\"goals\":[{\"id\":\"expose-the-worklist-over-mcp\",\"title\":\"Expose the worklist over MCP\",\"description\":\"Reads are resources, mutations are tools.\",\"group\":\"Harness\",\"status\":\"open\",\"createdAt\":\"2026-08-11T23:21:55.050Z\",\"updatedAt\":\"2026-08-11T23:21:55.050Z\"},{\"id\":\"document-client-setup\",\"title\":\"Document client setup\",\"dependsOn\":[\"expose-the-worklist-over-mcp\"],\"status\":\"open\",\"createdAt\":\"2026-08-11T23:21:55.054Z\",\"updatedAt\":\"2026-08-11T23:21:55.054Z\"},{\"id\":\"ship-the-compiled-bin\",\"title\":\"Ship the compiled bin\",\"dependsOn\":[\"document-client-setup\"],\"status\":\"open\",\"createdAt\":\"2026-08-11T23:21:55.054Z\",\"updatedAt\":\"2026-08-11T23:21:55.054Z\"}],\"warnings\":[]},\"meta\":{\"changed\":false,\"semanticNoOp\":false,\"changedFields\":[],\"revisions\":{\"project\":\"1\"}}}"}],"structuredContent":{"ok":true,"scope":"project","action":"apply-plan","result":{"scope":"project","action":"apply-plan","dryRun":true,"addedGoals":[{"id":"document-client-setup","title":"Document client setup","dependsOn":["expose-the-worklist-over-mcp"],"status":"open","createdAt":"2026-08-11T23:21:55.054Z","updatedAt":"2026-08-11T23:21:55.054Z"},{"id":"ship-the-compiled-bin","title":"Ship the compiled bin","dependsOn":["document-client-setup"],"status":"open","createdAt":"2026-08-11T23:21:55.054Z","updatedAt":"2026-08-11T23:21:55.054Z"}],"goals":[{"id":"expose-the-worklist-over-mcp","title":"Expose the worklist over MCP","description":"Reads are resources, mutations are tools.","group":"Harness","status":"open","createdAt":"2026-08-11T23:21:55.050Z","updatedAt":"2026-08-11T23:21:55.050Z"},{"id":"document-client-setup","title":"Document client setup","dependsOn":["expose-the-worklist-over-mcp"],"status":"open","createdAt":"2026-08-11T23:21:55.054Z","updatedAt":"2026-08-11T23:21:55.054Z"},{"id":"ship-the-compiled-bin","title":"Ship the compiled bin","dependsOn":["document-client-setup"],"status":"open","createdAt":"2026-08-11T23:21:55.054Z","updatedAt":"2026-08-11T23:21:55.054Z"}],"warnings":[]},"meta":{"changed":false,"semanticNoOp":false,"changedFields":[],"revisions":{"project":"1"}}},"isError":false},"jsonrpc":"2.0","id":7}
```

Roadmap file byte-identical after the dry run: **true** (`meta.changed` = false).

Applied batch:
```json
[
  {
    "id": "document-client-setup",
    "dependsOn": [
      "expose-the-worklist-over-mcp"
    ]
  },
  {
    "id": "ship-the-compiled-bin",
    "dependsOn": [
      "document-client-setup"
    ]
  }
]
```


## 6. Concurrency precondition: a stale expectedUpdatedAt is refused

```jsonrpc
-> {"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"update","arguments":{"id":"expose","title":"Overwritten by a stale writer","expectedUpdatedAt":"2000-01-01T00:00:00.000Z"}}}
<- {"result":{"content":[{"type":"text","text":"{\"ok\":false,\"scope\":\"project\",\"action\":\"update\",\"error\":{\"code\":\"CONFLICT\",\"message\":\"Project goal expose-the-worklist-over-mcp changed from 2000-01-01T00:00:00.000Z to 2026-08-11T23:21:55.050Z.\",\"retryable\":true,\"conflict\":{\"type\":\"goal-updated-at\",\"id\":\"expose-the-worklist-over-mcp\",\"expectedUpdatedAt\":\"2000-01-01T00:00:00.000Z\",\"actualUpdatedAt\":\"2026-08-11T23:21:55.050Z\",\"resolution\":\"refresh-and-retry\"}},\"meta\":{\"changed\":false,\"semanticNoOp\":false,\"changedFields\":[]}}"}],"structuredContent":{"ok":false,"scope":"project","action":"update","error":{"code":"CONFLICT","message":"Project goal expose-the-worklist-over-mcp changed from 2000-01-01T00:00:00.000Z to 2026-08-11T23:21:55.050Z.","retryable":true,"conflict":{"type":"goal-updated-at","id":"expose-the-worklist-over-mcp","expectedUpdatedAt":"2000-01-01T00:00:00.000Z","actualUpdatedAt":"2026-08-11T23:21:55.050Z","resolution":"refresh-and-retry"}},"meta":{"changed":false,"semanticNoOp":false,"changedFields":[]}},"isError":true},"jsonrpc":"2.0","id":10}
```

Typed conflict, no write:
```json
{
  "ok": false,
  "scope": "project",
  "action": "update",
  "error": {
    "code": "CONFLICT",
    "message": "Project goal expose-the-worklist-over-mcp changed from 2000-01-01T00:00:00.000Z to 2026-08-11T23:21:55.050Z.",
    "retryable": true,
    "conflict": {
      "type": "goal-updated-at",
      "id": "expose-the-worklist-over-mcp",
      "expectedUpdatedAt": "2000-01-01T00:00:00.000Z",
      "actualUpdatedAt": "2026-08-11T23:21:55.050Z",
      "resolution": "refresh-and-retry"
    }
  },
  "meta": {
    "changed": false,
    "semanticNoOp": false,
    "changedFields": []
  }
}
```

Same edit with the `updatedAt` from the caller's last read: ok=true, changedFields=["/goals"].


## 7. Sequencing resources: show, find, next, ready, waves

`move` reordered canonical file order to ["expose-the-worklist-over-mcp","ship-the-compiled-bin","document-client-setup"].

```jsonrpc
-> {"jsonrpc":"2.0","id":13,"method":"resources/read","params":{"uri":"stepstone://worklist/find/client%20setup"}}
<- {"result":{"contents":[{"uri":"stepstone://worklist/find/client%20setup","mimeType":"application/json","text":"{\"ok\":true,\"scope\":\"project\",\"action\":\"find\",\"result\":{\"scope\":\"project\",\"action\":\"find\",\"goals\":[{\"id\":\"document-client-setup\",\"title\":\"Document client setup\",\"dependsOn\":[\"expose-the-worklist-over-mcp\"],\"status\":\"open\",\"createdAt\":\"2026-08-11T23:21:55.056Z\",\"updatedAt\":\"2026-08-11T23:21:55.056Z\"}]},\"meta\":{\"changed\":false,\"semanticNoOp\":false,\"changedFields\":[],\"revisions\":{\"project\":\"4\"}}}"}]},"jsonrpc":"2.0","id":13}
```

`find` (path value URI-encoded, as docs/mcp.md instructs):
```json
{
  "matches": [
    "Document client setup"
  ]
}
```

Sequencing answers:
```json
{
  "show": {
    "id": "expose-the-worklist-over-mcp",
    "blocked": false,
    "blocks": [
      "document-client-setup"
    ]
  },
  "next": "expose-the-worklist-over-mcp",
  "ready": [
    "expose-the-worklist-over-mcp"
  ],
  "waves": [
    [
      "expose-the-worklist-over-mcp"
    ],
    [
      "document-client-setup"
    ],
    [
      "ship-the-compiled-bin"
    ]
  ]
}
```

`set_active` → expose-the-worklist-over-mcp is now `active`.


## 8. Exact confirmation for complete, reopen, archive, and delete

Each guarded tool is called first with no `confirm`, then with `confirm: true`. The roadmap file is compared byte for byte around every refusal.

```jsonrpc
-> {"jsonrpc":"2.0","id":18,"method":"tools/call","params":{"name":"complete","arguments":{"id":"expose"}}}
<- {"result":{"content":[{"type":"text","text":"{\"ok\":false,\"scope\":\"project\",\"action\":\"complete\",\"error\":{\"code\":\"APPROVAL_REQUIRED\",\"message\":\"Project complete requires explicit confirmation.\",\"retryable\":false,\"details\":{\"confirmation\":\"confirm=true\",\"resolution\":\"request-explicit-user-confirmation\"}},\"meta\":{\"changed\":false,\"semanticNoOp\":false,\"changedFields\":[]}}"}],"structuredContent":{"ok":false,"scope":"project","action":"complete","error":{"code":"APPROVAL_REQUIRED","message":"Project complete requires explicit confirmation.","retryable":false,"details":{"confirmation":"confirm=true","resolution":"request-explicit-user-confirmation"}},"meta":{"changed":false,"semanticNoOp":false,"changedFields":[]}},"isError":true},"jsonrpc":"2.0","id":18}
```

| tool | without `confirm` | roadmap file untouched | with `confirm: true` |
| --- | --- | --- | --- |
| `complete` | isError=true, APPROVAL_REQUIRED | true | ok, status=done |
| `reopen` | isError=true, APPROVAL_REQUIRED | true | ok, status=open |
| `archive` | isError=true, APPROVAL_REQUIRED | true | ok, status=archived |
| `delete` | isError=true, APPROVAL_REQUIRED | true | ok, goal removed |

The refusal envelope a client receives, in full:
```json
{
  "isError": true,
  "envelope": {
    "ok": false,
    "scope": "project",
    "action": "complete",
    "error": {
      "code": "APPROVAL_REQUIRED",
      "message": "Project complete requires explicit confirmation.",
      "retryable": false,
      "details": {
        "confirmation": "confirm=true",
        "resolution": "request-explicit-user-confirmation"
      }
    },
    "meta": {
      "changed": false,
      "semanticNoOp": false,
      "changedFields": []
    }
  }
}
```


## 9. Canonical per-operation worklist resolution

The server does not cache a startup path. A legacy `.pi/worklist.json` created while the same connection is open is picked up by the next operation, and once the canonical file exists again the passed-over legacy file is reported in `meta.shadowedWorklistPath`.

Legacy-only repository, add through the already-open connection: ok=true, `.pi/worklist.json` now holds ["written-to-the-legacy-file"], and a second roadmap at `.worklist/worklist.json` exists: **false**.

With both files present the canonical file wins and the passed-over one is named in the envelope:

```json
{
  "meta.shadowedWorklistPath": "/tmp/stepstone-mcp-evidence-a8Opeb/repo/.pi/worklist.json",
  "goals read from": ".worklist/worklist.json",
  "ids": [
    "expose-the-worklist-over-mcp",
    "document-client-setup"
  ]
}
```


## 10. Cross-process locking

Three separate `stepstone-mcp` processes - the shape of several harnesses pointed at one repository - each fire four concurrent `add` calls at the same roadmap file.

12 concurrent `add` calls across 3 processes: 12 succeeded, 12 distinct goals persisted, file revision 21, JSON still parses.

Persisted ids:
```json
[
  "concurrent-goal-0-0",
  "concurrent-goal-0-1",
  "concurrent-goal-0-2",
  "concurrent-goal-0-3",
  "concurrent-goal-1-0",
  "concurrent-goal-1-1",
  "concurrent-goal-1-2",
  "concurrent-goal-1-3",
  "concurrent-goal-2-0",
  "concurrent-goal-2-1",
  "concurrent-goal-2-2",
  "concurrent-goal-2-3"
]
```


## 11. The documented client command selects the MCP bin

docs/mcp.md tells a client to run `npx -y --package stepstone@latest stepstone-mcp`. Run here against the local tarball instead of the registry, the same argument boundary starts the server and completes an MCP handshake:

```jsonrpc
-> {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"evidence-client","version":"1.0.0"}}}
<- {"result":{"protocolVersion":"2025-06-18","capabilities":{"resources":{"listChanged":true},"tools":{"listChanged":true}},"serverInfo":{"name":"stepstone-mcp","version":"0.2.3"}},"jsonrpc":"2.0","id":1}
```

`npx --package <stepstone tarball> stepstone-mcp` → stepstone-mcp 0.2.3


## 12. Stdout stayed protocol-only

Bytes the session's server wrote to stderr: 0. Frames exchanged on stdout: 57, every one a JSON-RPC message.

Final roadmap file saved beside this transcript as `worklist-after-mcp-session.json`.
