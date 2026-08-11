import type { ProjectGoal, ProjectGoalStatus, SessionTask } from "./types.ts";

/**
 * Where each status sits whenever goals are ordered or counted by state: work in
 * flight first, then work still waiting, then everything already settled.
 *
 * A record rather than a list, so a status added to `ProjectGoalStatus` fails to
 * compile here instead of quietly dropping out of the counts a surface states.
 * A dropped status is not a missing chip: both the board header and the roadmap
 * summary print a total beside the parts, and the total would stop equalling the
 * sum of the parts it lists.
 */
export const GOAL_STATUS_RANK: Readonly<Record<ProjectGoalStatus, number>> = {
	active: 0,
	open: 1,
	done: 2,
	archived: 3,
};

/** Every status, in the one order every surface states them in. */
export const GOAL_STATUS_ORDER: readonly ProjectGoalStatus[] = (
	Object.keys(GOAL_STATUS_RANK) as ProjectGoalStatus[]
).sort((left, right) => GOAL_STATUS_RANK[left] - GOAL_STATUS_RANK[right]);

/** How many goals sit in one status. */
export interface GoalStatusCount {
	status: ProjectGoalStatus;
	count: number;
}

/**
 * How much of a roadmap sits in each state, in the shared order.
 *
 * A status nothing is in is left out rather than reported as a zero, so a
 * summary reads as what the roadmap holds instead of as a form with empty
 * fields. Shared rather than repeated per surface, because the board header and
 * the roadmap page are counting the same goals under the same rule.
 */
export function goalStatusCounts(goals: readonly ProjectGoal[]): GoalStatusCount[] {
	return GOAL_STATUS_ORDER.map((status) => ({
		status,
		count: goals.filter((goal) => goal.status === status).length,
	})).filter((entry) => entry.count > 0);
}

export function compactDescription(description: string): string {
	return description.replace(/\s+/g, " ").trim();
}

/**
 * `1 goal` or `3 goals`, so a count reads as a sentence wherever it is stated.
 *
 * Shared rather than spelled out per surface, because a wave header at the
 * terminal and a summary on the roadmap page are counting the same things and
 * have no reason to word it differently.
 */
export function goalCount(count: number): string {
	return `${count} goal${count === 1 ? "" : "s"}`;
}

export function formatSessionTasks(tasks: SessionTask[]): string {
	if (tasks.length === 0) return "No session tasks.";
	return tasks
		.map((t) => {
			const marker = t.status === "done" ? "[x]" : t.status === "doing" ? "[~]" : "[ ]";
			const goal = t.goalId ? ` (goal:${t.goalId})` : "";
			return `${marker} ${t.id}: ${t.title}${goal}`;
		})
		.join("\n");
}

export function formatProjectGoals(goals: ProjectGoal[]): string {
	if (goals.length === 0) return "No project goals.";
	// Canonical file order, unsorted: the array is the roadmap's own order.
	return goals
		.map(
			(g) =>
				`[${g.status}] ${g.id}: ${g.title}${g.description ? ` - ${compactDescription(g.description)}` : ""}`,
		)
		.join("\n");
}
