import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { WorklistApplicationService, type WorklistOperation } from "../src/application-service.ts";
import { SessionStore } from "../src/session-store.ts";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), "organization-service-"));
	directories.push(dir);
	const path = join(dir, "project.json");
	const service = new WorklistApplicationService({
		projectPath: path,
		sessionStore: new SessionStore({ appendEntry() {} } as unknown as ExtensionAPI),
	});
	const run = (operation: Omit<WorklistOperation, "scope">) =>
		service.execute({ scope: "project", ...operation }, { source: "tool" });
	return { run, path, service };
}

describe("organization application boundary", () => {
	it("requires intent, reports coherent structures, preserves legacy task contracts and conflicts", async () => {
		const { run, path } = await fixture();
		expect(await run({ action: "configure", title: "Launch" })).toMatchObject({
			ok: false,
			error: { code: "APPROVAL_REQUIRED" },
		});
		const added = await run({ action: "add", title: "Write guide" });
		expect(added).toMatchObject({ ok: true, result: { goal: { id: "write-guide" } } });
		const configured = await run({ action: "configure", title: "Launch", confirm: true });
		expect(configured).toMatchObject({
			ok: true,
			result: {
				project: { id: "launch", repositories: [] },
			},
			meta: { changedFields: ["/project"] },
		});
		const milestone = await run({ action: "add_milestone", title: "Docs ready" });
		expect(milestone).toMatchObject({
			ok: true,
			result: { milestone: { id: "docs-ready" } },
			meta: { changedFields: ["/milestones"] },
		});
		expect(await run({ action: "assign_milestone", id: "write-g", milestoneId: "docs-ready" })).toMatchObject(
			{
				ok: true,
				result: { goal: { id: "write-guide", milestoneId: "docs-ready" } },
				meta: { changedEntities: { projectGoalIds: ["write-guide"] } },
			},
		);
		const before = await readFile(path, "utf8");
		expect(
			await run({ action: "update_milestone", id: "docs-ready", title: "Changed", expectedRevision: "0" }),
		).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
		expect(await readFile(path, "utf8")).toBe(before);
		expect(await run({ action: "update_milestone", id: "docs-ready", title: "Docs complete" })).toMatchObject(
			{ ok: true, result: { milestone: { id: "docs-ready", title: "Docs complete" } } },
		);
		expect(await run({ action: "structure" })).toMatchObject({
			ok: true,
			result: { projectStructure: { tasks: [{ milestoneId: "docs-ready" }] } },
			meta: { changed: false, semanticNoOp: false },
		});
		expect(await run({ action: "assign_milestone", id: "write-guide", milestoneId: "" })).toMatchObject({
			ok: true,
			meta: { changed: true },
		});
		expect(await run({ action: "assign_milestone", id: "write-guide", milestoneId: "" })).toMatchObject({
			ok: true,
			meta: { semanticNoOp: true },
		});
	});

	it.each([
		{ action: "configure", confirm: true },
		{ action: "add_milestone" },
		{ action: "update_milestone", title: "Missing ID" },
		{ action: "assign_milestone", id: "task" },
		{ action: "structure", title: "Ignored title" },
		{ action: "list", repositories: [] },
		{ action: "list", milestoneId: "x" },
		{ action: "configure", title: "Bad URL", confirm: true, repositories: ["not a URL"] },
	])("rejects invalid requests: %j", async (operation) => {
		const { run } = await fixture();
		expect(await run(operation)).toMatchObject({
			ok: false,
			error: { code: "VALIDATION_FAILED" },
			meta: { changed: false },
		});
	});

	it("rejects organization fields in session operations", async () => {
		const { service } = await fixture();
		for (const field of [{ repositories: [] }, { milestoneId: "milestone" }]) {
			expect(
				await service.execute({ scope: "session", action: "list", ...field }, { source: "tool" }),
			).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
		}
	});
});
