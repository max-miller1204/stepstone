import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { SERVER_ORIGIN_ENV, SERVER_PROJECT_ENV, SERVER_TOKEN_ENV } from "../../src/cli-contract.ts";
import {
	resolveServerProject,
	ServerProjectClient,
	ServerProjectError,
	sameProjectDomain,
} from "../../src/service/project-client.ts";
import { parseCommand } from "../../src/service/protocol.ts";
import type { RevisionedProjectWorklist } from "../../src/types.ts";

const projectId = "11111111-1111-4111-8111-111111111111";

function worklist(revision: number): RevisionedProjectWorklist {
	return {
		version: 1,
		revision,
		goals: [
			{
				id: "ship-it",
				title: "Ship it",
				status: "open",
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
			},
		],
	};
}

describe("server project configuration", () => {
	it("keeps the goal file when no server variable is set", () => {
		expect(resolveServerProject({})).toEqual({ mode: "file" });
	});

	it("refuses a partial set instead of using the goal file", () => {
		const resolution = resolveServerProject({ [SERVER_ORIGIN_ENV]: "http://127.0.0.1:9" });
		expect(resolution.mode).toBe("invalid");
		if (resolution.mode === "invalid") expect(resolution.message).toContain("does not fall back");
	});

	it("refuses credentials, paths, and non-HTTP origins", () => {
		for (const origin of [
			"http://user:pass@127.0.0.1:9",
			"http://127.0.0.1:9/stepstone",
			"ftp://127.0.0.1",
		]) {
			const resolution = resolveServerProject({
				[SERVER_ORIGIN_ENV]: origin,
				[SERVER_TOKEN_ENV]: "token",
				[SERVER_PROJECT_ENV]: projectId,
			});
			expect(resolution.mode).toBe("invalid");
		}
	});

	it("requires a project UUID", () => {
		const resolution = resolveServerProject({
			[SERVER_ORIGIN_ENV]: "http://127.0.0.1:9",
			[SERVER_TOKEN_ENV]: "token",
			[SERVER_PROJECT_ENV]: "roadmap",
		});
		expect(resolution.mode).toBe("invalid");
	});

	it("accepts an origin and ignores the worklist revision when comparing content", () => {
		const resolution = resolveServerProject({
			[SERVER_ORIGIN_ENV]: "http://127.0.0.1:9/",
			[SERVER_TOKEN_ENV]: "token",
			[SERVER_PROJECT_ENV]: projectId,
		});
		expect(resolution).toMatchObject({ mode: "server", config: { origin: "http://127.0.0.1:9", projectId } });
		expect(sameProjectDomain(worklist(1), worklist(2))).toBe(true);
		expect(sameProjectDomain(worklist(1), { ...worklist(1), goals: [] })).toBe(false);
	});
});

describe("server project client", () => {
	const servers: { close: () => Promise<void> }[] = [];

	afterEach(async () => {
		await Promise.all(servers.splice(0).map((server) => server.close()));
	});

	async function listen(
		handler: (
			request: import("node:http").IncomingMessage,
			body: unknown,
		) => {
			status: number;
			payload: unknown;
		},
	): Promise<{ url: string; close: () => Promise<void> }> {
		const server = createServer(async (request, response) => {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			const raw = Buffer.concat(chunks).toString("utf8");
			let body: unknown;
			if (raw) body = JSON.parse(raw);
			const result = handler(request, body);
			response.writeHead(result.status, { "content-type": "application/json" });
			response.end(JSON.stringify(result.payload));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
		const address = server.address() as AddressInfo;
		const handle = {
			url: `http://127.0.0.1:${address.port}`,
			close: () =>
				new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
		};
		servers.push(handle);
		return handle;
	}

	it("reads a snapshot and posts a command", async () => {
		const posted: unknown[] = [];
		const http = await listen((request, body) => {
			expect(request.headers.authorization).toBe("Bearer token");
			if (request.method === "GET") {
				return {
					status: 200,
					payload: {
						version: 1,
						projectId,
						revision: 3,
						cursor: 3,
						worklist: worklist(3),
						tasks: [{ taskId: randomUUID(), reference: "ship-it" }],
					},
				};
			}
			posted.push(body);
			return {
				status: 200,
				payload: {
					version: 1,
					projectId,
					commandId: randomUUID(),
					actorId: "oidc:abc",
					revision: 4,
					cursor: 4,
					action: "update",
					taskIds: [],
				},
			};
		});
		const client = new ServerProjectClient({ origin: http.url, token: "token", projectId });
		await expect(client.snapshot()).resolves.toMatchObject({ revision: 3, projectId });
		const taskId = randomUUID();
		const receipt = await client.command(
			{ action: "update", taskId, title: "Ship it", expectedUpdatedAt: "2026-01-01T00:00:00.000Z" },
			3,
		);
		expect(receipt.revision).toBe(4);
		expect(parseCommand(posted[0]).operation).toMatchObject({
			expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
		});
	});

	it("maps a revision conflict and rejects an unreadable error", async () => {
		const http = await listen((request) => {
			if (request.url?.endsWith("/snapshot")) {
				return { status: 200, payload: { nope: true } };
			}
			return {
				status: 409,
				payload: { error: { code: "REVISION_CONFLICT", message: "Current project revision is 8." } },
			};
		});
		const client = new ServerProjectClient({ origin: http.url, token: "token", projectId });
		await expect(client.snapshot()).rejects.toMatchObject({ code: "UNAVAILABLE" });
		await expect(client.command({ action: "migrate_ids", confirm: true }, 1)).rejects.toMatchObject({
			code: "REVISION_CONFLICT",
			status: 409,
		});
	});

	it("reports a closed port as unavailable", async () => {
		const client = new ServerProjectClient({ origin: "http://127.0.0.1:1", token: "token", projectId });
		await expect(client.snapshot()).rejects.toBeInstanceOf(ServerProjectError);
		await expect(client.snapshot()).rejects.toThrow(/unavailable/);
	});
});
