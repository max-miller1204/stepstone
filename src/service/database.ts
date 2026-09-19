import type { PoolClient } from "pg";
import { Pool } from "pg";
import { hash, ServiceError } from "./protocol.ts";

const MIGRATIONS = [
	`
CREATE TABLE stepstone_projects (
 id uuid PRIMARY KEY,
 revision bigint NOT NULL CHECK (revision >= 0 AND revision <= 9007199254740991),
 state jsonb NOT NULL,
 projection jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE stepstone_members (
 project_id uuid NOT NULL REFERENCES stepstone_projects(id),
 actor_id text NOT NULL,
 role text NOT NULL CHECK (role IN ('reader','editor','owner')),
 PRIMARY KEY (project_id, actor_id)
);
CREATE TABLE stepstone_credentials (
 id uuid PRIMARY KEY,
 project_id uuid NOT NULL REFERENCES stepstone_projects(id),
 token_hash text NOT NULL,
 role text NOT NULL CHECK (role IN ('reader','editor')),
 scopes jsonb NOT NULL,
 expires_at timestamptz NOT NULL,
 revoked boolean NOT NULL DEFAULT false
);
CREATE TABLE stepstone_events (
 project_id uuid NOT NULL REFERENCES stepstone_projects(id),
 sequence bigint NOT NULL CHECK (sequence > 0),
 command_id uuid NOT NULL,
 actor_id text NOT NULL,
 event jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (project_id, sequence),
 UNIQUE (project_id, command_id)
);
CREATE TABLE stepstone_receipts (
 project_id uuid NOT NULL REFERENCES stepstone_projects(id),
 command_id uuid NOT NULL,
 actor_id text NOT NULL,
 fingerprint text NOT NULL,
 result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (project_id, command_id)
);
CREATE FUNCTION stepstone_immutable_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Stepstone history is append-only'; END $$;
CREATE TRIGGER stepstone_events_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON stepstone_events
 FOR EACH STATEMENT EXECUTE FUNCTION stepstone_immutable_history();
CREATE TRIGGER stepstone_receipts_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON stepstone_receipts
 FOR EACH STATEMENT EXECUTE FUNCTION stepstone_immutable_history();
`,
];

export function connectDatabase(connectionString: string): Pool {
	const pool = new Pool({
		connectionString,
		max: 10,
		connectionTimeoutMillis: 5000,
		statement_timeout: 15000,
		idle_in_transaction_session_timeout: 30000,
	});
	pool.on("error", (error) => {
		console.error("PostgreSQL pool failed:", error.message);
		process.exitCode = 1;
	});
	return pool;
}
export async function transaction<T>(pool: Pool, run: (client: PoolClient) => Promise<T>): Promise<T> {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		const result = await run(client);
		await client.query("COMMIT");
		return result;
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}
export async function migrate(pool: Pool): Promise<void> {
	await transaction(pool, async (client) => {
		await client.query("SELECT pg_advisory_xact_lock(1937006960)");
		await client.query(
			"CREATE TABLE IF NOT EXISTS stepstone_schema (version integer PRIMARY KEY, checksum text NOT NULL)",
		);
		const applied = (await client.query("SELECT version, checksum FROM stepstone_schema ORDER BY version"))
			.rows;
		if (applied.length > MIGRATIONS.length) throw new Error("Database schema is newer than this server.");
		for (let index = 0; index < MIGRATIONS.length; index++) {
			const checksum = hash(MIGRATIONS[index]);
			if (applied[index]) {
				if (applied[index].version !== index + 1 || applied[index].checksum !== checksum)
					throw new Error("Database migration history does not match this server.");
			} else {
				await client.query(MIGRATIONS[index]);
				await client.query("INSERT INTO stepstone_schema VALUES ($1, $2)", [index + 1, checksum]);
			}
		}
	});
}
export async function checkSchema(pool: Pool): Promise<void> {
	const applied = (await pool.query("SELECT version, checksum FROM stepstone_schema ORDER BY version")).rows;
	if (
		applied.length !== MIGRATIONS.length ||
		applied.some((row, i) => row.version !== i + 1 || row.checksum !== hash(MIGRATIONS[i]))
	)
		throw new ServiceError(
			"SCHEMA_MISMATCH",
			"Run the matching database migrations before starting this server.",
			503,
		);
}
