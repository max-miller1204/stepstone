import type { ProjectGoal, SessionTask } from "./types.ts";

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
