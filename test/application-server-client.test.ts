import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { WorklistApplicationService } from "../src/application-service.ts";
import { resolveServerProject } from "../src/service/project-client.ts";
import { parseCommand } from "../src/service/protocol.ts";
import { runGoalBoard } from "../src/tui/goal-board-runtime.ts";
import type { ProjectGoal, RevisionedProjectWorklist } from "../src/types.ts";
import { startStepstoneWebApp } from "../src/web-app.ts";

const execFileAsync = promisify(execFile);
const cliPath = resolve("src/cli.ts");
const projectId = "11111111-1111-4111-8111-111111111111";

function goal(id: string, title: string, extra: Partial<ProjectGoal> = {}): ProjectGoal {
	return {
		id,
		title,
		status: "open",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...extra,
	};
}

function worklist(goals: ProjectGoal[], revision = 1): RevisionedProjectWorklist {
	return { version: 1, revision, goals, retiredIds: [] };
}

class MockProjectServer {
	worklist: RevisionedProjectWorklist;
	readonly identities: Record<string, string> = {};
	readonly requests: { method: string; body?: unknown }[] = [];
	readonly projectId = projectId;
	readonly token = "test-token";
	url = "";
	failNext: { status: number; code: string; message: string } | undefined;
	omitTasks = false;
	private server: ReturnType<typeof createServer> | undefined;

	constructor(goals: ProjectGoal[]) {
		this.worklist = worklist(goals);
		this.assignIdentities();
	}

	env(): NodeJS.ProcessEnv {
		return {
			STEPSTONE_SERVER: this.url,
			STEPSTONE_TOKEN: this.token,
			STEPSTONE_PROJECT: this.projectId,
		};
	}

	private assignIdentities(): void {
		for (const item of this.worklist.goals) {
			if (!this.identities[item.id]) this.identities[item.id] = randomUUID();
		}
	}

	async start(): Promise<void> {
		this.server = createServer(async (request, response) => {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			const raw = Buffer.concat(chunks).toString("utf8");
			const body = raw ? (JSON.parse(raw) as unknown) : undefined;
			this.requests.push({ method: request.method ?? "", body });
			const result = await this.handle(request, body);
			response.writeHead(result.status, { "content-type": "application/json" });
			response.end(JSON.stringify(result.payload));
		});
		await new Promise<void>((resolveListen, reject) => {
			this.server?.once("error", reject);
			this.server?.listen(0, "127.0.0.1", () => resolveListen());
		});
		const address = this.server.address() as AddressInfo;
		this.url = `http://127.0.0.1:${address.port}`;
	}

	async close(): Promise<void> {
		if (!this.server) return;
		await new Promise<void>((resolveClose, reject) =>
			this.server?.close((error) => (error ? reject(error) : resolveClose())),
		);
	}

	private async handle(
		request: IncomingMessage,
		body: unknown,
	): Promise<{ status: number; payload: unknown }> {
		if (request.headers.authorization !== `Bearer ${this.token}`) {
			return {
				status: 401,
				payload: { error: { code: "UNAUTHORIZED", message: "A bearer credential is required." } },
			};
		}
		if (request.method === "GET") {
			return { status: 200, payload: this.snapshot() };
		}
		const command = body as {
			expectedRevision?: number;
			operation?: Record<string, unknown> & { taskId?: string };
		};
		if (command.expectedRevision !== this.worklist.revision) {
			return {
				status: 409,
				payload: {
					error: {
						code: "REVISION_CONFLICT",
						message: `Current project revision is ${this.worklist.revision}.`,
					},
				},
			};
		}
		if (this.failNext) {
			const failure = this.failNext;
			this.failNext = undefined;
			return { status: failure.status, payload: { error: { code: failure.code, message: failure.message } } };
		}
		const operation = { ...(command.operation ?? {}) };
		const taskId = operation.taskId;
		delete operation.taskId;
		if (typeof taskId === "string") {
			const reference = Object.entries(this.identities).find(([, id]) => id === taskId)?.[0];
			if (!reference) {
				return {
					status: 404,
					payload: { error: { code: "NOT_FOUND", message: "Task identity was not found." } },
				};
			}
			operation.id = reference;
		}
		const store = { worklist: this.worklist };
		const result = await new WorklistApplicationService({ projectStore: store }).execute(
			{ ...operation, scope: "project" } as never,
			{ source: "cli" },
		);
		if (!result.ok) {
			return {
				status: result.error.code === "APPROVAL_REQUIRED" ? 403 : 400,
				payload: { error: { code: result.error.code, message: result.error.message } },
			};
		}
		this.worklist = store.worklist;
		this.worklist.revision = (command.expectedRevision ?? 0) + 1;
		this.assignIdentities();
		return {
			status: 200,
			payload: {
				version: 1,
				projectId: this.projectId,
				commandId: randomUUID(),
				actorId: "oidc:test",
				revision: this.worklist.revision,
				cursor: this.worklist.revision,
				action: operation.action,
				taskIds: [],
			},
		};
	}

	private snapshot() {
		return {
			version: 1,
			projectId: this.projectId,
			revision: this.worklist.revision,
			cursor: this.worklist.revision,
			worklist: this.worklist,
			tasks: this.omitTasks
				? []
				: this.worklist.goals.map((item) => ({ taskId: this.identities[item.id], reference: item.id })),
		};
	}
}

function serviceFor(server: MockProjectServer, projectPath?: string): WorklistApplicationService {
	return new WorklistApplicationService({ ...(projectPath ? { projectPath } : {}), env: server.env() });
}

describe("configured server project access", () => {
	const servers: MockProjectServer[] = [];

	afterEach(async () => {
		await Promise.all(servers.splice(0).map((server) => server.close()));
	});

	async function boot(goals: ProjectGoal[]): Promise<MockProjectServer> {
		const server = new MockProjectServer(goals);
		await server.start();
		servers.push(server);
		return server;
	}

	it("reads and writes the server without changing the goal file", async () => {
		const server = await boot([goal("ship-it", "Ship it")]);
		const directory = await mkdtemp(join(tmpdir(), "stepstone-server-client-"));
		const file = join(directory, "worklist.json");
		const original = `${JSON.stringify({ secret: "file-only" })}\n`;
		await writeFile(file, original);
		const service = serviceFor(server, file);
		expect((await service.getProjectGoals(file)).map((item) => item.id)).toEqual(["ship-it"]);
		const added = await service.execute(
			{ scope: "project", action: "add", title: "From the server" },
			{ source: "cli" },
		);
		expect(added.ok).toBe(true);
		if (!added.ok) return;
		expect(added.result.goal?.title).toBe("From the server");
		expect(added.result.goal).toEqual(server.worklist.goals.at(-1));
		expect(added.meta.revisions?.project).toBe(String(server.worklist.revision));
		expect(await readFile(file, "utf8")).toBe(original);
		const command = server.requests.find((request) => request.method === "POST")?.body;
		expect(parseCommand(command).operation).toMatchObject({ action: "add", title: "From the server" });
	});

	it("resolves a former id to the server task UUID and reports a blocked activation", async () => {
		const server = await boot([
			goal("first", "First"),
			goal("review-the-guide", "Review", { previousIds: ["old-name"], dependsOn: ["first"] }),
		]);
		const service = serviceFor(server);
		const updated = await service.execute(
			{
				scope: "project",
				action: "update",
				id: "old-name",
				title: "Reviewed",
				expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
			},
			{ source: "cli" },
		);
		expect(updated.ok).toBe(true);
		if (!updated.ok) return;
		expect(updated.result.goal?.id).toBe("review-the-guide");
		const command = parseCommand(server.requests.find((request) => request.method === "POST")?.body);
		expect(command.operation).toMatchObject({
			action: "update",
			taskId: server.identities["review-the-guide"],
			expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
		});
		const activated = await service.execute(
			{ scope: "project", action: "set_active", id: "review-the-guide" },
			{ source: "cli" },
		);
		expect(activated.ok).toBe(true);
		if (activated.ok) expect(activated.result.blockedBy).toEqual(["first"]);
	});

	it("reports a server no-op without treating the advanced revision as a content change", async () => {
		const server = await boot([goal("ship-it", "Ship it")]);
		const service = serviceFor(server);
		const result = await service.execute(
			{ scope: "project", action: "update", id: "ship-it", title: "Ship it" },
			{ source: "cli" },
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.meta).toMatchObject({ changed: false, semanticNoOp: true, revisions: { project: "2" } });
		expect(server.worklist.revision).toBe(2);
	});

	it("previews a dry run locally and does not post it", async () => {
		const server = await boot([goal("ship-it", "Ship it")]);
		const service = serviceFor(server);
		const result = await service.execute(
			{
				scope: "project",
				action: "apply-plan",
				dryRun: true,
				plan: [{ title: "Planned goal", description: "Preview only" }],
			},
			{ source: "cli" },
		);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.result.addedGoals).toHaveLength(1);
		expect(server.requests.some((request) => request.method === "POST")).toBe(false);
		expect(server.worklist.revision).toBe(1);
	});

	it("does not post a command that still needs confirmation", async () => {
		const server = await boot([goal("ship-it", "Ship it")]);
		const service = serviceFor(server);
		const result = await service.execute(
			{ scope: "project", action: "delete", id: "ship-it" },
			{ source: "cli" },
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("APPROVAL_REQUIRED");
		expect(server.requests.some((request) => request.method === "POST")).toBe(false);
	});

	it("deletes through the server and maps a stale revision", async () => {
		const server = await boot([goal("ship-it", "Ship it")]);
		const service = serviceFor(server);
		const removed = await service.execute(
			{ scope: "project", action: "delete", id: "ship-it", confirm: true },
			{ source: "cli" },
		);
		expect(removed.ok).toBe(true);
		if (removed.ok) expect(removed.result.deletedGoalId).toBe("ship-it");
		expect(server.worklist.goals).toHaveLength(0);
		server.failNext = { status: 409, code: "REVISION_CONFLICT", message: "Current project revision is 9." };
		const conflict = await service.execute(
			{
				scope: "project",
				action: "add",
				title: "After the race",
				expectedRevision: String(server.worklist.revision),
			},
			{ source: "cli" },
		);
		expect(conflict.ok).toBe(false);
		if (!conflict.ok) {
			expect(conflict.error.code).toBe("CONFLICT");
			expect(conflict.error.conflict).toMatchObject({ actualRevision: "9" });
		}
	});

	it("posts organization, placement, and lifecycle commands", async () => {
		const server = await boot([goal("ship-it", "Ship it"), goal("other", "Other")]);
		const service = serviceFor(server);
		const shown = await service.execute(
			{ scope: "project", action: "show", id: "ship-it" },
			{ source: "cli" },
		);
		const listed = await service.execute({ scope: "project", action: "list" }, { source: "cli" });
		const structure = await service.execute({ scope: "project", action: "structure" }, { source: "cli" });
		expect(shown.ok && listed.ok && structure.ok).toBe(true);
		const described = await service.execute(
			{
				scope: "project",
				action: "update",
				id: "ship-it",
				description: "Details",
				group: "Now",
				dependsOn: ["other"],
				links: ["https://example.com/ship"],
			},
			{ source: "cli" },
		);
		expect(described.ok).toBe(true);
		const configured = await service.execute(
			{
				scope: "project",
				action: "configure",
				title: "Roadmap",
				description: "Shared",
				repositories: ["https://example.com/repo"],
				confirm: true,
			},
			{ source: "cli" },
		);
		expect(configured.ok).toBe(true);
		if (!configured.ok) return;
		expect(configured.result.project?.title).toBe("Roadmap");
		const added = await service.execute(
			{ scope: "project", action: "add_milestone", title: "Alpha", description: "First outcome" },
			{ source: "cli" },
		);
		expect(added.ok).toBe(true);
		if (!added.ok || !added.result.milestone) return;
		const milestoneId = added.result.milestone.id;
		const renamed = await service.execute(
			{ scope: "project", action: "update_milestone", id: milestoneId, title: "Alpha prime" },
			{ source: "cli" },
		);
		expect(renamed.ok).toBe(true);
		if (renamed.ok) expect(renamed.result.milestone?.title).toBe("Alpha prime");
		const assigned = await service.execute(
			{ scope: "project", action: "assign_milestone", id: "ship-it", milestoneId },
			{ source: "cli" },
		);
		expect(assigned.ok).toBe(true);
		const moved = await service.execute(
			{ scope: "project", action: "move", id: "ship-it", direction: "down" },
			{ source: "cli" },
		);
		expect(moved.ok).toBe(true);
		const started = await service.execute(
			{ scope: "project", action: "start", id: "other", branch: "feature" },
			{ source: "cli" },
		);
		expect(started.ok).toBe(true);
		const cleared = await service.execute(
			{ scope: "project", action: "start", id: "other", clear: true },
			{ source: "cli" },
		);
		expect(cleared.ok).toBe(true);
		const status = await service.execute(
			{ scope: "project", action: "set_status", id: "ship-it", status: "active" },
			{ source: "cli" },
		);
		expect(status.ok).toBe(true);
		for (const action of ["complete", "reopen", "archive"] as const) {
			const result = await service.execute(
				{ scope: "project", action, id: "ship-it", confirm: true },
				{ source: "cli" },
			);
			expect(result.ok).toBe(true);
		}
		const planned = await service.execute(
			{ scope: "project", action: "apply-plan", plan: [{ title: "Follow-up work" }] },
			{ source: "cli" },
		);
		expect(planned.ok).toBe(true);
		if (planned.ok) expect(planned.result.addedGoals?.[0]?.title).toBe("Follow-up work");
		const migrated = await service.execute(
			{ scope: "project", action: "migrate_ids", confirm: true },
			{ source: "cli" },
		);
		expect(migrated.ok).toBe(true);
		const commands = server.requests
			.filter((request) => request.method === "POST")
			.map((request) => parseCommand(request.body).operation.action);
		expect(commands).toEqual([
			"update",
			"configure",
			"add_milestone",
			"update_milestone",
			"assign_milestone",
			"move",
			"start",
			"start",
			"set_active",
			"complete",
			"reopen",
			"archive",
			"apply-plan",
			"migrate_ids",
		]);
	});

	it("maps server failures and a snapshot that omits task identity", async () => {
		const server = await boot([goal("ship-it", "Ship it")]);
		const service = serviceFor(server);
		const failures: { code: string; message: string; status: number; expect: string }[] = [
			{ code: "NOT_FOUND", message: "Task identity was not found.", status: 404, expect: "NOT_FOUND" },
			{
				code: "APPROVAL_REQUIRED",
				message: "Project complete requires explicit confirmation.",
				status: 403,
				expect: "APPROVAL_REQUIRED",
			},
			{
				code: "IDEMPOTENCY_CONFLICT",
				message: "Command ID was already used.",
				status: 409,
				expect: "CONFLICT",
			},
			{
				code: "CONFLICT",
				message: "Project goal ship-it changed from 2026-01-01T00:00:00.000Z to 2026-02-01T00:00:00.000Z.",
				status: 400,
				expect: "CONFLICT",
			},
			{
				code: "SERVICE_FAILED",
				message: "The service could not complete the request.",
				status: 503,
				expect: "UNAVAILABLE",
			},
		];
		for (const failure of failures) {
			server.failNext = failure;
			const result = await service.execute(
				{ scope: "project", action: "update", id: "ship-it", title: `Attempt ${failure.code}` },
				{ source: "cli" },
			);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error.code).toBe(failure.expect);
		}
		server.omitTasks = true;
		const missing = await service.execute(
			{ scope: "project", action: "update", id: "ship-it", title: "No identity" },
			{ source: "cli" },
		);
		expect(missing.ok).toBe(false);
		if (!missing.ok) expect(missing.error.code).toBe("NOT_FOUND");
	});

	it("refuses path migration and a partial or unreachable server without reading the file", async () => {
		const server = await boot([]);
		const directory = await mkdtemp(join(tmpdir(), "stepstone-no-fallback-"));
		const file = join(directory, "worklist.json");
		await writeFile(file, `${JSON.stringify({ goals: [goal("secret", "From the file")] })}\n`);
		const remote = serviceFor(server, file);
		const migration = await remote.execute(
			{ scope: "project", action: "migrate_path", confirm: true, targetPath: file },
			{ source: "cli" },
		);
		expect(migration.ok).toBe(false);
		if (!migration.ok) expect(migration.error.message).toContain("cannot migrate file paths");
		expect(server.requests).toHaveLength(0);
		expect(await readFile(file, "utf8")).toContain("From the file");

		const partial = new WorklistApplicationService({
			projectPath: file,
			env: { STEPSTONE_SERVER: "http://127.0.0.1:9" },
		});
		expect(partial.usesConfiguredServer()).toBe(true);
		await expect(partial.getProjectGoals(file)).rejects.toThrow(/does not fall back/);

		const down = new WorklistApplicationService({
			projectPath: file,
			env: {
				STEPSTONE_SERVER: "http://127.0.0.1:1",
				STEPSTONE_TOKEN: "token",
				STEPSTONE_PROJECT: projectId,
			},
		});
		const snapshot = await down.readProjectSnapshot("list");
		expect(snapshot.ok).toBe(false);
		if (!snapshot.ok) expect(snapshot.error.code).toBe("UNAVAILABLE");
		expect(await readFile(file, "utf8")).toContain("From the file");

		const held = new WorklistApplicationService({
			projectStore: { worklist: worklist([goal("memory", "Held in memory")]) },
			env: {
				STEPSTONE_SERVER: "http://127.0.0.1:1",
				STEPSTONE_TOKEN: "token",
				STEPSTONE_PROJECT: projectId,
			},
		});
		expect(held.usesConfiguredServer()).toBe(false);
		await expect(held.getProjectGoals()).resolves.toMatchObject([{ id: "memory" }]);
	});
});

describe("server-configured interfaces", () => {
	const servers: MockProjectServer[] = [];
	const previous = {
		STEPSTONE_SERVER: process.env.STEPSTONE_SERVER,
		STEPSTONE_TOKEN: process.env.STEPSTONE_TOKEN,
		STEPSTONE_PROJECT: process.env.STEPSTONE_PROJECT,
	};

	afterEach(async () => {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await Promise.all(servers.splice(0).map((server) => server.close()));
	});

	it("lists a server project from a directory that is not a repository", async () => {
		const server = new MockProjectServer([goal("ship-it", "Ship it")]);
		await server.start();
		servers.push(server);
		const outside = await mkdtemp(join(tmpdir(), "stepstone-outside-"));
		const listed = await execFileAsync(process.execPath, [cliPath, "project", "list", "--json"], {
			cwd: outside,
			env: { ...process.env, ...server.env() },
		});
		expect(JSON.parse(listed.stdout).result.goals).toMatchObject([{ id: "ship-it" }]);
		const posts = server.requests.filter((request) => request.method === "POST").length;
		await expect(
			execFileAsync(process.execPath, [cliPath, "project", "migrate_path", "--confirm", "--json"], {
				cwd: outside,
				env: { ...process.env, ...server.env() },
			}),
		).rejects.toMatchObject({ stderr: expect.stringContaining("cannot migrate file paths") });
		expect(server.requests.filter((request) => request.method === "POST")).toHaveLength(posts);
	});

	it("fails a partial server configuration before repository lookup", async () => {
		const outside = await mkdtemp(join(tmpdir(), "stepstone-partial-"));
		await expect(
			execFileAsync(process.execPath, [cliPath, "project", "list"], {
				cwd: outside,
				env: {
					...process.env,
					STEPSTONE_SERVER: "http://127.0.0.1:9",
					STEPSTONE_TOKEN: "",
					STEPSTONE_PROJECT: "",
				},
			}),
		).rejects.toMatchObject({ stderr: expect.stringContaining("does not fall back") });
	});

	it("refuses to start the editor when server configuration is partial", async () => {
		process.env.STEPSTONE_SERVER = "http://127.0.0.1:9";
		delete process.env.STEPSTONE_TOKEN;
		delete process.env.STEPSTONE_PROJECT;
		await expect(startStepstoneWebApp({})).rejects.toThrow(/does not fall back/);
	});

	it("serves the loopback editor from the server without a worktree", async () => {
		const server = new MockProjectServer([goal("ship-it", "Ship it")]);
		await server.start();
		servers.push(server);
		Object.assign(process.env, server.env());
		const app = await startStepstoneWebApp({ port: 0 });
		try {
			const response = await fetch(`${app.url}/api/state`);
			const payload = (await response.json()) as {
				result: { repositoryLabel: string; goals: { id: string }[] };
			};
			expect(payload.result.repositoryLabel).toBe("Server project");
			expect(payload.result.goals.map((item) => item.id)).toEqual(["ship-it"]);
		} finally {
			await app.close();
		}
	});

	it("reloads the board from the server", async () => {
		const server = new MockProjectServer([goal("ship-it", "Ship it")]);
		await server.start();
		servers.push(server);
		const input = new PassThrough();
		const output = new EventEmitter() as EventEmitter & {
			columns: number;
			rows: number;
			isTTY: boolean;
			chunks: string[];
			write: (chunk: string) => boolean;
			text: string;
		};
		output.columns = 100;
		output.rows = 26;
		output.isTTY = true;
		output.chunks = [];
		output.write = (chunk: string) => {
			output.chunks.push(chunk);
			return true;
		};
		Object.defineProperty(output, "text", {
			get: () =>
				// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping the ESC byte is the point here.
				output.chunks.join("").replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, ""),
		});
		const service = serviceFor(server);
		const done = runGoalBoard({
			service,
			resolveLocation: () => ({
				path: "",
				notice: "Project goals come from the configured server. The local goal file is not used.",
			}),
			repositoryLabel: "Server project",
			initialGoals: [],
			input,
			output,
			env: {},
		});
		input.write("R");
		const deadline = Date.now() + 5000;
		while (!output.text.includes("Reloaded from the server.") && Date.now() < deadline) {
			await new Promise((settle) => setTimeout(settle, 20));
		}
		input.write("q");
		await done;
		expect(output.text).toContain("Reloaded from the server.");
		expect(output.text).toContain("Ship it");
		expect(output.text).toContain("local goal file is not used");
	});
});

describe("server configuration helper", () => {
	it("treats an empty environment as file mode", () => {
		expect(resolveServerProject({}).mode).toBe("file");
	});
});
