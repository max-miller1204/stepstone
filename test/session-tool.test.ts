import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { WorklistApplicationService } from "../src/application-service.ts";
import { CLI_COMMAND_CONTRACT } from "../src/cli-contract.ts";
import worklistExtension from "../src/extension.ts";
import { formatSessionTasks } from "../src/format.ts";
import { WORKLIST_ERROR_CODES } from "../src/result-envelope.ts";
import { SESSION_SNAPSHOT_TYPE, SessionStore } from "../src/session-store.ts";
import { createProjectLocator, executeWorklist } from "../src/tool.ts";
import type { ProjectGoal, ProjectWorklist } from "../src/types.ts";
import type { DashboardResult } from "../src/ui.ts";

function fakePi(entries: unknown[] = []) {
	return {
		entries,
		api: {
			appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		} as unknown as ExtensionAPI,
	};
}

const ctx = { cwd: process.cwd() } as ExtensionContext;

describe("session state and tool", () => {
	it("reconstructs the latest snapshot on the active branch", () => {
		const { api } = fakePi();
		const store = new SessionStore(api);
		store.reconstruct({
			sessionManager: {
				getBranch: () => [
					{
						type: "custom",
						customType: SESSION_SNAPSHOT_TYPE,
						data: { version: 1, tasks: [{ id: "a", title: "old", status: "todo" }] },
					},
					{ type: "custom", customType: "other", data: {} },
					{
						type: "custom",
						customType: SESSION_SNAPSHOT_TYPE,
						data: {
							version: 1,
							tasks: [{ id: "b", title: "new", description: "Legacy context", status: "doing" }],
						},
					},
				],
			},
		} as unknown as ExtensionContext);
		expect(store.getTasks()).toEqual([{ id: "b", title: "new", status: "doing" }]);
	});

	it("restores branch-specific revisions and derives tokens for legacy snapshots", () => {
		const { api } = fakePi();
		const store = new SessionStore(api);
		const legacySnapshot = {
			type: "custom",
			id: "legacy-common",
			customType: SESSION_SNAPSHOT_TYPE,
			data: { version: 1, tasks: [{ id: "common", title: "Common", status: "todo" }] },
		};
		const branches = {
			first: [
				legacySnapshot,
				{
					type: "custom",
					id: "entry-first",
					customType: SESSION_SNAPSHOT_TYPE,
					data: {
						version: 2,
						revision: "branch-first",
						tasks: [{ id: "first", title: "First branch", status: "doing" }],
					},
				},
			],
			second: [
				legacySnapshot,
				{
					type: "custom",
					id: "entry-second",
					customType: SESSION_SNAPSHOT_TYPE,
					data: {
						version: 2,
						revision: "branch-second",
						tasks: [{ id: "second", title: "Second branch", status: "done" }],
					},
				},
			],
		};
		const reconstruct = (branch: unknown[]) =>
			store.reconstruct({
				sessionManager: { getBranch: () => branch },
			} as unknown as ExtensionContext);

		reconstruct(branches.first);
		expect(store.getRevision()).toBe("branch-first");
		expect(store.getTasks()[0]?.id).toBe("first");

		reconstruct(branches.second);
		expect(store.getRevision()).toBe("branch-second");
		expect(store.getTasks()[0]?.id).toBe("second");

		reconstruct([legacySnapshot]);
		expect(store.getRevision()).toBe("legacy-common");
		expect(store.getTasks()[0]?.id).toBe("common");
	});

	it("skips malformed tasks while keeping valid ones during reconstruction", () => {
		const { api } = fakePi();
		const store = new SessionStore(api);
		store.reconstruct({
			sessionManager: {
				getBranch: () => [
					{
						type: "custom",
						customType: SESSION_SNAPSHOT_TYPE,
						data: {
							version: 2,
							tasks: [
								null,
								["id", "title", "status"],
								{ title: "missing id", status: "todo" },
								{ id: 42, title: "numeric id", status: "todo" },
								{ id: "bad-title", title: null, status: "todo" },
								{ id: "bad-status", title: "Bad status", status: "paused" },
								{ id: "bad-goal", title: "Bad goal", status: "todo", goalId: 7 },
								{ id: "ok", title: "Valid", status: "doing" },
								{ id: "ok-goal", title: "Valid with goal", status: "done", goalId: "g-1" },
							],
						},
					},
				],
			},
		} as unknown as ExtensionContext);
		expect(store.getTasks()).toEqual([
			{ id: "ok", title: "Valid", status: "doing" },
			{ id: "ok-goal", title: "Valid with goal", status: "done", goalId: "g-1" },
		]);
	});

	it("migrates legacy snapshots on the next write without changing task IDs", async () => {
		const { api, entries } = fakePi();
		const store = new SessionStore(api);
		store.reconstruct({
			sessionManager: {
				getBranch: () => [
					{
						type: "custom",
						id: "legacy-snapshot",
						customType: SESSION_SNAPSHOT_TYPE,
						data: {
							version: 1,
							tasks: [
								{
									id: "stable-task",
									title: "Legacy task",
									description: "Legacy hidden context",
									status: "todo",
								},
							],
						},
					},
				],
			},
		} as unknown as ExtensionContext);

		await store.setTaskStatus("stable-task", "doing", { expectedRevision: "legacy-snapshot" });

		const snapshot = (entries.at(-1) as { data: { version: number; tasks: unknown[] } }).data;
		expect(snapshot.version).toBe(3);
		expect(snapshot.tasks).toEqual([{ id: "stable-task", title: "Legacy task", status: "doing" }]);
	});

	it("reads v3 snapshots carrying legacy orchestrator metadata and sheds it on the next write", async () => {
		const { api, entries } = fakePi();
		const store = new SessionStore(api);
		store.reconstruct({
			sessionManager: {
				getBranch: () => [
					{
						type: "custom",
						id: "receipt-entry",
						customType: "worklist-session-reconciliation-receipt",
						data: { idempotencyKey: "legacy-key", fingerprint: "legacy", goalId: "goal-1", tasks: [] },
					},
					{
						type: "custom",
						id: "managed-snapshot",
						customType: SESSION_SNAPSHOT_TYPE,
						data: {
							version: 3,
							revision: "managed-revision",
							tasks: [
								{
									id: "managed-task",
									title: "Projected work",
									status: "todo",
									goalId: "goal-1",
									managed: {
										version: 1,
										owner: "pi-orchestrator",
										external: { system: "pi-orchestrator", kind: "workflow-step", id: "step-1" },
									},
								},
							],
							projectionReconciliations: [
								{ idempotencyKey: "legacy-key", fingerprint: "legacy", goalId: "goal-1", tasks: [] },
							],
							managedOverrideTombstones: [
								{
									external: { system: "pi-orchestrator", kind: "workflow-step", id: "step-2" },
									taskId: "deleted-task",
									goalId: "goal-1",
									overriddenAt: "2026-07-24T20:00:00.000Z",
								},
							],
						},
					},
				],
			},
		} as unknown as ExtensionContext);

		expect(store.getTasks()).toEqual([
			{ id: "managed-task", title: "Projected work", status: "todo", goalId: "goal-1" },
		]);
		expect(store.getRevision()).toBe("managed-revision");

		const outcome = await store.setTaskStatus("managed-task", "doing", {
			expectedRevision: "managed-revision",
		});
		expect(outcome.result).not.toHaveProperty("managed");
		const snapshot = (entries.at(-1) as { data: Record<string, unknown> }).data;
		expect(snapshot.version).toBe(3);
		expect(snapshot.tasks).toEqual([
			{ id: "managed-task", title: "Projected work", status: "doing", goalId: "goal-1" },
		]);
		expect(snapshot).not.toHaveProperty("projectionReconciliations");
		expect(snapshot).not.toHaveProperty("managedOverrideTombstones");
	});

	it("ignores snapshots with unsupported versions", () => {
		const { api } = fakePi();
		const store = new SessionStore(api);
		store.reconstruct({
			sessionManager: {
				getBranch: () => [
					{
						type: "custom",
						customType: SESSION_SNAPSHOT_TYPE,
						data: { version: 2, tasks: [{ id: "a", title: "Supported", status: "todo" }] },
					},
					{
						type: "custom",
						customType: SESSION_SNAPSHOT_TYPE,
						data: { version: 4, tasks: [{ id: "b", title: "Future", status: "todo" }] },
					},
				],
			},
		} as unknown as ExtensionContext);
		expect(store.getTasks()).toEqual([{ id: "a", title: "Supported", status: "todo" }]);
	});

	it("supports session CRUD and persists snapshots", async () => {
		const { api, entries } = fakePi();
		const store = new SessionStore(api);
		await expect(
			executeWorklist(
				{
					scope: "session",
					action: "add",
					title: "Test it",
					description: "Cover the RPC and UI paths",
				},
				ctx,
				{ sessionStore: store, projectPath: null },
			),
		).rejects.toThrow("only supported for project goals");
		expect(entries).toHaveLength(0);
		const added = await executeWorklist({ scope: "session", action: "add", title: "Test it" }, ctx, {
			sessionStore: store,
			projectPath: null,
		});
		const id = added.details.tasks?.[0]?.id;
		expect(id).toBeTruthy();
		expect(formatSessionTasks(store.getTasks())).toContain("Test it");
		await executeWorklist({ scope: "session", action: "update", id, title: "Test it well" }, ctx, {
			sessionStore: store,
			projectPath: null,
		});
		expect(store.getTasks()[0]?.title).toBe("Test it well");
		await executeWorklist({ scope: "session", action: "set_status", id, status: "done" }, ctx, {
			sessionStore: store,
			projectPath: null,
		});
		expect(store.getTasks()[0]?.status).toBe("done");
		expect(entries).toHaveLength(3);
	});

	it("inserts and moves tasks by stable anchor ID", async () => {
		const { api, entries } = fakePi();
		const store = new SessionStore(api);
		const associated = { id: "b", title: "Completed", status: "done" as const, goalId: "goal-1" };
		store.setTasks([
			{ id: "a", title: "First", status: "todo" },
			associated,
			{ id: "c", title: "Current", status: "doing" },
		]);

		await executeWorklist({ scope: "session", action: "add", title: "Before", beforeId: "a" }, ctx, {
			sessionStore: store,
			projectPath: null,
		});
		await executeWorklist({ scope: "session", action: "add", title: "After", afterId: "b" }, ctx, {
			sessionStore: store,
			projectPath: null,
		});
		await executeWorklist({ scope: "session", action: "add", title: "Appended" }, ctx, {
			sessionStore: store,
			projectPath: null,
		});
		expect(store.getTasks().map((task) => task.title)).toEqual([
			"Before",
			"First",
			"Completed",
			"After",
			"Current",
			"Appended",
		]);

		await executeWorklist({ scope: "session", action: "move", id: "b", beforeId: "a" }, ctx, {
			sessionStore: store,
			projectPath: null,
		});
		await executeWorklist({ scope: "session", action: "move", id: "b", afterId: "c" }, ctx, {
			sessionStore: store,
			projectPath: null,
		});
		expect(store.getTasks().map((task) => task.title)).toEqual([
			"Before",
			"First",
			"After",
			"Current",
			"Completed",
			"Appended",
		]);
		expect(store.getTasks().find((task) => task.id === "b")).toEqual(associated);
		expect(entries).toHaveLength(5);
	});

	it("does not persist self-placement or already-satisfied moves", async () => {
		const { api, entries } = fakePi();
		const store = new SessionStore(api);
		store.setTasks([
			{ id: "a", title: "First", status: "todo" },
			{ id: "b", title: "Second", status: "doing" },
			{ id: "c", title: "Third", status: "done" },
		]);

		for (const params of [
			{ scope: "session" as const, action: "move", id: "a", beforeId: "a" },
			{ scope: "session" as const, action: "move", id: "a", beforeId: "b" },
			{ scope: "session" as const, action: "move", id: "b", afterId: "a" },
		]) {
			await expect(
				executeWorklist(params, ctx, { sessionStore: store, projectPath: null }),
			).resolves.toMatchObject({ details: { action: "move" } });
		}
		expect(entries).toHaveLength(0);

		await executeWorklist({ scope: "session", action: "move", id: "c", beforeId: "a" }, ctx, {
			sessionStore: store,
			projectPath: null,
		});
		expect(store.getTasks().map((task) => task.id)).toEqual(["c", "a", "b"]);
		expect(entries).toHaveLength(1);
	});

	it("does not append snapshots or advance revisions for semantic no-ops", async () => {
		const { api, entries } = fakePi();
		const store = new SessionStore(api);
		store.setTasks([
			{ id: "a", title: "Stable", status: "doing", goalId: "goal-1" },
			{ id: "b", title: "Anchor", status: "todo" },
		]);

		await expect(
			store.updateTask("a", { title: "Stable", goalId: "goal-1" }, { expectedRevision: "0" }),
		).resolves.toMatchObject({ result: { id: "a" }, changed: false, revision: "0" });
		await expect(store.setTaskStatus("a", "doing", { expectedRevision: "0" })).resolves.toMatchObject({
			result: { id: "a" },
			changed: false,
			revision: "0",
		});
		await expect(store.moveTask("a", { beforeId: "a" }, { expectedRevision: "0" })).resolves.toMatchObject({
			result: { id: "a" },
			changed: false,
			revision: "0",
		});
		expect(entries).toHaveLength(0);
		expect(store.getRevision()).toBe("0");

		await store.updateTask("a", { title: "Changed" }, { expectedRevision: "0" });
		const changedRevision = store.getRevision();
		expect(changedRevision).not.toBe("0");
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			type: "custom",
			customType: SESSION_SNAPSHOT_TYPE,
			data: { version: 3, revision: changedRevision },
		});

		await expect(
			store.updateTask("a", { title: "Changed" }, { expectedRevision: changedRevision }),
		).resolves.toMatchObject({ result: { id: "a" }, changed: false, revision: changedRevision });
		expect(entries).toHaveLength(1);
		expect(store.getRevision()).toBe(changedRevision);
		await expect(
			store.updateTask("a", { title: "Changed" }, { expectedRevision: "0" }),
		).rejects.toMatchObject({
			name: "SessionRevisionConflictError",
			expectedRevision: "0",
			actualRevision: changedRevision,
		});
		expect(entries).toHaveLength(1);
	});

	it("rejects invalid placement without poisoning serialized mutations", async () => {
		const { api, entries } = fakePi();
		const store = new SessionStore(api);
		store.setTasks([
			{ id: "a", title: "First", status: "todo" },
			{ id: "b", title: "Second", status: "todo" },
		]);

		const invalidCalls = [
			{
				params: { scope: "session" as const, action: "add", title: "Both", beforeId: "a", afterId: "b" },
				error: "exactly one",
			},
			{
				params: { scope: "session" as const, action: "add", title: "Blank", beforeId: "  " },
				error: "must not be blank",
			},
			{ params: { scope: "session" as const, action: "move", id: "a" }, error: "requires exactly one" },
			{ params: { scope: "session" as const, action: "list", beforeId: "a" }, error: "only supported" },
			{
				params: { scope: "project" as const, action: "add", title: "Goal", afterId: "a" },
				error: "only supported for project move",
			},
			{
				params: { scope: "session" as const, action: "move", id: "a", direction: "up" as const },
				error: "direction is only supported for project move",
			},
			{
				params: {
					scope: "project" as const,
					action: "move",
					id: "a",
					beforeId: "b",
					direction: "up" as const,
				},
				error: "mutually exclusive",
			},
			{
				params: { scope: "project" as const, action: "move", id: "a", direction: "sideways" as never },
				error: "direction must be up or down",
			},
		];
		for (const { params, error } of invalidCalls) {
			await expect(executeWorklist(params, ctx, { sessionStore: store, projectPath: null })).rejects.toThrow(
				error,
			);
		}
		expect(entries).toHaveLength(0);

		await expect(
			executeWorklist({ scope: "session", action: "add", title: "Unknown", beforeId: "missing" }, ctx, {
				sessionStore: store,
				projectPath: null,
			}),
		).rejects.toMatchObject({
			code: WORKLIST_ERROR_CODES.NOT_FOUND,
			details: { entity: "session-task-anchor", id: "missing" },
		});
		await expect(
			executeWorklist({ scope: "session", action: "move", id: "missing", beforeId: "a" }, ctx, {
				sessionStore: store,
				projectPath: null,
			}),
		).rejects.toMatchObject({
			code: WORKLIST_ERROR_CODES.NOT_FOUND,
			details: { entity: "session-task", id: "missing" },
		});
		await expect(
			executeWorklist({ scope: "session", action: "move", id: "a", afterId: "missing" }, ctx, {
				sessionStore: store,
				projectPath: null,
			}),
		).rejects.toMatchObject({
			code: WORKLIST_ERROR_CODES.NOT_FOUND,
			details: { entity: "session-task-anchor", id: "missing" },
		});

		const deleting = store.deleteTask("b");
		const staleAdd = store.addTask("Stale anchor", undefined, { afterId: "b" });
		const staleAddExpectation = expect(staleAdd).rejects.toThrow("anchor b not found");
		await expect(deleting).resolves.toMatchObject({ result: true, changed: true });
		await staleAddExpectation;
		await expect(store.addTask("Queue recovered")).resolves.toMatchObject({
			result: { title: "Queue recovered" },
			changed: true,
		});
		expect(store.getTasks().map((task) => task.title)).toEqual(["First", "Queue recovered"]);
		expect(entries).toHaveLength(2);
	});

	it("resolves move sources and anchors in serialized mutation order", async () => {
		const { api, entries } = fakePi();
		const store = new SessionStore(api);
		store.setTasks([
			{ id: "a", title: "First", status: "todo" },
			{ id: "b", title: "Anchor", status: "done" },
			{ id: "c", title: "Moving", status: "doing" },
		]);

		const deleteAnchor = store.deleteTask("b");
		const staleMove = store.moveTask("c", { afterId: "b" });
		const staleMoveExpectation = expect(staleMove).rejects.toThrow("anchor b not found");
		await expect(deleteAnchor).resolves.toMatchObject({ result: true, changed: true });
		await staleMoveExpectation;
		await expect(store.moveTask("c", { beforeId: "a" })).resolves.toMatchObject({
			result: { id: "c" },
			changed: true,
		});
		expect(store.getTasks().map((task) => task.id)).toEqual(["c", "a"]);
		expect(entries).toHaveLength(2);

		const deleteSource = store.deleteTask("c");
		const missingSourceMove = store.moveTask("c", { afterId: "a" });
		await expect(deleteSource).resolves.toMatchObject({ result: true, changed: true });
		await expect(missingSourceMove).resolves.toMatchObject({ result: null, changed: false });
		expect(entries).toHaveLength(3);
	});

	it("reports a dispatch claim and its release from the stored branch", async () => {
		const path = join(await mkdtemp(join(tmpdir(), "stepstone-tool-start-")), ".worklist", "worklist.json");
		const added = await executeWorklist({ scope: "project", action: "add", title: "Dispatch me" }, ctx, {
			projectPath: path,
		});
		const id = added.details.goal?.id;
		if (!id) throw new Error("Goal was not created");

		const claimed = await executeWorklist(
			{ scope: "project", action: "start", id, branch: "feat/dispatch" },
			ctx,
			{ projectPath: path },
		);
		expect(claimed.content).toBe("Started project goal dispatch-me on feat/dispatch");
		expect(claimed.details.goal).toMatchObject({ id, status: "open", branch: "feat/dispatch" });

		// A claim that changes no status is still a write, so the model has to be
		// told what happened rather than handed a failed call over state that
		// already moved underneath it.
		const released = await executeWorklist({ scope: "project", action: "start", id, clear: true }, ctx, {
			projectPath: path,
		});
		expect(released.content).toBe("Released project goal dispatch-me");
		expect(released.details.goal).not.toHaveProperty("branch");
	});

	it("warns in project activation text while keeping blocked activation successful", async () => {
		const path = join(await mkdtemp(join(tmpdir(), "stepstone-tool-blocked-")), ".worklist", "worklist.json");
		const blocker = await executeWorklist({ scope: "project", action: "add", title: "Slug ids" }, ctx, {
			projectPath: path,
		});
		const blockerId = blocker.details.goal?.id;
		if (!blockerId) throw new Error("Blocker goal was not created");
		const dependent = await executeWorklist(
			{ scope: "project", action: "add", title: "Dependency graph", dependsOn: [blockerId] },
			ctx,
			{ projectPath: path },
		);
		const dependentId = dependent.details.goal?.id;
		if (!dependentId) throw new Error("Dependent goal was not created");

		const activated = await executeWorklist(
			{ scope: "project", action: "set_active", id: dependentId },
			ctx,
			{ projectPath: path },
		);
		expect(activated.content).toBe(
			"Activated project goal dependency-graph\nWarning: dependency-graph is blocked; slug-ids has not landed yet.",
		);
		expect(activated.details).toMatchObject({
			goal: { id: "dependency-graph", status: "active" },
			blockedBy: ["slug-ids"],
		});

		const statusAlias = await executeWorklist(
			{ scope: "project", action: "set_status", id: dependentId, status: "active" },
			ctx,
			{ projectPath: path },
		);
		expect(statusAlias.content).toContain(
			"Warning: dependency-graph is blocked; slug-ids has not landed yet.",
		);
		expect(statusAlias.details.goal?.status).toBe("active");
	});

	it("fills and clears one session widget slot, named for the published package", async () => {
		// Pi keys a widget by the id the extension passes, so filling the slot under
		// one name and clearing it under another strands the widget on screen for the
		// rest of the session. Both calls therefore have to agree, and on the name the
		// package actually ships under.
		const root = await mkdtemp(join(tmpdir(), "stepstone-widget-"));
		execFileSync("git", ["init", "-q"], { cwd: root });
		const projectPath = join(root, ".worklist", "worklist.json");
		const added = await executeWorklist(
			{ scope: "project", action: "add", title: "Cross the first stone" },
			ctx,
			{ projectPath },
		);
		const goalId = added.details.goal?.id;
		if (!goalId) throw new Error("Goal was not created");
		await executeWorklist({ scope: "project", action: "set_active", id: goalId }, ctx, { projectPath });

		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
		const api = {
			appendEntry: () => {},
			registerTool: () => {},
			registerCommand: () => {},
			on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) => {
				handlers.set(event, handler);
			},
			events: { emit: () => {}, on: () => () => {} },
		} as unknown as ExtensionAPI;
		worklistExtension(api);
		const start = handlers.get("session_start");
		const shutdown = handlers.get("session_shutdown");
		if (!start || !shutdown) throw new Error("Session lifecycle handlers were not registered");

		const widgetCalls: Array<{ id: string; value: unknown }> = [];
		const context = {
			cwd: root,
			mode: "cli",
			sessionManager: { getBranch: () => [] },
			ui: {
				setWidget: (id: string, value: unknown) => widgetCalls.push({ id, value }),
				custom: async () => undefined,
				notify: () => {},
			},
		} as unknown as ExtensionContext;

		await start({}, context);
		const goalLines = ["Goal: Cross the first stone"];
		expect(widgetCalls).toEqual([{ id: CLI_COMMAND_CONTRACT.binary, value: goalLines }]);

		await shutdown({}, context);
		expect(widgetCalls.at(-1)).toEqual({ id: CLI_COMMAND_CONTRACT.binary, value: undefined });
		const slots = new Set(widgetCalls.map((call) => call.id));
		expect(slots).toEqual(new Set([CLI_COMMAND_CONTRACT.binary]));
	});

	it("surfaces blocked activation warnings from the Pi dashboard", async () => {
		const root = await mkdtemp(join(tmpdir(), "stepstone-dashboard-blocked-"));
		execFileSync("git", ["init", "-q"], { cwd: root });
		const projectPath = join(root, ".worklist", "worklist.json");
		await executeWorklist({ scope: "project", action: "add", title: "Slug ids" }, ctx, {
			projectPath,
		});
		await executeWorklist(
			{ scope: "project", action: "add", title: "Dependency graph", dependsOn: ["slug-ids"] },
			ctx,
			{ projectPath },
		);

		let tasksHandler: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
		let sessionStart: ((event: unknown, ctx: ExtensionContext) => Promise<void>) | undefined;
		const api = {
			appendEntry: () => {},
			registerTool: () => {},
			registerCommand: (
				name: string,
				config: { handler: (args: string, ctx: ExtensionContext) => Promise<void> },
			) => {
				if (name === "tasks") tasksHandler = config.handler;
			},
			on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) => {
				if (event === "session_start") sessionStart = handler;
			},
			events: { emit: () => {}, on: () => () => {} },
		} as unknown as ExtensionAPI;
		worklistExtension(api);
		if (!tasksHandler || !sessionStart) throw new Error("Dashboard handlers were not registered");

		const dashboardResults: DashboardResult[] = [
			{
				action: { kind: "advance", scope: "project", id: "dependency-graph" },
				state: { scope: "project", selectedId: "dependency-graph" },
			},
			{
				action: { kind: "close" },
				state: { scope: "project", selectedId: "dependency-graph" },
			},
		];
		const notifications: Array<{ text: string; tone: string }> = [];
		const dashboardContext = {
			cwd: root,
			mode: "tui",
			sessionManager: { getBranch: () => [] },
			ui: {
				setWidget: () => {},
				custom: async () => dashboardResults.shift(),
				notify: (text: string, tone: string) => notifications.push({ text, tone }),
			},
		} as unknown as ExtensionContext;
		await sessionStart({}, dashboardContext);
		await tasksHandler("", dashboardContext);

		expect(notifications).toContainEqual({
			text: "Activated project goal dependency-graph\nWarning: dependency-graph is blocked; slug-ids has not landed yet.",
			tone: "warning",
		});
		const listed = await executeWorklist({ scope: "project", action: "list" }, ctx, { projectPath });
		expect(listed.details.goals?.find((goal) => goal.id === "dependency-graph")?.status).toBe("active");
	});

	it("previews and applies an atomic project plan through the model tool", async () => {
		const projectPath = join(
			await mkdtemp(join(tmpdir(), "stepstone-tool-plan-")),
			".worklist",
			"worklist.json",
		);
		await executeWorklist({ scope: "project", action: "add", title: "Shared goal" }, ctx, {
			projectPath,
		});
		const plan = [{ title: "Shared goal" }, { title: "Batch dependent", dependsOn: ["shared-goal"] }];

		const preview = await executeWorklist(
			{ scope: "project", action: "apply-plan", plan, dryRun: true },
			ctx,
			{ projectPath },
		);
		expect(preview.content).toContain("Would add 2 project goal(s) without writing.");
		expect(preview.content).toContain(
			"Warning: shared-goal resolves to new batch goal shared-goal-2, not existing goal shared-goal.",
		);
		expect(preview.details.addedGoals?.[1].dependsOn).toEqual(["shared-goal-2"]);
		expect(
			(await executeWorklist({ scope: "project", action: "list" }, ctx, { projectPath })).details.goals,
		).toHaveLength(1);

		const applied = await executeWorklist({ scope: "project", action: "apply-plan", plan }, ctx, {
			projectPath,
		});
		expect(applied.content).toContain("Applied 2 project goal(s).");
		expect(applied.details.addedGoals?.map((goal) => goal.id)).toEqual(["shared-goal-2", "batch-dependent"]);
		expect(applied.details.goals).toHaveLength(3);
	});

	it("guards every destructive project lifecycle path", async () => {
		const path = join(await mkdtemp(join(tmpdir(), "stepstone-tool-")), ".worklist", "worklist.json");
		const { api } = fakePi();
		const store = new SessionStore(api);
		const added = await executeWorklist({ scope: "project", action: "add", title: "Ship" }, ctx, {
			sessionStore: store,
			projectPath: path,
		});
		const id = added.details.goals?.[0]?.id;
		for (const action of ["complete", "reopen", "archive", "delete"]) {
			await expect(
				executeWorklist({ scope: "project", action, id }, ctx, {
					sessionStore: store,
					projectPath: path,
				}),
			).rejects.toMatchObject({
				code: WORKLIST_ERROR_CODES.APPROVAL_REQUIRED,
				retryable: false,
			});
		}
		await expect(
			executeWorklist({ scope: "project", action: "set_status", id, status: "done" }, ctx, {
				sessionStore: store,
				projectPath: path,
			}),
		).rejects.toThrow("only accepts active");
		const completed = await executeWorklist(
			{ scope: "project", action: "complete", id, confirm: true },
			ctx,
			{ sessionStore: store, projectPath: path },
		);
		expect(completed.details.goals?.[0]?.status).toBe("done");
		await expect(
			executeWorklist({ scope: "project", action: "set_active", id }, ctx, {
				sessionStore: store,
				projectPath: path,
			}),
		).rejects.toThrow("must be reopened");
	});
});

describe("registered model tool", () => {
	type SessionHandler = (event: unknown, ctx: ExtensionContext) => Promise<void> | void;

	function registerExtension() {
		let tool: Record<string, unknown> | undefined;
		const handlers = new Map<string, SessionHandler>();
		const api = {
			appendEntry: () => {},
			registerTool: (config: Record<string, unknown>) => {
				tool = config;
			},
			registerCommand: () => {},
			on: (event: string, handler: SessionHandler) => {
				handlers.set(event, handler);
			},
			events: { emit: () => {}, on: () => () => {} },
		} as unknown as ExtensionAPI;
		worklistExtension(api);
		if (!tool) throw new Error("worklist tool was not registered");
		return { tool, handlers };
	}

	it("delivers the complete canonical capture workflow in the model prompt", () => {
		const { tool } = registerExtension();
		const guidelines = tool.promptGuidelines as string[];
		const action = CLI_COMMAND_CONTRACT.actions.find(({ name }) => name === "apply-plan");
		if (!action?.captureWorkflow) throw new Error("apply-plan capture workflow is missing");

		const captureGuideline = guidelines.find((guideline) =>
			action.captureWorkflow?.steps.every((step) => guideline.includes(step)),
		);
		expect(captureGuideline).toContain("worklist");
		expect(guidelines).toContain(
			"Never set worklist confirm=true for a project lifecycle action unless the user explicitly requested that exact completion, reopening, archival, or deletion.",
		);
	});

	type ToolExecute = (
		id: string,
		params: Record<string, unknown>,
		signal: undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	) => Promise<unknown>;

	interface LiveSession {
		call: (params: Record<string, unknown>) => Promise<unknown>;
		/** Everything the session has put in front of the user, newest last. */
		notifications: string[];
		/**
		 * What pi does for `/new`, `/resume`, `/fork` and `/clone`: shut the session
		 * down and start the next one on the same extension instance, which is
		 * registered once per process rather than once per session.
		 */
		restart: (reason: "new" | "resume" | "fork") => Promise<void>;
	}

	/**
	 * The arguments a model can actually send, which is the tool's declared
	 * parameter schema and nothing else.
	 *
	 * A tool call is composed from the schema pi advertises, so a field the schema
	 * never names cannot arrive at `execute` no matter what the service behind it
	 * would accept. Dropping undeclared keys here keeps a session test measuring
	 * the surface the model can reach rather than the wider one reachable only by
	 * calling `execute` directly.
	 */
	function declaredArguments(parameters: unknown, params: Record<string, unknown>): Record<string, unknown> {
		const declared = new Set(Object.keys((parameters as { properties: Record<string, unknown> }).properties));
		return Object.fromEntries(Object.entries(params).filter(([name]) => declared.has(name)));
	}

	/** A live session on a repository, left exactly as `session_start` leaves one. */
	async function startSession(cwd: string): Promise<LiveSession> {
		const { tool, handlers } = registerExtension();
		const notifications: string[] = [];
		const sessionContext = {
			cwd,
			mode: "cli",
			sessionManager: { getBranch: () => [] },
			ui: { notify: (message: string) => notifications.push(message), setWidget: () => {} },
		} as unknown as ExtensionContext;
		const sessionStart = handlers.get("session_start");
		if (!sessionStart) throw new Error("session_start handler was not registered");
		await sessionStart({ reason: "new" }, sessionContext);
		const execute = tool.execute as ToolExecute;
		return {
			call: (params) =>
				execute("call", declaredArguments(tool.parameters, params), undefined, undefined, sessionContext),
			notifications,
			restart: async (reason) => {
				await handlers.get("session_shutdown")?.({}, sessionContext);
				await sessionStart({ reason }, sessionContext);
			},
		};
	}

	it("resolves the same goal file a terminal in the repository would", async () => {
		// Canonical, because the resolver reports the canonical root back and a
		// temporary directory reaches it through a symlink on macOS.
		const root = await realpath(await mkdtemp(join(tmpdir(), "stepstone-tool-path-")));
		execFileSync("git", ["init", "-q"], { cwd: root });
		expect(createProjectLocator(root)()).toMatchObject({
			path: join(root, ".worklist", "worklist.json"),
			source: "default",
		});

		// A Pi session in a repository an older release wrote keeps reading the file
		// that is actually there, which is what makes the move need no migration.
		await mkdir(join(root, ".pi"), { recursive: true });
		await writeFile(join(root, ".pi", "worklist.json"), `${JSON.stringify({ version: 1, goals: [] })}\n`);
		expect(createProjectLocator(root)()).toMatchObject({
			path: join(root, ".pi", "worklist.json"),
			source: "legacy",
		});

		expect(createProjectLocator(await mkdtemp(join(tmpdir(), "stepstone-tool-no-git-")))()).toBeNull();
	});

	it("writes where the goal file is now, not where it was when the session started", async () => {
		const root = await mkdtemp(join(tmpdir(), "stepstone-tool-migrated-"));
		execFileSync("git", ["init", "-q"], { cwd: root });
		const legacy = join(root, ".pi", "worklist.json");
		const migrated = join(root, ".worklist", "worklist.json");
		await mkdir(join(root, ".pi"), { recursive: true });
		await writeFile(
			legacy,
			`${JSON.stringify({
				version: 1,
				revision: 1,
				goals: [
					{
						id: "carried",
						title: "Carried across",
						status: "open",
						createdAt: "2026-01-01T00:00:00.000Z",
						updatedAt: "2026-01-01T00:00:00.000Z",
					},
				],
			})}\n`,
		);
		const session = await startSession(root);

		// migrate_path, run in a terminal while the session stays open on the file
		// it moved.
		const migration = await new WorklistApplicationService({ projectPath: legacy }).execute(
			{ scope: "project", action: "migrate_path", targetPath: migrated, confirm: true },
			{ source: "cli" },
		);
		expect(migration.ok).toBe(true);

		await session.call({ scope: "project", action: "add", title: "Added after the move" });

		// The goal joins the roadmap that moved. Writing to the remembered path
		// would recreate the legacy file holding only this goal, which is the split
		// roadmap the whole resolution order exists to prevent.
		const worklist = JSON.parse(await readFile(migrated, "utf8")) as ProjectWorklist;
		expect(worklist.goals.map((goal) => goal.id)).toEqual(["carried", "added-after-the-move"]);
		await expect(readFile(legacy, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("announces a second worklist that appears while the session is already running", async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "stepstone-tool-shadowed-")));
		execFileSync("git", ["init", "-q"], { cwd: root });
		const legacy = join(root, ".pi", "worklist.json");
		const current = join(root, ".worklist", "worklist.json");
		await mkdir(join(root, ".pi"), { recursive: true });
		await writeFile(legacy, `${JSON.stringify({ version: 1, goals: [] })}\n`);

		// A repository an older release wrote: one roadmap, so nothing to warn about.
		const session = await startSession(root);
		expect(session.notifications).toEqual([]);

		// A branch checkout, a merge, or a colleague's older release lands the second
		// file. From here every read and write the session makes silently moves to it.
		await mkdir(join(root, ".worklist"), { recursive: true });
		await writeFile(current, `${JSON.stringify({ version: 1, goals: [] })}\n`);

		await session.call({ scope: "project", action: "list" });

		const warnings = session.notifications.filter((message) =>
			message.includes("two project worklists exist"),
		);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain(`Reading and writing ${current}`);
		expect(warnings[0]).toContain(`${legacy} is ignored`);

		// Said when it becomes true, not on every turn after.
		await session.call({ scope: "project", action: "list" });
		expect(
			session.notifications.filter((message) => message.includes("two project worklists exist")),
		).toHaveLength(1);

		// The next session is told too. pi registers this extension once per process
		// and reuses it across /new, /resume and /fork, so a session that inherited
		// the previous one's dedupe would show one roadmap and never name the other.
		await session.restart("new");
		expect(
			session.notifications.filter((message) => message.includes("two project worklists exist")),
		).toHaveLength(2);
	});

	it("lets the registered model tool guard a branch claim with the goal timestamp", async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "stepstone-tool-guarded-start-")));
		execFileSync("git", ["init", "-q"], { cwd: root });
		const session = await startSession(root);
		const added = (await session.call({
			scope: "project",
			action: "add",
			title: "Guarded dispatch",
		})) as { details: { goal?: ProjectGoal } };
		const baseline = added.details.goal;
		if (!baseline) throw new Error("The model tool did not return the added goal");

		const claimed = (await session.call({
			scope: "project",
			action: "start",
			id: baseline.id,
			branch: "feat/guarded",
			expectedUpdatedAt: baseline.updatedAt,
		})) as { details: { goal?: ProjectGoal } };
		expect(claimed.details.goal).toMatchObject({ id: baseline.id, branch: "feat/guarded" });

		await expect(
			session.call({
				scope: "project",
				action: "start",
				id: baseline.id,
				branch: "feat/stale",
				expectedUpdatedAt: baseline.updatedAt,
			}),
		).rejects.toMatchObject({
			code: "CONFLICT",
			retryable: true,
			conflict: {
				type: "goal-updated-at",
				id: baseline.id,
				expectedUpdatedAt: baseline.updatedAt,
			},
		});
	});

	it("tells a session that Git is unavailable rather than that it left the repository", async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "stepstone-tool-no-git-")));
		execFileSync("git", ["init", "-q"], { cwd: root });
		const emptyBin = await mkdtemp(join(tmpdir(), "stepstone-tool-no-git-bin-"));
		const realPath = process.env.PATH;

		// A session that starts while Git cannot be run. The session is in the
		// repository it has always been in, and saying otherwise would send someone
		// looking for a repository they are standing in.
		let unavailable: unknown;
		let session: Awaited<ReturnType<typeof startSession>>;
		process.env.PATH = emptyBin;
		try {
			session = await startSession(root);
			unavailable = await session.call({ scope: "project", action: "add", title: "While Git is away" }).then(
				() => undefined,
				(error: unknown) => error,
			);
		} finally {
			process.env.PATH = realPath;
		}
		expect(unavailable).toMatchObject({
			code: "UNAVAILABLE",
			retryable: false,
			details: { resolution: "repair-git-availability" },
		});
		expect(String((unavailable as Error).message)).not.toContain("require a git repository");

		// The session recovers on the next operation: the lookup that never got an
		// answer is asked again rather than settling the rest of the session.
		const added = (await session.call({
			scope: "project",
			action: "add",
			title: "Once Git is back",
		})) as { details: { goal?: ProjectGoal } };
		expect(added.details.goal?.title).toBe("Once Git is back");

		// A session genuinely outside a repository keeps the standing answer, so
		// session tasks stay usable there.
		const bare = await realpath(await mkdtemp(join(tmpdir(), "stepstone-tool-bare-")));
		const outside = await startSession(bare);
		await expect(outside.call({ scope: "project", action: "list" })).rejects.toMatchObject({
			code: "UNAVAILABLE",
			details: { resolution: "run-inside-git-repository" },
		});
	});

	it("recovers when the repository Git refused is repaired mid-session", async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "stepstone-tool-refused-")));
		execFileSync("git", ["init", "-q"], { cwd: root });
		const config = join(root, ".git", "config");
		const original = await readFile(config, "utf8");
		// The routine instance is dubious ownership in a container: Git prints the
		// command to run, the user runs it, and the session has to pick that up.
		await writeFile(config, "this is not a config file\n");

		const session = await startSession(root);
		const refused = await session.call({ scope: "project", action: "add", title: "While Git objects" }).then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(refused).toMatchObject({
			code: "UNAVAILABLE",
			retryable: false,
			details: { resolution: "repair-git-repository" },
		});
		// Not the standing verdict: the session is inside the repository, and it is
		// told what Git actually objected to.
		expect(String((refused as Error).message)).not.toContain("require a git repository");
		expect(String((refused as Error).message)).toContain("bad config");

		await writeFile(config, original);
		const added = (await session.call({
			scope: "project",
			action: "add",
			title: "Once the config is fixed",
		})) as { details: { goal?: ProjectGoal } };
		expect(added.details.goal?.title).toBe("Once the config is fixed");
	});

	it("still reports a goal file it cannot read when the widget refreshes", async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "stepstone-tool-malformed-")));
		execFileSync("git", ["init", "-q"], { cwd: root });
		await mkdir(join(root, ".worklist"), { recursive: true });
		// Persisted state the session cannot parse. Only Git being unreachable lets the
		// widget fall quiet; a file someone has to repair must still be named.
		await writeFile(join(root, ".worklist", "worklist.json"), "{ not json\n");

		const session = await startSession(root);
		const reported = session.notifications.filter((message) =>
			message.includes("Malformed project worklist"),
		);
		expect(reported).toHaveLength(1);
		expect(reported[0]).toContain(join(root, ".worklist", "worklist.json"));
	});

	it("keeps model tool execution sequential so ordering mutations stay serialized", () => {
		expect(registerExtension().tool.executionMode).toBe("sequential");
	});

	it("exposes the session ordering surface to the model", () => {
		const { tool } = registerExtension();
		const parameters = tool.parameters as {
			properties: Record<string, { type?: string; enum?: string[]; description?: string }>;
			required?: string[];
		};
		expect(parameters.properties.action.enum).toContain("move");
		expect(parameters.properties.action.enum).toContain("apply-plan");
		expect(parameters.properties.id.description).toContain("for move");
		expect(parameters.properties.beforeId).toBeDefined();
		expect(parameters.properties.afterId).toBeDefined();
		expect(parameters.properties.plan).toBeDefined();
		expect(parameters.properties.dryRun).toBeDefined();
		// The optimistic concurrency guard is only usable if the model is told it
		// exists, which action it guards, and that it is an optional string.
		expect(parameters.properties.expectedUpdatedAt?.type).toBe("string");
		expect(parameters.properties.expectedUpdatedAt?.description).toContain("start");
		expect(parameters.required ?? []).not.toContain("expectedUpdatedAt");
		expect(tool.description).toContain("Project move requires exactly one of beforeId or afterId");
		expect(tool.description).not.toContain("Project Goals cannot be reordered");
	});
});
