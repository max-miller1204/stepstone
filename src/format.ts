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

/**
 * One glyph per status.
 *
 * The active goal gets a diamond rather than a fourth circle so the pinned row
 * still reads as the odd one out on a terminal with no color at all. Shared
 * rather than spelled out per surface, because the terminal board, the inline
 * widget, and the dashboard are naming the same four states.
 */
export const GOAL_STATUS_MARKERS: Readonly<Record<ProjectGoalStatus, string>> = {
	active: "◆",
	open: "○",
	done: "✓",
	archived: "◌",
};

/** A goal still in play and untouched for this long is worth pointing at. */
export const GOAL_STALE_AFTER_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The section a goal reads as being filed under.
 *
 * A goal file is editable by hand and the schema only requires a string here, so
 * a blank or padded group is normalized the way a written one would have been
 * rather than rendering a header with no name on it.
 */
export function goalSection(goal: ProjectGoal): string | undefined {
	return goal.group?.trim() || undefined;
}

/**
 * Whole days since a goal was last touched, once that crosses the threshold.
 *
 * Only work still in play can go stale: a done or archived goal is finished
 * rather than neglected, so its age says nothing a surface should nag about.
 */
export function goalStalenessDays(goal: ProjectGoal, now: number = Date.now()): number | undefined {
	if (goal.status !== "open" && goal.status !== "active") return undefined;
	const updated = Date.parse(goal.updatedAt);
	if (!Number.isFinite(updated)) return undefined;
	const days = Math.floor((now - updated) / DAY_MS);
	return days >= GOAL_STALE_AFTER_DAYS ? days : undefined;
}

/** Render an ISO timestamp as local `YYYY-MM-DD HH:MM`, or pass it through unchanged. */
export function formatGoalTimestamp(value: string): string {
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) return value;
	const pad = (part: number) => String(part).padStart(2, "0");
	const date = `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`;
	return `${date} ${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
}

/** Key of the bucket for goals no group names, which shares a namespace with group names. */
export const UNGROUPED_SECTION_KEY = "\u0000ungrouped";
export const UNGROUPED_SECTION_LABEL = "Ungrouped";

/** One section of a goal list, and the goals filed under it in canonical file order. */
export interface GoalSection {
	key: string;
	label: string;
	goals: ProjectGoal[];
	/** False for the implicit bucket, which is a leftover rather than a section somebody named. */
	named: boolean;
}

/**
 * Goals grouped into sections in first-appearance order, with the unnamed ones last.
 *
 * The implicit bucket is kept beside the named sections rather than inside them,
 * so a goal filed under a group that happens to spell the bucket's own key
 * cannot overwrite it and disappear from the list.
 *
 * A roadmap where nothing is grouped comes back as that one unnamed bucket, so
 * callers can render it as a plain list: a header that is the only header says
 * nothing, and it would cost every existing roadmap a row.
 */
export function goalSections(goals: readonly ProjectGoal[]): GoalSection[] {
	const named = new Map<string, ProjectGoal[]>();
	const ungrouped: ProjectGoal[] = [];
	for (const goal of goals) {
		const section = goalSection(goal);
		if (section === undefined) {
			ungrouped.push(goal);
			continue;
		}
		const existing = named.get(section);
		if (existing) existing.push(goal);
		else named.set(section, [goal]);
	}
	const sections: GoalSection[] = [...named].map(([label, sectionGoals]) => ({
		key: label,
		label,
		goals: sectionGoals,
		named: true,
	}));
	if (ungrouped.length > 0) {
		sections.push({
			key: UNGROUPED_SECTION_KEY,
			label: UNGROUPED_SECTION_LABEL,
			goals: ungrouped,
			named: false,
		});
	}
	return sections;
}

/** Whether a section list is the single unnamed bucket a roadmap with no groups yields. */
export function isUngroupedList(sections: readonly GoalSection[]): boolean {
	return sections.length === 1 && !sections[0].named;
}

/** The section a goal is shown under, among sections built from a list holding it. */
export function sectionHolding(sections: readonly GoalSection[], goalId: string): GoalSection | undefined {
	return sections.find((section) => section.goals.some((goal) => goal.id === goalId));
}

/** Where a one-step reorder puts a goal, as an anchored placement. */
export interface GoalReorderPlacement {
	id: string;
	beforeId: string;
}

/**
 * The file move that lands a one-step reorder inside `section` on screen.
 *
 * The pair is always rewritten as "put the goal that ends up first immediately
 * before the goal that ends up second", never as "put the moved goal after its
 * neighbour". Both spell the same two-goal order, but only the first leaves a
 * section where it was: sections are ordered by the earliest file position any
 * of their goals holds, so re-inserting a section's own first goal further down
 * hands that position to whatever goal happens to sit between them and makes an
 * unrelated section jump the queue. Inserting at a position the section already
 * occupies cannot move the section at all.
 *
 * Shared by every surface that reorders goals, because a keystroke that reads
 * the same on the terminal board and in the inline dashboard has to write the
 * same file. A step off either end of the section is no move: the section is the
 * list, and crossing into another one would write an order the sections put back.
 */
export function resolveSectionReorder(
	section: readonly ProjectGoal[],
	sourceId: string,
	delta: -1 | 1,
): GoalReorderPlacement | undefined {
	const sourceIndex = section.findIndex((goal) => goal.id === sourceId);
	if (sourceIndex < 0) return undefined;
	const anchor = section[sourceIndex + delta];
	if (!anchor) return undefined;
	const [first, second] = delta < 0 ? [section[sourceIndex], anchor] : [anchor, section[sourceIndex]];
	return { id: first.id, beforeId: second.id };
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
