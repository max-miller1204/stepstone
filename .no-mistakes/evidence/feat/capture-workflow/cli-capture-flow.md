# Capture workflow, end to end in a fresh repository

Every block below is verbatim stdout from `node src/cli.ts` at target commit 399ed5a, run in a fresh `git init` repository.

## 1. `project init` writes the marker-managed AGENTS.md block

```text
$ stepstone project init
Refreshed the Stepstone block in /tmp/stepstone-capture-transcript-2vaa/AGENTS.md.

Optional integrations were not installed or registered:
Skill installation: npx skills add max-miller1204/stepstone --skill stepstone -g
MCP client configuration:
{
  "mcpServers": {
    "stepstone": {
      "command": "npx",
      "args": [
        "-y",
        "--package",
        "stepstone@latest",
        "stepstone-mcp"
      ],
      "cwd": "/tmp/stepstone-capture-transcript-2vaa"
    }
  }
}
Choose the skill installation scope and MCP client configuration location for your harness.
(exit 0)

```

The block an agent reads in AGENTS.md now carries the plan entry shape and the capture workflow:

```markdown
Capture plan entry shape: `{"title":"required broad outcome","description":"optional context","group":"optional section","dependsOn":["optional goal reference"]}`. No other fields are accepted.

Capture workflow: Brainstorm broad outcomes for the roadmap rather than internal implementation steps. Draft the exact plain JSON array that represents the complete proposed goal batch. When a later, naturally ordered goal would collide with an earlier goal in the same modules or files, add the earlier goal's pre-collision slug to the later goal's `dependsOn` array even when no logical dependency exists. Present that exact JSON array to the user and wait for explicit approval before making any mutation. An optional dry-run is only a preview of validation, projected IDs, dependencies, and warnings; it is never approval and never replaces the explicit approval step. After explicit approval, perform exactly one mutating `apply-plan` call for the entire approved array; never turn the batch into per-goal `add` calls.
```

## 2. The agent drafts the exact JSON array and presents it for approval

The second goal names the first in `dependsOn` only because both land in the search module - the collision rule, not a logical dependency.

```json
[
  {
    "title": "Export search results to CSV",
    "description": "People can take a result set out of the app.",
    "group": "Search"
  },
  {
    "title": "Saved searches",
    "description": "People can re-run a search they named earlier.",
    "group": "Search",
    "dependsOn": ["export-search-results-to-csv"]
  }
]
```

## 3. Optional dry run: preview only, nothing written

```text
$ stepstone project apply-plan plan.json --dry-run --json
{
  "ok": true,
  "scope": "project",
  "action": "apply-plan",
  "result": {
    "scope": "project",
    "action": "apply-plan",
    "dryRun": true,
    "addedGoals": [
      {
        "id": "export-search-results-to-csv",
        "title": "Export search results to CSV",
        "description": "People can take a result set out of the app.",
        "group": "Search",
        "status": "open",
        "createdAt": "2026-08-12T02:25:00.643Z",
        "updatedAt": "2026-08-12T02:25:00.643Z"
      },
      {
        "id": "saved-searches",
        "title": "Saved searches",
        "description": "People can re-run a search they named earlier.",
        "group": "Search",
        "dependsOn": [
          "export-search-results-to-csv"
        ],
        "status": "open",
        "createdAt": "2026-08-12T02:25:00.643Z",
        "updatedAt": "2026-08-12T02:25:00.643Z"
      }
    ],
    "goals": [
      {
        "id": "export-search-results-to-csv",
        "title": "Export search results to CSV",
        "description": "People can take a result set out of the app.",
        "group": "Search",
        "status": "open",
        "createdAt": "2026-08-12T02:25:00.643Z",
        "updatedAt": "2026-08-12T02:25:00.643Z"
      },
      {
        "id": "saved-searches",
        "title": "Saved searches",
        "description": "People can re-run a search they named earlier.",
        "group": "Search",
        "dependsOn": [
          "export-search-results-to-csv"
        ],
        "status": "open",
        "createdAt": "2026-08-12T02:25:00.643Z",
        "updatedAt": "2026-08-12T02:25:00.643Z"
      }
    ],
    "warnings": []
  },
  "meta": {
    "changed": false,
    "semanticNoOp": false,
    "changedFields": [],
    "revisions": {
      "project": "0"
    },
    "cliVersion": "0.4.0"
  }
}
(exit 0)

```

```text
$ ls .worklist/worklist.json
ls: cannot access '.worklist/worklist.json': No such file or directory
(exit 2)
```

The preview reports `"changed": false` and project revision `0`; the goal file does not exist yet, so the dry run is a preview and not an approval-shaped side effect.

## 4. After explicit user approval: exactly one mutating apply-plan call

```text
$ stepstone project apply-plan plan.json --json
{
  "ok": true,
  "scope": "project",
  "action": "apply-plan",
  "result": {
    "scope": "project",
    "action": "apply-plan",
    "dryRun": false,
    "addedGoals": [
      {
        "id": "export-search-results-to-csv",
        "title": "Export search results to CSV",
        "description": "People can take a result set out of the app.",
        "group": "Search",
        "status": "open",
        "createdAt": "2026-08-12T02:25:00.809Z",
        "updatedAt": "2026-08-12T02:25:00.809Z"
      },
      {
        "id": "saved-searches",
        "title": "Saved searches",
        "description": "People can re-run a search they named earlier.",
        "group": "Search",
        "dependsOn": [
          "export-search-results-to-csv"
        ],
        "status": "open",
        "createdAt": "2026-08-12T02:25:00.809Z",
        "updatedAt": "2026-08-12T02:25:00.809Z"
      }
    ],
    "goals": [
      {
        "id": "export-search-results-to-csv",
        "title": "Export search results to CSV",
        "description": "People can take a result set out of the app.",
        "group": "Search",
        "status": "open",
        "createdAt": "2026-08-12T02:25:00.809Z",
        "updatedAt": "2026-08-12T02:25:00.809Z"
      },
      {
        "id": "saved-searches",
        "title": "Saved searches",
        "description": "People can re-run a search they named earlier.",
        "group": "Search",
        "dependsOn": [
          "export-search-results-to-csv"
        ],
        "status": "open",
        "createdAt": "2026-08-12T02:25:00.809Z",
        "updatedAt": "2026-08-12T02:25:00.809Z"
      }
    ],
    "warnings": []
  },
  "meta": {
    "changed": true,
    "semanticNoOp": false,
    "changedFields": [
      "/goals"
    ],
    "changedEntities": {
      "projectGoalIds": [
        "export-search-results-to-csv",
        "saved-searches"
      ],
      "sessionTaskIds": []
    },
    "revisions": {
      "project": "1"
    },
    "cliVersion": "0.4.0"
  }
}
(exit 0)

```

## 5. Both goals landed in one revision, with the collision edge intact

```text
$ jq -c '{revision, goals: [.goals[] | {id, dependsOn}]}' .worklist/worklist.json
{"revision":1,"goals":[{"id":"export-search-results-to-csv","dependsOn":[]},{"id":"saved-searches","dependsOn":["export-search-results-to-csv"]}]}

$ stepstone project waves
Wave 1 (1 goal):
  [open] export-search-results-to-csv: Export search results to CSV
Wave 2 (1 goal):
  [open] saved-searches: Saved searches
(exit 0)

```

## 6. The batch stays atomic: one bad reference writes nothing

```text
$ stepstone project apply-plan bad-plan.json --json
{
  "ok": false,
  "scope": "project",
  "action": "apply-plan",
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Project plan dependency a-goal-that-does-not-exist was not found in the batch or existing goals.",
    "retryable": false,
    "details": {
      "fields": [
        "dependsOn"
      ],
      "reference": "a-goal-that-does-not-exist",
      "resolution": "add-batch-goal-or-use-existing-goal-id"
    }
  },
  "meta": {
    "changed": false,
    "semanticNoOp": false,
    "changedFields": [],
    "cliVersion": "0.4.0"
  }
}
(exit 1)

$ node -e 'read revision and ids back'
revision: 1 goals: export-search-results-to-csv, saved-searches
```

The valid first entry was not added and the revision is still `1`: the plan applies as one unit or not at all.
