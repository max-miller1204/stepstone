import { expect, test } from "vitest";
import { WorklistApplicationService } from "../src/application-service.ts";
import { createEmptyWorklist, mutateProjectWorklist } from "../src/project-store.ts";

test("database snapshots use shared application rules without a file path", async () => {
	const store = { worklist: createEmptyWorklist() };
	const app = new WorklistApplicationService({ projectStore: store });
	const add = await app.execute(
		{ scope: "project", action: "add", title: "Snapshot task" },
		{ source: "cli" },
	);
	expect(add.ok).toBe(true);
	expect(store.worklist.revision).toBe(1);
	expect(await app.getProjectGoals()).toHaveLength(1);
	expect((await app.readProjectSnapshot("list")).ok).toBe(true);
	const unchanged = structuredClone(store.worklist);
	expect(
		(await app.execute({ scope: "project", action: "complete", id: "snapshot-task" }, { source: "cli" })).ok,
	).toBe(false);
	expect(store.worklist).toEqual(unchanged);
	expect(
		(
			await app.execute(
				{ scope: "project", action: "migrate_path", targetPath: "/invalid", confirm: true },
				{ source: "cli" },
			)
		).ok,
	).toBe(false);
	expect(() => new WorklistApplicationService({ projectStore: store, projectPath: "/invalid" })).toThrow(
		"Choose one",
	);
});
test("snapshot mutation rejects invalid state and exhausted revisions", async () => {
	const store = { worklist: createEmptyWorklist() };
	await expect(
		mutateProjectWorklist(store, (current) => ({ worklist: { ...current, revision: -1 }, result: null })),
	).rejects.toThrow("invalid worklist");
	store.worklist.revision = Number.MAX_SAFE_INTEGER;
	await expect(
		mutateProjectWorklist(store, (current) => ({ worklist: current, result: null })),
	).rejects.toThrow("exhausted");
});
