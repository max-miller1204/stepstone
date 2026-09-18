import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findGoalByStoredId } from "../src/goal-selection.ts";
import {
	addMilestone,
	addProjectGoal,
	assignTaskMilestone,
	configureProject,
	migrateProjectGoalIds,
	readProjectStructure,
	updateMilestone,
	updateProjectGoal,
} from "../src/project-mutations.ts";
import { isProjectWorklist, readProjectWorklist } from "../src/project-store.ts";

let directory: string;
let path: string;
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "stepstone-organization-"));
	path = join(directory, "worklist.json");
});
afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

const stamp = "2026-01-01T00:00:00.000Z";
const historicalTask = {
	id: "frozen-task",
	previousIds: ["older-task"],
	title: "Historical task",
	status: "done",
	createdAt: stamp,
	updatedAt: stamp,
	completedAt: stamp,
	group: "Legacy group",
	links: ["https://example.com/evidence"],
	historicalExtension: { evidence: "keep" },
};

describe("project organization", () => {
	it("upgrades explicitly and preserves complete task and identity history", async () => {
		const dependent = { ...historicalTask, id: "dependent", previousIds: [], dependsOn: ["older-task"] };
		await writeFile(
			path,
			JSON.stringify({
				version: 1,
				revision: 4,
				goals: [historicalTask, dependent],
				retiredIds: ["deleted", "former-deleted"],
			}),
		);
		const before = await readProjectStructure(path);
		expect(before.project).toBeUndefined();
		expect(before.milestones).toEqual([]);
		const configured = await configureProject(
			path,
			{
				title: "Larger effort",
				repositories: ["https://EXAMPLE.com/repo", "https://example.com/repo", "https://example.com/other"],
			},
			{ expectedRevision: "4" },
		);
		expect(configured.revision).toBe("5");
		expect(configured.project?.repositories).toEqual([
			"https://example.com/repo",
			"https://example.com/other",
		]);
		expect(configured.tasks).toEqual([historicalTask, dependent]);
		expect(configured.retiredIds).toEqual(["deleted", "former-deleted"]);
		expect((await readProjectWorklist(path)).data.version).toBe(2);
		await updateProjectGoal(path, "older-task", { title: "Renamed task" });
		const updated = (await readProjectStructure(path)).tasks[0];
		expect(updated).toMatchObject({
			...historicalTask,
			title: "Renamed task",
			updatedAt: expect.any(String),
		});
	});

	it("keeps ordinary legacy writes at version 1 and refuses premature milestone writes", async () => {
		await addProjectGoal(path, "Actionable work");
		expect((await readProjectWorklist(path)).data.version).toBe(1);
		const bytes = await readFile(path, "utf8");
		await expect(addMilestone(path, { title: "Outcome" })).rejects.toThrow("Configure the project");
		expect(await readFile(path, "utf8")).toBe(bytes);
	});

	it("supports projects without repositories, stable milestone IDs, assignment and clearing", async () => {
		await writeFile(path, JSON.stringify({ version: 1, goals: [historicalTask] }));
		const configured = await configureProject(path, { title: "Effort" });
		expect(configured.project?.repositories).toEqual([]);
		const first = await addMilestone(path, { title: "Useful outcome" });
		const second = await addMilestone(path, { title: "Useful outcome" });
		expect(second.milestone?.id).toBe("useful-outcome-2");
		const renamed = await updateMilestone(path, "useful-outcome", {
			title: "Better outcome",
			description: "Meaningful result",
		});
		expect(renamed.milestone?.id).toBe(first.milestone?.id);
		const assigned = await assignTaskMilestone(path, "older-task", "useful-outcome");
		expect(assigned.goal.milestoneId).toBe("useful-outcome");
		expect(assigned.goal.group).toBe("Legacy group");
		const cleared = await assignTaskMilestone(path, "older-task", "");
		expect(cleared.goal).not.toHaveProperty("milestoneId");
		expect((await configureProject(path, { title: "Renamed effort" })).project?.id).toBe("effort");
	});

	it("does not change bytes or revisions for no-ops and rejects stale revisions", async () => {
		await configureProject(path, { title: "Effort" });
		await addProjectGoal(path, "Task");
		await addMilestone(path, { title: "Outcome" });
		await assignTaskMilestone(path, "task", "outcome");
		const bytes = await readFile(path, "utf8");
		const revision = (await readProjectStructure(path)).revision;
		for (const result of [
			await configureProject(path, { title: "Effort" }),
			await updateMilestone(path, "outcome", {}),
			await assignTaskMilestone(path, "task", "outcome"),
		]) {
			expect(result.changed).toBe(false);
			expect(result.revision).toBe(revision);
		}
		await expect(addMilestone(path, { title: "Another outcome" }, { expectedRevision: "0" })).rejects.toThrow(
			"revision changed",
		);
		expect(await readFile(path, "utf8")).toBe(bytes);
	});

	it("rejects invalid metadata and unknown references without persistence", async () => {
		await configureProject(path, { title: "Effort" });
		const bytes = await readFile(path, "utf8");
		await expect(configureProject(path, { title: " " })).rejects.toThrow("nonempty title");
		for (const repository of ["/local/repo", "ssh://host/repo", "https://user:secret@example.com/repo"]) {
			await expect(configureProject(path, { title: "Effort", repositories: [repository] })).rejects.toThrow(
				"HTTP(S)",
			);
		}
		await expect(updateMilestone(path, "missing", { title: "Renamed" })).rejects.toThrow("not found");
		await expect(assignTaskMilestone(path, "missing", "missing")).rejects.toThrow("Milestone missing");
		await expect(assignTaskMilestone(path, "missing", "")).rejects.toThrow("not found");
		expect(await readFile(path, "utf8")).toBe(bytes);
	});

	it("rejects malformed version 2 metadata and milestone references", async () => {
		await configureProject(path, { title: "Effort" });
		const valid = (await readProjectWorklist(path)).data;
		expect(isProjectWorklist(valid)).toBe(true);
		for (const invalid of [
			{ ...valid, project: undefined },
			{ ...valid, milestones: undefined },
			{ ...valid, revision: undefined },
			{ ...valid, project: { ...valid.project, unknown: true } },
			{ ...valid, project: { ...valid.project, repositories: ["relative"] } },
			{ ...valid, goals: [{ ...historicalTask, milestoneId: "missing" }] },
			{ ...valid, milestones: [{ id: "bad", title: "", createdAt: stamp, updatedAt: stamp }] },
		])
			expect(isProjectWorklist(invalid)).toBe(false);
	});
});

describe("organization compatibility boundaries", () => {
	it("preserves opaque legacy metadata and rejects an ambiguous explicit upgrade", async () => {
		for (const extension of [
			{ project: { legacy: true } },
			{ milestones: "historical" },
			{ goals: [{ ...historicalTask, milestoneId: { legacy: true } }] },
		]) {
			const legacy = { version: 1, goals: [historicalTask], ...extension };
			expect(isProjectWorklist(legacy)).toBe(true);
			await writeFile(path, JSON.stringify(legacy));
			await updateProjectGoal(path, "older-task", { title: "Edited task" });
			const saved = JSON.parse(await readFile(path, "utf8"));
			expect(saved).toMatchObject({
				...legacy,
				goals: [{ ...legacy.goals[0], title: "Edited task", updatedAt: expect.any(String) }],
			});
			expect(await readProjectStructure(path)).toMatchObject({ milestones: [] });
			expect((await readProjectStructure(path)).project).toBeUndefined();
			const bytes = await readFile(path, "utf8");
			await expect(configureProject(path, { title: "Effort" })).rejects.toThrow(
				"Legacy organization fields conflict",
			);
			expect(await readFile(path, "utf8")).toBe(bytes);
		}
	});

	it("preserves milestone assignment and historical references through ID migration", async () => {
		const oldId = "goal-mse1rzxb-8213cc2a";
		const dispatch = { goalId: oldId, branch: "historical-branch" };
		await writeFile(
			path,
			JSON.stringify({ version: 1, dispatch, goals: [{ ...historicalTask, id: oldId }] }),
		);
		await configureProject(path, { title: "Effort" });
		await addMilestone(path, { title: "Outcome" });
		await assignTaskMilestone(path, oldId, "outcome");
		await migrateProjectGoalIds(path);
		const saved = JSON.parse(await readFile(path, "utf8"));
		expect(saved.dispatch).toEqual(dispatch);
		expect(findGoalByStoredId(saved.goals, saved.dispatch.goalId)).toMatchObject({
			id: "historical-task",
			milestoneId: "outcome",
			previousIds: ["older-task", oldId],
		});
		expect(saved.milestones[0].id).toBe("outcome");
	});

	it("rejects runtime coercion and invalid descriptions before writing", async () => {
		for (const repositories of ["https://example.com", [new URL("https://example.com")], [null], [42]]) {
			await expect(
				configureProject(path, { title: "Effort", repositories: repositories as unknown as string[] }),
			).rejects.toThrow("Repositories must");
		}
		await expect(
			configureProject(path, { title: "Effort", description: 42 as unknown as string }),
		).rejects.toThrow("Description must be a string");
		await expect(
			addMilestone(path, { title: "Outcome", description: null as unknown as string }),
		).rejects.toThrow("Description must be a string");
	});

	it("preserves omitted metadata and clears explicit repository lists and descriptions", async () => {
		await configureProject(path, {
			title: "Effort",
			description: "Long effort",
			repositories: ["http://example.com/repo"],
		});
		expect((await configureProject(path, { title: "Renamed" })).project).toMatchObject({
			id: "effort",
			description: "Long effort",
			repositories: ["http://example.com/repo"],
		});
		expect(
			(await configureProject(path, { title: "Renamed", description: "", repositories: [] })).project,
		).toMatchObject({ description: "", repositories: [] });
		await addMilestone(path, { title: "Outcome", description: "A result" });
		expect((await updateMilestone(path, "outcome", { title: "New outcome" })).milestone?.description).toBe(
			"A result",
		);
		expect((await updateMilestone(path, "outcome", { description: "" })).milestone?.description).toBe("");
	});

	it("refuses malformed organization files for reads and each mutation", async () => {
		await writeFile(path, "{broken");
		for (const action of [
			() => readProjectStructure(path),
			() => configureProject(path, { title: "Effort" }),
			() => addMilestone(path, { title: "Outcome" }),
			() => updateMilestone(path, "outcome", {}),
			() => assignTaskMilestone(path, "task", ""),
		]) {
			await expect(action()).rejects.toThrow("Malformed project file");
		}
		expect(await readFile(path, "utf8")).toBe("{broken");
	});

	it("validates all organization metadata and rejects duplicate or invalid milestones", async () => {
		await configureProject(path, { title: "Effort" });
		await addMilestone(path, { title: "Outcome" });
		const valid = (await readProjectWorklist(path)).data;
		for (const project of [
			null,
			[],
			"project",
			{ ...valid.project, id: "Bad ID" },
			{ ...valid.project, title: " " },
			{ ...valid.project, description: 2 },
			{ ...valid.project, createdAt: "invalid" },
			{ ...valid.project, updatedAt: null },
			{ ...valid.project, repositories: null },
			{ ...valid.project, repositories: ["https://example.com/", "https://example.com/"] },
			{ ...valid.project, repositories: ["https://EXAMPLE.com/"] },
			{ ...valid.project, repositories: ["ssh://example.com/repo"] },
			{ ...valid.project, repositories: ["https://user@example.com/"] },
		])
			expect(isProjectWorklist({ ...valid, project })).toBe(false);
		const milestone = { id: "outcome", title: "Outcome", createdAt: stamp, updatedAt: stamp };
		for (const milestones of [
			null,
			[milestone, milestone],
			[{ ...milestone, unexpected: true }],
			[{ ...milestone, description: 2 }],
			[{ ...milestone, id: 42 }],
		])
			expect(isProjectWorklist({ ...valid, milestones })).toBe(false);
		expect(isProjectWorklist({ ...valid, version: "2" })).toBe(false);
		expect(isProjectWorklist({ ...valid, goals: [{ ...historicalTask, milestoneId: 42 }] })).toBe(false);
	});
});
