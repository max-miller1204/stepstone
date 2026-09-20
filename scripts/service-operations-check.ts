/** Prove installation and recovery from the packed release without a server checkout. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const execute = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), "stepstone-operations-"));
const suffix = randomBytes(6).toString("hex");
const network = `stepstone-test-${suffix}`;
const database = `stepstone-db-${suffix}`;
const server = `stepstone-server-${suffix}`;
const image = `stepstone-operations:${suffix}`;
const password = randomBytes(24).toString("hex");
const databaseUrl = `postgresql://postgres:${password}@${database}:5432/stepstone`;
const restoredUrl = `postgresql://postgres:${password}@${database}:5432/restored`;
const evidence: string[] = [];
const created = { image: false, network: false, database: false, server: false };
async function run(binary: string, args: string[], cwd?: string): Promise<string> {
	try {
		return (await execute(binary, args, { cwd, timeout: 300000, maxBuffer: 16 * 1024 * 1024 })).stdout;
	} catch (error) {
		throw new Error(String(error).replaceAll(password, "[redacted]"));
	}
}
const docker = (args: string[]) => run("docker", args);
const tool = (args: string[], url = databaseUrl) =>
	docker([
		"run",
		"--rm",
		"--network",
		network,
		"-e",
		`DATABASE_URL=${url}`,
		"-v",
		`${directory}:/backups`,
		image,
		...args,
	]);
const code = (source: string, url = databaseUrl) =>
	docker([
		"run",
		"--rm",
		"--network",
		network,
		"-e",
		`DATABASE_URL=${url}`,
		"--entrypoint",
		"node",
		image,
		"--input-type=module",
		"-e",
		source,
	]);
const record = (message: string) => {
	evidence.push(message);
	console.log(message);
};
try {
	await chmod(directory, 0o777);
	const npmPath = process.env.npm_execpath;
	if (!npmPath) throw new Error("Run this check through npm run test:service:operations.");
	await run(process.execPath, [npmPath, "pack", "--pack-destination", directory], resolve("."));
	const archive = (await readdir(directory)).find((file) => file.endsWith(".tgz"));
	assert.ok(archive);
	await run("tar", ["-xzf", join(directory, archive), "-C", directory]);
	await docker([
		"build",
		"-f",
		join(directory, "package/deploy/Dockerfile"),
		"-t",
		image,
		join(directory, "package"),
	]);
	created.image = true;
	record("Built the server image from the npm tarball without Git or a source checkout.");
	await docker(["network", "create", network]);
	created.network = true;
	await docker([
		"run",
		"-d",
		"--name",
		database,
		"--network",
		network,
		"-e",
		`POSTGRES_PASSWORD=${password}`,
		"-e",
		"POSTGRES_DB=stepstone",
		"postgres:18.3@sha256:7e32e9833a6fb1c92c32552794cb6ed569d51b445a54907d35fc112ef39684db",
	]);
	created.database = true;
	let ready = false;
	for (let i = 0; i < 60; i++) {
		try {
			await docker(["exec", database, "pg_isready", "-U", "postgres", "-d", "stepstone"]);
			ready = true;
			break;
		} catch {
			await delay(500);
		}
	}
	assert.ok(ready, "PostgreSQL did not become ready.");
	await tool(["migrate"]);
	await tool(["migrate"]);
	const setup = `import {connectDatabase} from './dist/service/database.js';
import {AuthoritativeService} from './dist/service/service.js';
import {oidcActor} from './dist/service/protocol.js';
import {randomUUID} from 'node:crypto';
const pool=connectDatabase(process.env.DATABASE_URL); const service=new AuthoritativeService(pool);
const actor={actorId:oidcActor('https://example.com','owner'),administrator:true,expiresAt:Date.now()+3600000};`;
	const seeded = JSON.parse(
		await code(`${setup}
try {
 const projectId=randomUUID();
 await service.execute(actor,{version:1,commandId:randomUUID(),projectId,expectedRevision:0,operation:{action:'create_project',title:'Recovery proof',confirm:true}});
 const command={version:1,commandId:randomUUID(),projectId,expectedRevision:1,operation:{action:'add',title:'Survives restore'}};
 const receipt=await service.execute(actor,command);
 console.log(JSON.stringify({command,receipt,snapshot:await service.snapshot(actor,projectId)}));
} finally {await pool.end();}`),
	);
	record("Applied migrations twice and created canonical task state through the shared services.");
	await tool(["backup", "/backups/service.dump"]);
	await assert.rejects(tool(["backup", "/backups/service.dump"]), /exist/i);
	await docker(["exec", database, "createdb", "-U", "postgres", "restored"]);
	await tool(["restore", "/backups/service.dump", "--confirm"], restoredUrl);
	const recovered = JSON.parse(
		await code(
			`${setup}
try {
 const command=${JSON.stringify(seeded.command)};
 const receipt=await service.execute(actor,command);
 console.log(JSON.stringify({receipt,snapshot:await service.snapshot(actor,command.projectId)}));
} finally {await pool.end();}`,
			restoredUrl,
		),
	);
	assert.deepEqual(recovered.receipt, seeded.receipt);
	assert.deepEqual(recovered.snapshot, seeded.snapshot);
	await tool(["verify"], restoredUrl);
	await assert.rejects(
		tool(["restore", "/backups/service.dump", "--confirm"], restoredUrl),
		/empty database/,
	);
	record(
		"Restored state, projection, events, and receipts. Exact retry returned the original receipt without another event.",
	);
	record("Refused archive overwrite and refused restore into a populated database.");
	await writeFile(
		join(directory, "server.json"),
		JSON.stringify({
			host: "0.0.0.0",
			port: 4318,
			publicOrigin: "https://stepstone.example.com",
			oidc: {
				issuer: "https://identity.example.com",
				audience: "stepstone",
				jwksUri: "https://identity.example.com/jwks",
				administratorSubjects: ["owner"],
			},
		}),
	);
	await docker([
		"run",
		"-d",
		"--name",
		server,
		"--network",
		network,
		"--read-only",
		"-e",
		`DATABASE_URL=${restoredUrl}`,
		"-v",
		`${directory}/server.json:/config/server.json:ro`,
		image,
		"serve",
		"/config/server.json",
	]);
	created.server = true;
	const probe = () =>
		docker([
			"exec",
			server,
			"node",
			"-e",
			"fetch('http://127.0.0.1:4318/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
		]);
	const waitForReady = async () => {
		for (let attempt = 0; attempt < 40; attempt++) {
			try {
				await probe();
				return;
			} catch {
				await delay(250);
			}
		}
		throw new Error(`Service did not become ready: ${await docker(["logs", server])}`);
	};
	await waitForReady();
	await docker(["restart", server]);
	await waitForReady();
	record(
		"Started and restarted the read-only service container. Readiness passed against the restored database.",
	);
	await mkdir("artifacts", { recursive: true });
	await writeFile(
		"artifacts/service-operations.json",
		JSON.stringify(
			{
				checks: evidence,
				restored: { projectId: seeded.command.projectId, revision: seeded.receipt.revision },
				archiveBytes: (await stat(join(directory, "service.dump"))).size,
			},
			null,
			2,
		),
	);
} finally {
	if (created.server) await docker(["rm", "-f", server]);
	if (created.database) await docker(["rm", "-f", database]);
	if (created.network) await docker(["network", "rm", network]);
	if (created.image) await docker(["image", "rm", image]);
	await rm(directory, { recursive: true, force: true });
}
