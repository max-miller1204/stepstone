import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createContext, runInContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CollaborationClient, CollaborationRequestError } from "../src/collaboration-client.ts";
import { COLLABORATION_PAGE } from "../src/collaboration-page.ts";
import type { CollaborationCommand, CollaborationSnapshot } from "../src/collaboration-protocol.ts";
import { CollaborationService } from "../src/collaboration-protocol.ts";
import { startCollaborationServer } from "../src/collaboration-server.ts";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const servers: Awaited<ReturnType<typeof startCollaborationServer>>[] = [];
const owner = { id: "test-owner", role: "owner" as const };
const credentials = [
	{ token: "owner-token", actor: owner },
	{ token: "reader-token", actor: { id: "test-reader", role: "reader" as const } },
];
const script = resolve("scripts/collaboration-proof.ts");

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "stepstone-collaboration-http-"));
	roots.push(root);
	const store = join(root, "worklist.json");
	const service = new CollaborationService({ resolvePath: () => store });
	const snapshot = await service.initialize(owner, { title: "Protocol proof", confirm: true });
	const server = await startCollaborationServer({ store, host: "127.0.0.1", port: 0, credentials });
	servers.push(server);
	const client = new CollaborationClient(server.url, "owner-token");
	return { root, store, snapshot, server, client };
}

function add(snapshot: CollaborationSnapshot, title = "Shared task"): CollaborationCommand {
	return {
		version: 1,
		commandId: randomUUID(),
		projectId: snapshot.projectId,
		expectedRevision: snapshot.revision,
		action: "add",
		title,
	};
}

function post(url: string, command: unknown, headers: Record<string, string> = {}) {
	return fetch(`${url}/api/commands`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: "Bearer owner-token",
			...headers,
		},
		body: JSON.stringify(command),
	});
}

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.close()));
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("collaboration HTTP protocol", () => {
	it("serves the browser and common client without embedding credentials", async () => {
		const { server } = await fixture();
		const page = await fetch(server.url);
		expect(page.status).toBe(200);
		const html = await page.text();
		expect(html).toContain("/client.js");
		expect(html).not.toContain("owner-token");
		expect((await fetch(`${server.url}/favicon.ico`)).status).toBe(204);
		const module = await fetch(`${server.url}/client.js`);
		expect(module.headers.get("content-type")).toContain("javascript");
		expect(await module.text()).toContain("export class CollaborationClient");
	});

	it("authenticates reads and forbids reader writes without changing state", async () => {
		const { server, snapshot, client } = await fixture();
		expect((await fetch(`${server.url}/api/snapshot`)).status).toBe(401);
		await expect(new CollaborationClient(server.url, "wrong-token").snapshot()).rejects.toThrow("401");
		const reader = new CollaborationClient(server.url, "reader-token");
		expect(await reader.snapshot()).toEqual(snapshot);
		await expect(reader.command(add(snapshot))).rejects.toThrow("403");
		expect(await client.snapshot()).toEqual(snapshot);
	});

	it("rejects foreign origins, unknown versions, actor spoofing, and invalid event cursors", async () => {
		const { server, snapshot, client } = await fixture();
		expect((await post(server.url, add(snapshot), { origin: "https://foreign.example" })).status).toBe(403);
		const version = await post(server.url, { ...add(snapshot), version: 2 });
		expect(version.status).toBe(400);
		expect(await version.json()).toMatchObject({ code: "VALIDATION_FAILED" });
		expect((await post(server.url, { ...add(snapshot), actorId: "another-owner" })).status).toBe(400);
		const headers = { authorization: "Bearer owner-token" };
		expect((await fetch(`${server.url}/api/events?after=-1`, { headers })).status).toBe(400);
		const ahead = await fetch(`${server.url}/api/events?after=1`, { headers });
		expect(ahead.status).toBe(409);
		expect(await ahead.json()).toMatchObject({ code: "SNAPSHOT_REQUIRED" });
		expect(await client.snapshot()).toEqual(snapshot);
	});

	it("uses the same authoritative server for a separate CLI process and HTTP client", async () => {
		const { root, server, snapshot, client } = await fixture();
		const env = { ...process.env, STEPSTONE_SERVER: server.url, STEPSTONE_TOKEN: "owner-token" };
		const command = add(snapshot, "Created by CLI");
		const commandFile = join(root, "command.json");
		await writeFile(commandFile, JSON.stringify(command));
		const result = await execFileAsync(process.execPath, [script, "command", commandFile], {
			env,
			cwd: root,
		});
		const receipt = JSON.parse(result.stdout);
		expect(receipt.commandId).toBe(command.commandId);
		const current = await client.snapshot();
		expect(current.tasks).toHaveLength(1);
		expect(current.tasks[0]).toMatchObject({ taskId: receipt.taskId, goal: { title: "Created by CLI" } });
		const cliSnapshot = await execFileAsync(process.execPath, [script, "snapshot"], { env, cwd: root });
		expect(JSON.parse(cliSnapshot.stdout)).toEqual(current);
		await expect(client.command(add(snapshot, "Stale browser write"))).rejects.toThrow("REVISION_CONFLICT");
		expect(await client.snapshot()).toEqual(current);
	});

	it("resumes missed events in order and delivers later commands on the live stream", async () => {
		const { client, snapshot } = await fixture();
		const first = await client.command(add(snapshot, "First"));
		const abort = new AbortController();
		const stream = client.events(snapshot.cursor, abort.signal);
		const initial = await stream.next();
		expect(initial.value).toMatchObject({
			cursor: first.cursor,
			commandId: first.commandId,
			actorId: owner.id,
		});
		abort.abort();
		await expect(stream.return(undefined)).rejects.toMatchObject({ name: "AbortError" });
		const second = await client.command(add(await client.snapshot(), "Second"));
		const third = await client.command(add(await client.snapshot(), "Third"));
		const resumedAbort = new AbortController();
		const resumed = client.events(first.cursor, resumedAbort.signal);
		try {
			expect((await resumed.next()).value).toMatchObject({
				cursor: second.cursor,
				commandId: second.commandId,
			});
			expect((await resumed.next()).value).toMatchObject({
				cursor: third.cursor,
				commandId: third.commandId,
			});
			const pending = resumed.next();
			const fourth = await client.command(add(await client.snapshot(), "Fourth"));
			expect((await pending).value).toMatchObject({ cursor: fourth.cursor, commandId: fourth.commandId });
		} finally {
			resumedAbort.abort();
			await expect(resumed.return(undefined)).rejects.toMatchObject({ name: "AbortError" });
		}
	});

	it("replays events larger than the socket buffer without dropping a fast reader", async () => {
		const { client, snapshot, store } = await fixture();
		const service = new CollaborationService({ resolvePath: () => store });
		// Large valid actor IDs force normal response backpressure with a small fixture.
		const actor = { id: `actor-${"x".repeat(128 * 1024)}`, role: "owner" as const };
		const first = await service.execute(actor, add(snapshot, "Large event"));
		const second = await service.execute(owner, add(await service.snapshot(owner), "Later event"));
		const stream = client.events(0, AbortSignal.timeout(5000));
		try {
			expect((await stream.next()).value).toMatchObject({ cursor: first.cursor, actorId: actor.id });
			expect((await stream.next()).value).toMatchObject({
				cursor: second.cursor,
				commandId: second.commandId,
			});
		} finally {
			await stream.return(undefined);
		}
	});

	it("persists receipts and identity across server restart", async () => {
		const { client, snapshot, server, store } = await fixture();
		const command = add(snapshot);
		const receipt = await client.command(command);
		const current = await client.snapshot();
		await server.close();
		servers.splice(servers.indexOf(server), 1);
		const restarted = await startCollaborationServer({ store, host: "127.0.0.1", port: 0, credentials });
		servers.push(restarted);
		const restored = new CollaborationClient(restarted.url, "owner-token");
		expect(await restored.snapshot()).toEqual(current);
		expect(await restored.command(command)).toEqual(receipt);
		expect(await restored.snapshot()).toEqual(current);
	});

	it("fails visibly in the client and CLI when the configured server is unavailable", async () => {
		const { root, server, client } = await fixture();
		await server.close();
		servers.splice(servers.indexOf(server), 1);
		await expect(client.snapshot()).rejects.toThrow("Configured collaboration server is unavailable");
		await expect(
			execFileAsync(process.execPath, [script, "snapshot"], {
				cwd: root,
				env: { ...process.env, STEPSTONE_SERVER: server.url, STEPSTONE_TOKEN: "owner-token" },
			}),
		).rejects.toMatchObject({
			code: 1,
			stderr: expect.stringContaining("Configured collaboration server is unavailable"),
		});
	});
});

function browserHarness(
	initial: CollaborationSnapshot,
	transport: Pick<CollaborationClient, "snapshot" | "command">,
) {
	const elements = new Map<
		string,
		{
			textContent: string;
			value: string;
			disabled: boolean;
			hidden: boolean;
			append(...children: unknown[]): void;
			replaceChildren(): void;
		}
	>();
	const element = () => ({
		textContent: "",
		value: "",
		disabled: false,
		hidden: false,
		append(..._children: unknown[]) {},
		replaceChildren() {},
	});
	const get = (id: string) => {
		const existing = elements.get(id);
		if (existing) return existing;
		const created = element();
		elements.set(id, created);
		return created;
	};
	const context = createContext({
		initial,
		transport,
		CollaborationClient,
		CollaborationRequestError,
		crypto: { randomUUID },
		document: {
			getElementById: get,
			createElement: element,
			querySelectorAll: () => [get("task-title"), get("add-button")],
		},
	});
	const script = COLLABORATION_PAGE.split('<script type="module">')[1]
		.split("</script>")[0]
		.replace(/^import .*;$/m, "");
	runInContext(script, context);
	runInContext("snapshot = initial; client = transport; render();", context);
	return { get, run: (code: string) => runInContext(code, context) };
}

describe("browser command recovery", () => {
	it("retries the original command after a lost response and an SSE snapshot refresh", async () => {
		const { client, snapshot } = await fixture();
		const commands: CollaborationCommand[] = [];
		let loseResponse = true;
		const browser = browserHarness(snapshot, {
			snapshot: () => client.snapshot(),
			command: async (command) => {
				commands.push(structuredClone(command));
				if (commands.length === 2)
					throw new CollaborationRequestError(403, "Credential no longer permits writes");
				const receipt = await client.command(command);
				if (loseResponse) {
					loseResponse = false;
					throw new Error("Response lost after commit");
				}
				return receipt;
			},
		});
		browser.get("task-title").value = "Only once";
		await expect(browser.run("send({action:'add',title:'Only once'})")).rejects.toThrow("Response lost");
		expect(browser.get("retry").disabled).toBe(false);
		expect(browser.get("pending").hidden).toBe(false);
		expect(browser.get("task-title").disabled).toBe(true);
		await browser.run("refresh()");
		await expect(browser.run("send({action:'add',title:'Another change'})")).rejects.toThrow(
			"pending change",
		);
		await expect(browser.run("submitPending()")).rejects.toThrow("403");
		expect(browser.get("pending").hidden).toBe(false);
		await browser.run("submitPending()");
		expect(commands).toHaveLength(3);
		expect(commands[1]).toEqual(commands[0]);
		expect(commands[2]).toEqual(commands[0]);
		const current = await client.snapshot();
		expect(current.tasks).toHaveLength(1);
		expect(current.cursor).toBe(1);
		expect(browser.get("task-title").value).toBe("");
		expect(browser.get("task-title").disabled).toBe(false);
		expect(browser.get("pending").hidden).toBe(true);
	});

	it("releases an uncertain command when retry proves it never committed", async () => {
		const { client, snapshot } = await fixture();
		const commands: CollaborationCommand[] = [];
		let dropRequest = true;
		const browser = browserHarness(snapshot, {
			snapshot: () => client.snapshot(),
			command: (command) => {
				commands.push(structuredClone(command));
				if (dropRequest) {
					dropRequest = false;
					return Promise.reject(new Error("Connection failed before sending"));
				}
				return client.command(command);
			},
		});
		browser.get("task-title").value = "My task";
		await expect(browser.run("send({action:'add',title:'My task'})")).rejects.toThrow("before sending");
		await client.command(add(snapshot, "Other client"));
		await browser.run("refresh()");
		await expect(browser.run("submitPending()")).rejects.toMatchObject({
			status: 409,
			code: "REVISION_CONFLICT",
		});
		expect(commands[1]).toEqual(commands[0]);
		expect(browser.get("pending").hidden).toBe(true);
		expect(browser.get("task-title").disabled).toBe(false);
		expect(browser.get("task-title").value).toBe("My task");
		await browser.run("send({action:'add',title:'My task'})");
		expect(commands[2].commandId).not.toBe(commands[0].commandId);
		expect((await client.snapshot()).tasks.map((task) => task.goal.title)).toEqual([
			"Other client",
			"My task",
		]);
	});

	it("releases a rejected command and clears an acknowledged add before a failed refresh", async () => {
		const { client, snapshot } = await fixture();
		await client.command(add(snapshot, "Concurrent task"));
		let failRefresh = false;
		const browser = browserHarness(snapshot, {
			command: (command) => client.command(command),
			snapshot: () => (failRefresh ? Promise.reject(new Error("Snapshot unavailable")) : client.snapshot()),
		});
		browser.get("task-title").value = "New task";
		await expect(browser.run("send({action:'add',title:'New task'})")).rejects.toThrow("REVISION_CONFLICT");
		expect(browser.get("pending").hidden).toBe(true);
		expect(browser.get("task-title").disabled).toBe(false);
		await browser.run("refresh()");
		failRefresh = true;
		await expect(browser.run("send({action:'add',title:'New task'})")).rejects.toThrow(
			"Snapshot unavailable",
		);
		expect(browser.get("task-title").value).toBe("");
		expect(browser.get("pending").hidden).toBe(true);
		expect((await client.snapshot()).tasks).toHaveLength(2);
	});
});

describe("invalid server error responses", () => {
	it.each(["null", "[]", '{"code":17}', "not JSON"])(
		"fails loudly for %s instead of classifying it as a command refusal",
		async (body) => {
			const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { status: 409 }));
			try {
				const client = new CollaborationClient("https://review.example", "token");
				await expect(client.snapshot()).rejects.toThrow();
				await expect(client.snapshot()).rejects.not.toBeInstanceOf(CollaborationRequestError);
			} finally {
				fetchMock.mockRestore();
			}
		},
	);
});
