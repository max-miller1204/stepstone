<!-- markdownlint-disable MD013 -->

# MCP server

stepstone exposes Project Goals to any client that supports the [Model Context Protocol](https://modelcontextprotocol.io/) (MCP).
The integration is cross-harness: read operations are MCP resources, mutations are MCP tools, and every operation uses the same application service and persistent roadmap as the CLI.

## Configure an MCP client

Claude Code is the exception: its [plugin](skill.md#claude-code-plugin-versus-the-standalone-skill) bundles this server already configured, so installing the plugin replaces the configuration below.

The published package contains two executables.
`stepstone` is the command-line interface that npm selects for a command such as `npx -y stepstone@latest project list`.
`stepstone-mcp` is the stdio MCP server, so an MCP client must select that bin explicitly:

```sh
npx -y --package stepstone@latest stepstone-mcp
```

A typical MCP client configuration is:

```json
{
  "mcpServers": {
    "stepstone": {
      "command": "npx",
      "args": ["-y", "--package", "stepstone@latest", "stepstone-mcp"],
      "cwd": "/absolute/path/to/repository"
    }
  }
}
```

MCP clients use different names and locations for their configuration files, but the command and argument boundary above should remain unchanged.
The `-y` option allows npm to install the selected package version without an interactive prompt, `--package stepstone@latest` makes both published bins available, and the final argument selects `stepstone-mcp` rather than the default CLI bin.
Use an absolute `cwd` when the client supports it, and point it anywhere inside the Git repository whose roadmap the server should expose.
If a client has no `cwd` setting, use that client's supported mechanism for starting the server inside the target repository.
Configure a separate server process for each repository.
The compiled bin for the MCP server needs Node 20 or newer and does not require a harness-specific extension.

### Stdio behavior

The MCP client owns the server process and exchanges JSON-RPC messages over its standard input and standard output.
The server does not listen on an HTTP port, open a user interface, or accept CLI subcommands on standard input.
Standard output is reserved for MCP protocol traffic, while a fatal startup error is written to standard error.
A manually launched server normally appears idle because it is waiting for an MCP client to send a protocol message.

## Repository and worklist resolution

At startup, the server resolves the real Git root containing its process working directory.
If the working directory is not inside a Git repository, operations return an `UNAVAILABLE` application-service envelope instead of reading an unrelated file.

The Claude Code plugin is the one client that does not start the server inside the repository: Claude Code runs a plugin's server from the plugin's own cache directory, so the bundled configuration hands the project directory over in the `STEPSTONE_PLUGIN_PROJECT_ROOT` environment variable, and the server resolves the repository and any relative override from that directory instead of from its process working directory.
It is that plugin's private handoff rather than a setting to configure: every other client selects the repository with `cwd`.

Within that repository, every resource read and tool mutation resolves the goal file again through the one resolution order every interface shares, described in [storage.md](storage.md#which-file-a-repository-has).
Re-resolving before every operation means that a file appearing after the server started, such as after a branch change, is used according to the same canonical rules.

The server takes no flags, so `$STEPSTONE_WORKLIST` is its only goal-file override; give it an absolute value in client configuration, because a relative one is resolved from the directory the server resolves the repository from.
When both the canonical and the legacy file exist, `meta.shadowedWorklistPath` on every envelope names the file being passed over, which is the whole of the warning an MCP client gets, because the server has no prose channel beside its JSON responses.
The server never migrates a file: `migrate_path` stays a CLI action and is not exposed as an MCP tool.
See [storage.md](storage.md) for the file schema, locking, revisions, and migration behavior.

## Read resources

The server publishes six resources under the `stepstone://worklist` URI prefix.
`show` and `find` are URI templates, so clients must substitute and URI-encode their path values.

| Resource | Purpose |
| --- | --- |
| `stepstone://worklist/list` | List the repository's Project Goals. |
| `stepstone://worklist/show/{id}` | Read one goal selected by a complete ID or unique ID prefix, including whether it is blocked and the goal IDs it blocks. |
| `stepstone://worklist/find/{query}` | Find goals whose title or description contains the query. |
| `stepstone://worklist/next` | Read the first ready goal in canonical file order. |
| `stepstone://worklist/ready` | Read every unblocked, unclaimed open goal in the parallel frontier. |
| `stepstone://worklist/waves` | Read unfinished goals grouped into their earliest dependency waves, plus any unreachable goals. |

Each resource has MIME type `application/json` and contains one JSON-serialized application-service envelope.
An empty `next` or `ready` is a successful answer, represented by an absent `result.goal` or an empty `result.goals` array.
Resource reads do not mutate the roadmap.

## Mutation tools

The server publishes nine mutation tools.
Tool names, titles, descriptions, confirmation metadata, capture-workflow metadata, and apply-plan schema descriptions come from the same command contract as the CLI's agent-facing surface.
JSON field names use the camel-case MCP forms shown below rather than CLI flag names.

| Tool | Required input | Optional input | Effect |
| --- | --- | --- | --- |
| `add` | `title` | `description`, `group`, `dependsOn`, `links` | Add an open goal. |
| `apply-plan` | `plan` | `dryRun` | Validate and atomically add a JSON array of goal plan entries, or only validate it when `dryRun` is true. |
| `update` | `id` | `title`, `description`, `appendDescription`, `group`, `dependsOn`, `links`, `expectedUpdatedAt` | Edit a goal and replace any supplied dependency or link set. |
| `move` | `id` | One of `direction`, `beforeId`, or `afterId` | Move a goal in canonical file order, with `direction` set to `up` or `down`. |
| `set_active` | `id` | `expectedUpdatedAt` | Make a goal the single active goal. |
| `complete` | `id`, `confirm` | `expectedUpdatedAt` | Mark a goal done. |
| `reopen` | `id`, `confirm` | `expectedUpdatedAt` | Reopen a done or archived goal. |
| `archive` | `id`, `confirm` | `expectedUpdatedAt` | Archive a goal. |
| `delete` | `id`, `confirm` | `expectedUpdatedAt` | Permanently delete a goal. |

An `id` may be a complete goal ID or a unique ID prefix.
`dependsOn` is an array of goal IDs or unique prefixes.
`links` is an array of absolute HTTP or HTTPS URLs kept for a reader rather than for any machine semantics, and an `update` replaces the whole set exactly as `dependsOn` does, so send every URL the goal should end up with and send an empty array to clear them.
The `plan` format and its deterministic reference rules are documented in [goals.md](goals.md#json-goal-plans).
Pass the `updatedAt` value from the caller's last read as `expectedUpdatedAt` when changing an existing goal, so a concurrent edit returns a conflict instead of being overwritten.
Every mutation runs through the shared cross-process lock and atomic file replacement.

## Capturing a brainstorm

The `apply-plan` tool carries the brainstorm-to-approved-plan workflow itself: in its description, in `_meta.captureWorkflow`, and in the `plan`, plan-entry, and `dryRun` schema descriptions, all rendered from the contract, so a client reads the steps off the tool it is about to call.
Those steps are written once, in [cli.md](cli.md#capture-brainstorms-as-approved-goal-plans).
On this surface the preview they allow is an `apply-plan` call with `dryRun: true`, which is never the user's approval, and the approved array is applied by exactly one call with `dryRun` omitted rather than by a sequence of `add` calls.

## Exact confirmation guardrails

`complete`, `reopen`, `archive`, and `delete` require a boolean `confirm` input because each one changes lifecycle state or removes a goal.
Pass `confirm: true` only after the user explicitly requested that exact action for that exact goal.
Do not infer confirmation from a general request to manage the roadmap, a confirmation for another action or goal, a previous turn, or a client's generic permission to execute tools.
Do not automatically retry an unconfirmed call with `confirm: true`.
Ask the user for the missing exact confirmation, then retry only the action and goal they approved.

The four tool schemas declare `confirm` as an optional boolean, and their MCP metadata advertises `confirmRequired: true`.
Confirmation is a guardrail the application service enforces, not a JSON Schema requirement, so an omitted `confirm` reaches the service and is refused with the same actionable envelope as `confirm: false` rather than a protocol-level validation error that carries no guidance.
The server forwards the supplied boolean unchanged to the application service and never fills it in.
Any value other than literal `true` fails without a write and returns an envelope with `error.code` set to `APPROVAL_REQUIRED`, `error.details.confirmation` set to `confirm=true`, and `error.details.resolution` set to `request-explicit-user-confirmation`.
`expectedUpdatedAt` is a concurrency precondition and never substitutes for confirmation.

## Application-service envelopes

MCP preserves the shared application-service result envelope rather than converting goal operations into harness-specific prose.
A success has `ok: true`, `scope: "project"`, the requested `action`, an action-specific `result`, and `meta`.
A failure has `ok: false`, the same `scope` and `action`, a typed `error`, and `meta`.
The error contains a stable `code`, a human-readable `message`, a `retryable` boolean, and optional conflict or detail fields.
Metadata reports `changed`, `semanticNoOp`, sorted JSON Pointer `changedFields`, and any changed entities or revisions that apply.

```json
{
  "ok": true,
  "scope": "project",
  "action": "ready",
  "result": {
    "scope": "project",
    "action": "ready",
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

Resource responses place the JSON envelope in their `application/json` text body.
Tool responses expose the envelope both as `structuredContent` and as JSON text in `content`, so clients with either MCP result representation receive the same data.
A failed tool response keeps the typed failure envelope and also sets the MCP `isError` flag.
Unlike the CLI's `--json` adapter, the MCP adapter does not add `meta.cliVersion`.
