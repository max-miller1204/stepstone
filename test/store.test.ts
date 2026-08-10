import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import lockfile from "proper-lockfile";
import { describe, expect, it } from "vitest";
import {
	createEmptyWorklist,
	isProjectWorklist,
	moveProjectWorklist,
	mutateProjectWorklist,
	ProjectGoalConflictError,
	ProjectWorklistMoveRefusedError,
	readProjectWorklist,
} from "../src/project-store.ts";

const execFileAsync = promisify(execFile);

async function tempPath() {
	const root = await mkdtemp(join(tmpdir(), "stepstone-"));
	return join(root, ".worklist", "worklist.json");
}

describe("project store", () => {
	it("treats a missing file as an empty worklist", async () => {
		const result = await readProjectWorklist(await tempPath());
		expect(result).toEqual({ data: createEmptyWorklist() });
	});

	it("reads legacy worklists at revision zero and persists revision one on mutation", async () => {
		const path = await tempPath();
		await mkdir(join(path, ".."), { recursive: true });
		const legacyValue = { version: 1, goals: [] };
		const legacy = `${JSON.stringify(legacyValue, null, 2)}\n`;
		await writeFile(path, legacy);

		expect(isProjectWorklist(legacyValue)).toBe(true);
		const readResult = await readProjectWorklist(path);
		expect(readResult).toEqual({ data: { version: 1, revision: 0, goals: [] } });
		expect(await readFile(path, "utf8")).toBe(legacy);

		const mutation = await mutateProjectWorklist(path, (worklist) => ({ worklist, result: "migrated" }), {
			expectedRevision: "0",
		});
		expect(mutation).toEqual({ data: "migrated", revision: 1 });
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ version: 1, revision: 1, goals: [] });
	});

	it("accepts legacy externalMutations values and preserves unknown keys across mutations", async () => {
		const path = await tempPath();
		await mkdir(join(path, ".."), { recursive: true });
		const worklist = {
			version: 1,
			revision: 7,
			goals: [],
			externalMutations: { legacy: "non-array value" },
			consumerMetadata: { preserved: true },
		};
		await writeFile(path, `${JSON.stringify(worklist, null, 2)}\n`);

		expect(isProjectWorklist(worklist)).toBe(true);
		expect((await readProjectWorklist(path)).data).toMatchObject(worklist);

		const mutation = await mutateProjectWorklist(
			path,
			(current) => ({ worklist: current, result: "updated" }),
			{ expectedRevision: "7" },
		);
		expect(mutation).toEqual({ data: "updated", revision: 8 });
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ ...worklist, revision: 8 });
	});

	it("validates retired goal IDs when present", () => {
		expect(isProjectWorklist({ version: 1, goals: [], retiredIds: ["deleted-goal"] })).toBe(true);
		expect(isProjectWorklist({ version: 1, goals: [], retiredIds: ["deleted-goal", 1] })).toBe(false);
	});

	it("accepts the optional goal fields, and only in the shapes they declare", () => {
		const goal = {
			id: "goal-1",
			title: "Guarded",
			status: "open",
			createdAt: "2026-05-04T09:12:31.004Z",
			updatedAt: "2026-05-04T09:12:31.004Z",
		};
		const worklistWith = (overrides: Record<string, unknown>) => ({
			version: 1,
			goals: [{ ...goal, ...overrides }],
		});

		expect(
			isProjectWorklist(
				worklistWith({
					group: "Foundation",
					completedAt: "2026-05-05T09:12:31.004Z",
					branch: "feat/guard",
					links: ["https://example.test/pull/12"],
					dependsOn: ["goal-0"],
				}),
			),
		).toBe(true);
		// A goal carrying none of them is still valid: every field is additive.
		expect(isProjectWorklist(worklistWith({}))).toBe(true);

		for (const invalid of [
			{ group: 1 },
			{ completedAt: false },
			{ branch: ["feat/guard"] },
			{ links: "https://example.test/pull/12" },
			{ links: [1] },
			{ dependsOn: "goal-0" },
			{ dependsOn: [1] },
		]) {
			expect(isProjectWorklist(worklistWith(invalid)), JSON.stringify(invalid)).toBe(false);
		}
	});

	it("refuses a mutation whose target goal moved after the caller read it", async () => {
		const path = await tempPath();
		await mkdir(join(path, ".."), { recursive: true });
		const stored = {
			version: 1,
			revision: 4,
			goals: [
				{
					id: "goal-1",
					title: "Guarded",
					status: "open",
					createdAt: "2026-05-04T09:12:31.004Z",
					updatedAt: "2026-05-04T09:12:31.004Z",
				},
			],
		};
		await writeFile(path, `${JSON.stringify(stored, null, 2)}\n`);
		const beforeConflict = await readFile(path, "utf8");

		await expect(
			mutateProjectWorklist(path, (worklist) => ({ worklist, result: "written" }), {
				expectedGoal: { id: "goal-1", updatedAt: "2026-05-04T09:12:30.000Z" },
			}),
		).rejects.toThrow(ProjectGoalConflictError);
		expect(await readFile(path, "utf8")).toBe(beforeConflict);

		// The same instant in another ISO 8601 spelling is the same baseline, not a change.
		const equivalent = await mutateProjectWorklist(path, (worklist) => ({ worklist, result: "written" }), {
			expectedGoal: { id: "goal-1", updatedAt: "2026-05-04T10:12:31.004+01:00" },
		});
		expect(equivalent).toEqual({ data: "written", revision: 5 });

		// A goal that is gone belongs to the mutation's own not-found, which is more
		// precise than a conflict about a timestamp nothing carries any more.
		const missing = await mutateProjectWorklist(path, (worklist) => ({ worklist, result: "written" }), {
			expectedGoal: { id: "goal-missing", updatedAt: "2026-05-04T09:12:31.004Z" },
		});
		expect(missing).toEqual({ data: "written", revision: 6 });
	});

	it("refuses to overwrite malformed data", async () => {
		const path = await tempPath();
		await mkdir(join(path, ".."), { recursive: true });
		await writeFile(path, "not json\n");
		const result = await mutateProjectWorklist(path, (worklist) => ({ worklist, result: true }));
		expect(result.error).toContain("Malformed");
		expect(await readFile(path, "utf8")).toBe("not json\n");
	});

	it("serializes concurrent read-modify-write operations across processes", async () => {
		const path = await tempPath();
		const fixture = resolve("test/fixtures/mutate.ts");
		await Promise.all(
			Array.from({ length: 12 }, (_, index) => execFileAsync(process.execPath, [fixture, path, `g${index}`])),
		);
		const result = await readProjectWorklist(path);
		expect(result.error).toBeUndefined();
		expect(result.data.goals).toHaveLength(12);
		expect(result.data.revision).toBe(12);
	});

	it("checks expected revisions inside the cross-process lock", async () => {
		const path = await tempPath();
		const fixture = resolve("test/fixtures/mutate.ts");
		const attempts = await Promise.allSettled([
			execFileAsync(process.execPath, [fixture, path, "first", "0"]),
			execFileAsync(process.execPath, [fixture, path, "second", "0"]),
		]);

		expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
		const rejected = attempts.filter((attempt) => attempt.status === "rejected");
		expect(rejected).toHaveLength(1);
		expect(String(rejected[0]?.reason.stderr)).toContain("ProjectRevisionConflictError");
		const result = await readProjectWorklist(path);
		expect(result.data.revision).toBe(1);
		expect(result.data.goals).toHaveLength(1);
	});
});

describe("project worklist move", () => {
	/** A worklist with one goal on it, so a move can be shown to carry content. */
	async function seed(path: string): Promise<string> {
		await mkdir(join(path, ".."), { recursive: true });
		const contents = `${JSON.stringify(
			{
				version: 1,
				revision: 4,
				goals: [
					{
						id: "carried",
						title: "Carried across",
						status: "open",
						createdAt: "2026-01-01T00:00:00.000Z",
						updatedAt: "2026-01-01T00:00:00.000Z",
					},
				],
			},
			null,
			2,
		)}\n`;
		await writeFile(path, contents);
		return contents;
	}

	it("lands the file at the new path byte for byte and leaves nothing behind", async () => {
		const root = await mkdtemp(join(tmpdir(), "stepstone-move-"));
		const from = join(root, ".pi", "worklist.json");
		const to = join(root, ".worklist", "worklist.json");
		const contents = await seed(from);

		const result = await moveProjectWorklist(from, to);

		expect(result).toEqual({ data: { fromPath: from, toPath: to }, revision: 4 });
		expect(await readFile(to, "utf8")).toBe(contents);
		await expect(readFile(from, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		// A location change, not an edit: the revision the goals were written at is
		// the revision they are read back at.
		expect((await readProjectWorklist(to)).data.revision).toBe(4);
	});

	it("refuses a destination that already holds a worklist rather than overwriting it", async () => {
		const root = await mkdtemp(join(tmpdir(), "stepstone-move-existing-"));
		const from = join(root, ".pi", "worklist.json");
		const to = join(root, ".worklist", "worklist.json");
		await seed(from);
		const destination = await seed(to);

		await expect(moveProjectWorklist(from, to)).rejects.toThrow(ProjectWorklistMoveRefusedError);
		expect(await readFile(to, "utf8")).toBe(destination);
		expect(await readFile(from, "utf8")).toBe(destination);
	});

	it("refuses a source that is not there", async () => {
		const root = await mkdtemp(join(tmpdir(), "stepstone-move-missing-"));
		const from = join(root, ".pi", "worklist.json");
		await expect(moveProjectWorklist(from, join(root, ".worklist", "worklist.json"))).rejects.toMatchObject({
			name: "ProjectWorklistMoveRefusedError",
			reason: "source-missing",
		});
	});

	it("leaves a malformed worklist where its owner last saw it", async () => {
		const root = await mkdtemp(join(tmpdir(), "stepstone-move-malformed-"));
		const from = join(root, ".pi", "worklist.json");
		const to = join(root, ".worklist", "worklist.json");
		await mkdir(join(from, ".."), { recursive: true });
		await writeFile(from, "not json\n");

		const result = await moveProjectWorklist(from, to);

		expect(result.error).toContain("Malformed");
		expect(await readFile(from, "utf8")).toBe("not json\n");
		await expect(readFile(to, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("releases the destination lock when the source lock cannot be taken", async () => {
		const root = await mkdtemp(join(tmpdir(), "stepstone-move-contended-"));
		const from = join(root, ".pi", "worklist.json");
		const to = join(root, ".worklist", "worklist.json");
		const contents = await seed(from);
		const sourceDir = join(from, "..");
		const holder = await lockfile.lock(sourceDir, {
			lockfilePath: join(sourceDir, ".worklist.lock"),
			stale: 10000,
		});

		const blocked = await moveProjectWorklist(from, to);
		await holder();

		expect(blocked.error).toMatch(/already being held/);
		expect(await readFile(from, "utf8")).toBe(contents);
		await expect(readFile(to, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		// The refused move must not strand the destination lock it took first: the
		// next writer there has to be able to take it.
		const after = await mutateProjectWorklist(to, (worklist) => ({ worklist, result: "unblocked" }));
		expect(after).toEqual({ data: "unblocked", revision: 1 });
	});

	it("holds the source lock across the move, so a concurrent writer cannot append to a file that is leaving", async () => {
		const root = await mkdtemp(join(tmpdir(), "stepstone-move-locked-"));
		const from = join(root, ".pi", "worklist.json");
		const to = join(root, ".worklist", "worklist.json");
		await seed(from);
		const fixture = resolve("test/fixtures/mutate.ts");

		const [moved] = await Promise.all([
			moveProjectWorklist(from, to),
			execFileAsync(process.execPath, [fixture, from, "written-during-move"]),
		]);

		expect(moved.error).toBeUndefined();
		// The source lock serializes the two, so whichever order they took, no
		// accepted goal is lost: the writer either landed before the move and
		// travelled with it, leaving one file, or took the freed source lock
		// afterwards and recreated the source holding its own goal, leaving the
		// two-worklist state the resolver warns about on the next command.
		const [movedGoals, sourceGoals] = await Promise.all([readProjectWorklist(to), readProjectWorklist(from)]);
		const ids = [...movedGoals.data.goals, ...sourceGoals.data.goals].map((goal) => goal.id);
		expect(ids).toContain("carried");
		expect(ids).toContain("written-during-move");
	});
});
