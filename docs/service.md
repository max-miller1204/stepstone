# Authoritative collaboration service

The `run-an-authoritative-stepstone` goal defines this service's scope.
One PostgreSQL database holds projects, tasks, membership, credentials, current projections, events, and command receipts.
The same server runs on a laptop or a shared host.
It requires no Git repository, worklist file, dispatch journal, Pi installation, or developer checkout.

The existing file CLI and Pi interfaces remain separate clients of the file model.
Moving those interfaces and importing existing worklists belong to the later migration goal.
The wave 4 file proof remains a development proof. Its endpoints and credentials do not select this service.

## Install from a release

Use Docker with Compose and an npm client to obtain the release artifact.
Choose an explicit Stepstone release version that contains `stepstone-server`.
The commands below use `VERSION` as that version.

1. Download the release with `npm pack stepstone@VERSION --ignore-scripts`.
2. Extract it with `tar -xzf stepstone-VERSION.tgz`.
3. Build the image with `docker build -f package/deploy/Dockerfile -t stepstone-server:VERSION package`.
4. Create a private deployment directory.
5. Copy `package/deploy/compose.yaml` into that directory.
6. Copy `package/deploy/compose.env.example` to `.env` there.
7. Copy `package/deploy/service.env.example` to `service.env` there.
8. Copy `package/deploy/server.example.json` to `server.json` there.
9. Set the exact image tag in `.env`.
10. Set a random database password in `.env`.
11. Set the matching, URL-encoded password in `service.env`.
12. Set the OIDC issuer, API audience, JWKS URL, and initial administrator subject in `server.json`.
13. Create `backups` with write access for the image's `postgres` user.
14. Restrict `.env` and `service.env` to the deployment owner with `chmod 600 .env service.env`.
15. Run `docker compose up -d`.
16. Run `docker compose ps` and check that the server is healthy.

The release contains the compiled server and all runtime dependencies.
The Dockerfile pins its Node and PostgreSQL base image digests.
It installs the runtime tree from the release's shrinkwrap.
The final image contains Node, PostgreSQL client tools, compiled files, and runtime dependencies.
It runs as the `postgres` user with a read-only root filesystem in Compose.
Database files live in the named Compose volume.
Do not remove that volume during an upgrade.

For a laptop, set `publicOrigin` to `http://127.0.0.1:4318`.
Keep the Compose port binding on `127.0.0.1`.
For a shared host, set `publicOrigin` to the externally reachable HTTPS origin.
Put an HTTPS reverse proxy in front of the loopback port.
Disable proxy buffering for `/v1/projects/*/events` and allow long-lived responses.
Do not expose the database port or the unencrypted application port publicly.
The service does not trust forwarded identity headers.

A remote PostgreSQL installation can replace the Compose database.
Set `DATABASE_URL` explicitly and configure verified PostgreSQL TLS for that deployment.
The database account for migration must be able to create tables and functions.
A separate runtime account needs schema read access, project updates, membership changes, credential changes, and event and receipt inserts.
It does not need permission to change the schema or update and delete history.

## Authentication and membership

Configure one OIDC issuer and its trusted JWKS endpoint.
Both require HTTPS, except loopback development endpoints.
Users obtain a JWT access token for the configured API audience through their identity provider.
This service validates signature, issuer, audience, subject, expiry, issue time, and token age.
It accepts RS256 and ES256 signatures and a maximum token age of 24 hours.
It does not implement browser login, account registration, recovery, or an interactive CLI login flow.
Those flows belong to the identity provider and later clients.

`GET /v1/whoami` returns the authenticated user's stable actor ID.
The ID derives from the exact issuer and subject, not email or display name.
Changing either identity field creates a different actor.
`stepstone-server actor <issuer> <subject>` computes the same ID for membership administration.

The configured administrator subjects can create projects.
Project creation grants the creator the owner role.
Administrators do not receive access to other projects automatically.
Owners grant explicit membership through a `set_member` command.
Signing in alone grants no project access.
Removing or demoting the last owner fails.

| Project role | Rights |
| --- | --- |
| reader | Read snapshots and subscribe to events |
| editor | Reader rights plus task and milestone changes |
| owner | Editor rights plus project configuration, task deletion, ID migration, membership, and credential administration |

Every protected request uses `Authorization: Bearer <token>`.
The service checks project permissions inside the same transaction as its reads or writes.
Subscriptions recheck identity expiry, membership, and credential status before each batch.
An idle subscription rechecks once per second.
A revoked subscription receives an error and closes.
An already authorized response can still be in transit when revocation commits.

### Service credentials

Run `stepstone-server credential` in a private terminal or redirect its output to a private file.
The command generates a random token, a credential ID, and a SHA-256 token hash.
Store the token securely. Submit only its hash to the service.
The database and successful command receipts do not store the plaintext token.
For a container installation, use `docker compose run --rm server credential`.

An owner submits a `grant_service` command with these fields:

```json
{
  "action": "grant_service",
  "credentialId": "REPLACE_WITH_GENERATED_UUID",
  "tokenHash": "REPLACE_WITH_GENERATED_HASH",
  "role": "editor",
  "scopes": ["read", "subscribe", "write"],
  "expiresAt": "2027-01-01T00:00:00.000Z",
  "confirm": true
}
```

Choose an expiry in the future.
A credential belongs to one project and has a separate stable service actor ID.
Its scopes and role both restrict access.
It cannot hold the owner role, create projects, delete tasks, or administer access.
A scope does not override the role restriction.
To rotate a credential, grant a new credential, update its consumer, then revoke the old credential.
Submit `revoke_service` with `credentialId` and `confirm: true`.
A revoked credential ID cannot be granted again.
`GET /v1/projects/<projectId>/access` lists membership and credential metadata for owners.
It does not return credential hashes or tokens.

## HTTP command contract

All writes use `POST /v1/commands` with `Content-Type: application/json`.
The service rejects unknown fields, unsupported versions, and oversized requests.
Each command contains an immutable project UUID, a new command UUID, an expected revision, and one operation:

```json
{
  "version": 1,
  "commandId": "REPLACE_WITH_NEW_UUID",
  "projectId": "REPLACE_WITH_PROJECT_UUID",
  "expectedRevision": 0,
  "operation": {
    "action": "create_project",
    "title": "Example project",
    "confirm": true
  }
}
```

The administrator supplies a new project UUID for creation.
Creation requires revision zero. It commits revision one.
To submit a prepared command file:

```sh
curl --fail-with-body \
  -H "Authorization: Bearer $STEPSTONE_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary @command.json \
  "$STEPSTONE_SERVER/v1/commands"
```

Read `GET /v1/projects/<projectId>/snapshot` before preparing later commands.
It returns project revision, event cursor, canonical worklist projection, and immutable task UUIDs mapped to current references.
Task mutations use `taskId` for the target.
Dependency and placement fields use the stored human-facing goal references, including former references.
A rename preserves task identity and the frozen reference.
ID migration keeps former references and immutable identity.
Deletion retires references and retains identity history.

Supported domain actions are `configure`, `add`, `update`, `complete`, `reopen`, `archive`, `delete`, `set_active`, `start`, `move`, `migrate_ids`, `add_milestone`, `update_milestone`, `assign_milestone`, and `apply-plan`.
Their fields use the shared application rules.
The source schema in `src/service/protocol.ts` defines the exact accepted payloads.
Lifecycle operations and ID migration require `confirm: true`.
A client must collect explicit authorization before setting that field.
The `start` action records branch context only. It does not create a branch or workspace.
File-path migration, file import, dispatch, and workspace management are not service operations.

A PostgreSQL row lock serializes each project's commands and permission changes.
The service runs domain changes through `WorklistApplicationService` and `src/project-mutations.ts` against a private transaction snapshot.
It commits canonical state, projection, one ordered event, and the successful receipt in one PostgreSQL transaction.
The existing file store retains its cross-process lock and atomic replacement behavior.
The database path never creates a temporary worklist file or switches to file storage.

A stale expected revision returns `REVISION_CONFLICT` without a mutation or receipt.
Read current state and prepare a new command with a new command ID.
An uncertain network result requires retrying the exact original command with the same ID.
The same actor and command content return the stored result.
Reuse with different content or another actor returns `IDEMPOTENCY_CONFLICT`.
Current permissions still apply to retries.
Accepted semantic no-ops advance the project revision and event sequence.
Rejected commands do not receive receipts.

Receipts contain project, command, actor, action, revision, event sequence, and affected task IDs.
They do not contain project snapshots.
Events carry the same compact acceptance record. Clients refresh the snapshot after an event.
Events provide command order and invalidation; they are not a complete state-reconstruction log.

## Subscriptions

1. Read a snapshot.
2. Open `GET /v1/projects/<projectId>/events?after=<cursor>`.
3. Process SSE `change` events in sequence order.
4. Ignore repeated cursors that the client has already processed.
5. Reconnect with the last processed cursor in `Last-Event-ID`.

The server replays retained events in batches of at most 100.
It polls PostgreSQL for subsequent events, which supports separate service processes without an in-memory authority.
`Last-Event-ID` takes precedence over the query cursor.
Invalid or future cursors receive `SNAPSHOT_REQUIRED`.
The client must establish a new snapshot cursor after that error.
A slow consumer has five seconds to drain a blocked write before its connection closes.

## Upgrades and database migrations

1. Back up the database and save the current image tag and configuration.
2. Obtain and build the new release artifact.
3. Stop the server with `docker compose stop server`.
4. Set the new explicit image tag in `.env`.
5. Run `docker compose run --rm migrate`.
6. Run `docker compose run --rm server verify`.
7. Start the server with `docker compose up -d server`.
8. Check `/health/ready` and read a known project snapshot.

Migration commands take a database advisory lock.
Each migration and its checksum record commit together.
Repeated migration commands do not apply a migration twice.
A checksum mismatch or a database newer than the binary fails explicitly.
Server startup requires the exact supported schema; it does not migrate automatically.

Do not run an older binary against an incompatible migrated database.
To roll back such an upgrade, restore the pre-upgrade archive into a new database and use the matching old image and configuration.
Do not copy old SQL over the running database.

## Backup and restore

Create a consistent PostgreSQL custom archive:

```sh
docker compose run --rm server backup /backups/stepstone-backup.dump
```

The destination must not exist. The archive is created with mode `0600`.
The CLI publishes the final archive path only after the dump finishes and its file is synced.
A killed backup process can leave a `.partial-<UUID>` file. Remove that incomplete file before the next backup.
The archive includes canonical state, projections, identity history, membership, credential hashes, events, receipts, and migration checksums.
Save `server.json`, the image tag or digest, and deployment secrets separately.
Encrypt archives when moving them off the host.
The archive does not include external OIDC accounts or PostgreSQL cluster roles.

Restore only into a newly created, empty database.
Set `DATABASE_URL` to that database, then run:

```sh
stepstone-server restore /path/to/stepstone-backup.dump --confirm
stepstone-server verify
```

In Compose, pass the new URL with `docker compose run --rm -e DATABASE_URL server restore /backups/stepstone-backup.dump --confirm` after setting it in the invoking environment.
The restore uses a single PostgreSQL transaction and stops on the first SQL error.
The CLI refuses a populated destination and checks schema and project invariants after restoration.
Switch the service to the restored database only after verification succeeds.
Run a known command retry and confirm that it returns the original receipt.

Schedule backups through the host's scheduler according to the team's recovery requirements.
This installation provides snapshot backups, not continuous archiving or automatic failover.
The maximum data loss is the interval since the last usable backup.
Test restores regularly on a separate database.

## Retention, health, and storage

Wave 5 retains all events and compact receipts for the lifetime of the project.
There is no automatic pruning or permanent project deletion endpoint.
The database rejects updates, deletes, and truncation of event and receipt history.
Do not remove those triggers to reclaim space.
Events and receipts are independent tables, so future event retention cannot implicitly delete deduplication records.

`stepstone-server storage` reports per-project state, projection, event, and receipt sizes and counts.
These logical row sizes exclude indexes and some database overhead.
Monitor total PostgreSQL disk usage separately.
Size the database for growth and stop writes explicitly if capacity is exhausted.
Backup archives are independent of live history. Remove old archives only under the operator's backup retention policy after verifying a newer restore.

`GET /health/live` checks the HTTP process.
`GET /health/ready` checks database connectivity and exact migration compatibility.
Neither endpoint returns project data or credentials.
`stepstone-server verify` checks current projections, task identity, owner membership, event order, and matching receipts in a consistent database snapshot.
The service returns structured errors and logs unexpected failures without returning database internals to clients.

## Verification

The service test suite requires a disposable PostgreSQL instance:

```sh
STEPSTONE_TEST_DATABASE_URL=postgresql://postgres:PASSWORD@127.0.0.1:5432/postgres npm run test:service -- --coverage
npm run test:service:operations
```

The first suite creates and removes a unique test database.
It tests concurrent writers, rollback, retries, domain operations, OIDC, permissions, credential revocation, SSE recovery, and backpressure.
Its coverage gate is separate from the existing file and Pi suite.
The operations check requires Docker. It builds the packed release, creates an isolated database, performs backup and restore, verifies a command retry, and restarts the service container.
It writes inspectable results to `artifacts/service-operations.json`.
