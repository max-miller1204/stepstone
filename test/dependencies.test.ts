import { describe, expect, it } from "vitest";
import {
	dependencyWaves,
	dependentGoals,
	findDependencyCycle,
	findDependencyCycleFromRoots,
	formatDependencyCycle,
	goalsInDependencyOrder,
	isGoalBlocked,
	isGoalClaimed,
	nextGoal,
	projectGoalSequenceCues,
	readyGoals,
	resolveDependencies,
	unsatisfiedDependencies,
} from "../src/dependencies.ts";
import type { ProjectGoal } from "../src/types.ts";

function goal(overrides: Partial<ProjectGoal> & Pick<ProjectGoal, "id">): ProjectGoal {
	return {
		title: overrides.id,
		status: "open",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

describe("project goal dependency graph", () => {
	it("satisfies an edge once its target is done or archived", () => {
		const goals = [
			goal({ id: "done", status: "done" }),
			goal({ id: "archived", status: "archived" }),
			goal({ id: "open" }),
			goal({ id: "active", status: "active" }),
			goal({ id: "waiting", dependsOn: ["done", "archived", "open", "active"] }),
		];
		const waiting = goals[4];

		expect(resolveDependencies(goals, waiting).map((entry) => entry.satisfied)).toEqual([
			true,
			true,
			false,
			false,
		]);
		expect(unsatisfiedDependencies(goals, waiting).map((entry) => entry.id)).toEqual(["open", "active"]);
		expect(isGoalBlocked(goals, waiting)).toBe(true);
	});

	it("reads an edge naming no goal as unsatisfied rather than met", () => {
		// Deleting a goal strips the edges naming it, so a dangling edge means the
		// file was hand-edited. Treating it as satisfied would release a dependent
		// on work nothing ever finished.
		const goals = [goal({ id: "waiting", dependsOn: ["vanished"] })];
		expect(resolveDependencies(goals, goals[0])).toEqual([{ id: "vanished", satisfied: false }]);
		expect(isGoalBlocked(goals, goals[0])).toBe(true);
	});

	it("never calls a settled goal blocked", () => {
		const blockers = [goal({ id: "blocker" })];
		for (const status of ["done", "archived"] as const) {
			const settled = goal({ id: "settled", status, dependsOn: ["blocker"] });
			expect(isGoalBlocked([...blockers, settled], settled), status).toBe(false);
		}
		const live = goal({ id: "live", status: "active", dependsOn: ["blocker"] });
		expect(isGoalBlocked([...blockers, live], live)).toBe(true);
	});

	it("derives the reverse direction from the stored one, in file order", () => {
		const goals = [
			goal({ id: "late", dependsOn: ["foundation"] }),
			goal({ id: "foundation" }),
			goal({ id: "early", dependsOn: ["foundation"] }),
		];
		expect(dependentGoals(goals, goals[1]).map((entry) => entry.id)).toEqual(["late", "early"]);
		expect(dependentGoals(goals, goals[0])).toEqual([]);
	});

	it("resolves an edge written against a former ID", () => {
		const goals = [
			goal({ id: "renamed", previousIds: ["goal-mse1rzxb-8213cc2a"], status: "done" }),
			goal({ id: "waiting", dependsOn: ["goal-mse1rzxb-8213cc2a"] }),
		];
		expect(resolveDependencies(goals, goals[1])[0]).toMatchObject({ satisfied: true });
		expect(dependentGoals(goals, goals[0]).map((entry) => entry.id)).toEqual(["waiting"]);
	});

	it("finds a cycle reachable from one goal and names each goal on it once", () => {
		const goals = [
			goal({ id: "a", dependsOn: ["b"] }),
			goal({ id: "b", dependsOn: ["c"] }),
			goal({ id: "c", dependsOn: ["a"] }),
		];
		expect(findDependencyCycle(goals, "a")).toEqual(["a", "b", "c"]);
		expect(findDependencyCycle(goals, "b")).toEqual(["b", "c", "a"]);
		expect(formatDependencyCycle(["a", "b", "c"])).toBe("a -> b -> c -> a");
	});

	it("treats a goal depending on itself as the degenerate cycle", () => {
		const goals = [goal({ id: "solo", dependsOn: ["solo"] })];
		expect(findDependencyCycle(goals, "solo")).toEqual(["solo"]);
		expect(formatDependencyCycle(["solo"])).toBe("solo -> solo");
	});

	it("reports no cycle for a graph that merely re-converges", () => {
		// A diamond visits `base` twice without ever re-entering the active path, so
		// a walk that mistook a repeat visit for a loop would refuse a valid graph.
		const goals = [
			goal({ id: "base" }),
			goal({ id: "left", dependsOn: ["base"] }),
			goal({ id: "right", dependsOn: ["base"] }),
			goal({ id: "top", dependsOn: ["left", "right"] }),
		];
		expect(findDependencyCycle(goals, "top")).toBeUndefined();
	});

	it("reports nothing for a goal that does not exist", () => {
		expect(findDependencyCycle([goal({ id: "only" })], "missing")).toBeUndefined();
	});

	it("searches every changed goal, including one whose cycle an earlier root cannot reach", () => {
		// The roots share `base`, which the first walk clears, so a search that
		// carried that verdict too far would miss the loop the last root closes.
		const goals = [
			goal({ id: "base" }),
			goal({ id: "left", dependsOn: ["base"] }),
			goal({ id: "right", dependsOn: ["base"] }),
			goal({ id: "trailer", dependsOn: ["base", "loop"] }),
			goal({ id: "loop", dependsOn: ["trailer"] }),
		];
		expect(findDependencyCycleFromRoots(goals, ["left", "right"])).toBeUndefined();
		expect(findDependencyCycleFromRoots(goals, ["left", "right", "trailer"])).toEqual(["trailer", "loop"]);
		expect(findDependencyCycleFromRoots(goals, [])).toBeUndefined();
		expect(findDependencyCycleFromRoots(goals, ["missing"])).toBeUndefined();
	});
});

describe("project goal sequencing", () => {
	it("offers the whole unblocked frontier and starts with the first of it", () => {
		const goals = [
			goal({ id: "landed", status: "done" }),
			goal({ id: "waiting", dependsOn: ["frontier"] }),
			goal({ id: "released", dependsOn: ["landed"] }),
			goal({ id: "frontier" }),
		];

		expect(readyGoals(goals).map((entry) => entry.id)).toEqual(["released", "frontier"]);
		// next is the first ready goal by definition, so the two can never disagree.
		expect(nextGoal(goals)?.id).toBe(readyGoals(goals)[0].id);
		expect(nextGoal(goals)?.id).toBe("released");
	});

	it("holds back a goal someone already took, whether by activation or by branch", () => {
		const goals = [
			goal({ id: "activated", status: "active" }),
			goal({ id: "dispatched", branch: "feat/dispatched" }),
			goal({ id: "free" }),
		];

		expect(goals.map(isGoalClaimed)).toEqual([true, true, false]);
		expect(readyGoals(goals).map((entry) => entry.id)).toEqual(["free"]);
		expect(nextGoal(goals)?.id).toBe("free");
	});

	it("suggests nothing rather than settled or blocked work", () => {
		const settled = [goal({ id: "done", status: "done" }), goal({ id: "archived", status: "archived" })];
		expect(readyGoals(settled)).toEqual([]);
		expect(nextGoal(settled)).toBeUndefined();
		expect(nextGoal([])).toBeUndefined();

		const blocked = [goal({ id: "blocker" }), goal({ id: "waiting", dependsOn: ["blocker"] })];
		expect(readyGoals(blocked).map((entry) => entry.id)).toEqual(["blocker"]);
	});

	it("layers unfinished goals into the earliest wave each could start in", () => {
		const goals = [
			goal({ id: "last", dependsOn: ["left", "right"] }),
			goal({ id: "left", dependsOn: ["base"] }),
			goal({ id: "base", dependsOn: ["landed"] }),
			goal({ id: "landed", status: "done" }),
			goal({ id: "right", dependsOn: ["base"] }),
		];

		const { waves, unreachable } = dependencyWaves(goals);
		// A settled dependency clears its dependent into wave 1, and each wave holds
		// its goals in file order rather than the order the walk reached them.
		expect(waves.map((wave) => wave.map((entry) => entry.id))).toEqual([
			["base"],
			["left", "right"],
			["last"],
		]);
		expect(unreachable).toEqual([]);
	});

	it("layers a claimed goal like any other, because a wave is not a suggestion", () => {
		const goals = [
			goal({ id: "inflight", status: "active" }),
			goal({ id: "dispatched", branch: "feat/dispatched" }),
			goal({ id: "waiting", dependsOn: ["inflight"] }),
		];

		const { waves } = dependencyWaves(goals);
		expect(waves.map((wave) => wave.map((entry) => entry.id))).toEqual([
			["inflight", "dispatched"],
			["waiting"],
		]);
		// The frontier is wave 1 with the claimed goals removed, so a reader can see
		// why a goal that appears in the schedule is not on offer.
		expect(readyGoals(goals)).toEqual([]);
	});

	it("leaves out finished work and reports an empty roadmap as no waves at all", () => {
		expect(dependencyWaves([])).toEqual({ waves: [], unreachable: [] });
		const settled = [goal({ id: "done", status: "done" }), goal({ id: "archived", status: "archived" })];
		expect(dependencyWaves(settled)).toEqual({ waves: [], unreachable: [] });
	});

	it("names the goals no wave can hold instead of dropping them from the schedule", () => {
		// Both shapes need a hand-edited file: mutations refuse a cycle and strip the
		// edges naming a deleted goal. A goal missing from the schedule entirely is a
		// goal nobody notices is stuck, so they are reported rather than omitted.
		const goals = [
			goal({ id: "startable" }),
			goal({ id: "dangling", dependsOn: ["vanished"] }),
			goal({ id: "loop-a", dependsOn: ["loop-b"] }),
			goal({ id: "loop-b", dependsOn: ["loop-a"] }),
			goal({ id: "behind-the-loop", dependsOn: ["loop-a"] }),
		];

		const { waves, unreachable } = dependencyWaves(goals);
		expect(waves.map((wave) => wave.map((entry) => entry.id))).toEqual([["startable"]]);
		expect(unreachable.map((entry) => entry.id)).toEqual(["dangling", "loop-a", "loop-b", "behind-the-loop"]);
	});

	it("orders active, settled, dependency waves, and unreachable work", () => {
		const goals = [
			goal({ id: "later", dependsOn: ["ready"] }),
			goal({ id: "stuck", dependsOn: ["missing"] }),
			goal({ id: "done", status: "done" }),
			goal({ id: "ready" }),
			goal({ id: "active", status: "active" }),
			goal({ id: "same-wave" }),
		];

		expect(goalsInDependencyOrder(goals).map((entry) => entry.id)).toEqual([
			"active",
			"done",
			"ready",
			"same-wave",
			"later",
			"stuck",
		]);
	});

	it("derives compact cues for readiness, claims, later waves, and unreachable work", () => {
		const goals = [
			goal({ id: "ready" }),
			goal({ id: "active", status: "active", branch: "feat/active" }),
			goal({ id: "claimed", branch: "feat/claimed" }),
			goal({ id: "later", dependsOn: ["ready"] }),
			goal({ id: "stuck", dependsOn: ["missing"] }),
			goal({ id: "done", status: "done" }),
			goal({ id: "archived", status: "archived" }),
		];

		expect(Object.fromEntries(projectGoalSequenceCues(goals))).toEqual({
			ready: { badge: "READY", readiness: "Ready", wave: 1 },
			active: { badge: "ACTIVE", readiness: "Active", wave: 1 },
			claimed: { badge: "CLAIMED", readiness: "Claimed", wave: 1 },
			later: { badge: "W2", readiness: "Blocked", wave: 2 },
			stuck: { badge: "STUCK", readiness: "Stuck", unreachable: true },
		});
	});

	it("keeps an active or claimed cue when no dependency wave can reach it", () => {
		const goals = [
			goal({ id: "active", status: "active", dependsOn: ["missing"] }),
			goal({ id: "claimed", branch: "feat/claimed", dependsOn: ["missing"] }),
		];

		expect(Object.fromEntries(projectGoalSequenceCues(goals))).toEqual({
			active: { badge: "ACTIVE", readiness: "Active", unreachable: true },
			claimed: { badge: "CLAIMED", readiness: "Claimed", unreachable: true },
		});
	});

	it("resolves sequencing edges through former IDs and past retired ones", () => {
		const goals = [
			goal({ id: "renamed", previousIds: ["goal-mse1rzxb-8213cc2a"], status: "done" }),
			goal({ id: "released", dependsOn: ["goal-mse1rzxb-8213cc2a"] }),
			goal({ id: "orphaned", dependsOn: ["goal-mse1rzxb-retired"] }),
		];
		const retiredIds = ["goal-mse1rzxb-retired"];

		expect(readyGoals(goals, retiredIds).map((entry) => entry.id)).toEqual(["released"]);
		expect(nextGoal(goals, retiredIds)?.id).toBe("released");
		const { waves, unreachable } = dependencyWaves(goals, retiredIds);
		expect(waves.map((wave) => wave.map((entry) => entry.id))).toEqual([["released"]]);
		expect(unreachable.map((entry) => entry.id)).toEqual(["orphaned"]);
	});
});
