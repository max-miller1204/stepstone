import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { WorklistApplicationService, type WorklistOperation } from "../src/application-service.ts";
import { inspectPreparedClaims } from "../src/claim-evidence.ts";
import {
	ApplicationRoadmapBinding,
	currentDispatchTarget,
	defaultDispatchStateDirectory,
	FileDispatchStateStore,
	GitWorktreeBinding,
} from "../src/dispatch-bindings.ts";
import { DispatchDriver, unavailableDispatchGoalIds } from "../src/dispatch-driver.ts";
import { createWorklistLocator } from "../src/git.ts";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "stepstone-workspace-editor-")));
	roots.push(directory);
	const root = join(directory, "repo");
	await mkdir(root);
	for (const args of [
		["init", "-b", "main"],
		["config", "user.name", "Stepstone Test"],
		["config", "user.email", "stepstone@example.test"],
		["commit", "--allow-empty", "-m", "initial"],
	])
		await execFileAsync("git", args, { cwd: root });
	const service = new WorklistApplicationService({ projectPath: null });
	const locate = createWorklistLocator(root);
	service.setProjectPathResolver(() => locate().path);
	const roadmap = new ApplicationRoadmapBinding(root);
	const workspace = new GitWorktreeBinding(root, directory);
	const store = new FileDispatchStateStore(await defaultDispatchStateDirectory(root));
	const driver = new DispatchDriver({
		roadmap,
		workspace,
		store,
		merges: {
			findMerged: async () => undefined,
			syncTarget: async () => {
				throw new Error("Unexpected merge");
			},
		},
	});
	async function mutate(operation: Omit<WorklistOperation, "scope">) {
		const result = await service.execute({ ...operation, scope: "project" }, { source: "cli" });
		if (!result.ok) throw new Error(result.error.message);
		return result;
	}
	async function create(ids: string[]) {
		const target = await currentDispatchTarget(root);
		return driver.create({
			repositoryRoot: root,
			approvedGoalIds: ids,
			maxParallel: 1,
			targetBranch: target.branch,
			targetRevision: target.revision,
			workspaceConfig: { workspaceParent: directory },
		});
	}
	return { root, roadmap, workspace, store, driver, mutate, create };
}

it("keeps preparation, activity inspection, recovery, and cleanup available through workspace bindings", async () => {
	const f = await fixture();
	await f.mutate({ action: "add", title: "Prepared goal" });
	const run = await f.create(["prepared-goal"]);
	const prepared = await f.store.withRunLock(run.id, () => f.driver.advance(run.id));
	const entry = prepared.entries["prepared-goal"];
	expect(entry.phase).toBe("prepared");
	if (!entry.workspace) throw new Error("Missing workspace");
	expect(await readFile(join(entry.workspace.path, "STEPSTONE_GOAL.md"), "utf8")).toContain("Prepared goal");
	expect(await f.store.list()).toMatchObject([{ id: run.id }]);
	expect(unavailableDispatchGoalIds(["prepared-goal"], (await f.roadmap.read()).goals, [prepared])).toEqual([
		"prepared-goal",
	]);
	await expect(f.driver.cleanup(run.id)).rejects.toThrow("still has custody");
	await writeFile(join(entry.workspace.path, "uncommitted.txt"), "Review this work.\n");
	expect(await inspectPreparedClaims(prepared, f.roadmap, f.workspace)).toMatchObject({
		"prepared-goal": {
			canonical: { state: "matches" },
			workspace: { state: "observed", hasUncommittedChanges: true },
		},
	});
	await rename(entry.workspace.path, `${entry.workspace.path}-unavailable`);
	expect(await inspectPreparedClaims(prepared, f.roadmap, f.workspace)).toMatchObject({
		"prepared-goal": { workspace: { state: "unavailable" } },
	});
	await rename(`${entry.workspace.path}-unavailable`, entry.workspace.path);
	await rm(join(entry.workspace.path, "uncommitted.txt"));
	const recovered = await f.driver.recoverRelease(run.id, "prepared-goal");
	expect(recovered.entries["prepared-goal"]).toMatchObject({
		phase: "cleanup-pending",
		message: expect.stringContaining("no configured Git remote"),
	});
	const after = await f.roadmap.read();
	expect(after.goals[0].branch).toBeUndefined();
	expect(unavailableDispatchGoalIds(["prepared-goal"], after.goals, [recovered])).toEqual(["prepared-goal"]);
	expect(await f.driver.cleanup(run.id)).toMatchObject({
		entries: { "prepared-goal": { phase: "cleanup-pending" } },
	});
});

it("continues blocked approvals and preserves stored IDs after roadmap migration", async () => {
	const f = await fixture();
	await f.mutate({ action: "add", title: "Original prerequisite" });
	await f.mutate({ action: "add", title: "Original dependent", dependsOn: ["original-prerequisite"] });
	const path = createWorklistLocator(f.root)().path;
	if (!path) throw new Error("Missing roadmap path");
	await writeFile(
		path,
		(await readFile(path, "utf8")).replaceAll("original-dependent", "goal-review-1234abcd"),
	);
	const run = await f.create(["goal-review-1234abcd"]);
	expect((await f.driver.advance(run.id)).entries).toEqual({});
	expect(unavailableDispatchGoalIds(["goal-review-1234abcd"], (await f.roadmap.read()).goals, [run])).toEqual(
		["goal-review-1234abcd"],
	);
	await f.mutate({ action: "update", id: "goal-review-1234abcd", title: "Migrated dependent" });
	await f.mutate({ action: "migrate_ids", confirm: true });
	const migrated = await f.roadmap.read();
	expect(migrated.goals[1]).toMatchObject({
		id: "migrated-dependent",
		previousIds: ["goal-review-1234abcd"],
	});
	expect(unavailableDispatchGoalIds(["migrated-dependent"], migrated.goals, [run])).toEqual([
		"migrated-dependent",
	]);
	await f.roadmap.complete("original-prerequisite", migrated.goals[0].updatedAt);
	const prepared = await f.driver.advance(run.id);
	expect(prepared.approvedGoalIds).toEqual(["goal-review-1234abcd"]);
	expect(Object.keys(prepared.entries)).toEqual(["goal-review-1234abcd"]);
	expect(prepared.entries["goal-review-1234abcd"]).toMatchObject({
		phase: "prepared",
		branch: "stepstone/goal-review-1234abcd",
	});
	await f.driver.recoverRelease(run.id, "goal-review-1234abcd");
	const resumed = await f.driver.advance(run.id);
	expect(resumed.entries["goal-review-1234abcd"].phase).toBe("cleanup-pending");
	expect(Object.keys(resumed.entries)).toEqual(["goal-review-1234abcd"]);
});
