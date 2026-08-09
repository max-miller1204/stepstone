import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	activateProjectGoal,
	addProjectGoal,
	applyProjectPlan,
	deleteProjectGoal,
	migrateProjectGoalIds,
	moveProjectGoal,
	ProjectGoalActivationBlockedError,
	ProjectGoalAnchorNotFoundError,
	ProjectGoalDependencyCycleError,
	ProjectGoalDependencyNotFoundError,
	ProjectGoalNotFoundError,
	readProjectGoals,
	transitionProjectGoal,
	updateProjectGoal,
} from "../src/project-mutations.ts";
import { readProjectWorklist } from "../src/project-store.ts";

async function tempPath() {
	const root = await mkdtemp(join(tmpdir(), "stepstone-mutations-"));
	return join(root, ".pi", "worklist.json");
}

describe("project mutation service", () => {
	it("returns the post-mutation goal list computed under the lock", async () => {
		const path = await tempPath();
		const first = await addProjectGoal(path, "First");
		const second = await addProjectGoal(path, "Second", { description: "With description" });
		expect(first.goals.map((goal) => goal.title)).toEqual(["First"]);
		expect(first.revision).toBe("1");
		expect(second.goals.map((goal) => goal.title)).toEqual(["First", "Second"]);
		expect(second.revision).toBe("2");
		expect(second.goal.description).toBe("With description");
	});

	it("previews and applies a batch in one atomic revision", async () => {
		const path = await tempPath();
		const existing = await addProjectGoal(path, "Existing foundation");
		const plan = [
			{
				title: "Batch feature",
				description: "Depends on both new and existing work.",
				dependsOn: ["batch-foundation", existing.goal.id],
			},
			{ title: "Batch foundation", group: "Capture" },
		];
		const before = await readProjectWorklist(path);

		const preview = await applyProjectPlan(path, plan, { dryRun: true });
		expect(preview).toMatchObject({ changed: false, revision: "1" });
		expect(preview.addedGoals.map((goal) => goal.id)).toEqual(["batch-feature", "batch-foundation"]);
		expect(preview.addedGoals[0].dependsOn).toEqual(["batch-foundation", "existing-foundation"]);
		expect(await readProjectWorklist(path)).toEqual(before);

		const applied = await applyProjectPlan(path, plan);
		expect(applied).toMatchObject({ changed: true, revision: "2" });
		expect(applied.addedGoals.map((goal) => goal.id)).toEqual(["batch-feature", "batch-foundation"]);
		expect(new Set(applied.addedGoals.map((goal) => goal.createdAt))).toHaveLength(1);
		expect((await readProjectGoals(path)).goals.map((goal) => goal.id)).toEqual([
			"existing-foundation",
			"batch-feature",
			"batch-foundation",
		]);
	});

	it("serializes concurrent plans without splitting either batch", async () => {
		const path = await tempPath();
		const [first, second] = await Promise.all([
			applyProjectPlan(path, [{ title: "Shared title" }, { title: "First dependent" }]),
			applyProjectPlan(path, [{ title: "Shared title" }, { title: "Second dependent" }]),
		]);
		expect([first.revision, second.revision].sort()).toEqual(["1", "2"]);
		const goals = (await readProjectGoals(path)).goals;
		expect(goals.map((goal) => goal.id).sort()).toEqual([
			"first-dependent",
			"second-dependent",
			"shared-title",
			"shared-title-2",
		]);
		const firstIds = first.addedGoals.map((goal) => goal.id);
		const secondIds = second.addedGoals.map((goal) => goal.id);
		expect(goals.slice(0, 2).map((goal) => goal.id)).toEqual(first.revision === "1" ? firstIds : secondIds);
		expect(goals.slice(2).map((goal) => goal.id)).toEqual(first.revision === "2" ? firstIds : secondIds);
	});

	it("appends a paragraph without replaying the stored description", async () => {
		const path = await tempPath();
		const { goal } = await addProjectGoal(path, "Stage E", { description: "First paragraph." });

		const noted = await updateProjectGoal(path, goal.id, {
			appendDescription: "Stale as of 2026-08-03.",
		});
		expect(noted.goal.description).toBe("First paragraph.\n\nStale as of 2026-08-03.");
		expect(noted.goal.title).toBe("Stage E");

		const twice = await updateProjectGoal(path, goal.id, { appendDescription: "Soft-depends on goal-x." });
		expect(twice.goal.description).toBe(
			"First paragraph.\n\nStale as of 2026-08-03.\n\nSoft-depends on goal-x.",
		);

		const bare = await addProjectGoal(path, "No description yet");
		const first = await updateProjectGoal(path, bare.goal.id, { appendDescription: "The only note." });
		expect(first.goal.description).toBe("The only note.");
	});

	it("throws typed errors for missing goals", async () => {
		const path = await tempPath();
		await expect(updateProjectGoal(path, "missing", { title: "x" })).rejects.toThrow(
			ProjectGoalNotFoundError,
		);
		await expect(activateProjectGoal(path, "missing")).rejects.toThrow(ProjectGoalNotFoundError);
		await expect(transitionProjectGoal(path, "missing", "done")).rejects.toThrow(ProjectGoalNotFoundError);
		await expect(deleteProjectGoal(path, "missing")).rejects.toThrow(ProjectGoalNotFoundError);
		expect((await readProjectGoals(path)).revision).toBe("0");
	});

	it("derives goal IDs from titles and freezes them against later renames", async () => {
		const path = await tempPath();
		const first = await addProjectGoal(path, "Support goal templates");
		const second = await addProjectGoal(path, "Support goal templates!");
		expect(first.goal.id).toBe("support-goal-templates");
		expect(second.goal.id).toBe("support-goal-templates-2");

		const renamed = await updateProjectGoal(path, first.goal.id, { title: "Something else entirely" });
		expect(renamed.goal.id).toBe("support-goal-templates");

		// The freed-looking slug is still taken, because the renamed goal keeps it.
		const third = await addProjectGoal(path, "Support goal templates");
		expect(third.goal.id).toBe("support-goal-templates-3");
	});

	it("mints distinct slug IDs for concurrent adds of the same title", async () => {
		const path = await tempPath();
		const additions = await Promise.all([
			addProjectGoal(path, "Support goal templates"),
			addProjectGoal(path, "Support goal templates"),
		]);

		expect(additions.map(({ goal }) => goal.id).sort()).toEqual([
			"support-goal-templates",
			"support-goal-templates-2",
		]);
		expect((await readProjectGoals(path)).goals.map((goal) => goal.id).sort()).toEqual([
			"support-goal-templates",
			"support-goal-templates-2",
		]);
	});

	it("keeps legacy-shaped title slugs frozen after a rename", async () => {
		const path = await tempPath();
		const added = await addProjectGoal(path, "Goal abc deadbeef");
		expect(added.goal.id).toBe("goal-abc-deadbeef-2");

		const renamed = await updateProjectGoal(path, added.goal.id, { title: "Something unrelated" });
		expect(renamed.goal.id).toBe("goal-abc-deadbeef-2");

		const migrated = await migrateProjectGoalIds(path);
		expect(migrated.changed).toBe(false);
		expect(migrated.migrations).toEqual([]);
		expect(migrated.goals[0].id).toBe("goal-abc-deadbeef-2");
	});

	it("retires every ID of a deleted goal without making it resolvable", async () => {
		const path = await tempPath();
		await mkdir(dirname(path), { recursive: true });
		await writeFile(
			path,
			`${JSON.stringify({
				version: 1,
				revision: 0,
				goals: [
					{
						id: "older-goal",
						title: "Older goal",
						status: "open",
						createdAt: "2026-08-03T00:00:00.000Z",
						updatedAt: "2026-08-03T00:00:00.000Z",
					},
					{
						id: "goal-mse1rzxb-8213cc2a",
						title: "Support goal templates",
						status: "open",
						createdAt: "2026-08-04T00:00:00.000Z",
						updatedAt: "2026-08-04T00:00:00.000Z",
					},
				],
			})}\n`,
			"utf8",
		);

		await deleteProjectGoal(path, "older-goal");
		const migrated = await migrateProjectGoalIds(path);
		await deleteProjectGoal(path, migrated.goals[0].id);
		const afterDelete = await readProjectWorklist(path);
		expect(afterDelete.data.retiredIds).toEqual([
			"older-goal",
			"support-goal-templates",
			"goal-mse1rzxb-8213cc2a",
		]);
		expect(afterDelete.data.goals).toEqual([]);

		const replacement = await addProjectGoal(path, "Support goal templates");
		expect(replacement.goal.id).toBe("support-goal-templates-2");
		expect((await readProjectWorklist(path)).data.retiredIds).toEqual([
			"older-goal",
			"support-goal-templates",
			"goal-mse1rzxb-8213cc2a",
		]);
	});

	it("migrates generated IDs once, records them, and leaves readable IDs alone", async () => {
		const path = await tempPath();
		await mkdir(dirname(path), { recursive: true });
		await writeFile(
			path,
			`${JSON.stringify({
				version: 1,
				revision: 3,
				goals: [
					{
						id: "goal-mse1rzxb-8213cc2a",
						title: "Support goal templates",
						status: "open",
						createdAt: "2026-08-04T02:37:07.871Z",
						updatedAt: "2026-08-04T03:01:42.534Z",
					},
					{
						id: "future-start-goal",
						title: "Already readable",
						status: "archived",
						createdAt: "2026-07-13T00:00:00.000Z",
						updatedAt: "2026-07-13T00:00:00.000Z",
					},
				],
			})}\n`,
			"utf8",
		);

		const migrated = await migrateProjectGoalIds(path);
		expect(migrated.changed).toBe(true);
		expect(migrated.revision).toBe("4");
		expect(migrated.migrations).toEqual([
			{
				from: "goal-mse1rzxb-8213cc2a",
				to: "support-goal-templates",
				title: "Support goal templates",
			},
		]);
		expect(migrated.goals.map((goal) => goal.id)).toEqual(["support-goal-templates", "future-start-goal"]);
		expect(migrated.goals[0].previousIds).toEqual(["goal-mse1rzxb-8213cc2a"]);
		expect(migrated.goals[0].updatedAt > "2026-08-04T03:01:42.534Z").toBe(true);
		// An untouched goal keeps its baseline, so a migration cannot invalidate a
		// caller's read of a goal it did not rename.
		expect(migrated.goals[1].updatedAt).toBe("2026-07-13T00:00:00.000Z");

		const rerun = await migrateProjectGoalIds(path);
		expect(rerun.changed).toBe(false);
		expect(rerun.migrations).toEqual([]);
		expect(rerun.revision).toBe("4");

		// A migrated ID is as taken as any other, so a later goal cannot shadow it.
		const added = await addProjectGoal(path, "Support goal templates");
		expect(added.goal.id).toBe("support-goal-templates-2");
	});

	it("appends new goals and reorders them only when asked", async () => {
		const path = await tempPath();
		// A clock that runs backwards would resort a createdAt-ordered list, so the
		// appended order is asserted against titles added out of chronological turn.
		for (const title of ["First", "Second", "Third"]) await addProjectGoal(path, title);
		const titles = async () => (await readProjectGoals(path)).goals.map((goal) => goal.title);
		expect(await titles()).toEqual(["First", "Second", "Third"]);

		expect((await moveProjectGoal(path, "third", { direction: "up" })).changed).toBe(true);
		expect(await titles()).toEqual(["First", "Third", "Second"]);

		expect((await moveProjectGoal(path, "third", { beforeId: "first" })).changed).toBe(true);
		expect(await titles()).toEqual(["Third", "First", "Second"]);

		expect((await moveProjectGoal(path, "third", { afterId: "second" })).changed).toBe(true);
		expect(await titles()).toEqual(["First", "Second", "Third"]);
	});

	it("treats a move that changes nothing as a no-op instead of a write", async () => {
		const path = await tempPath();
		for (const title of ["First", "Second"]) await addProjectGoal(path, title);
		const before = await readProjectGoals(path);

		for (const placement of [
			{ direction: "up" as const },
			{ beforeId: "second" as const },
			{ afterId: "first" as const },
		]) {
			// Each move is checked against the file the previous one left behind.
			const outcome = await moveProjectGoal(path, "first", placement);
			expect(outcome.changed, JSON.stringify(placement)).toBe(false);
		}
		expect((await moveProjectGoal(path, "second", { direction: "down" })).changed).toBe(false);
		expect(await readProjectGoals(path)).toEqual(before);
	});

	it("leaves every goal's baseline untouched when only the order changes", async () => {
		const path = await tempPath();
		for (const title of ["First", "Second"]) await addProjectGoal(path, title);
		const before = (await readProjectGoals(path)).goals;

		const moved = await moveProjectGoal(path, "second", { direction: "up" });
		expect(moved.revision).toBe("3");
		expect(moved.goals.map((goal) => goal.id)).toEqual(["second", "first"]);
		for (const goal of before) {
			expect(moved.goals.find((candidate) => candidate.id === goal.id)).toEqual(goal);
		}
	});

	it("reports a missing goal and a missing anchor separately", async () => {
		const path = await tempPath();
		await addProjectGoal(path, "Only");
		await expect(moveProjectGoal(path, "missing", { direction: "up" })).rejects.toThrow(
			ProjectGoalNotFoundError,
		);
		await expect(moveProjectGoal(path, "only", { beforeId: "missing" })).rejects.toThrow(
			ProjectGoalAnchorNotFoundError,
		);
		expect((await readProjectGoals(path)).revision).toBe("1");
	});

	it("resolves former goal IDs at the locked mutation boundary", async () => {
		const path = await tempPath();
		const first = await addProjectGoal(path, "First");
		const second = await addProjectGoal(path, "Second");
		const current = await readProjectWorklist(path);
		if (current.error) throw new Error(current.error);
		await writeFile(
			path,
			`${JSON.stringify({
				...current.data,
				goals: current.data.goals.map((goal) => ({
					...goal,
					previousIds: [`former-${goal.id}`],
				})),
			})}\n`,
			"utf8",
		);

		const moved = await moveProjectGoal(path, `former-${second.goal.id}`, {
			beforeId: `former-${first.goal.id}`,
		});
		expect(moved.goals.map((goal) => goal.id)).toEqual([second.goal.id, first.goal.id]);
		await expect(
			updateProjectGoal(path, `former-${second.goal.id}`, { title: "Still reachable" }),
		).resolves.toMatchObject({ goal: { id: second.goal.id, title: "Still reachable" } });
	});

	it("stamps a completion, clears it on reopen, and keeps it through archival", async () => {
		const path = await tempPath();
		const { goal } = await addProjectGoal(path, "Finish the migration");
		expect(goal.completedAt).toBeUndefined();

		const done = await transitionProjectGoal(path, goal.id, "done");
		expect(done.goal.completedAt).toBe(done.goal.updatedAt);

		const archived = await transitionProjectGoal(path, goal.id, "archived");
		expect(archived.goal.completedAt).toBe(done.goal.completedAt);

		const reopened = await transitionProjectGoal(path, goal.id, "open");
		expect(reopened.goal.completedAt).toBeUndefined();
		expect(Object.hasOwn(reopened.goal, "completedAt")).toBe(false);

		// A goal completed before the field existed has an unknown completion
		// moment, and completing it again is a no-op that must not invent one.
		const legacy = await addProjectGoal(path, "Older work");
		await transitionProjectGoal(path, legacy.goal.id, "done");
		const untouched = await updateProjectGoal(path, legacy.goal.id, {});
		expect(untouched.changed).toBe(false);
	});

	it("sets, keeps, and clears a goal's group", async () => {
		const path = await tempPath();
		const { goal } = await addProjectGoal(path, "Ship it", { group: "  Foundation  " });
		expect(goal.group).toBe("Foundation");

		const renamed = await updateProjectGoal(path, goal.id, { title: "Ship it soon" });
		expect(renamed.goal.group).toBe("Foundation");

		expect((await updateProjectGoal(path, goal.id, { group: "Foundation" })).changed).toBe(false);

		const regrouped = await updateProjectGoal(path, goal.id, { group: "Later" });
		expect(regrouped.goal.group).toBe("Later");

		const cleared = await updateProjectGoal(path, goal.id, { group: "" });
		expect(Object.hasOwn(cleared.goal, "group")).toBe(false);
		expect((await updateProjectGoal(path, goal.id, { group: "" })).changed).toBe(false);
	});

	it("stores dependency edges canonically and replaces the whole set on update", async () => {
		const path = await tempPath();
		const first = await addProjectGoal(path, "Slug ids");
		const second = await addProjectGoal(path, "Schema fields");
		const third = await addProjectGoal(path, "Dependency graph", {
			dependsOn: [first.goal.id, second.goal.id],
		});
		expect(third.goal.dependsOn).toEqual(["slug-ids", "schema-fields"]);

		// The set is replaced, not extended, so what a caller sends is what is stored.
		const narrowed = await updateProjectGoal(path, third.goal.id, { dependsOn: [second.goal.id] });
		expect(narrowed.goal.dependsOn).toEqual(["schema-fields"]);
		expect((await updateProjectGoal(path, third.goal.id, { dependsOn: ["schema-fields"] })).changed).toBe(
			false,
		);

		// Repeats and blank entries say nothing a single edge does not.
		const deduped = await updateProjectGoal(path, third.goal.id, {
			dependsOn: ["slug-ids", " ", "slug-ids"],
		});
		expect(deduped.goal.dependsOn).toEqual(["slug-ids"]);

		const cleared = await updateProjectGoal(path, third.goal.id, { dependsOn: [] });
		expect(Object.hasOwn(cleared.goal, "dependsOn")).toBe(false);
		expect((await updateProjectGoal(path, third.goal.id, { dependsOn: [] })).changed).toBe(false);
	});

	it("stores an edge under the target's current ID, whatever name the caller used", async () => {
		const path = await tempPath();
		await mkdir(dirname(path), { recursive: true });
		await writeFile(
			path,
			`${JSON.stringify({
				version: 1,
				revision: 0,
				goals: [
					{
						id: "slug-ids",
						title: "Slug ids",
						status: "open",
						createdAt: "2026-08-03T00:00:00.000Z",
						updatedAt: "2026-08-03T00:00:00.000Z",
						previousIds: ["goal-mse1rzxb-8213cc2a"],
					},
				],
			})}\n`,
			"utf8",
		);

		const added = await addProjectGoal(path, "Dependency graph", {
			dependsOn: ["goal-mse1rzxb-8213cc2a"],
		});
		expect(added.goal.dependsOn).toEqual(["slug-ids"]);
	});

	it("treats a guessed add-time self ID as an unknown dependency", async () => {
		const path = await tempPath();

		const refused = await addProjectGoal(path, "Solo", { dependsOn: ["solo"] }).catch(
			(error: unknown) => error,
		);
		expect(refused).toBeInstanceOf(ProjectGoalDependencyNotFoundError);
		expect((refused as ProjectGoalDependencyNotFoundError).dependencyId).toBe("solo");
		expect((await readProjectGoals(path)).goals).toEqual([]);
	});

	it("refuses edges that name nothing, name the goal itself, or close a cycle", async () => {
		const path = await tempPath();
		const first = await addProjectGoal(path, "Slug ids");
		const second = await addProjectGoal(path, "Dependency graph", { dependsOn: [first.goal.id] });
		const before = await readProjectGoals(path);

		await expect(addProjectGoal(path, "Broken", { dependsOn: ["nowhere"] })).rejects.toThrow(
			ProjectGoalDependencyNotFoundError,
		);
		await expect(updateProjectGoal(path, second.goal.id, { dependsOn: ["nowhere"] })).rejects.toThrow(
			ProjectGoalDependencyNotFoundError,
		);
		await expect(updateProjectGoal(path, first.goal.id, { dependsOn: [first.goal.id] })).rejects.toThrow(
			ProjectGoalDependencyCycleError,
		);
		await expect(updateProjectGoal(path, first.goal.id, { dependsOn: [second.goal.id] })).rejects.toThrow(
			ProjectGoalDependencyCycleError,
		);

		// Every refusal is decided before anything is written.
		expect(await readProjectGoals(path)).toEqual(before);
	});

	it("names every goal on a refused cycle", async () => {
		const path = await tempPath();
		await addProjectGoal(path, "One");
		await addProjectGoal(path, "Two", { dependsOn: ["one"] });
		await addProjectGoal(path, "Three", { dependsOn: ["two"] });

		const refused = await updateProjectGoal(path, "one", { dependsOn: ["three"] }).catch(
			(error: unknown) => error,
		);
		expect(refused).toBeInstanceOf(ProjectGoalDependencyCycleError);
		expect((refused as ProjectGoalDependencyCycleError).cycle).toEqual(["one", "three", "two"]);
		expect((refused as Error).message).toContain("one -> three -> two -> one");
	});

	it("refuses a batch cycle that only a later entry reaches", async () => {
		const path = await tempPath();
		const existing = await addProjectGoal(path, "Shared foundation");

		const refused = await applyProjectPlan(path, [
			{ title: "Leader", dependsOn: [existing.goal.id] },
			{ title: "Follower", dependsOn: [existing.goal.id, "leader"] },
			{ title: "Trailer", dependsOn: ["loop"] },
			{ title: "Loop", dependsOn: ["trailer"] },
		]).catch((error: unknown) => error);

		expect(refused).toBeInstanceOf(ProjectGoalDependencyCycleError);
		expect((refused as ProjectGoalDependencyCycleError).cycle).toEqual(["trailer", "loop"]);
		expect((await readProjectGoals(path)).goals.map((goal) => goal.id)).toEqual(["shared-foundation"]);
	});

	it("strips edges to a deleted goal inside the same mutation", async () => {
		const path = await tempPath();
		await addProjectGoal(path, "Slug ids");
		await addProjectGoal(path, "Schema fields");
		await addProjectGoal(path, "Dependency graph", { dependsOn: ["slug-ids", "schema-fields"] });
		await addProjectGoal(path, "Apply plan", { dependsOn: ["schema-fields"] });
		const untouchedBefore = (await readProjectGoals(path)).goals.find((goal) => goal.id === "slug-ids");

		const deleted = await deleteProjectGoal(path, "schema-fields");
		expect(deleted.strippedGoalIds).toEqual(["dependency-graph", "apply-plan"]);

		const after = await readProjectGoals(path);
		expect(after.goals.find((goal) => goal.id === "dependency-graph")?.dependsOn).toEqual(["slug-ids"]);
		// An edge set emptied by the deletion leaves no empty array behind.
		const emptied = after.goals.find((goal) => goal.id === "apply-plan");
		expect(Object.hasOwn(emptied ?? {}, "dependsOn")).toBe(false);
		// The stripped goals changed, so they are stamped; the untouched one is not.
		expect(String(emptied?.updatedAt) > deleted.goals[0].createdAt).toBe(true);
		expect(after.goals.find((goal) => goal.id === "slug-ids")).toEqual(untouchedBefore);
	});

	it("rewrites dependency edges when an ID migration renames their target", async () => {
		const path = await tempPath();
		await mkdir(dirname(path), { recursive: true });
		await writeFile(
			path,
			`${JSON.stringify({
				version: 1,
				revision: 1,
				goals: [
					{
						id: "goal-mse1rzxb-8213cc2a",
						title: "Slug ids",
						status: "open",
						createdAt: "2026-08-04T00:00:00.000Z",
						updatedAt: "2026-08-04T00:00:00.000Z",
					},
					{
						id: "dependency-graph",
						title: "Dependency graph",
						status: "open",
						createdAt: "2026-08-04T00:00:00.000Z",
						updatedAt: "2026-08-04T00:00:00.000Z",
						dependsOn: ["goal-mse1rzxb-8213cc2a"],
					},
					{
						id: "unrelated",
						title: "Unrelated",
						status: "open",
						createdAt: "2026-08-04T00:00:00.000Z",
						updatedAt: "2026-08-04T00:00:00.000Z",
					},
				],
			})}\n`,
			"utf8",
		);

		const migrated = await migrateProjectGoalIds(path);
		expect(migrated.goals[0].id).toBe("slug-ids");
		expect(migrated.changedGoalIds).toEqual(["slug-ids", "dependency-graph"]);
		// A former ID would still resolve, but leaving it stored would let the file
		// disagree with itself about what the goal is called.
		expect(migrated.goals[1].dependsOn).toEqual(["slug-ids"]);
		expect(migrated.goals[1].updatedAt > "2026-08-04T00:00:00.000Z").toBe(true);
		expect(migrated.goals[2].updatedAt).toBe("2026-08-04T00:00:00.000Z");
	});

	it("blocks activating done or archived goals with a typed error", async () => {
		const path = await tempPath();
		const { goal } = await addProjectGoal(path, "Finished");
		await transitionProjectGoal(path, goal.id, "done");
		await expect(activateProjectGoal(path, goal.id)).rejects.toThrow(ProjectGoalActivationBlockedError);
		expect((await readProjectGoals(path)).revision).toBe("2");
		await transitionProjectGoal(path, goal.id, "archived");
		await expect(activateProjectGoal(path, goal.id)).rejects.toThrow(ProjectGoalActivationBlockedError);
	});
});
