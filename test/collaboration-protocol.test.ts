import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorklistApplicationService } from "../src/application-service.ts";
import type { CollaborationCommand } from "../src/collaboration-protocol.ts";
import { CollaborationService } from "../src/collaboration-protocol.ts";

const owner = { id: "owner", role: "owner" as const };
const editor = { id: "editor", role: "editor" as const };
const reader = { id: "reader", role: "reader" as const };
let directory: string;
let path: string;
let service: CollaborationService;
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "stepstone-protocol-"));
	path = join(directory, "state.json");
	service = new CollaborationService({ resolvePath: () => path });
});
afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});
async function init() {
	return service.initialize(owner, { title: "Proof", confirm: true });
}
async function command(patch: Partial<CollaborationCommand> = {}) {
	const snapshot = await service.snapshot(owner);
	return {
		version: 1 as const,
		commandId: randomUUID(),
		projectId: snapshot.projectId,
		expectedRevision: snapshot.revision,
		action: "add" as const,
		title: "Task",
		...patch,
	};
}
describe("collaboration aggregate", () => {
	it("commits task, identity, receipt and event together and replays after restart", async () => {
		await init();
		const input = await command();
		const receipt = await service.execute(editor, input);
		const restarted = new CollaborationService({ resolvePath: () => path });
		expect(await restarted.execute(editor, input)).toEqual(receipt);
		const snapshot = await restarted.snapshot(reader);
		expect(snapshot.tasks).toHaveLength(1);
		expect(snapshot.tasks[0].taskId).toBe(receipt.taskId);
		expect(snapshot.cursor).toBe(1);
		expect(await restarted.events(reader, 0)).toEqual([
			expect.objectContaining({ commandId: input.commandId, actorId: editor.id, cursor: 1 }),
		]);
		const disk = JSON.parse(await readFile(path, "utf8"));
		expect(disk.collaboration.receipts[input.commandId].receipt).toEqual(receipt);
	});
	it("serializes racing commands and leaves a stale command uncommitted", async () => {
		await init();
		const input = await command();
		const results = await Promise.allSettled([
			service.execute(owner, input),
			service.execute(owner, { ...input, commandId: randomUUID(), title: "Other" }),
		]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
		expect((await service.snapshot(reader)).tasks).toHaveLength(1);
		expect(await service.events(reader, 0)).toHaveLength(1);
	});
	it("rejects command reuse with different content or actor before stale checks", async () => {
		await init();
		const input = await command();
		await service.execute(owner, input);
		await expect(service.execute(owner, { ...input, title: "Different" })).rejects.toMatchObject({
			code: "IDEMPOTENCY_CONFLICT",
		});
		await expect(service.execute(editor, input)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
	});
	it("enforces strict envelopes, roles, revision and lifecycle confirmation", async () => {
		await init();
		await expect(service.execute(reader, await command())).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(service.execute(owner, { ...(await command()), unexpected: true })).rejects.toMatchObject({
			code: "VALIDATION_FAILED",
		});
		await expect(
			service.execute(owner, { ...(await command()), projectId: randomUUID() }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		const add = await service.execute(owner, await command());
		const complete = await command({ action: "complete", taskId: add.taskId, title: undefined });
		const before = await readFile(path, "utf8");
		await expect(service.execute(owner, complete)).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
		expect(await readFile(path, "utf8")).toBe(before);
		await service.execute(owner, { ...complete, confirm: true });
		await expect(
			service.execute(owner, { ...complete, commandId: randomUUID(), confirm: true }),
		).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
		await expect(
			service.execute(
				editor,
				await command({ action: "delete", taskId: add.taskId, title: undefined, confirm: true }),
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
	it("preserves former and retired IDs through explicit adoption and deletion", async () => {
		const now = new Date().toISOString();
		await writeFile(
			path,
			JSON.stringify({
				version: 1,
				revision: 0,
				goals: [
					{
						id: "stable",
						previousIds: ["former"],
						title: "Existing",
						status: "active",
						createdAt: now,
						updatedAt: now,
					},
				],
				retiredIds: ["old-retired"],
			}),
		);
		const snapshot = await init();
		const taskId = snapshot.tasks[0].taskId;
		await service.execute(owner, await command({ action: "update", taskId, title: "Renamed" }));
		expect((await service.snapshot(reader)).tasks[0]).toMatchObject({
			taskId,
			goal: { id: "stable", previousIds: ["former"] },
		});
		await service.execute(
			owner,
			await command({ action: "delete", taskId, title: undefined, confirm: true }),
		);
		expect((await service.snapshot(reader)).retiredIds).toEqual(
			expect.arrayContaining(["stable", "former", "old-retired"]),
		);
		expect(JSON.parse(await readFile(path, "utf8")).collaboration.identities.stable).toBe(taskId);
	});
	it("rejects uninitialized stores, repeated initialization and invalid cursors", async () => {
		await expect(service.snapshot(reader)).rejects.toMatchObject({ code: "INVALID_STORE" });
		await expect(service.initialize(editor, { title: "Proof", confirm: true })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(service.initialize(owner, { title: "Proof", confirm: false })).rejects.toMatchObject({
			code: "APPROVAL_REQUIRED",
		});
		await init();
		await expect(init()).rejects.toMatchObject({ code: "ALREADY_INITIALIZED" });
		for (const cursor of [-1, 1, 0.5])
			await expect(service.events(reader, cursor)).rejects.toMatchObject({ code: "SNAPSHOT_REQUIRED" });
		expect(await service.events(reader, 0)).toEqual([]);
	});
	it("does not overwrite an occupied collaboration metadata field", async () => {
		await init();
		const stored = JSON.parse(await readFile(path, "utf8"));
		stored.collaboration = null;
		await writeFile(path, JSON.stringify(stored));
		const before = await readFile(path, "utf8");
		await expect(init()).rejects.toMatchObject({ code: "ALREADY_INITIALIZED" });
		expect(await readFile(path, "utf8")).toBe(before);
	});
	it("prevents local domain mutations from bypassing the command ledger", async () => {
		await init();
		const before = await readFile(path, "utf8");
		const result = await new WorklistApplicationService({ projectPath: path }).execute(
			{ scope: "project", action: "add", title: "Bypass" },
			{ source: "cli" },
		);
		expect(result.ok).toBe(false);
		expect(await readFile(path, "utf8")).toBe(before);
	});
	it("records accepted no-op commands and resumes only later events", async () => {
		await init();
		const add = await service.execute(owner, await command());
		const update = await service.execute(
			owner,
			await command({ action: "update", taskId: add.taskId, title: "Task" }),
		);
		expect(update.result.meta.semanticNoOp).toBe(true);
		expect(update.revision).toBe(add.revision + 1);
		expect(await service.events(reader, add.cursor)).toEqual([
			expect.objectContaining({ cursor: update.cursor }),
		]);
		expect((await service.snapshot(reader)).revision).toBe(update.revision);
	});
	it("refuses local path migration for a collaboration aggregate", async () => {
		await init();
		const before = await readFile(path, "utf8");
		const result = await new WorklistApplicationService({ projectPath: path }).execute(
			{ scope: "project", action: "migrate_path", targetPath: join(directory, "other.json"), confirm: true },
			{ source: "cli" },
		);
		expect(result.ok).toBe(false);
		expect(await readFile(path, "utf8")).toBe(before);
	});
	it("fails loudly when stored receipts or event fields are corrupt", async () => {
		await init();
		const input = await command();
		await service.execute(owner, input);
		const valid = JSON.parse(await readFile(path, "utf8"));
		for (const corrupt of [
			{ ...valid, collaboration: { ...valid.collaboration, receipts: {} } },
			{
				...valid,
				collaboration: {
					...valid.collaboration,
					events: [{ ...valid.collaboration.events[0], actorId: 42 }],
				},
			},
			{ ...valid, collaboration: { ...valid.collaboration, identities: { task: "invalid" } } },
		]) {
			await writeFile(path, JSON.stringify(corrupt));
			await expect(service.snapshot(reader)).rejects.toMatchObject({ code: "INVALID_STORE" });
			await expect(service.execute(owner, input)).rejects.toMatchObject({ code: "INVALID_STORE" });
		}
	});
});
