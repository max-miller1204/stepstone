import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { dependentGoals, isGoalBlocked, resolveDependencies } from "./dependencies.ts";
import {
	compactDescription,
	formatGoalTimestamp,
	GOAL_STATUS_MARKERS,
	goalSection,
	goalSections,
	goalStalenessDays,
	goalStatusCounts,
	isUngroupedList,
	resolveSectionReorder,
	sectionHolding,
} from "./format.ts";
import type { ProjectGoal, SessionTask, SessionTaskPlacement } from "./types.ts";

function goalCountLine(goals: readonly ProjectGoal[]): string {
	return goalStatusCounts(goals)
		.map((entry) => `${GOAL_STATUS_MARKERS[entry.status]} ${entry.count}`)
		.join(" · ");
}

export function buildWidgetLines(tasks: SessionTask[], goals: ProjectGoal[]): string[] {
	const active = goals.find((goal) => goal.status === "active");
	const pending = tasks.filter((task) => task.status !== "done");
	if (!active && goals.length === 0 && pending.length === 0) return [];
	const lines: string[] = [];
	if (active) lines.push(`${GOAL_STATUS_MARKERS.active} Active: ${active.title}`);
	if (goals.length > 0) lines.push(`Goals: ${goalCountLine(goals)}`);
	for (const task of pending.slice(0, 3)) {
		lines.push(`${task.status === "doing" ? "●" : "○"} ${task.title}`);
	}
	if (pending.length > 3) lines.push(`+${pending.length - 3} more`);
	return lines;
}

export function buildPromptSummary(tasks: SessionTask[], goals: ProjectGoal[], maxItems = 8): string {
	const active = goals.find((goal) => goal.status === "active");
	const pending = tasks.filter((task) => task.status !== "done").slice(0, maxItems);
	if (!active && pending.length === 0) return "";
	const lines = ["[WORKLIST]"];
	if (active) {
		const description = active.description ? ` - ${compactDescription(active.description)}` : "";
		lines.push(`Active project goal: ${active.title}${description}`);
	}
	if (pending.length) {
		lines.push("Incomplete session tasks:");
		for (const task of pending) {
			lines.push(`- [${task.status === "doing" ? "doing" : "todo"}] ${task.title}`);
		}
	}
	const remaining = tasks.filter((task) => task.status !== "done").length - pending.length;
	if (remaining > 0) lines.push(`- ...and ${remaining} more`);
	return lines.join("\n");
}

export type DashboardAction =
	| { kind: "close" }
	| { kind: "view"; scope: "session" | "project"; id: string }
	| { kind: "add"; scope: "session" | "project" }
	| { kind: "insert"; scope: "session"; beforeId: string }
	| ({ kind: "move"; scope: "session" | "project"; id: string } & SessionTaskPlacement)
	| { kind: "edit"; scope: "session" | "project"; id: string }
	| { kind: "advance"; scope: "session" | "project"; id: string }
	| { kind: "delete"; scope: "session" | "project"; id: string };

export interface DashboardState {
	scope: "session" | "project";
	selectedId?: string;
}

export interface DashboardResult {
	action: DashboardAction;
	state: DashboardState;
}

type DashboardProjectRow =
	| { kind: "group"; label: string; count: number }
	| { kind: "goal"; goal: ProjectGoal; indented: boolean };

function groupedProjectRows(goals: readonly ProjectGoal[]): DashboardProjectRow[] {
	const sections = goalSections(goals);
	if (isUngroupedList(sections))
		return sections[0].goals.map((goal) => ({ kind: "goal", goal, indented: false }));

	const rows: DashboardProjectRow[] = [];
	for (const section of sections) {
		rows.push({ kind: "group", label: section.label, count: section.goals.length });
		rows.push(...section.goals.map((goal) => ({ kind: "goal" as const, goal, indented: true })));
	}
	return rows;
}

export class Dashboard {
	private scope: "session" | "project";
	private selected: number;
	constructor(
		private readonly tasks: SessionTask[],
		private readonly goals: ProjectGoal[],
		private readonly theme: Theme,
		private readonly done: (result: DashboardResult) => void,
		initialState?: DashboardState,
		private readonly now: () => number = Date.now,
	) {
		this.scope = initialState?.scope ?? "session";
		const selectedIndex = initialState?.selectedId
			? this.items().findIndex((item) => item.id === initialState.selectedId)
			: -1;
		this.selected = selectedIndex >= 0 ? selectedIndex : 0;
	}

	/** The goals the Project Goal pane lists, before they are grouped into rows. */
	private visibleGoals(): ProjectGoal[] {
		return this.goals.filter((goal) => goal.status !== "archived");
	}

	/**
	 * The roadmap's shape, counted over every goal rather than the listed ones.
	 *
	 * The chips state what the roadmap holds, which is the same thing the terminal
	 * board's header states, so an archived goal is counted here even though this
	 * pane never lists one and offers no filter key to reveal it. That would leave
	 * a chip standing for rows nobody can find, so the board's `shown of total` is
	 * carried over to say how many of the counted goals are on screen, and it is
	 * only worth a reader's attention when the two numbers differ.
	 */
	private goalCountSummary(): string {
		const listed = this.visibleGoals().length;
		const counts = goalCountLine(this.goals);
		return listed === this.goals.length ? counts : `${counts} · ${listed} of ${this.goals.length} listed`;
	}

	private items(): Array<SessionTask | ProjectGoal> {
		if (this.scope === "session") return this.tasks;
		return groupedProjectRows(this.visibleGoals())
			.filter((row): row is Extract<DashboardProjectRow, { kind: "goal" }> => row.kind === "goal")
			.map((row) => row.goal);
	}

	private finish(action: DashboardAction): void {
		const selectedId = this.items()[this.selected]?.id;
		this.done({
			action,
			state: { scope: this.scope, ...(selectedId !== undefined ? { selectedId } : {}) },
		});
	}

	/**
	 * Reorder the selected item within the list it is shown in.
	 *
	 * A Session Task anchors on the neighboring row rather than a stored index, so
	 * a move lands where the user watched it land even when the list is a filtered
	 * view of a longer one.
	 *
	 * A Project Goal moves through the rule the terminal board reorders by, so one
	 * keystroke cannot mean two things across the two surfaces: the goal steps
	 * within its own section, a section boundary is an end of the list, and the
	 * pair is written so that re-inserting a section's first goal cannot hand its
	 * file position - and with it the section's place on the roadmap - to a goal
	 * filed under a different section.
	 */
	private moveAction(
		item: { id: string },
		items: Array<{ id: string }>,
		delta: -1 | 1,
	): DashboardAction | undefined {
		if (this.scope === "project") {
			const section = sectionHolding(goalSections(this.visibleGoals()), item.id);
			const placement = section && resolveSectionReorder(section.goals, item.id, delta);
			return placement ? { kind: "move", scope: "project", ...placement } : undefined;
		}
		const anchor = items[this.selected + delta];
		if (!anchor) return undefined;
		return delta < 0
			? { kind: "move", scope: "session", id: item.id, beforeId: anchor.id }
			: { kind: "move", scope: "session", id: item.id, afterId: anchor.id };
	}

	private handleMove(data: string, items: Array<{ id: string }>): boolean {
		const delta = matchesKey(data, Key.shift("up"))
			? -1
			: matchesKey(data, Key.shift("down"))
				? 1
				: undefined;
		if (delta === undefined) return false;
		const item = items[this.selected];
		const action = item && this.moveAction(item, items, delta);
		if (action) this.finish(action);
		return true;
	}

	handleInput(data: string): void {
		const items = this.items();
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.finish({ kind: "close" });
			return;
		}
		if (matchesKey(data, Key.tab) || matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
			this.scope = this.scope === "session" ? "project" : "session";
			this.selected = 0;
			return;
		}
		if (this.handleMove(data, items)) return;
		if (matchesKey(data, Key.up)) this.selected = Math.max(0, this.selected - 1);
		if (matchesKey(data, Key.down))
			this.selected = Math.min(Math.max(0, items.length - 1), this.selected + 1);
		if (data === "a") {
			this.finish({ kind: "add", scope: this.scope });
			return;
		}
		const item = items[this.selected];
		if (!item) return;
		if (data === "i" && this.scope === "session") {
			this.finish({ kind: "insert", scope: "session", beforeId: item.id });
		} else if (data === "e") this.finish({ kind: "edit", scope: this.scope, id: item.id });
		else if (data === "d") this.finish({ kind: "delete", scope: this.scope, id: item.id });
		else if (data === "v" || matchesKey(data, Key.enter)) {
			this.finish({ kind: "view", scope: this.scope, id: item.id });
		} else if (matchesKey(data, Key.space)) {
			this.finish({ kind: "advance", scope: this.scope, id: item.id });
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const lines = [
			th.fg("accent", th.bold("Worklist")),
			`${this.scope === "session" ? th.fg("accent", "[Session Tasks]") : "Session Tasks"}  ${this.scope === "project" ? th.fg("accent", "[Project Goals]") : "Project Goals"}`,
			"",
		];
		const items = this.items();
		if (this.scope === "project" && this.goals.length > 0) {
			lines.push(th.fg("muted", `Goals: ${this.goalCountSummary()}`), "");
		}
		if (!items.length) lines.push(th.fg("dim", "  No items. Press a to add one."));
		if (this.scope === "project") {
			let itemIndex = 0;
			for (const row of groupedProjectRows(this.visibleGoals())) {
				if (row.kind === "group") {
					lines.push(`  ${th.bold(`▾ ${row.label}`)} ${th.fg("dim", `(${row.count})`)}`);
					continue;
				}
				const goal = row.goal;
				const prefix = itemIndex === this.selected ? th.fg("accent", ">") : " ";
				const inset = row.indented ? "  " : "";
				const marker =
					goal.status === "active"
						? th.fg("accent", GOAL_STATUS_MARKERS.active)
						: GOAL_STATUS_MARKERS[goal.status];
				const settled = goal.status === "done" || goal.status === "archived";
				const title =
					goal.status === "active"
						? th.fg("accent", th.bold(goal.title))
						: settled
							? th.fg("dim", goal.title)
							: goal.title;
				const stale = goalStalenessDays(goal, this.now());
				const badge = stale === undefined ? "" : ` ${th.fg("muted", `${stale}d`)}`;
				const blocked = isGoalBlocked(this.goals, goal) ? ` ${th.fg("muted", "blocked")}` : "";
				lines.push(`${prefix} ${inset}${marker} ${title}${badge}${blocked} ${th.fg("dim", goal.id)}`);
				itemIndex += 1;
			}
		} else {
			items.forEach((item, index) => {
				const status = item.status;
				const marker = status === "done" ? "✓" : status === "doing" ? "●" : "○";
				const prefix = index === this.selected ? th.fg("accent", ">") : " ";
				lines.push(`${prefix} ${marker} ${item.title} ${th.fg("dim", item.id)}`);
			});
		}
		const selected = items[this.selected];
		if (this.scope === "project" && selected && "description" in selected && selected.description) {
			lines.push("", th.fg("muted", `Description: ${compactDescription(selected.description)}`));
		}
		const help =
			this.scope === "session"
				? "tab switch  ↑↓ navigate  enter view  space advance  a append  i insert  shift+↑↓ move  e edit  d delete  esc close"
				: "tab switch  ↑↓ navigate  enter view  space advance  a add  shift+↑↓ move  e edit  d delete  esc close";
		lines.push("", th.fg("dim", help));
		return lines.map((line) => truncateToWidth(line, width));
	}

	invalidate(): void {}
}

export type DashboardDetailItem =
	| { scope: "session"; task: SessionTask; goal?: ProjectGoal }
	| { scope: "project"; goal: ProjectGoal };

export interface DashboardDetailOptions {
	item: DashboardDetailItem;
	/**
	 * The roadmap snapshot the selected goal came from, used for derived dependency rows.
	 *
	 * Required rather than defaulted to the one selected goal: an edge resolves
	 * against the goals it is given, so a caller that passed nothing would have
	 * every real dependency rendered as missing rather than as what it is.
	 */
	goals: readonly ProjectGoal[];
	theme: Theme;
	terminalRows: () => number;
	done: () => void;
}

function buildGoalDetailSections(
	goal: ProjectGoal,
	goals: readonly ProjectGoal[],
	addSection: (label: string, value: string, color?: "text" | "accent" | "muted" | "dim") => void,
): void {
	addSection("Title", goal.title, "accent");
	const blocked = isGoalBlocked(goals, goal) ? " · blocked" : "";
	addSection("Status", `${GOAL_STATUS_MARKERS[goal.status]} ${goal.status.toUpperCase()}${blocked}`);
	if (goal.group !== undefined) addSection("Group", goalSection(goal) ?? "Ungrouped", "muted");
	if (goal.branch !== undefined) addSection("Branch", goal.branch, "muted");
	const stale = goalStalenessDays(goal);
	addSection(
		"Updated",
		`${formatGoalTimestamp(goal.updatedAt)}${stale === undefined ? "" : ` · ${stale}d untouched`}`,
		"muted",
	);
	addSection("Created", formatGoalTimestamp(goal.createdAt), "muted");
	if (goal.completedAt !== undefined) addSection("Completed", formatGoalTimestamp(goal.completedAt), "muted");
	addSection("ID", goal.id, "muted");
	const dependencies = resolveDependencies(goals, goal);
	if (dependencies.length > 0) {
		addSection(
			"Depends on",
			dependencies
				.map((entry) => {
					if (!entry.goal) return `? ${entry.id} (missing)`;
					const state = entry.satisfied ? "satisfied" : "waiting";
					return `${GOAL_STATUS_MARKERS[entry.goal.status]} ${entry.id} (${state})`;
				})
				.join("\n"),
			"muted",
		);
	}
	const dependents = dependentGoals(goals, goal);
	if (dependents.length > 0) {
		addSection(
			"Blocks",
			dependents.map((dependent) => `${GOAL_STATUS_MARKERS[dependent.status]} ${dependent.id}`).join("\n"),
			"muted",
		);
	}
	if (goal.links?.length) addSection("Links", goal.links.join("\n"), "muted");
	addSection("Description", goal.description?.trim() || "Not provided");
}

function buildDetailContent(options: DashboardDetailOptions, width: number): string[] {
	const { item, theme } = options;
	const content: string[] = [];
	const addSection = (label: string, value: string, color: "text" | "accent" | "muted" | "dim" = "text") => {
		content.push(theme.fg("dim", label));
		for (const paragraph of (value || "Not provided").split("\n")) {
			for (const line of wrapTextWithAnsi(paragraph || " ", width)) {
				content.push(theme.fg(color, line));
			}
		}
		content.push("");
	};

	if (item.scope === "project") {
		buildGoalDetailSections(item.goal, options.goals, addSection);
	} else {
		const { task, goal } = item;
		addSection("Title", task.title, "accent");
		addSection("Status", task.status.toUpperCase());
		addSection("ID", task.id, "muted");
		if (goal) {
			addSection("Associated Project Goal", goal.title, "accent");
			if (goal.group !== undefined) addSection("Goal Group", goalSection(goal) ?? "Ungrouped", "muted");
			addSection("Goal Description", goal.description?.trim() || "Not provided");
			addSection("Goal ID", goal.id, "muted");
		} else if (task.goalId) {
			addSection("Associated Goal ID", task.goalId, "muted");
		}
	}
	if (content.at(-1) === "") content.pop();
	return content;
}

function renderDetailPanel(
	options: DashboardDetailOptions,
	scrollOffset: number,
	width: number,
): { lines: string[]; scrollOffset: number } {
	const { item, theme, terminalRows } = options;
	const innerWidth = Math.max(1, width - 2);
	const content = buildDetailContent(options, Math.max(1, innerWidth - 2));
	const bodyRows = Math.max(4, Math.floor(terminalRows() * 0.8) - 3);
	const maxOffset = Math.max(0, content.length - bodyRows);
	const boundedOffset = Math.min(scrollOffset, maxOffset);
	const visible = content.slice(boundedOffset, boundedOffset + bodyRows);
	const border = (text: string) => theme.fg("border", text);
	const panelLine = (text: string) =>
		`${border("│")}${truncateToWidth(` ${text}`, innerWidth, "", true)}${border("│")}`;
	const panelTitle = item.scope === "project" ? " Project Goal Details " : " Session Task Details ";
	const title = truncateToWidth(panelTitle, innerWidth, "");
	const titleRule = "─".repeat(Math.max(0, innerWidth - visibleWidth(title)));
	const lines = [`${border("╭")}${theme.fg("accent", theme.bold(title))}${border(`${titleRule}╮`)}`];

	for (const line of visible) lines.push(panelLine(line));
	for (let index = visible.length; index < bodyRows; index += 1) lines.push(panelLine(""));

	const remaining = maxOffset - boundedOffset;
	const help =
		maxOffset > 0 ? `${boundedOffset} above • ${remaining} below • ↑↓ scroll • esc close` : "enter/esc close";
	lines.push(panelLine(theme.fg("dim", help)));
	lines.push(border(`╰${"─".repeat(innerWidth)}╯`));
	return { lines, scrollOffset: boundedOffset };
}

export class DashboardDetail {
	private scrollOffset = 0;

	constructor(private readonly options: DashboardDetailOptions) {}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter) || matchesKey(data, Key.ctrl("c"))) {
			this.options.done();
			return;
		}
		if (matchesKey(data, Key.up) || data === "k") {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
		} else if (matchesKey(data, Key.down) || data === "j") {
			this.scrollOffset += 1;
		} else if (matchesKey(data, Key.pageUp)) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 8);
		} else if (matchesKey(data, Key.pageDown)) {
			this.scrollOffset += 8;
		}
	}

	render(width: number): string[] {
		const result = renderDetailPanel(this.options, this.scrollOffset, width);
		this.scrollOffset = result.scrollOffset;
		return result.lines;
	}

	invalidate(): void {}
}
