import { findGoalByStoredId } from "./goal-selection.ts";
import type { ProjectGoal } from "./types.ts";

/**
 * The Project Goal dependency graph: what an edge means and what it implies.
 *
 * Only the forward direction is stored, as `dependsOn` on the goal that waits.
 * Everything else here is derived from that one array, so a reverse edge, a
 * blocked reading, and a cycle report can never disagree with the file.
 *
 * These functions are pure and Pi-free, so the CLI, the terminal board, the
 * model tool, and the mutation service all read the same graph the same way.
 */

/**
 * Whether a dependency has been met.
 *
 * Done and archived both count: an archived goal is one someone decided not to
 * do, which settles the question the edge was waiting on just as finishing it
 * would. Anything still open or active has not landed yet.
 */
export function isDependencySatisfied(goal: ProjectGoal): boolean {
	return goal.status === "done" || goal.status === "archived";
}

/**
 * The goals still to do, which is what every sequencing read is a view of.
 *
 * Defined once beside the predicate it inverts, so a count reported alongside a
 * schedule and the goals the schedule actually holds cannot drift apart.
 */
export function unfinishedGoals(goals: readonly ProjectGoal[]): ProjectGoal[] {
	return goals.filter((goal) => !isDependencySatisfied(goal));
}

/** One stored edge, resolved against the goals it was read alongside. */
export interface GoalDependency {
	/** The ID exactly as stored on the depending goal. */
	id: string;
	/** The goal it names, absent when the edge resolves to nothing. */
	goal?: ProjectGoal;
	satisfied: boolean;
}

/**
 * A goal's dependencies in stored order, each resolved to the goal it names.
 *
 * An edge that resolves to nothing is reported unsatisfied rather than ignored.
 * Deleting a goal strips the edges naming it inside the same mutation, so a
 * dangling edge means the file was edited by hand, and reading it as satisfied
 * would quietly release a goal that nothing ever finished.
 */
export function resolveDependencies(
	goals: readonly ProjectGoal[],
	goal: ProjectGoal,
	retiredIds: readonly string[] = [],
): GoalDependency[] {
	return (goal.dependsOn ?? []).map((id) => {
		const target = findGoalByStoredId(goals, id, retiredIds);
		return {
			id,
			...(target ? { goal: target } : {}),
			satisfied: target !== undefined && isDependencySatisfied(target),
		};
	});
}

/** The dependencies still standing between a goal and the work starting. */
export function unsatisfiedDependencies(
	goals: readonly ProjectGoal[],
	goal: ProjectGoal,
	retiredIds: readonly string[] = [],
): GoalDependency[] {
	return resolveDependencies(goals, goal, retiredIds).filter((entry) => !entry.satisfied);
}

/**
 * Whether a goal is waiting on work that has not landed.
 *
 * Blocked is a derived display state rather than a status: it is recomputed from
 * the graph on every read, so nothing can be left marked blocked after the goal
 * that held it up was finished. A settled goal is never blocked, because a done
 * or archived goal is not waiting to start.
 */
export function isGoalBlocked(
	goals: readonly ProjectGoal[],
	goal: ProjectGoal,
	retiredIds: readonly string[] = [],
): boolean {
	if (isDependencySatisfied(goal)) return false;
	return unsatisfiedDependencies(goals, goal, retiredIds).length > 0;
}

/**
 * The goals this one blocks, in canonical file order.
 *
 * Derived by scanning forward edges rather than stored, so adding an edge writes
 * one field on one goal and both directions stay true by construction.
 */
export function dependentGoals(
	goals: readonly ProjectGoal[],
	goal: ProjectGoal,
	retiredIds: readonly string[] = [],
): ProjectGoal[] {
	return goals.filter((candidate) =>
		(candidate.dependsOn ?? []).some((id) => findGoalByStoredId(goals, id, retiredIds)?.id === goal.id),
	);
}

/**
 * A dependency cycle reachable from one goal, as the goals on it in order.
 *
 * The walk starts at the goal a mutation changed, because every other goal's
 * edges were already acyclic before it ran, so a cycle can only exist if the new
 * edges closed one. A goal that depends on itself is the degenerate case and
 * comes back as a single-entry path.
 *
 * The result names each goal on the cycle once, starting with the first one the
 * walk re-entered, so `["a", "b"]` reads as `a -> b -> a`.
 */
export function findDependencyCycle(
	goals: readonly ProjectGoal[],
	startId: string,
	retiredIds: readonly string[] = [],
): string[] | undefined {
	return findDependencyCycleFromRoots(goals, [startId], retiredIds);
}

/**
 * The first dependency cycle reachable from any of the goals a mutation changed.
 *
 * A batch mutation adds many goals at once and every one of them can close a
 * loop, so all of them are roots. One walk covers them all: a goal the walk has
 * already left behind reaches no cycle in this graph, and that stays true
 * whichever root arrived at it, so the roots share a single settled set instead
 * of re-walking the graph once per root under the write lock.
 */
export function findDependencyCycleFromRoots(
	goals: readonly ProjectGoal[],
	startIds: readonly string[],
	retiredIds: readonly string[] = [],
): string[] | undefined {
	const path: string[] = [];
	const onPath = new Set<string>();
	const settled = new Set<string>();

	const walk = (goal: ProjectGoal): string[] | undefined => {
		path.push(goal.id);
		onPath.add(goal.id);
		for (const id of goal.dependsOn ?? []) {
			const next = findGoalByStoredId(goals, id, retiredIds);
			if (!next || settled.has(next.id)) continue;
			if (onPath.has(next.id)) return path.slice(path.indexOf(next.id));
			const cycle = walk(next);
			if (cycle) return cycle;
		}
		path.pop();
		onPath.delete(goal.id);
		settled.add(goal.id);
		return undefined;
	};

	for (const startId of startIds) {
		const start = findGoalByStoredId(goals, startId, retiredIds);
		if (!start || settled.has(start.id)) continue;
		const cycle = walk(start);
		if (cycle) return cycle;
	}
	return undefined;
}

/** Render a cycle as the chain it is, so an error names the whole loop. */
export function formatDependencyCycle(cycle: readonly string[]): string {
	return [...cycle, cycle[0]].join(" -> ");
}

/**
 * Whether someone has already taken a goal on.
 *
 * Activation and a recorded branch are the two ways a goal is spoken for: one
 * says a human named it the goal in flight, the other is the dispatch marker
 * written when work actually starts. Both are read from dedicated fields rather
 * than inferred from prose, so a goal is claimed only when somebody said so.
 */
export function isGoalClaimed(goal: ProjectGoal): boolean {
	return goal.status === "active" || goal.branch !== undefined;
}

/**
 * The goals that could be started right now, in canonical file order.
 *
 * This is the parallel frontier: every one of them has had its dependencies
 * land, and none of them is already spoken for, so they may all run at once.
 * Claimed goals are left out because handing the same work to a second driver
 * is the one mistake a dispatch read exists to prevent.
 */
export function readyGoals(goals: readonly ProjectGoal[], retiredIds: readonly string[] = []): ProjectGoal[] {
	return goals.filter(
		(goal) => goal.status === "open" && !isGoalClaimed(goal) && !isGoalBlocked(goals, goal, retiredIds),
	);
}

/**
 * The single goal to start next, or nothing when the frontier is empty.
 *
 * Defined as the first ready goal rather than computed another way, so a driver
 * asking for one goal and a human reading the whole frontier can never be told
 * two different things. File order breaks the tie because that order is the
 * sequence somebody arranged the roadmap in.
 */
export function nextGoal(
	goals: readonly ProjectGoal[],
	retiredIds: readonly string[] = [],
): ProjectGoal | undefined {
	return readyGoals(goals, retiredIds)[0];
}

/** Unfinished goals in dependency layers, and the ones no layer can hold. */
export interface GoalWaves {
	/** Topological layers, earliest first; wave 1 is the unblocked frontier. */
	waves: ProjectGoal[][];
	/** Goals whose edges can never all land, through a cycle or a missing goal. */
	unreachable: ProjectGoal[];
}

/**
 * Unfinished goals arranged into the earliest layer each could start in.
 *
 * Wave 1 is everything unblocked today, and each later wave is exactly what the
 * wave before it releases, so the layers read as a schedule: how much can run in
 * parallel, and what finishing this round opens up. Layering is about the shape
 * of the remaining work rather than what is free to pick up, so a claimed goal
 * still occupies its wave; `readyGoals` is the frontier with those removed.
 *
 * A goal on a hand-edited cycle, or waiting on an edge that names no goal, can
 * never be released by any wave. Those come back separately rather than being
 * dropped, because a goal missing from the schedule entirely is a goal nobody
 * notices is stuck.
 */
export function dependencyWaves(
	goals: readonly ProjectGoal[],
	retiredIds: readonly string[] = [],
): GoalWaves {
	const placed = new Set<string>();
	const waves: ProjectGoal[][] = [];
	let remaining = unfinishedGoals(goals);
	while (remaining.length > 0) {
		const wave = remaining.filter((goal) =>
			unsatisfiedDependencies(goals, goal, retiredIds).every(
				(entry) => entry.goal !== undefined && placed.has(entry.goal.id),
			),
		);
		// Nothing became eligible, so every goal left is waiting on something no
		// wave will ever land; another pass would loop over the same set forever.
		if (wave.length === 0) break;
		for (const goal of wave) placed.add(goal.id);
		waves.push(wave);
		remaining = remaining.filter((goal) => !placed.has(goal.id));
	}
	return { waves, unreachable: remaining };
}

export interface ProjectGoalSequenceCue {
	badge: "ACTIVE" | "CLAIMED" | "READY" | `W${number}` | "STUCK";
	readiness: "Active" | "Claimed" | "Ready" | "Blocked" | "Stuck";
	/** Earliest dependency wave, absent when no wave can reach the goal. */
	wave?: number;
	unreachable?: true;
}

/**
 * Compact sequencing cues for unfinished goals, keyed by stable goal ID.
 *
 * A cue is a derived view over the dependency graph and claim fields. It never
 * becomes stored state. Active and branch claims take precedence over readiness
 * because work already in flight must not read as available to start again.
 */
export function projectGoalSequenceCues(
	goals: readonly ProjectGoal[],
	retiredIds: readonly string[] = [],
): Map<string, ProjectGoalSequenceCue> {
	const cues = new Map<string, ProjectGoalSequenceCue>();
	const cueFor = (goal: ProjectGoal, wave?: number): ProjectGoalSequenceCue => {
		if (goal.status === "active") return { badge: "ACTIVE", readiness: "Active", ...(wave ? { wave } : {}) };
		if (goal.branch !== undefined)
			return { badge: "CLAIMED", readiness: "Claimed", ...(wave ? { wave } : {}) };
		if (wave === 1) return { badge: "READY", readiness: "Ready", wave };
		if (wave !== undefined) return { badge: `W${wave}`, readiness: "Blocked", wave };
		return { badge: "STUCK", readiness: "Stuck", unreachable: true };
	};

	const { waves, unreachable } = dependencyWaves(goals, retiredIds);
	waves.forEach((wave, index) => {
		for (const goal of wave) cues.set(goal.id, cueFor(goal, index + 1));
	});
	for (const goal of unreachable) {
		const cue = cueFor(goal);
		cues.set(goal.id, { ...cue, unreachable: true });
	}
	return cues;
}

/**
 * Goals in the dependency schedule shown by interactive Project Goal lists.
 *
 * Active work stays first. Settled work follows because it has already released
 * its dependents. Unfinished goals then follow their earliest dependency wave.
 * File order breaks every tie, and unreachable work stays last.
 */
export function goalsInDependencyOrder(
	goals: readonly ProjectGoal[],
	retiredIds: readonly string[] = [],
): ProjectGoal[] {
	const fileRank = new Map(goals.map((goal, index) => [goal.id, index]));
	const cues = projectGoalSequenceCues(goals, retiredIds);
	const rank = (goal: ProjectGoal): number => {
		if (goal.status === "done" || goal.status === "archived") return 0;
		return cues.get(goal.id)?.wave ?? Number.MAX_SAFE_INTEGER;
	};
	return [...goals].sort((left, right) => {
		if ((left.status === "active") !== (right.status === "active")) {
			return left.status === "active" ? -1 : 1;
		}
		const wave = rank(left) - rank(right);
		if (wave !== 0) return wave;
		return (fileRank.get(left.id) ?? 0) - (fileRank.get(right.id) ?? 0);
	});
}
