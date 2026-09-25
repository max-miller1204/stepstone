import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { configSchema, createAuthenticator } from "../../src/service/auth.ts";
import { checkSchema, connectDatabase, migrate, transaction } from "../../src/service/database.ts";
import { startService } from "../../src/service/http.ts";
import { loadImportWorklist } from "../../src/service/import.ts";
import type { Command, Principal } from "../../src/service/protocol.ts";
import { canonical, hash, oidcActor, parseCommand } from "../../src/service/protocol.ts";
import { AuthoritativeService } from "../../src/service/service.ts";

const connection = process.env.STEPSTONE_TEST_DATABASE_URL;
if (!connection)
	throw new Error("STEPSTONE_TEST_DATABASE_URL is required. Use a disposable PostgreSQL instance.");
const adminPool = new Pool({ connectionString: connection });
const database = `stepstone_test_${randomBytes(8).toString("hex")}`;
const databaseUrl = new URL(connection);
databaseUrl.pathname = `/${database}`;
let pool: Pool;
let service: AuthoritativeService;
let server: Server;
let issuerServer: Server;
let origin: string;
let issuer: string;
let ownerToken: string;
let owner: Principal;
let reader: Principal;
let jwtKey: Awaited<ReturnType<typeof generateKeyPair>>;
let auth: ReturnType<typeof createAuthenticator>;
const command = (projectId: string, expectedRevision: number, operation: Command["operation"]): Command => ({
	version: 1,
	commandId: randomUUID(),
	projectId,
	expectedRevision,
	operation,
});
async function project() {
	const projectId = randomUUID();
	const create = command(projectId, 0, { action: "create_project", title: "Service test", confirm: true });
	await service.execute(owner, create);
	return { projectId, create };
}
async function token(
	subject: string,
	options: { audience?: string; expires?: number; issuer?: string } = {},
) {
	return new SignJWT({})
		.setProtectedHeader({ alg: "RS256", kid: "test-key" })
		.setIssuer(options.issuer ?? issuer)
		.setAudience(options.audience ?? "stepstone")
		.setSubject(subject)
		.setIssuedAt()
		.setExpirationTime(options.expires ?? Math.floor(Date.now() / 1000) + 3600)
		.sign(jwtKey.privateKey);
}
async function request(path: string, method = "GET", body?: unknown, bearer = ownerToken) {
	return fetch(`${origin}${path}`, {
		method,
		headers: { authorization: `Bearer ${bearer}`, ...(body ? { "content-type": "application/json" } : {}) },
		...(body ? { body: JSON.stringify(body) } : {}),
	});
}
beforeAll(async () => {
	await adminPool.query(`CREATE DATABASE ${database}`);
	pool = connectDatabase(databaseUrl.href);
	await expect(checkSchema(pool)).rejects.toThrow();
	await Promise.all([migrate(pool), migrate(pool)]);
	service = new AuthoritativeService(pool);
	jwtKey = await generateKeyPair("RS256");
	const jwk = { ...(await exportJWK(jwtKey.publicKey)), kid: "test-key", alg: "RS256", use: "sig" };
	issuerServer = createServer((_request, response) => {
		response.setHeader("content-type", "application/json");
		response.end(JSON.stringify({ keys: [jwk] }));
	});
	await new Promise<void>((resolve) => issuerServer.listen(0, "127.0.0.1", resolve));
	const address = issuerServer.address();
	if (!address || typeof address === "string") throw new Error("Issuer did not bind.");
	issuer = `http://127.0.0.1:${address.port}`;
	const config = configSchema.parse({
		host: "127.0.0.1",
		port: 0,
		publicOrigin: "http://127.0.0.1",
		oidc: { issuer, audience: "stepstone", jwksUri: `${issuer}/keys`, administratorSubjects: ["owner"] },
	});
	auth = createAuthenticator(config.oidc);
	ownerToken = await token("owner");
	owner = await auth(ownerToken);
	reader = await auth(await token("reader"));
	server = await startService(service, config);
	const httpAddress = server.address();
	if (!httpAddress || typeof httpAddress === "string") throw new Error("Service did not bind.");
	origin = `http://127.0.0.1:${httpAddress.port}`;
});
afterAll(async () => {
	server?.closeAllConnections();
	await Promise.all(
		[server, issuerServer]
			.filter(Boolean)
			.map(
				(server) =>
					new Promise<void>((resolve, reject) =>
						server.close((error) => (error ? reject(error) : resolve())),
					),
			),
	);
	await pool?.end();
	await adminPool.query(`DROP DATABASE ${database} WITH (FORCE)`);
	await adminPool.end();
});

test("atomic state, event, receipt and projection survive retries and restart", async () => {
	const { projectId, create } = await project();
	expect(await service.execute(owner, create)).toMatchObject({ revision: 1 });
	const add = command(projectId, 1, { action: "add", title: "Stable identity" });
	const receipt = await service.execute(owner, add);
	expect(receipt.taskIds).toHaveLength(1);
	const anotherPool = connectDatabase(databaseUrl.href);
	try {
		const restarted = new AuthoritativeService(anotherPool);
		expect(await restarted.execute(owner, add)).toEqual(receipt);
		expect((await restarted.snapshot(owner, projectId)).worklist.goals[0].title).toBe("Stable identity");
	} finally {
		await anotherPool.end();
	}
	await expect(
		service.execute(owner, { ...add, operation: { action: "add", title: "Other" } }),
	).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
	await expect(service.execute(owner, { ...add, commandId: randomUUID() })).rejects.toMatchObject({
		code: "REVISION_CONFLICT",
	});
	expect(await service.events(owner, projectId, 0)).toHaveLength(2);
	await service.verify();
});

test("concurrent database connections accept one writer at a revision", async () => {
	const { projectId } = await project();
	const secondPool = connectDatabase(databaseUrl.href);
	try {
		const second = new AuthoritativeService(secondPool);
		const results = await Promise.allSettled([
			service.execute(owner, command(projectId, 1, { action: "add", title: "One" })),
			second.execute(owner, command(projectId, 1, { action: "add", title: "Two" })),
		]);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		expect(results.find((r) => r.status === "rejected")).toMatchObject({
			reason: { code: "REVISION_CONFLICT" },
		});
	} finally {
		await secondPool.end();
	}
});

test("rollback leaves no state change when event insertion fails", async () => {
	const { projectId } = await project();
	await pool.query(
		`CREATE FUNCTION reject_test_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.project_id='${projectId}' THEN RAISE EXCEPTION 'injected storage failure'; END IF; RETURN NEW; END $$`,
	);
	await pool.query(
		"CREATE TRIGGER reject_test_event BEFORE INSERT ON stepstone_events FOR EACH ROW EXECUTE FUNCTION reject_test_event()",
	);
	const add = command(projectId, 1, { action: "add", title: "Must roll back" });
	try {
		await expect(service.execute(owner, add)).rejects.toThrow("injected storage failure");
	} finally {
		await pool.query("DROP TRIGGER reject_test_event ON stepstone_events; DROP FUNCTION reject_test_event()");
	}
	expect((await service.snapshot(owner, projectId)).worklist.goals).toEqual([]);
	expect(await service.events(owner, projectId, 1)).toEqual([]);
	expect(await service.execute(owner, add)).toMatchObject({ revision: 2 });
});

test("all domain operations use shared validation and preserve identity and retired references", async () => {
	const { projectId } = await project();
	let revision = 1;
	const execute = async (operation: Command["operation"]) => {
		const r = await service.execute(owner, command(projectId, revision, operation));
		revision = r.revision;
		return r;
	};
	const first = (await execute({ action: "add", title: "First", description: "Initial" })).taskIds[0];
	const second = (
		await execute({ action: "add", title: "Second", dependsOn: ["first"], links: ["https://example.com"] })
	).taskIds[0];
	await execute({ action: "update", taskId: first, title: "Renamed" });
	await execute({ action: "update", taskId: first, appendDescription: "More" });
	const moved = await execute({ action: "move", taskId: second, beforeId: "first" });
	expect(moved.taskIds).toEqual([second]);
	expect(await service.events(owner, projectId, moved.cursor - 1)).toEqual([moved]);
	expect((await service.snapshot(owner, projectId)).worklist.goals.map((goal) => goal.id)).toEqual([
		"second",
		"first",
	]);
	await execute({ action: "set_active", taskId: first });
	await execute({ action: "start", taskId: first, branch: "feature/test" });
	await expect(
		execute({ action: "complete", taskId: first, confirm: false } as unknown as Command["operation"]),
	).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
	await execute({ action: "complete", taskId: first, confirm: true });
	await execute({ action: "reopen", taskId: first, confirm: true });
	await execute({ action: "archive", taskId: first, confirm: true });
	await execute({ action: "reopen", taskId: first, confirm: true });
	await execute({ action: "add_milestone", title: "Release" });
	const snapshot = await service.snapshot(owner, projectId);
	const milestone = snapshot.worklist.milestones?.[0];
	if (!milestone) throw new Error("Missing milestone.");
	await execute({ action: "update_milestone", id: milestone.id, title: "Release one" });
	await execute({ action: "assign_milestone", taskId: first, milestoneId: milestone.id });
	await execute({
		action: "configure",
		title: "Project renamed",
		repositories: ["https://example.com/repo"],
		confirm: true,
	});
	await execute({ action: "migrate_ids", confirm: true });
	await execute({
		action: "apply-plan",
		plan: [{ title: "Third" }, { title: "Fourth", dependsOn: ["third"] }],
	});
	const beforeDelete = await service.snapshot(owner, projectId);
	expect(beforeDelete.tasks.find((t) => t.taskId === first)).toBeDefined();
	await execute({ action: "delete", taskId: first, confirm: true });
	const deleted = await service.snapshot(owner, projectId);
	expect(deleted.worklist.retiredIds).toContain("first");
	await expect(execute({ action: "update", taskId: first, title: "Resurrect" })).rejects.toMatchObject({
		code: "NOT_FOUND",
	});
	const replacement = await execute({ action: "add", title: "First" });
	expect(replacement.taskIds[0]).not.toBe(first);
	await service.verify();
});

test("permissions apply to snapshots, commands, events, and membership administration", async () => {
	const { projectId } = await project();
	await expect(service.snapshot(reader, projectId)).rejects.toMatchObject({ code: "FORBIDDEN" });
	await expect(service.events(reader, projectId, 0)).rejects.toMatchObject({ code: "FORBIDDEN" });
	await expect(
		service.execute(
			reader,
			command(randomUUID(), 0, { action: "create_project", title: "No", confirm: true }),
		),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	await service.execute(
		owner,
		command(projectId, 1, { action: "set_member", actorId: reader.actorId, role: "reader", confirm: true }),
	);
	expect((await service.snapshot(reader, projectId)).revision).toBe(2);
	await expect(
		service.execute(reader, command(projectId, 2, { action: "add", title: "Denied" })),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	await expect(service.access(reader, projectId)).rejects.toMatchObject({ code: "FORBIDDEN" });
	await expect(
		service.execute(
			owner,
			command(projectId, 2, { action: "set_member", actorId: owner.actorId, role: null, confirm: true }),
		),
	).rejects.toMatchObject({ code: "LAST_OWNER" });
	await service.execute(
		owner,
		command(projectId, 2, { action: "set_member", actorId: reader.actorId, role: "editor", confirm: true }),
	);
	const add = command(projectId, 3, { action: "add", title: "Editor task" });
	await service.execute(reader, add);
	await expect(service.execute(owner, add)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
	await service.execute(
		owner,
		command(projectId, 4, { action: "set_member", actorId: reader.actorId, role: null, confirm: true }),
	);
	await expect(service.events(reader, projectId, 0)).rejects.toMatchObject({ code: "FORBIDDEN" });
	expect(await service.access(owner, projectId)).toMatchObject({ members: [{ actor_id: owner.actorId }] });
});

test("scoped service credentials expire, revoke, and cannot cross projects", async () => {
	const { projectId } = await project();
	const other = await project();
	const credentialId = randomUUID();
	const serviceToken = `sts_${credentialId}.${randomBytes(32).toString("base64url")}`;
	const principal = await auth(serviceToken);
	const grant = command(projectId, 1, {
		action: "grant_service",
		credentialId,
		tokenHash: hash(serviceToken),
		role: "editor",
		scopes: ["read", "write", "subscribe"],
		expiresAt: new Date(Date.now() + 3600000).toISOString(),
		confirm: true,
	});
	await expect(service.snapshot(principal, projectId)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	await service.execute(owner, grant);
	expect((await service.snapshot(principal, projectId)).revision).toBe(2);
	await expect(service.snapshot(principal, other.projectId)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	await expect(
		service.execute(
			principal,
			command(projectId, 2, { action: "delete", taskId: randomUUID(), confirm: true }),
		),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	await service.execute(principal, command(projectId, 2, { action: "add", title: "Agent task" }));
	await service.execute(
		owner,
		command(projectId, 3, { action: "revoke_service", credentialId, confirm: true }),
	);
	await expect(service.snapshot(principal, projectId)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	await expect(
		service.execute(
			owner,
			command(projectId, 4, {
				...grant.operation,
				action: "grant_service",
				credentialId,
				tokenHash: hash(serviceToken),
				role: "editor",
				scopes: ["read"],
				confirm: true,
				expiresAt: new Date(0).toISOString(),
			}),
		),
	).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
	await expect(
		service.execute(
			owner,
			command(projectId, 4, { action: "revoke_service", credentialId: randomUUID(), confirm: true }),
		),
	).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("OIDC rejects wrong issuer, audience, expiry, signature and malformed tokens", async () => {
	expect(owner.actorId).toBe(oidcActor(issuer, "owner"));
	for (const invalid of [
		"bad",
		"sts_bad",
		await token("owner", { audience: "other" }),
		await token("owner", { issuer: "https://other.example" }),
		await token("owner", { expires: 1 }),
		`${ownerToken.slice(0, -10)}aaaaaaaaaa`,
	])
		await expect(auth(invalid)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	const { projectId } = await project();
	await expect(service.snapshot({ ...owner, expiresAt: 0 }, projectId)).rejects.toMatchObject({
		code: "UNAUTHORIZED",
	});
	expect(
		configSchema.safeParse({ host: "0.0.0.0", port: 2, publicOrigin: "http://example.com", oidc: {} })
			.success,
	).toBe(false);
	expect(canonical({ z: 1, a: [2, { b: 3 }] })).toBe(canonical({ a: [2, { b: 3 }], z: 1 }));
	expect(() => parseCommand({ version: 7 })).toThrow();
});

test("HTTP health, validation, authorization, commands, and snapshot routes", async () => {
	expect((await fetch(`${origin}/health/live`)).status).toBe(200);
	expect((await fetch(`${origin}/health/ready`)).status).toBe(200);
	expect((await fetch(`${origin}/v1/whoami`)).status).toBe(401);
	expect((await request("/v1/whoami")).status).toBe(200);
	expect((await request("/unknown")).status).toBe(404);
	expect(
		(
			await fetch(`${origin}/v1/whoami`, {
				headers: { authorization: `Bearer ${ownerToken}`, origin: "https://other.example" },
			})
		).status,
	).toBe(403);
	const projectId = randomUUID();
	const create = command(projectId, 0, { action: "create_project", title: "HTTP", confirm: true });
	expect((await request("/v1/commands", "POST", create)).status).toBe(200);
	expect((await request(`/v1/projects/${projectId}/snapshot`)).status).toBe(200);
	expect((await request(`/v1/projects/${projectId}/access`)).status).toBe(200);
	expect((await request(`/v1/projects/${projectId}/events`)).status).toBe(409);
	expect((await request(`/v1/projects/${projectId}/events?after=99999`)).status).toBe(409);
	expect((await request("/v1/commands", "POST", { ...create, version: 8 })).status).toBe(400);
	expect((await request("/v1/commands", "POST")).status).toBe(415);
	expect(
		(
			await fetch(`${origin}/v1/commands`, {
				method: "POST",
				headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
				body: "{",
			})
		).status,
	).toBe(400);
});

test("SSE replay closes after membership is revoked and reconnect resumes in order", async () => {
	const { projectId } = await project();
	await service.execute(
		owner,
		command(projectId, 1, { action: "set_member", actorId: reader.actorId, role: "reader", confirm: true }),
	);
	const response = await request(
		`/v1/projects/${projectId}/events?after=0`,
		"GET",
		undefined,
		await token("reader"),
	);
	const stream = response.body?.getReader();
	if (!stream) throw new Error("Missing event stream.");
	let text = "";
	while (!text.includes("id: 2")) text += new TextDecoder().decode((await stream.read()).value);
	expect(text.indexOf("id: 1")).toBeLessThan(text.indexOf("id: 2"));
	await service.execute(
		owner,
		command(projectId, 2, { action: "set_member", actorId: reader.actorId, role: null, confirm: true }),
	);
	while (!text.includes("event: error")) {
		const next = await stream.read();
		if (next.done) break;
		text += new TextDecoder().decode(next.value);
	}
	expect(text).toContain("FORBIDDEN");
	await stream.cancel();
	const reconnect = await fetch(`${origin}/v1/projects/${projectId}/events`, {
		headers: { authorization: `Bearer ${ownerToken}`, "last-event-id": "2" },
	});
	const resumed = reconnect.body?.getReader();
	if (!resumed) throw new Error("Missing resumed event stream.");
	const frame = new TextDecoder().decode((await resumed.read()).value);
	expect(frame).toContain("id: 3");
	expect(frame).not.toContain("id: 2");
	await resumed.cancel();
});

test("migrations fail on mismatched versions and append-only history rejects deletion", async () => {
	await expect(pool.query("DELETE FROM stepstone_events")).rejects.toThrow("append-only");
	await expect(pool.query("TRUNCATE stepstone_receipts")).rejects.toThrow("append-only");
	await expect(
		transaction(pool, async (client) => {
			await client.query("UPDATE stepstone_schema SET checksum='invalid'");
			throw new Error("rollback");
		}),
	).rejects.toThrow("rollback");
	await checkSchema(pool);
	const storage = await service.storage();
	expect(Array.isArray(storage)).toBe(true);
	await service.verify();
});

test("task references that match object property names retain valid UUID identity", async () => {
	const { projectId } = await project();
	const receipt = await service.execute(
		owner,
		command(projectId, 1, { action: "add", title: "constructor" }),
	);
	expect(receipt.taskIds[0]).toMatch(/^[0-9a-f-]{36}$/);
	const snapshot = await service.snapshot(owner, projectId);
	expect(snapshot.tasks[0]).toEqual({ reference: "constructor", taskId: receipt.taskIds[0] });
	await service.verify();
});

test("expired, altered, and read-only service credentials fail closed", async () => {
	const { projectId } = await project();
	const credentialId = randomUUID();
	const serviceToken = `sts_${credentialId}.${randomBytes(32).toString("base64url")}`;
	const principal = await auth(serviceToken);
	await service.execute(
		owner,
		command(projectId, 1, {
			action: "grant_service",
			credentialId,
			tokenHash: hash(serviceToken),
			role: "reader",
			scopes: ["read"],
			expiresAt: new Date(Date.now() + 3600000).toISOString(),
			confirm: true,
		}),
	);
	expect((await service.snapshot(principal, projectId)).revision).toBe(2);
	await expect(service.events(principal, projectId, 0)).rejects.toMatchObject({ code: "FORBIDDEN" });
	await expect(
		service.execute(principal, command(projectId, 2, { action: "add", title: "Denied" })),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	const altered = await auth(`sts_${credentialId}.${randomBytes(32).toString("base64url")}`);
	await expect(service.snapshot(altered, projectId)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	await pool.query("UPDATE stepstone_credentials SET expires_at=now()-interval '1 second' WHERE id=$1", [
		credentialId,
	]);
	await expect(service.snapshot(principal, projectId)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});

test("schema drift and newer schema versions refuse startup and migration", async () => {
	const original = (await pool.query("SELECT checksum FROM stepstone_schema WHERE version=1")).rows[0]
		.checksum;
	await pool.query("UPDATE stepstone_schema SET checksum='changed'");
	try {
		await expect(checkSchema(pool)).rejects.toMatchObject({ code: "SCHEMA_MISMATCH" });
		await expect(migrate(pool)).rejects.toThrow("history does not match");
		expect((await fetch(`${origin}/health/ready`)).status).toBe(503);
	} finally {
		await pool.query("UPDATE stepstone_schema SET checksum=$1 WHERE version=1", [original]);
	}
	await pool.query("INSERT INTO stepstone_schema VALUES(2,'future')");
	try {
		await expect(migrate(pool)).rejects.toThrow("newer than this server");
	} finally {
		await pool.query("DELETE FROM stepstone_schema WHERE version=2");
	}
});

test("verification detects damaged projections and missing task identities", async () => {
	const { projectId } = await project();
	await service.execute(owner, command(projectId, 1, { action: "add", title: "Verify me" }));
	const original = (
		await pool.query("SELECT state, projection FROM stepstone_projects WHERE id=$1", [projectId])
	).rows[0];
	await pool.query("UPDATE stepstone_projects SET projection='{}'::jsonb WHERE id=$1", [projectId]);
	try {
		await expect(service.verify()).rejects.toThrow("projection is inconsistent");
	} finally {
		await pool.query("UPDATE stepstone_projects SET projection=$2 WHERE id=$1", [
			projectId,
			original.projection,
		]);
	}
	await pool.query(
		"UPDATE stepstone_projects SET state=jsonb_set(state,'{identities}','{}'), projection=jsonb_set(projection,'{tasks}', '[{\"reference\":\"verify-me\"}]') WHERE id=$1",
		[projectId],
	);
	try {
		await expect(service.verify()).rejects.toThrow();
	} finally {
		await pool.query("UPDATE stepstone_projects SET state=$2,projection=$3 WHERE id=$1", [
			projectId,
			original.state,
			original.projection,
		]);
	}
	await service.verify();
});

test("legacy identity migration preserves former references, dependency edges, and retired IDs", async () => {
	const { projectId } = await project();
	const first = (await service.execute(owner, command(projectId, 1, { action: "add", title: "Legacy task" })))
		.taskIds[0];
	await service.execute(
		owner,
		command(projectId, 2, { action: "add", title: "Dependent", dependsOn: ["legacy-task"] }),
	);
	// Model a stored identity from an older deployment. This is not a file import interface.
	const row = (await pool.query("SELECT state FROM stepstone_projects WHERE id=$1", [projectId])).rows[0];
	const legacyId = "goal-mse1rzxb-8213cc2a";
	row.state.worklist.goals[0].id = legacyId;
	row.state.worklist.goals[1].dependsOn = [legacyId];
	row.state.worklist.retiredIds = ["retired-reference"];
	row.state.identities[legacyId] = first;
	delete row.state.identities["legacy-task"];
	await pool.query("UPDATE stepstone_projects SET state=$2 WHERE id=$1", [projectId, row.state]);
	await service.execute(owner, command(projectId, 3, { action: "migrate_ids", confirm: true }));
	const snapshot = await service.snapshot(owner, projectId);
	expect(snapshot.tasks.find((task) => task.taskId === first)?.reference).toBe("legacy-task");
	expect(snapshot.worklist.goals[0].previousIds).toContain(legacyId);
	expect(snapshot.worklist.goals[1].dependsOn).toEqual(["legacy-task"]);
	expect(snapshot.worklist.retiredIds).toContain("retired-reference");
	await service.execute(
		owner,
		command(projectId, 4, { action: "update", taskId: first, description: "Same task" }),
	);
	await service.verify();
});

test("credential identity cannot be reused after revocation", async () => {
	const { projectId } = await project();
	const operation: Command["operation"] = {
		action: "grant_service",
		credentialId: randomUUID(),
		tokenHash: hash("test only"),
		role: "reader",
		scopes: ["read"],
		expiresAt: new Date(Date.now() + 3600000).toISOString(),
		confirm: true,
	};
	await service.execute(owner, command(projectId, 1, operation));
	await service.execute(
		owner,
		command(projectId, 2, { action: "revoke_service", credentialId: operation.credentialId, confirm: true }),
	);
	await expect(service.execute(owner, command(projectId, 3, operation))).rejects.toMatchObject({
		code: "CREDENTIAL_EXISTS",
	});
	expect((await service.snapshot(owner, projectId)).revision).toBe(3);
});

const importedStamp = "2026-01-02T03:04:05.000Z";
function importedWorklist() {
	return {
		version: 2,
		revision: 4,
		project: {
			id: "release-preparation",
			title: "Release preparation",
			repositories: ["https://github.com/example/client"],
			createdAt: importedStamp,
			updatedAt: importedStamp,
		},
		milestones: [
			{
				id: "documentation-is-ready",
				title: "Documentation is ready",
				createdAt: importedStamp,
				updatedAt: importedStamp,
			},
		],
		goals: [
			{
				id: "review-the-guide",
				previousIds: ["goal-old-review"],
				title: "Review the guide",
				description: "Keep the historical note",
				status: "done",
				createdAt: importedStamp,
				updatedAt: importedStamp,
				completedAt: importedStamp,
				group: "Docs",
				branch: "docs/review",
				links: ["https://github.com/example/client/pull/1"],
				milestoneId: "documentation-is-ready",
				dependsOn: ["ship-the-draft"],
				externalRef: "issue-9",
			},
			{
				id: "ship-the-draft",
				title: "Ship the draft",
				status: "open",
				createdAt: importedStamp,
				updatedAt: importedStamp,
			},
		],
		retiredIds: ["removed-task"],
	};
}

test("imports file history once and leaves the source file untouched", async () => {
	const projectId = randomUUID();
	const directory = await mkdtemp(join(tmpdir(), "stepstone-import-"));
	const path = join(directory, "worklist.json");
	await writeFile(path, `${JSON.stringify(importedWorklist())}\n`);
	const before = await readFile(path);
	try {
		const imported = await service.importWorklist({
			projectId,
			actorId: owner.actorId,
			worklist: await loadImportWorklist(path),
			replace: false,
			dryRun: false,
		});
		expect(imported).toMatchObject({
			revision: 1,
			changed: true,
			resolution: "initial",
			fileRevision: 4,
			taskCount: 2,
			dryRun: false,
		});
		expect(await readFile(path)).toEqual(before);
		const snapshot = await service.snapshot(owner, projectId);
		expect(snapshot.worklist.goals[0]).toMatchObject({
			id: "review-the-guide",
			previousIds: ["goal-old-review"],
			branch: "docs/review",
			links: ["https://github.com/example/client/pull/1"],
			dependsOn: ["ship-the-draft"],
			completedAt: importedStamp,
			milestoneId: "documentation-is-ready",
		});
		expect((snapshot.worklist.goals[0] as { externalRef?: string }).externalRef).toBe("issue-9");
		expect(snapshot.worklist.retiredIds).toEqual(["removed-task"]);
		expect(snapshot.worklist.project?.repositories).toEqual(["https://github.com/example/client"]);
		expect(snapshot.tasks.map((task) => task.reference)).toEqual(["review-the-guide", "ship-the-draft"]);
		const stored = (await pool.query("SELECT state FROM stepstone_projects WHERE id=$1", [projectId])).rows[0]
			.state;
		expect(stored.importSource).toEqual({ fingerprint: imported.fingerprint, fileRevision: 4 });
		const again = await service.importWorklist({
			projectId,
			actorId: owner.actorId,
			worklist: importedWorklist(),
			replace: true,
			dryRun: false,
		});
		expect(again).toMatchObject({ changed: false, resolution: "unchanged", revision: 1 });
		expect(
			Number(
				(await pool.query("SELECT count(*) FROM stepstone_events WHERE project_id=$1", [projectId])).rows[0]
					.count,
			),
		).toBe(1);
		expect((await service.exportWorklist(projectId)).goals.map((goal) => goal.id)).toEqual([
			"review-the-guide",
			"ship-the-draft",
		]);
		await service.verify();
	} finally {
		await rm(directory, { recursive: true });
	}
});

test("refuses a divergent file until replace explicitly adopts it", async () => {
	const projectId = randomUUID();
	const worklist = importedWorklist();
	await service.importWorklist({
		projectId,
		actorId: owner.actorId,
		worklist,
		replace: false,
		dryRun: false,
	});
	await service.execute(owner, command(projectId, 1, { action: "add", title: "Server only task" }));
	const before = await service.snapshot(owner, projectId);
	await expect(
		service.importWorklist({
			projectId,
			actorId: owner.actorId,
			worklist,
			replace: false,
			dryRun: true,
		}),
	).rejects.toMatchObject({ code: "DIVERGENT_HISTORY", status: 409 });
	expect((await service.snapshot(owner, projectId)).revision).toBe(before.revision);
	const preview = await service.importWorklist({
		projectId,
		actorId: owner.actorId,
		worklist,
		replace: true,
		dryRun: true,
	});
	expect(preview).toMatchObject({
		dryRun: true,
		resolution: "replace-with-file",
		changed: true,
		revision: before.revision + 1,
	});
	expect((await service.snapshot(owner, projectId)).revision).toBe(before.revision);
	const replaced = await service.importWorklist({
		projectId,
		actorId: owner.actorId,
		worklist: {
			...worklist,
			goals: [
				{
					...worklist.goals[0],
					id: "review-the-manual",
					previousIds: ["review-the-guide", "goal-old-review"],
					dependsOn: [],
				},
				{
					id: "publish-notes",
					title: "Publish notes",
					status: "open",
					createdAt: importedStamp,
					updatedAt: importedStamp,
				},
			],
		},
		replace: true,
		dryRun: false,
	});
	expect(replaced).toMatchObject({ resolution: "replace-with-file", changed: true });
	const snapshot = await service.snapshot(owner, projectId);
	const original = before.tasks.find((task) => task.reference === "review-the-guide");
	const dropped = before.tasks.find((task) => task.reference === "ship-the-draft");
	const serverOnly = before.tasks.find((task) => task.reference === "server-only-task");
	expect(snapshot.tasks.find((task) => task.reference === "review-the-manual")?.taskId).toBe(
		original?.taskId,
	);
	expect(snapshot.tasks.map((task) => task.reference)).toEqual(["review-the-manual", "publish-notes"]);
	const identities = (await pool.query("SELECT state FROM stepstone_projects WHERE id=$1", [projectId]))
		.rows[0].state.identities;
	expect(identities["review-the-guide"]).toBe(original?.taskId);
	expect(identities["ship-the-draft"]).toBe(dropped?.taskId);
	expect(identities["server-only-task"]).toBe(serverOnly?.taskId);
	expect(identities["publish-notes"]).not.toBe(serverOnly?.taskId);
	await expect(
		service.importWorklist({
			projectId,
			actorId: reader.actorId,
			worklist,
			replace: true,
			dryRun: false,
		}),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	expect((await service.snapshot(owner, projectId)).revision).toBe(replaced.revision);
	await service.verify();
});

test("previews a new import without creating a project and rejects invalid targets", async () => {
	const projectId = randomUUID();
	const preview = await service.importWorklist({
		projectId,
		actorId: owner.actorId,
		worklist: importedWorklist(),
		replace: false,
		dryRun: true,
	});
	expect(preview).toMatchObject({ resolution: "initial", revision: 1, changed: true, dryRun: true });
	await expect(service.snapshot(owner, projectId)).rejects.toMatchObject({ code: "NOT_FOUND" });
	const { projectId: existing } = await project();
	await expect(
		service.importWorklist({
			projectId: existing,
			actorId: owner.actorId,
			worklist: importedWorklist(),
			replace: false,
			dryRun: false,
		}),
	).rejects.toMatchObject({ code: "DIVERGENT_HISTORY" });
	expect((await service.snapshot(owner, existing)).worklist.project?.title).toBe("Service test");
	await expect(
		service.importWorklist({
			projectId: "not-a-uuid",
			actorId: owner.actorId,
			worklist: importedWorklist(),
			replace: false,
			dryRun: false,
		}),
	).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
	await expect(
		service.importWorklist({
			projectId,
			actorId: "not-an-actor",
			worklist: importedWorklist(),
			replace: false,
			dryRun: false,
		}),
	).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
	await expect(service.exportWorklist(randomUUID())).rejects.toMatchObject({ code: "NOT_FOUND" });
	await expect(service.exportWorklist("not-a-uuid")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
});

test("reuses a task identity when the file adopts a former goal ID", async () => {
	const projectId = randomUUID();
	const worklist = importedWorklist();
	await service.importWorklist({
		projectId,
		actorId: owner.actorId,
		worklist,
		replace: false,
		dryRun: false,
	});
	const before = await service.snapshot(owner, projectId);
	const adopted = await service.importWorklist({
		projectId,
		actorId: owner.actorId,
		worklist: {
			...worklist,
			goals: [
				{ ...worklist.goals[0], id: "goal-old-review", previousIds: ["review-the-guide"] },
				worklist.goals[1],
			],
		},
		replace: true,
		dryRun: false,
	});
	expect(adopted.resolution).toBe("replace-with-file");
	const snapshot = await service.snapshot(owner, projectId);
	expect(snapshot.tasks.find((task) => task.reference === "goal-old-review")?.taskId).toBe(
		before.tasks.find((task) => task.reference === "review-the-guide")?.taskId,
	);
	expect(snapshot.tasks.find((task) => task.reference === "ship-the-draft")?.taskId).toBe(
		before.tasks.find((task) => task.reference === "ship-the-draft")?.taskId,
	);
	await service.verify();
});

test("refuses to replace a project whose revision cannot advance", async () => {
	const projectId = randomUUID();
	await service.importWorklist({
		projectId,
		actorId: owner.actorId,
		worklist: importedWorklist(),
		replace: false,
		dryRun: false,
	});
	const row = (
		await pool.query("SELECT revision, state, projection FROM stepstone_projects WHERE id=$1", [projectId])
	).rows[0];
	const state = structuredClone(row.state);
	state.worklist.revision = Number.MAX_SAFE_INTEGER;
	await pool.query("UPDATE stepstone_projects SET revision=$2, state=$3 WHERE id=$1", [
		projectId,
		Number.MAX_SAFE_INTEGER,
		state,
	]);
	const changed = importedWorklist();
	changed.goals[1].title = "Needs a new revision";
	try {
		await expect(
			service.importWorklist({
				projectId,
				actorId: owner.actorId,
				worklist: changed,
				replace: true,
				dryRun: true,
			}),
		).rejects.toMatchObject({ code: "REVISION_EXHAUSTED" });
	} finally {
		await pool.query("UPDATE stepstone_projects SET revision=$2, state=$3, projection=$4 WHERE id=$1", [
			projectId,
			row.revision,
			row.state,
			row.projection,
		]);
	}
});

test("refuses an import that would alias two goals to one task identity", async () => {
	const projectId = randomUUID();
	await service.importWorklist({
		projectId,
		actorId: owner.actorId,
		worklist: importedWorklist(),
		replace: false,
		dryRun: false,
	});
	const row = (await pool.query("SELECT state FROM stepstone_projects WHERE id=$1", [projectId])).rows[0];
	const original = structuredClone(row.state);
	row.state.identities["ship-the-draft"] = row.state.identities["review-the-guide"];
	await pool.query("UPDATE stepstone_projects SET state=$2 WHERE id=$1", [projectId, row.state]);
	const changed = importedWorklist();
	changed.goals[1].title = "Ship a different draft";
	try {
		await expect(
			service.importWorklist({
				projectId,
				actorId: owner.actorId,
				worklist: changed,
				replace: true,
				dryRun: false,
			}),
		).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
		expect(
			Number(
				(await pool.query("SELECT revision FROM stepstone_projects WHERE id=$1", [projectId])).rows[0]
					.revision,
			),
		).toBe(1);
	} finally {
		await pool.query("UPDATE stepstone_projects SET state=$2 WHERE id=$1", [projectId, original]);
	}
});
