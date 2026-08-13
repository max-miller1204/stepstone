import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	unwrapWorklistApplicationResult,
	WorklistApplicationService,
	type WorklistOperationSource,
} from "../src/application-service.ts";
import { WORKLIST_ERROR_CODES } from "../src/result-envelope.ts";
import { SessionStore } from "../src/session-store.ts";
import type { ProjectWorklist } from "../src/types.ts";

function createSessionStore() {
	const entries: unknown[] = [];
	const pi = {
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
	} as unknown as ExtensionAPI;
	return { entries, store: new SessionStore(pi) };
}

describe("worklist application service", () => {
	it("projects and applies JSON plans through the canonical service boundary", async () => {
		const projectPath = join(
			await mkdtemp(join(tmpdir(), "stepstone-application-plan-")),
			".worklist",
			"worklist.json",
		);
		const service = new WorklistApplicationService({ projectPath });
		const plan = [{ title: "Plan foundation" }, { title: "Plan feature", dependsOn: ["plan-foundation"] }];

		const preview = await service.execute(
			{ scope: "project", action: "apply-plan", plan, dryRun: true },
			{ source: "cli" },
		);
		expect(preview).toMatchObject({
			ok: true,
			result: {
				dryRun: true,
				addedGoals: [{ id: "plan-foundation" }, { id: "plan-feature", dependsOn: ["plan-foundation"] }],
			},
			meta: {
				changed: false,
				semanticNoOp: false,
				changedFields: [],
				revisions: { project: "0" },
			},
		});
		expect(await service.getProjectGoals()).toEqual([]);

		const applied = await service.execute(
			{ scope: "project", action: "apply-plan", plan },
			{ source: "cli" },
		);
		expect(applied).toMatchObject({
			ok: true,
			result: { dryRun: false },
			meta: {
				changed: true,
				semanticNoOp: false,
				changedFields: ["/goals"],
				changedEntities: {
					projectGoalIds: ["plan-feature", "plan-foundation"],
					sessionTaskIds: [],
				},
				revisions: { project: "1" },
			},
		});

		const invalid = await service.execute(
			{
				scope: "project",
				action: "apply-plan",
				plan: [{ title: "Unsupported", status: "open" }],
			},
			{ source: "cli" },
		);
		expect(invalid).toMatchObject({
			ok: false,
			error: {
				code: WORKLIST_ERROR_CODES.VALIDATION_FAILED,
				details: { fields: ["plan/0/status"] },
			},
			meta: { changed: false },
		});

		const invalidDryRun = await service.execute(
			{ scope: "project", action: "apply-plan", plan: [], dryRun: "false" as never },
			{ source: "tool" },
		);
		expect(invalidDryRun).toMatchObject({
			ok: false,
			error: {
				code: WORKLIST_ERROR_CODES.VALIDATION_FAILED,
				details: { fields: ["dryRun"], resolution: "provide-boolean-dry-run" },
			},
		});

		const empty = await service.execute(
			{ scope: "project", action: "apply-plan", plan: [] },
			{ source: "cli" },
		);
		expect(empty).toMatchObject({
			ok: true,
			result: { addedGoals: [] },
			meta: { changed: false, semanticNoOp: true, revisions: { project: "1" } },
		});
		expect(await service.getProjectGoals()).toHaveLength(2);
	});

	it("rejects stale Project Goal mutations with the current persisted revision", async () => {
		const projectPath = join(
			await mkdtemp(join(tmpdir(), "stepstone-application-revision-")),
			".worklist",
			"worklist.json",
		);
		const firstClient = new WorklistApplicationService({ projectPath });
		const secondClient = new WorklistApplicationService({ projectPath });

		const added = await firstClient.execute(
			{ scope: "project", action: "add", title: "Revision guarded", expectedRevision: "0" },
			{ source: "cli" },
		);
		expect(added).toMatchObject({
			ok: true,
			meta: { changed: true, semanticNoOp: false, revisions: { project: "1" } },
		});
		if (!added.ok || !added.result.goal) return;

		const updated = await secondClient.execute(
			{
				scope: "project",
				action: "update",
				id: added.result.goal.id,
				title: "Newer title",
				expectedRevision: "1",
			},
			{ source: "dashboard" },
		);
		expect(updated).toMatchObject({ ok: true, meta: { revisions: { project: "2" } } });
		const beforeConflict = await readFile(projectPath, "utf8");

		const conflict = await firstClient.execute(
			{
				scope: "project",
				action: "update",
				id: added.result.goal.id,
				title: "Stale overwrite",
				expectedRevision: "1",
			},
			{ source: "cli" },
		);
		expect(conflict).toEqual({
			ok: false,
			scope: "project",
			action: "update",
			error: {
				code: WORKLIST_ERROR_CODES.CONFLICT,
				message: "Project worklist revision changed from 1 to 2.",
				retryable: true,
				conflict: {
					type: "revision",
					expectedRevision: "1",
					actualRevision: "2",
					resolution: "refresh-and-retry",
				},
			},
			meta: {
				changed: false,
				semanticNoOp: false,
				changedFields: [],
				revisions: { project: "2" },
			},
		});
		expect(await readFile(projectPath, "utf8")).toBe(beforeConflict);
	});

	it("guards one goal's baseline and appends to it without replaying the stored text", async () => {
		const projectPath = join(
			await mkdtemp(join(tmpdir(), "stepstone-application-goal-baseline-")),
			".worklist",
			"worklist.json",
		);
		const service = new WorklistApplicationService({ projectPath });
		const added = await service.execute(
			{ scope: "project", action: "add", title: "Stage E", description: "First paragraph." },
			{ source: "cli" },
		);
		if (!added.ok || !added.result.goal) return;
		const baseline = added.result.goal;

		// Another writer moves the goal, leaving the first caller's baseline stale.
		const other = await service.execute(
			{
				scope: "project",
				action: "update",
				id: baseline.id,
				appendDescription: "Recorded by someone else.",
			},
			{ source: "tool" },
		);
		expect(other).toMatchObject({
			ok: true,
			result: { goal: { description: "First paragraph.\n\nRecorded by someone else." } },
			meta: { changed: true, revisions: { project: "2" } },
		});
		if (!other.ok || !other.result.goal) return;
		const current = other.result.goal.updatedAt;
		const beforeConflict = await readFile(projectPath, "utf8");

		const conflict = await service.execute(
			{
				scope: "project",
				action: "update",
				id: baseline.id,
				description: "Stale overwrite",
				expectedUpdatedAt: baseline.updatedAt,
			},
			{ source: "cli" },
		);
		expect(conflict).toEqual({
			ok: false,
			scope: "project",
			action: "update",
			error: {
				code: WORKLIST_ERROR_CODES.CONFLICT,
				message: `Project goal ${baseline.id} changed from ${baseline.updatedAt} to ${current}.`,
				retryable: true,
				conflict: {
					type: "goal-updated-at",
					id: baseline.id,
					expectedUpdatedAt: baseline.updatedAt,
					actualUpdatedAt: current,
					resolution: "refresh-and-retry",
				},
			},
			meta: { changed: false, semanticNoOp: false, changedFields: [] },
		});
		expect(await readFile(projectPath, "utf8")).toBe(beforeConflict);

		// The same change lands once it is rebuilt on a fresh read.
		const retried = await service.execute(
			{
				scope: "project",
				action: "update",
				id: baseline.id,
				appendDescription: "Added after re-reading.",
				expectedUpdatedAt: current,
			},
			{ source: "cli" },
		);
		expect(retried).toMatchObject({
			ok: true,
			result: {
				goal: {
					description: "First paragraph.\n\nRecorded by someone else.\n\nAdded after re-reading.",
				},
			},
			meta: { changed: true, revisions: { project: "3" } },
		});
	});

	it("guards readable legacy timestamps by exact value", async () => {
		const projectPath = join(
			await mkdtemp(join(tmpdir(), "stepstone-application-legacy-baseline-")),
			".worklist",
			"worklist.json",
		);
		await mkdir(join(projectPath, ".."), { recursive: true });
		await writeFile(
			projectPath,
			`${JSON.stringify(
				{
					version: 1,
					revision: 1,
					goals: [
						{
							id: "goal-legacy",
							title: "Legacy baseline",
							status: "open",
							createdAt: "2026-05-04T09:12:31.004Z",
							updatedAt: " legacy ",
						},
					],
				},
				null,
				2,
			)}\n`,
		);
		const service = new WorklistApplicationService({ projectPath });
		const beforeConflict = await readFile(projectPath, "utf8");

		const conflict = await service.execute(
			{
				scope: "project",
				action: "update",
				id: "goal-legacy",
				title: "Stale rewrite",
				expectedUpdatedAt: "yesterday",
			},
			{ source: "cli" },
		);
		expect(conflict).toMatchObject({
			ok: false,
			error: {
				code: WORKLIST_ERROR_CODES.CONFLICT,
				conflict: {
					type: "goal-updated-at",
					expectedUpdatedAt: "yesterday",
					actualUpdatedAt: " legacy ",
				},
			},
		});
		expect(await readFile(projectPath, "utf8")).toBe(beforeConflict);

		const updated = await service.execute(
			{
				scope: "project",
				action: "update",
				id: "goal-legacy",
				title: "Guarded rewrite",
				expectedUpdatedAt: " legacy ",
			},
			{ source: "cli" },
		);
		expect(updated).toMatchObject({
			ok: true,
			result: { goal: { id: "goal-legacy", title: "Guarded rewrite" } },
			meta: { changed: true, revisions: { project: "2" } },
		});
	});

	it("rejects description and baseline options that would lose or ignore stored text", async () => {
		const projectPath = join(
			await mkdtemp(join(tmpdir(), "stepstone-application-goal-options-")),
			".worklist",
			"worklist.json",
		);
		const service = new WorklistApplicationService({ projectPath });
		const added = await service.execute(
			{ scope: "project", action: "add", title: "Stage E", description: "First paragraph." },
			{ source: "cli" },
		);
		if (!added.ok || !added.result.goal) return;
		const id = added.result.goal.id;
		const beforeRejections = await readFile(projectPath, "utf8");

		const rejections: Array<[Parameters<typeof service.execute>[0], string]> = [
			[
				{ scope: "project", action: "update", id, description: "Replace", appendDescription: "Add" },
				"mutually exclusive",
			],
			[
				{ scope: "project", action: "update", id, title: "Renamed", appendDescription: "Add" },
				"appending never changes the title",
			],
			[{ scope: "project", action: "update", id, appendDescription: "   " }, "must not be blank"],
			[
				{ scope: "project", action: "add", title: "New", appendDescription: "Add" },
				"only supported for project update",
			],
			[
				{ scope: "project", action: "update", id, title: "New", expectedUpdatedAt: "   " },
				"must not be blank",
			],
			[
				{
					scope: "project",
					action: "add",
					id,
					title: "New",
					expectedUpdatedAt: "2026-05-04T09:12:31.004Z",
				},
				"only supported for target-goal mutations",
			],
			[
				{ scope: "project", action: "list", id, expectedUpdatedAt: "2026-05-04T09:12:31.004Z" },
				"only supported for target-goal mutations",
			],
		];
		for (const [operation, message] of rejections) {
			// Each rejection is asserted against the same untouched fixture file.
			// pi-lens-ignore: await-in-loop
			const rejected = await service.execute(operation, { source: "cli" });
			expect(rejected, JSON.stringify(operation)).toMatchObject({
				ok: false,
				error: { code: WORKLIST_ERROR_CODES.VALIDATION_FAILED },
			});
			expect(rejected.ok ? "" : rejected.error.message).toContain(message);
		}
		expect(await readFile(projectPath, "utf8")).toBe(beforeRejections);

		// Session Tasks have no description, so they have no goal baseline either.
		const sessionService = new WorklistApplicationService({ sessionStore: createSessionStore().store });
		const sessionRejection = await sessionService.execute(
			{ scope: "session", action: "update", id: "task-1", expectedUpdatedAt: "2026-05-04T09:12:31.004Z" },
			{ source: "cli" },
		);
		expect(sessionRejection).toMatchObject({
			ok: false,
			error: {
				code: WORKLIST_ERROR_CODES.VALIDATION_FAILED,
				message: "expectedUpdatedAt is only supported for project goals.",
				details: { fields: ["expectedUpdatedAt"], resolution: "remove-expected-updated-at" },
			},
		});

		// The Pi tool schema is not scope-discriminated, so every project-only
		// field reaches a session call. Silently dropping one leaves the caller
		// believing it stored something it never did, which is the whole reason
		// this rejection exists, so no field may be left off the list.
		for (const [field, value, resolution] of [
			["branch", "feat/x", "use-project-start"],
			["clear", true, "use-project-start"],
			["links", ["https://example.com/spec"], "remove-links"],
			["group", "Foundation", "remove-group"],
		] as const) {
			// Each call shares the one session service, so they stay sequential.
			// pi-lens-ignore: await-in-loop
			const dropped = await sessionService.execute(
				{ scope: "session", action: "add", title: "Session task", [field]: value },
				{ source: "tool" },
			);
			expect(dropped).toMatchObject({
				ok: false,
				error: {
					code: WORKLIST_ERROR_CODES.VALIDATION_FAILED,
					message: `${field} is only supported for project goals.`,
					details: { fields: [field], resolution },
				},
			});
		}
		expect(sessionService.getSessionTasks()).toEqual([]);
	});

	it("preserves Project Goal files, revisions, and timestamps for semantic no-ops", async () => {
		const projectPath = join(
			await mkdtemp(join(tmpdir(), "stepstone-application-no-op-")),
			".worklist",
			"worklist.json",
		);
		const service = new WorklistApplicationService({ projectPath });
		const added = await service.execute(
			{ scope: "project", action: "add", title: "Stable", description: "Unchanged" },
			{ source: "cli" },
		);
		if (!added.ok || !added.result.goal) return;
		const id = added.result.goal.id;
		const createdUpdatedAt = added.result.goal.updatedAt;
		const beforeUpdate = await readFile(projectPath, "utf8");

		const sameUpdate = await service.execute(
			{
				scope: "project",
				action: "update",
				id,
				title: "Stable",
				description: "Unchanged",
				expectedRevision: "1",
			},
			{ source: "cli" },
		);
		expect(sameUpdate).toMatchObject({
			ok: true,
			result: { goal: { id, updatedAt: createdUpdatedAt } },
			meta: {
				changed: false,
				semanticNoOp: true,
				changedFields: [],
				revisions: { project: "1" },
			},
		});
		expect(await readFile(projectPath, "utf8")).toBe(beforeUpdate);

		const activated = await service.execute(
			{ scope: "project", action: "set_active", id, expectedRevision: "1" },
			{ source: "dashboard" },
		);
		expect(activated).toMatchObject({ ok: true, meta: { changed: true, revisions: { project: "2" } } });
		const beforeRepeatedActivation = await readFile(projectPath, "utf8");
		const repeatedActivation = await service.execute(
			{ scope: "project", action: "set_active", id, expectedRevision: "2" },
			{ source: "cli" },
		);
		expect(repeatedActivation).toMatchObject({
			ok: true,
			meta: { changed: false, semanticNoOp: true, revisions: { project: "2" } },
		});
		expect(await readFile(projectPath, "utf8")).toBe(beforeRepeatedActivation);

		const completed = await service.execute(
			{ scope: "project", action: "complete", id, confirm: true, expectedRevision: "2" },
			{ source: "command" },
		);
		expect(completed).toMatchObject({ ok: true, meta: { changed: true, revisions: { project: "3" } } });
		const beforeRepeatedCompletion = await readFile(projectPath, "utf8");
		const repeatedCompletion = await service.execute(
			{ scope: "project", action: "complete", id, confirm: true, expectedRevision: "3" },
			{ source: "cli" },
		);
		expect(repeatedCompletion).toMatchObject({
			ok: true,
			meta: { changed: false, semanticNoOp: true, revisions: { project: "3" } },
		});
		expect(await readFile(projectPath, "utf8")).toBe(beforeRepeatedCompletion);
	});

	it("rejects stale Session Task mutations and avoids snapshots for semantic no-ops", async () => {
		const initialRevision = "snapshot-a";
		const { entries, store } = createSessionStore();
		store.reconstruct({
			sessionManager: {
				getBranch: () => [
					{
						type: "custom",
						id: initialRevision,
						customType: "worklist-session-snapshot",
						data: {
							version: 2,
							tasks: [{ id: "task-1", title: "Original", status: "todo" }],
						},
					},
				],
			},
		} as never);
		const service = new WorklistApplicationService({ sessionStore: store });

		const updated = await service.execute(
			{
				scope: "session",
				action: "update",
				id: "task-1",
				title: "Newer title",
				expectedRevision: initialRevision,
			},
			{ source: "dashboard" },
		);
		expect(updated).toMatchObject({
			ok: true,
			meta: { changed: true, semanticNoOp: false, revisions: { session: expect.any(String) } },
		});
		if (!updated.ok) return;
		const currentRevision = updated.meta.revisions?.session;
		expect(currentRevision).not.toBe(initialRevision);
		expect(entries).toHaveLength(1);

		const conflict = await service.execute(
			{
				scope: "session",
				action: "update",
				id: "task-1",
				title: "Stale overwrite",
				expectedRevision: initialRevision,
			},
			{ source: "cli" },
		);
		expect(conflict).toEqual({
			ok: false,
			scope: "session",
			action: "update",
			error: {
				code: WORKLIST_ERROR_CODES.CONFLICT,
				message: `Session task revision changed from ${initialRevision} to ${currentRevision}.`,
				retryable: true,
				conflict: {
					type: "revision",
					expectedRevision: initialRevision,
					actualRevision: currentRevision,
					resolution: "refresh-and-retry",
				},
			},
			meta: {
				changed: false,
				semanticNoOp: false,
				changedFields: [],
				revisions: { session: currentRevision },
			},
		});
		expect(store.getTasks()[0]?.title).toBe("Newer title");
		expect(entries).toHaveLength(1);

		const noOp = await service.execute(
			{
				scope: "session",
				action: "update",
				id: "task-1",
				title: "Newer title",
				expectedRevision: currentRevision,
			},
			{ source: "cli" },
		);
		expect(noOp).toMatchObject({
			ok: true,
			meta: {
				changed: false,
				semanticNoOp: true,
				revisions: { session: currentRevision },
			},
		});
		expect(entries).toHaveLength(1);
	});

	it("reports queued identical Session Task mutations as one change and one semantic no-op", async () => {
		const { entries, store } = createSessionStore();
		store.setTasks([{ id: "task-1", title: "Original", status: "todo" }]);
		const service = new WorklistApplicationService({ sessionStore: store });

		const [first, second] = await Promise.all([
			service.execute(
				{ scope: "session", action: "update", id: "task-1", title: "Shared result" },
				{ source: "dashboard" },
			),
			service.execute(
				{ scope: "session", action: "update", id: "task-1", title: "Shared result" },
				{ source: "cli" },
			),
		]);

		expect(first).toMatchObject({
			ok: true,
			meta: { changed: true, semanticNoOp: false, revisions: { session: expect.any(String) } },
		});
		expect(second).toMatchObject({
			ok: true,
			meta: { changed: false, semanticNoOp: true, revisions: first.meta.revisions },
		});
		expect(entries).toHaveLength(1);
	});

	it("returns the same deterministic success and error envelopes to every interface", async () => {
		const { store } = createSessionStore();
		store.setTasks([{ id: "task-1", title: "Deterministic", status: "doing" }]);
		const service = new WorklistApplicationService({ sessionStore: store });
		const sources = [
			"tool",
			"command",
			"dashboard",
			"cli",
		] as const satisfies readonly WorklistOperationSource[];

		const successes = await Promise.all(
			sources.map((source) => service.execute({ scope: "session", action: "list" }, { source })),
		);
		expect(successes).toEqual(
			sources.map(() => ({
				ok: true,
				scope: "session",
				action: "list",
				result: {
					scope: "session",
					action: "list",
					tasks: [{ id: "task-1", title: "Deterministic", status: "doing" }],
				},
				meta: {
					changed: false,
					semanticNoOp: false,
					changedFields: [],
					revisions: { session: "0" },
				},
			})),
		);

		const failures = await Promise.all(
			sources.map((source) =>
				service.execute({ scope: "session", action: "move", id: "task-1" }, { source }),
			),
		);
		expect(failures).toEqual(
			sources.map(() => ({
				ok: false,
				scope: "session",
				action: "move",
				error: {
					code: WORKLIST_ERROR_CODES.VALIDATION_FAILED,
					message: "Session move requires exactly one of beforeId or afterId.",
					retryable: false,
					details: {
						fields: ["afterId", "beforeId"],
						resolution: "provide-one-placement-anchor",
					},
				},
				meta: { changed: false, semanticNoOp: false, changedFields: [] },
			})),
		);

		await expect(
			service.execute(
				{ scope: "session", action: "move", id: "task-1", beforeId: "task-1" },
				{ source: "dashboard" },
			),
		).resolves.toMatchObject({
			ok: true,
			meta: { changed: false, semanticNoOp: true, changedFields: [] },
		});
	});

	it("returns actionable not-found and approval errors without rejecting", async () => {
		const projectPath = join(
			await mkdtemp(join(tmpdir(), "stepstone-application-errors-")),
			".worklist",
			"worklist.json",
		);
		const { store } = createSessionStore();
		const service = new WorklistApplicationService({ sessionStore: store, projectPath });

		await expect(
			service.execute({ scope: "session", action: "delete", id: "missing" }, { source: "tool" }),
		).resolves.toEqual({
			ok: false,
			scope: "session",
			action: "delete",
			error: {
				code: WORKLIST_ERROR_CODES.NOT_FOUND,
				message: "Session task missing was not found.",
				retryable: false,
				details: { entity: "session-task", id: "missing", resolution: "refresh-and-select-existing" },
			},
			meta: { changed: false, semanticNoOp: false, changedFields: [] },
		});

		const added = await service.execute(
			{ scope: "project", action: "add", title: "Protected goal" },
			{ source: "command" },
		);
		expect(added.ok).toBe(true);
		if (!added.ok) return;
		const id = added.result.goal?.id;
		expect(id).toBeTruthy();
		await expect(
			service.execute({ scope: "project", action: "complete", id }, { source: "cli" }),
		).resolves.toEqual({
			ok: false,
			scope: "project",
			action: "complete",
			error: {
				code: WORKLIST_ERROR_CODES.APPROVAL_REQUIRED,
				message: "Project complete requires explicit confirmation.",
				retryable: false,
				details: { confirmation: "confirm=true", resolution: "request-explicit-user-confirmation" },
			},
			meta: { changed: false, semanticNoOp: false, changedFields: [] },
		});
	});

	it("classifies malformed persistence deterministically without exposing raw exceptions", async () => {
		const projectPath = join(
			await mkdtemp(join(tmpdir(), "stepstone-application-persistence-")),
			".worklist",
			"worklist.json",
		);
		await mkdir(join(projectPath, ".."), { recursive: true });
		await writeFile(projectPath, "not json\n");
		const service = new WorklistApplicationService({ projectPath });

		await expect(service.execute({ scope: "project", action: "list" }, { source: "cli" })).resolves.toEqual({
			ok: false,
			scope: "project",
			action: "list",
			error: {
				code: WORKLIST_ERROR_CODES.PERSISTENCE_FAILED,
				message: `Malformed project worklist or unsupported schema. Repair ${projectPath} before retrying.`,
				retryable: false,
				details: { resolution: "repair-project-file", path: projectPath },
			},
			meta: { changed: false, semanticNoOp: false, changedFields: [] },
		});
		await expect(service.readProjectSnapshot("migrate_ids")).resolves.toEqual({
			ok: false,
			scope: "project",
			action: "migrate_ids",
			error: {
				code: WORKLIST_ERROR_CODES.PERSISTENCE_FAILED,
				message: `Malformed project worklist or unsupported schema. Repair ${projectPath} before retrying.`,
				retryable: false,
				details: { resolution: "repair-project-file", path: projectPath },
			},
			meta: { changed: false, semanticNoOp: false, changedFields: [] },
		});
	});

	it("applies one operation contract for tool, command, dashboard, and CLI callers", async () => {
		const projectPath = join(
			await mkdtemp(join(tmpdir(), "stepstone-application-service-")),
			".worklist",
			"worklist.json",
		);
		const { entries, store } = createSessionStore();
		const service = new WorklistApplicationService({ sessionStore: store, projectPath });
		const sources = [
			"tool",
			"command",
			"dashboard",
			"cli",
		] as const satisfies readonly WorklistOperationSource[];

		for (const [index, source] of sources.entries()) {
			await service.execute({ scope: "session", action: "add", title: `${source} task` }, { source });
			const id = service.getSessionTasks().at(-1)?.id;
			expect(id).toBeTruthy();
			await service.execute(
				{ scope: "session", action: "set_status", id, status: index % 2 === 0 ? "doing" : "done" },
				{ source },
			);
		}

		expect(service.getSessionTasks().map(({ title, status }) => ({ title, status }))).toEqual([
			{ title: "tool task", status: "doing" },
			{ title: "command task", status: "done" },
			{ title: "dashboard task", status: "doing" },
			{ title: "cli task", status: "done" },
		]);
		expect(entries).toHaveLength(8);

		const added = await service.execute(
			{ scope: "project", action: "add", title: "Shared goal", description: "One rule set" },
			{ source: "cli" },
		);
		const goalId = unwrapWorklistApplicationResult(added).goal?.id;
		expect(goalId).toBeTruthy();
		await service.execute(
			{ scope: "project", action: "update", id: goalId, title: "Updated through dashboard" },
			{ source: "dashboard" },
		);
		const listed = unwrapWorklistApplicationResult(
			await service.execute({ scope: "project", action: "list" }, { source: "tool" }),
		);
		expect(listed.goals).toEqual([
			expect.objectContaining({
				id: goalId,
				title: "Updated through dashboard",
				description: "One rule set",
			}),
		]);
	});

	it("resolves goal selectors for every interface and refuses ambiguous ones", async () => {
		const projectPath = join(
			await mkdtemp(join(tmpdir(), "stepstone-application-selector-")),
			".worklist",
			"worklist.json",
		);
		const service = new WorklistApplicationService({ projectPath });
		await service.execute({ scope: "project", action: "add", title: "Ship the CLI" }, { source: "cli" });
		await service.execute({ scope: "project", action: "add", title: "Ship the CLI" }, { source: "cli" });
		await service.execute(
			{ scope: "project", action: "add", title: "Support goal templates" },
			{ source: "tool" },
		);

		// A prefix resolves the same way whichever interface sends it.
		for (const source of ["tool", "command", "dashboard", "cli"] as const) {
			await expect(
				service.execute(
					{ scope: "project", action: "update", id: "supp", title: `Renamed by ${source}` },
					{ source },
				),
			).resolves.toMatchObject({
				ok: true,
				result: { goal: { id: "support-goal-templates", title: `Renamed by ${source}` } },
				meta: { changedEntities: { projectGoalIds: ["support-goal-templates"] } },
			});
			await expect(
				service.execute({ scope: "project", action: "update", id: "ship", title: "Guessed" }, { source }),
			).resolves.toMatchObject({
				ok: false,
				error: {
					code: WORKLIST_ERROR_CODES.VALIDATION_FAILED,
					details: {
						resolution: "provide-unambiguous-goal-id",
						candidateCount: 2,
						candidates: [{ id: "ship-the-cli" }, { id: "ship-the-cli-2" }],
					},
				},
			});
		}
		expect((await service.getProjectGoals()).map((goal) => goal.title)).toEqual([
			"Ship the CLI",
			"Ship the CLI",
			"Renamed by cli",
		]);

		// A baseline guard applies to the goal the selector resolved to, not to the
		// literal text the caller typed, so a prefix cannot slip past the check.
		const resolved = (await service.getProjectGoals()).find((goal) => goal.id === "support-goal-templates");
		await expect(
			service.execute(
				{
					scope: "project",
					action: "update",
					id: "supp",
					title: "Stale",
					expectedUpdatedAt: "2020-01-01T00:00:00.000Z",
				},
				{ source: "cli" },
			),
		).resolves.toMatchObject({
			ok: false,
			error: {
				code: WORKLIST_ERROR_CODES.CONFLICT,
				conflict: { type: "goal-updated-at", id: "support-goal-templates" },
			},
		});
		await expect(
			service.execute(
				{
					scope: "project",
					action: "update",
					id: "supp",
					title: "Fresh",
					expectedUpdatedAt: resolved?.updatedAt,
				},
				{ source: "cli" },
			),
		).resolves.toMatchObject({ ok: true, result: { goal: { id: "support-goal-templates" } } });
	});

	it("migrates generated goal IDs only on explicit confirmation", async () => {
		const projectPath = join(
			await mkdtemp(join(tmpdir(), "stepstone-application-migrate-")),
			".worklist",
			"worklist.json",
		);
		await mkdir(dirname(projectPath), { recursive: true });
		await writeFile(
			projectPath,
			`${JSON.stringify({
				version: 1,
				revision: 1,
				goals: [
					{
						id: "goal-ms6gwxrg-56c1bde6",
						title: "Support goal templates",
						status: "active",
						createdAt: "2026-05-04T09:12:31.004Z",
						updatedAt: "2026-05-04T09:12:31.004Z",
					},
					{
						id: "dependency-graph",
						title: "Dependency graph",
						status: "open",
						createdAt: "2026-05-04T09:12:31.004Z",
						updatedAt: "2026-05-04T09:12:31.004Z",
						dependsOn: ["goal-ms6gwxrg-56c1bde6"],
					},
				],
			})}\n`,
			"utf8",
		);
		const service = new WorklistApplicationService({ projectPath });
		await expect(service.readProjectSnapshot("migrate_ids")).resolves.toMatchObject({
			ok: true,
			action: "migrate_ids",
			result: {
				goals: [{ id: "goal-ms6gwxrg-56c1bde6" }, { id: "dependency-graph" }],
				retiredIds: [],
			},
			meta: {
				changed: false,
				semanticNoOp: false,
				revisions: { project: "1" },
			},
		});

		const refused = await service.execute({ scope: "project", action: "migrate_ids" }, { source: "cli" });
		expect(refused).toMatchObject({
			ok: false,
			error: { code: WORKLIST_ERROR_CODES.APPROVAL_REQUIRED, retryable: false },
		});
		expect((await service.getProjectGoals())[0].id).toBe("goal-ms6gwxrg-56c1bde6");

		const migrated = await service.execute(
			{ scope: "project", action: "migrate_ids", confirm: true },
			{ source: "cli" },
		);
		expect(migrated).toMatchObject({
			ok: true,
			result: {
				migrations: [{ from: "goal-ms6gwxrg-56c1bde6", to: "support-goal-templates" }],
				goals: [
					{ id: "support-goal-templates" },
					{ id: "dependency-graph", dependsOn: ["support-goal-templates"] },
				],
			},
			meta: {
				changed: true,
				semanticNoOp: false,
				changedEntities: {
					projectGoalIds: ["dependency-graph", "support-goal-templates"],
				},
				revisions: { project: "2" },
			},
		});

		// Whatever still refers to the goal by its old ID keeps resolving to it.
		await expect(
			service.execute(
				{ scope: "project", action: "update", id: "goal-ms6gwxrg-56c1bde6", title: "Still reachable" },
				{ source: "tool" },
			),
		).resolves.toMatchObject({ ok: true, result: { goal: { id: "support-goal-templates" } } });

		const rerun = await service.execute(
			{ scope: "project", action: "migrate_ids", confirm: true },
			{ source: "cli" },
		);
		expect(rerun).toMatchObject({
			ok: true,
			result: { migrations: [] },
			meta: { changed: false, semanticNoOp: true, revisions: { project: "3" } },
		});
	});

	it("moves the goal file only on explicit confirmation, and reports the location as what changed", async () => {
		const root = await mkdtemp(join(tmpdir(), "stepstone-application-migrate-path-"));
		const legacyPath = join(root, ".pi", "worklist.json");
		const currentPath = join(root, ".worklist", "worklist.json");
		await mkdir(dirname(legacyPath), { recursive: true });
		await writeFile(
			legacyPath,
			`${JSON.stringify({
				version: 1,
				revision: 7,
				goals: [
					{
						id: "carried-across",
						title: "Carried across",
						status: "open",
						createdAt: "2026-05-04T09:12:31.004Z",
						updatedAt: "2026-05-04T09:12:31.004Z",
					},
				],
			})}\n`,
			"utf8",
		);
		const service = new WorklistApplicationService({ projectPath: legacyPath });

		const refused = await service.execute(
			{ scope: "project", action: "migrate_path", targetPath: currentPath },
			{ source: "cli" },
		);
		expect(refused).toMatchObject({
			ok: false,
			error: { code: WORKLIST_ERROR_CODES.APPROVAL_REQUIRED, retryable: false },
		});
		expect(await readFile(legacyPath, "utf8")).toContain("carried-across");

		const migrated = await service.execute(
			{ scope: "project", action: "migrate_path", targetPath: currentPath, confirm: true },
			{ source: "cli" },
		);
		expect(migrated).toMatchObject({
			ok: true,
			action: "migrate_path",
			result: {
				goals: [{ id: "carried-across" }],
				worklistPath: currentPath,
				previousWorklistPath: legacyPath,
			},
			meta: {
				changed: true,
				semanticNoOp: false,
				// Every goal moved and none was edited, so no goal is reported as changed.
				changedFields: ["/worklistPath"],
				changedEntities: { projectGoalIds: [], sessionTaskIds: [] },
				revisions: { project: "7" },
			},
		});
		expect(await readFile(currentPath, "utf8")).toContain("carried-across");

		// The service now answers from the file it moved, and asking again is the
		// no-op an ID migration reports when no ID needs rewriting.
		service.setProjectPathResolver(() => currentPath);
		await expect(
			service.execute(
				{ scope: "project", action: "migrate_path", targetPath: currentPath, confirm: true },
				{ source: "cli" },
			),
		).resolves.toMatchObject({
			ok: true,
			result: { worklistPath: currentPath, goals: [{ id: "carried-across" }] },
			meta: { changed: false, semanticNoOp: true, changedFields: [] },
		});
	});

	it("refuses to move a goal file onto one that already exists", async () => {
		const root = await mkdtemp(join(tmpdir(), "stepstone-application-migrate-clash-"));
		const legacyPath = join(root, ".pi", "worklist.json");
		const currentPath = join(root, ".worklist", "worklist.json");
		const contents = `${JSON.stringify({ version: 1, revision: 0, goals: [] })}\n`;
		await mkdir(dirname(legacyPath), { recursive: true });
		await mkdir(dirname(currentPath), { recursive: true });
		await writeFile(legacyPath, contents, "utf8");
		await writeFile(currentPath, contents, "utf8");
		const service = new WorklistApplicationService({ projectPath: legacyPath });

		await expect(
			service.execute(
				{ scope: "project", action: "migrate_path", targetPath: currentPath, confirm: true },
				{ source: "cli" },
			),
		).resolves.toMatchObject({
			ok: false,
			error: {
				code: WORKLIST_ERROR_CODES.VALIDATION_FAILED,
				retryable: false,
				details: { path: currentPath, conflictingPath: legacyPath, resolution: "merge-worklists-by-hand" },
			},
		});
		expect(await readFile(legacyPath, "utf8")).toBe(contents);
	});

	it("refuses a target path on any action that would ignore it", async () => {
		const projectPath = join(
			await mkdtemp(join(tmpdir(), "stepstone-application-target-path-")),
			".worklist",
			"worklist.json",
		);
		const service = new WorklistApplicationService({ projectPath });
		await expect(
			service.execute(
				{ scope: "project", action: "add", title: "Somewhere else", targetPath: "/tmp/elsewhere.json" },
				{ source: "tool" },
			),
		).resolves.toMatchObject({
			ok: false,
			error: {
				code: WORKLIST_ERROR_CODES.VALIDATION_FAILED,
				message: "targetPath is only supported for project migrate_path.",
			},
		});
	});

	it("reorders Project Goals without confirmation and reports the move as one change", async () => {
		const projectPath = join(
			await mkdtemp(join(tmpdir(), "stepstone-application-move-")),
			".worklist",
			"worklist.json",
		);
		const service = new WorklistApplicationService({ projectPath });
		for (const title of ["First", "Second", "Third"]) {
			// Each add depends on the goals the previous one left behind.
			await service.execute({ scope: "project", action: "add", title }, { source: "cli" });
		}

		const moved = await service.execute(
			{ scope: "project", action: "move", id: "third", direction: "up" },
			{ source: "tool" },
		);
		expect(moved).toMatchObject({
			ok: true,
			action: "move",
			meta: {
				changed: true,
				semanticNoOp: false,
				changedFields: ["/goals"],
				changedEntities: { projectGoalIds: ["third"], sessionTaskIds: [] },
				revisions: { project: "4" },
			},
		});
		expect(unwrapWorklistApplicationResult(moved).goals?.map((goal) => goal.id)).toEqual([
			"first",
			"third",
			"second",
		]);

		// A move names only a position, so it is never gated behind confirmation and
		// never leaves the moved goal looking edited.
		const before = (await service.getProjectGoals()).find((goal) => goal.id === "third");
		const again = await service.execute(
			{ scope: "project", action: "move", id: "third", beforeId: "second" },
			{ source: "dashboard" },
		);
		expect(again).toMatchObject({ ok: true, meta: { changed: false, semanticNoOp: true } });
		expect((await service.getProjectGoals()).find((goal) => goal.id === "third")).toEqual(before);

		await expect(
			service.execute({ scope: "project", action: "move", id: "third" }, { source: "cli" }),
		).resolves.toMatchObject({
			ok: false,
			error: {
				code: WORKLIST_ERROR_CODES.VALIDATION_FAILED,
				details: { fields: ["afterId", "beforeId", "direction"] },
			},
		});
		await service.execute({ scope: "project", action: "add", title: "First follow-up" }, { source: "cli" });
		for (const field of ["beforeId", "afterId"] as const) {
			await expect(
				service.execute({ scope: "project", action: "move", id: "third", [field]: "fir" }, { source: "cli" }),
			).resolves.toMatchObject({
				ok: false,
				error: {
					code: WORKLIST_ERROR_CODES.VALIDATION_FAILED,
					details: { fields: [field], resolution: "provide-unambiguous-goal-id" },
				},
			});
		}
		await expect(
			service.execute({ scope: "project", action: "update", id: "third", group: "X" }, { source: "cli" }),
		).resolves.toMatchObject({ ok: true, result: { goal: { group: "X" } } });
		await expect(
			service.execute({ scope: "project", action: "set_active", id: "third", group: "X" }, { source: "cli" }),
		).resolves.toMatchObject({
			ok: false,
			error: { code: WORKLIST_ERROR_CODES.VALIDATION_FAILED, details: { fields: ["group"] } },
		});
	});

	it("resolves dependency edges the same way as every other goal reference", async () => {
		const projectPath = join(
			await mkdtemp(join(tmpdir(), "stepstone-application-dependencies-")),
			".worklist",
			"worklist.json",
		);
		const service = new WorklistApplicationService({ projectPath });
		for (const title of ["Slug ids", "Schema fields"]) {
			// Each add reads the IDs the previous one minted, so they run in turn.
			// pi-lens-ignore: await-in-loop
			await service.execute({ scope: "project", action: "add", title }, { source: "cli" });
		}

		// A prefix names a goal in an edge exactly as it does in an id argument.
		const added = await service.execute(
			{ scope: "project", action: "add", title: "Dependency graph", dependsOn: ["slug", "schema"] },
			{ source: "cli" },
		);
		expect(added).toMatchObject({
			ok: true,
			result: { goal: { dependsOn: ["slug-ids", "schema-fields"] } },
		});

		await expect(
			service.execute(
				{ scope: "project", action: "update", id: "dependency-graph", dependsOn: ["s"] },
				{ source: "cli" },
			),
		).resolves.toMatchObject({
			ok: false,
			error: {
				code: WORKLIST_ERROR_CODES.VALIDATION_FAILED,
				details: { fields: ["dependsOn"], resolution: "provide-unambiguous-goal-id" },
			},
		});
		await expect(
			service.execute(
				{ scope: "project", action: "add", title: "Blank edge", dependsOn: ["slug-ids", "  "] },
				{ source: "cli" },
			),
		).resolves.toMatchObject({
			ok: false,
			error: {
				code: WORKLIST_ERROR_CODES.VALIDATION_FAILED,
				details: { fields: ["dependsOn"], resolution: "provide-non-blank-goal-ids" },
			},
		});
		await expect(
			service.execute(
				{ scope: "project", action: "add", title: "Unknown edge", dependsOn: ["nowhere"] },
				{ source: "cli" },
			),
		).resolves.toMatchObject({
			ok: false,
			error: {
				code: WORKLIST_ERROR_CODES.NOT_FOUND,
				details: { entity: "project-goal-dependency", id: "nowhere" },
			},
		});
		await expect(
			service.execute(
				{ scope: "project", action: "set_active", id: "slug-ids", dependsOn: ["schema-fields"] },
				{ source: "cli" },
			),
		).resolves.toMatchObject({
			ok: false,
			error: {
				code: WORKLIST_ERROR_CODES.VALIDATION_FAILED,
				details: { fields: ["dependsOn"], resolution: "use-project-add-or-update" },
			},
		});
		const withSession = new WorklistApplicationService({
			sessionStore: createSessionStore().store,
			projectPath,
		});
		await expect(
			withSession.execute(
				{ scope: "session", action: "add", title: "Task", dependsOn: ["slug-ids"] },
				{ source: "cli" },
			),
		).resolves.toMatchObject({
			ok: false,
			error: {
				code: WORKLIST_ERROR_CODES.VALIDATION_FAILED,
				details: { fields: ["dependsOn"], resolution: "remove-depends-on" },
			},
		});
	});

	it("reports a refused cycle with the goals on it, and writes nothing", async () => {
		const projectPath = join(
			await mkdtemp(join(tmpdir(), "stepstone-application-cycle-")),
			".worklist",
			"worklist.json",
		);
		const service = new WorklistApplicationService({ projectPath });
		await service.execute({ scope: "project", action: "add", title: "Slug ids" }, { source: "cli" });
		await service.execute(
			{ scope: "project", action: "add", title: "Dependency graph", dependsOn: ["slug-ids"] },
			{ source: "cli" },
		);
		const before = await readFile(projectPath, "utf8");

		await expect(
			service.execute(
				{ scope: "project", action: "update", id: "slug-ids", dependsOn: ["dependency-graph"] },
				{ source: "tool" },
			),
		).resolves.toMatchObject({
			ok: false,
			error: {
				code: WORKLIST_ERROR_CODES.DEPENDENCY_CYCLE,
				retryable: false,
				details: {
					fields: ["dependsOn"],
					cycle: ["slug-ids", "dependency-graph"],
					cyclePath: "slug-ids -> dependency-graph -> slug-ids",
					resolution: "remove-an-edge-from-the-cycle",
				},
			},
			meta: { changed: false },
		});
		expect(await readFile(projectPath, "utf8")).toBe(before);
	});

	it("warns about a blocked activation instead of refusing it", async () => {
		const projectPath = join(
			await mkdtemp(join(tmpdir(), "stepstone-application-blocked-")),
			".worklist",
			"worklist.json",
		);
		const service = new WorklistApplicationService({ projectPath });
		await service.execute({ scope: "project", action: "add", title: "Slug ids" }, { source: "cli" });
		await service.execute(
			{ scope: "project", action: "add", title: "Dependency graph", dependsOn: ["slug-ids"] },
			{ source: "cli" },
		);

		// Blocked is a reading of the graph, so the activation still happens.
		await expect(
			service.execute({ scope: "project", action: "set_active", id: "dependency-graph" }, { source: "cli" }),
		).resolves.toMatchObject({
			ok: true,
			result: { goal: { id: "dependency-graph", status: "active" }, blockedBy: ["slug-ids"] },
		});

		await service.execute(
			{ scope: "project", action: "complete", id: "slug-ids", confirm: true },
			{ source: "cli" },
		);
		const unblocked = await service.execute(
			{ scope: "project", action: "set_active", id: "dependency-graph" },
			{ source: "cli" },
		);
		expect(unblocked.ok && Object.hasOwn(unblocked.result, "blockedBy")).toBe(false);
	});

	it("reports the goals that lost an edge to a deleted goal", async () => {
		const projectPath = join(
			await mkdtemp(join(tmpdir(), "stepstone-application-strip-")),
			".worklist",
			"worklist.json",
		);
		const service = new WorklistApplicationService({ projectPath });
		await service.execute({ scope: "project", action: "add", title: "Slug ids" }, { source: "cli" });
		await service.execute(
			{ scope: "project", action: "add", title: "Dependency graph", dependsOn: ["slug-ids"] },
			{ source: "cli" },
		);

		await expect(
			service.execute(
				{ scope: "project", action: "delete", id: "slug-ids", confirm: true },
				{ source: "cli" },
			),
		).resolves.toMatchObject({
			ok: true,
			meta: { changedEntities: { projectGoalIds: ["dependency-graph", "slug-ids"] } },
		});
		expect((await service.getProjectGoals())[0].dependsOn).toBeUndefined();
	});

	it("refuses a claim on a finished goal as a permanent refusal rather than a retryable failure", async () => {
		const projectPath = join(
			await mkdtemp(join(tmpdir(), "stepstone-application-start-blocked-")),
			".worklist",
			"worklist.json",
		);
		const service = new WorklistApplicationService({ projectPath });

		for (const { action, status, retainsClaim } of [
			{ action: "complete", status: "done", retainsClaim: false },
			{ action: "archive", status: "archived", retainsClaim: true },
		] as const) {
			const added = await service.execute(
				{ scope: "project", action: "add", title: `Finished by ${action}` },
				{ source: "cli" },
			);
			const id = unwrapWorklistApplicationResult(added).goal?.id;
			await expect(
				service.execute({ scope: "project", action: "start", id, branch: "feat/claim" }, { source: "cli" }),
			).resolves.toMatchObject({ ok: true, result: { goal: { id, branch: "feat/claim" } } });
			await expect(
				service.execute({ scope: "project", action, id, confirm: true }, { source: "cli" }),
			).resolves.toMatchObject({ ok: true, result: { goal: { id, status } } });

			// Only done releases the claim on its way through; archiving keeps it,
			// which is the state a release has to still be able to reach.
			const finished = (await service.getProjectGoals()).find((goal) => goal.id === id);
			expect(finished).toMatchObject({ status });
			if (retainsClaim) expect(finished).toMatchObject({ branch: "feat/claim" });
			else expect(finished).not.toHaveProperty("branch");

			if (action === "complete") {
				const historicalCompletedAt = finished?.completedAt;
				const worklist = JSON.parse(await readFile(projectPath, "utf8")) as ProjectWorklist;
				const stored = worklist.goals.find((goal) => goal.id === id);
				if (!stored) throw new Error(`Finished goal ${id} was not stored`);
				stored.branch = "feat/stale-claim";
				await writeFile(projectPath, `${JSON.stringify(worklist, null, 2)}\n`);

				const cleaned = await service.execute(
					{ scope: "project", action: "complete", id, confirm: true },
					{ source: "cli" },
				);
				expect(cleaned).toMatchObject({
					ok: true,
					result: { goal: { status: "done", completedAt: historicalCompletedAt } },
					meta: { changed: true },
				});
				if (cleaned.ok) expect(cleaned.result.goal).not.toHaveProperty("branch");
			}

			// A dispatcher told `retryable: true` retries a refusal that can never
			// succeed, and the persistence wording sends a human to check repository
			// access and the lock for a condition that is neither. `set_active`
			// already answers this correctly, so `start` has to match it.
			const refused = await service.execute(
				{ scope: "project", action: "start", id, branch: "feat/second" },
				{ source: "cli" },
			);
			expect(refused).toMatchObject({
				ok: false,
				scope: "project",
				action: "start",
				error: {
					code: WORKLIST_ERROR_CODES.VALIDATION_FAILED,
					retryable: false,
					details: { id, resolution: "reopen-project-goal" },
				},
				meta: { changed: false },
			});
			expect((await service.getProjectGoals()).find((goal) => goal.id === id)?.branch).toBe(
				retainsClaim ? "feat/claim" : undefined,
			);

			// Releasing is not an activation, so the claim archiving kept can still
			// be dropped without reopening the goal first.
			await expect(
				service.execute({ scope: "project", action: "start", id, clear: true }, { source: "cli" }),
			).resolves.toMatchObject({ ok: true, action: "start", meta: { changed: retainsClaim } });
			expect((await service.getProjectGoals()).find((goal) => goal.id === id)).not.toHaveProperty("branch");
		}
	});

	it("enforces shared validation and explicit confirmation regardless of caller", async () => {
		const projectPath = join(
			await mkdtemp(join(tmpdir(), "stepstone-application-validation-")),
			".worklist",
			"worklist.json",
		);
		const { store } = createSessionStore();
		const service = new WorklistApplicationService({ sessionStore: store, projectPath });
		const added = await service.execute(
			{ scope: "project", action: "add", title: "Protected goal" },
			{ source: "command" },
		);
		const id = unwrapWorklistApplicationResult(added).goal?.id;

		for (const source of ["tool", "command", "dashboard", "cli"] as const) {
			await expect(
				service.execute(
					{ scope: "session", action: "add", title: "Invalid", beforeId: "a", afterId: "b" },
					{ source },
				),
			).resolves.toMatchObject({
				ok: false,
				error: { code: WORKLIST_ERROR_CODES.VALIDATION_FAILED, retryable: false },
			});
			await expect(
				service.execute({ scope: "project", action: "complete", id }, { source }),
			).resolves.toMatchObject({
				ok: false,
				error: { code: WORKLIST_ERROR_CODES.APPROVAL_REQUIRED, retryable: false },
			});
		}

		expect((await service.getProjectGoals()).find((goal) => goal.id === id)?.status).toBe("open");
		await expect(
			service.execute({ scope: "project", action: "complete", id, confirm: true }, { source: "dashboard" }),
		).resolves.toMatchObject({ ok: true, result: { goal: { id, status: "done" } } });
	});
});
