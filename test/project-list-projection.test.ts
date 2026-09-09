import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
	formatProjectGoalListPage,
	PROJECT_GOAL_LIST_LIMITS,
	PROJECT_GOAL_LIST_TRUNCATION_MARKER,
	ProjectGoalListCursorConflictError,
	ProjectGoalListValidationError,
	projectProjectGoalList,
} from "../src/project-list-projection.ts";
import type { ProjectGoal, ProjectGoalStatus } from "../src/types.ts";

function goal(index: number, overrides: Partial<ProjectGoal> = {}): ProjectGoal {
	return {
		id: `goal-${index}`,
		title: `Goal ${index}`,
		description: `Description ${index} `.repeat(200),
		status: "open",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

function rewriteCursor(cursor: string, patch: Record<string, unknown>): string {
	const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
	return Buffer.from(JSON.stringify({ ...decoded, ...patch }), "utf8").toString("base64url");
}

function resultBytes(page: ReturnType<typeof projectProjectGoalList>): number {
	return Buffer.byteLength(
		JSON.stringify({ scope: "project", action: "list", projectGoalList: page }),
		"utf8",
	);
}

describe("bounded Project Goal list projection", () => {
	it("returns one canonical-order page without descriptions or full goal details", () => {
		const statuses: ProjectGoalStatus[] = ["archived", "done", "active", "open"];
		const goals = Array.from({ length: 70 }, (_, index) =>
			goal(index, { status: statuses[index % statuses.length] }),
		);
		const page = projectProjectGoalList(goals, "12", {});
		const content = formatProjectGoalListPage(page);

		expect(page.goals).toHaveLength(PROJECT_GOAL_LIST_LIMITS.defaultItems);
		expect(page.goals.map(({ id }) => id)).toEqual(
			goals.slice(0, PROJECT_GOAL_LIST_LIMITS.defaultItems).map(({ id }) => id),
		);
		expect(page).toMatchObject({ total: 70, matched: 70, offset: 0, returned: 20, omitted: 50 });
		expect(page.nextCursor).toEqual(expect.any(String));
		expect(JSON.stringify(page)).not.toContain("Description");
		expect(JSON.stringify(page)).not.toContain("createdAt");
		expect(resultBytes(page)).toBeLessThanOrEqual(PROJECT_GOAL_LIST_LIMITS.totalBytes);
		expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(PROJECT_GOAL_LIST_LIMITS.totalBytes);
		expect(content).toContain("Continue with cursor:");
	});

	it("continues with the cursor's revision and filters", () => {
		const goals = Array.from({ length: 18 }, (_, index) =>
			goal(index, {
				status: index % 3 === 0 ? "done" : "open",
				group: index % 2 === 0 ? "Later" : "Foundation",
			}),
		);
		const first = projectProjectGoalList(goals, "8", {
			statuses: ["open"],
			group: " Later ",
			limit: 2,
		});
		if (!first.nextCursor) throw new Error("First page did not return a cursor");
		const second = projectProjectGoalList(goals, "8", { cursor: first.nextCursor, limit: 2 });
		const matching = goals.filter((item) => item.status === "open" && item.group === "Later");

		expect(first).toMatchObject({ statuses: ["open"], group: "Later", offset: 0, returned: 2 });
		expect(second).toMatchObject({ statuses: ["open"], group: "Later", offset: 2, omitted: 2 });
		expect([...first.goals, ...second.goals].map(({ id }) => id)).toEqual(
			matching.slice(0, 4).map(({ id }) => id),
		);
	});

	it("truncates titles by encoded UTF-8 bytes without splitting graphemes", () => {
		const repeated = "👩🏽‍💻".repeat(100);
		const page = projectProjectGoalList([goal(1, { title: repeated })], "1", {});
		const title = page.goals[0]?.title ?? "";
		const prefix = title.slice(0, -PROJECT_GOAL_LIST_TRUNCATION_MARKER.length);

		expect(title.endsWith(PROJECT_GOAL_LIST_TRUNCATION_MARKER)).toBe(true);
		expect(page.truncatedTitleGoalIds).toEqual(["goal-1"]);
		expect(prefix).toBe(
			"👩🏽‍💻".repeat([...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(prefix)].length),
		);
	});

	it("rejects invalid requests and stale cursors loudly", () => {
		const goals = Array.from({ length: 3 }, (_, index) => goal(index));
		expect(() => projectProjectGoalList(goals, "1", { statuses: [] })).toThrow(
			ProjectGoalListValidationError,
		);
		expect(() => projectProjectGoalList(goals, "1", { statuses: ["open", "open"] })).toThrow(
			ProjectGoalListValidationError,
		);
		expect(() => projectProjectGoalList(goals, "1", { limit: 51 })).toThrow(ProjectGoalListValidationError);
		expect(() => projectProjectGoalList(goals, "1", { group: "x".repeat(257) })).toThrow(
			ProjectGoalListValidationError,
		);
		expect(() => projectProjectGoalList(goals, "1", { group: 3 as never })).toThrow(
			ProjectGoalListValidationError,
		);
		expect(() => projectProjectGoalList(goals, "1", { cursor: "x".repeat(1025) })).toThrow(
			ProjectGoalListValidationError,
		);
		expect(() => projectProjectGoalList(goals, "1", { cursor: "not-a-cursor" })).toThrow(
			ProjectGoalListValidationError,
		);

		const first = projectProjectGoalList(goals, "1", { limit: 1 });
		const cursor = first.nextCursor;
		if (!cursor) throw new Error("First page did not return a cursor");
		expect(() => projectProjectGoalList(goals, "2", { cursor })).toThrow(ProjectGoalListCursorConflictError);
		expect(() => projectProjectGoalList(goals, "1", { cursor, statuses: ["open"] })).toThrow(
			ProjectGoalListValidationError,
		);

		const end = projectProjectGoalList(goals, "1", {
			cursor: rewriteCursor(cursor, { offset: goals.length }),
		});
		expect(end).toMatchObject({ offset: goals.length, returned: 0, omitted: 0 });
		expect(() =>
			projectProjectGoalList(goals, "1", {
				cursor: rewriteCursor(cursor, { offset: goals.length + 1 }),
			}),
		).toThrow(ProjectGoalListValidationError);
	});

	it("rejects same-revision cursors after order or filter fields change", () => {
		const firstGoal = goal(1, { group: "Later" });
		const secondGoal = goal(2, { group: "Later" });
		const goals = [firstGoal, secondGoal];
		const first = projectProjectGoalList(goals, "4", { limit: 1, statuses: ["open"], group: "Later" });
		if (!first.nextCursor) throw new Error("First page did not return a cursor");
		for (const changed of [
			[secondGoal, firstGoal],
			[goal(1, { group: "Later", status: "done" }), secondGoal],
			[goal(1, { group: "Foundation" }), secondGoal],
		]) {
			expect(() => projectProjectGoalList(changed, "4", { cursor: first.nextCursor })).toThrow(
				ProjectGoalListCursorConflictError,
			);
		}
	});

	it("selects ungrouped goals with an empty group filter", () => {
		const page = projectProjectGoalList(
			[goal(1), goal(2, { group: "Later" }), goal(3, { group: "  " })],
			"1",
			{ group: "" },
		);
		expect(page.goals.map(({ id }) => id)).toEqual(["goal-1", "goal-3"]);
		expect(page).toMatchObject({ total: 3, matched: 2, group: "" });
	});
});
