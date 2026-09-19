#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { link, open, readFile, rm } from "node:fs/promises";
import { CLI_COMMAND_CONTRACT } from "./cli-contract.ts";
import { configSchema } from "./service/auth.ts";
import { checkSchema, connectDatabase, migrate } from "./service/database.ts";
import { startService } from "./service/http.ts";
import { hash, oidcActor } from "./service/protocol.ts";
import { AuthoritativeService } from "./service/service.ts";

const usage = `${CLI_COMMAND_CONTRACT.binary}-server <command>
  serve <config.json>       Start the HTTP service. Requires DATABASE_URL.
  migrate                  Apply database migrations. Requires DATABASE_URL.
  verify                   Check database invariants. Requires DATABASE_URL.
  storage                  Report retained history and storage sizes.
  backup <new-file.dump>    Create a PostgreSQL custom archive with pg_dump.
  restore <file.dump> --confirm  Restore into an empty database with pg_restore.
  credential               Generate a service token and its grant fields.
  actor <issuer> <subject>  Calculate an OIDC actor ID for membership commands.
  help                     Show this help.
`;
async function postgresTool(
	binary: string,
	args: string[],
	database: string,
	output?: number,
): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const connection = new URL(database);
		const password = decodeURIComponent(connection.password);
		connection.password = "";
		if (connection.searchParams.has("password"))
			throw new Error("Put the database password in the URL authority, not a query parameter.");
		const child = spawn(binary, [...args, "--dbname", connection.href], {
			env: { ...process.env, PGPASSWORD: password },
			stdio: ["ignore", output ?? "ignore", "pipe"],
		});
		let diagnostic = "";
		child.stderr?.on("data", (chunk) => {
			diagnostic = (diagnostic + String(chunk)).slice(-8000);
		});
		child.once("error", reject);
		child.once("exit", (code) =>
			code === 0
				? resolve()
				: reject(new Error(`${binary} failed (${code}): ${diagnostic.replaceAll(database, "[database]")}`)),
		);
	});
}
async function main(args: string[]): Promise<void> {
	const [command, ...rest] = args;
	if (command === "help" && rest.length === 0) {
		process.stdout.write(usage);
		return;
	}
	if (command === "credential" && rest.length === 0) {
		const credentialId = randomUUID();
		const token = `sts_${credentialId}.${randomBytes(32).toString("base64url")}`;
		console.log(JSON.stringify({ token, credentialId, tokenHash: hash(token) }));
		return;
	}
	if (command === "actor" && rest.length === 2) {
		console.log(JSON.stringify({ actorId: oidcActor(rest[0], rest[1]) }));
		return;
	}
	const valid =
		((command === "serve" || command === "backup") && rest.length === 1) ||
		(["migrate", "verify", "storage"].includes(command) && rest.length === 0) ||
		(command === "restore" && rest.length === 2 && rest[1] === "--confirm");
	if (!valid) throw new Error(usage);
	const database = process.env.DATABASE_URL;
	if (!database) throw new Error("DATABASE_URL is required.");
	const pool = connectDatabase(database);
	let serving = false;
	try {
		if (command === "migrate") {
			await migrate(pool);
			console.log(JSON.stringify({ ok: true }));
		} else if (command === "serve") {
			const config = configSchema.parse(JSON.parse(await readFile(rest[0], "utf8")));
			const server = await startService(new AuthoritativeService(pool), config);
			serving = true;
			console.log(JSON.stringify({ listening: server.address(), publicOrigin: config.publicOrigin }));
			const stop = () => {
				server.close(() => {
					void pool.end();
				});
				server.closeAllConnections();
			};
			process.once("SIGTERM", stop);
			process.once("SIGINT", stop);
		} else if (command === "restore") {
			const tables = await pool.query(
				"SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r','p','v','m','S')",
			);
			if (tables.rowCount)
				throw new Error("Restore requires an empty database. Create a new database first.");
			await postgresTool(
				"pg_restore",
				["--exit-on-error", "--single-transaction", "--no-owner", "--no-privileges", rest[0]],
				database,
			);
			await checkSchema(pool);
			await new AuthoritativeService(pool).verify();
			console.log(JSON.stringify({ ok: true }));
		} else {
			await checkSchema(pool);
			const service = new AuthoritativeService(pool);
			if (command === "storage")
				console.log(JSON.stringify({ retention: "indefinite", projects: await service.storage() }));
			else if (command === "verify") {
				await service.verify();
				console.log(JSON.stringify({ ok: true }));
			} else {
				const temporary = `${rest[0]}.partial-${randomUUID()}`;
				const file = await open(temporary, "wx", 0o600);
				try {
					await postgresTool(
						"pg_dump",
						["--format=custom", "--no-owner", "--no-privileges"],
						database,
						file.fd,
					);
					await file.sync();
					// Publish the complete archive without replacing an existing path.
					await link(temporary, rest[0]);
				} finally {
					await file.close();
					await rm(temporary);
				}
				console.log(JSON.stringify({ ok: true, archive: rest[0] }));
			}
		}
	} finally {
		if (!serving) await pool.end();
	}
}
main(process.argv.slice(2)).catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
