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
	if (active) lines.push(`${GOAL_STATUS_MARKERS.active} Active: ${compactDescription(active.title)}`);
	if (goals.length > 0) lines.push(`Goals: ${goalCountLine(goals)}`);
	for (const task of pending.slice(0, 3)) {
		lines.push(`${task.status === "doing" ? "●" : "○"} ${compactDescription(task.title)}`);
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
		lines.push(`Active project goal: ${compactDescription(active.title)}${description}`);
	}
	if (pending.length) {
		lines.push("Incomplete session tasks:");
		for (const task of pending) {
			lines.push(`- [${task.status === "doing" ? "doing" : "todo"}] ${compactDescription(task.title)}`);
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

export type DashboardFilter = "open" | "done" | "archived" | "all";

export interface DashboardState {
	scope: "session" | "project";
	selectedId?: string;
	selectedGroup?: string;
	selectedIndex?: number;
	sessionFilter?: Exclude<DashboardFilter, "archived">;
	projectFilter?: DashboardFilter;
	expandedGroups?: string[];
	/**
	 * Index of the first list row the viewport showed.
	 *
	 * Carried with the selection because the dashboard is rebuilt after every
	 * action: without it the restored list re-derives its offset from the cursor
	 * alone and jumps under a cursor that never moved.
	 */
	listScroll?: number;
}

export interface DashboardResult {
	action: DashboardAction;
	state: DashboardState;
}

type DashboardProjectRow =
	| {
			kind: "group";
			key: string;
			label: string;
			goals: readonly ProjectGoal[];
			collapsed: boolean;
	  }
	| { kind: "goal"; key: string; goal: ProjectGoal; indented: boolean };

type DashboardRow = { kind: "task"; key: string; task: SessionTask } | DashboardProjectRow;

const SESSION_FILTERS: readonly Exclude<DashboardFilter, "archived">[] = ["open", "done", "all"];
const PROJECT_FILTERS: readonly DashboardFilter[] = ["open", "done", "archived", "all"];
/** Rows the wrapped key map may occupy before the rest of it is left off screen. */
const HELP_ROW_LIMIT = 3;

/**
 * The key map packed into rows no wider than the pane, one hint at a time.
 *
 * Wrapped on the gaps between hints rather than on any space, because a hint
 * split across two rows reads as two different keys.
 */
function wrapKeyHints(help: string, width: number): string[] {
	const lines: string[] = [];
	let current = "";
	for (const hint of help.split("  ").filter(Boolean)) {
		const candidate = current ? `${current}  ${hint}` : hint;
		if (current && visibleWidth(candidate) > width) {
			lines.push(current);
			current = hint;
		} else current = candidate;
	}
	if (current) lines.push(current);
	return lines;
}

const DASHBOARD_FILTER_LABELS: Record<DashboardFilter, string> = {
	open: "Open",
	done: "Done",
	archived: "Archived",
	all: "All",
};

function taskMatchesFilter(task: SessionTask, filter: Exclude<DashboardFilter, "archived">): boolean {
	if (filter === "all") return true;
	return filter === "done" ? task.status === "done" : task.status !== "done";
}

function goalMatchesFilter(goal: ProjectGoal, filter: DashboardFilter): boolean {
	if (filter === "all") return true;
	if (filter === "open") return goal.status === "open" || goal.status === "active";
	return goal.status === filter;
}

function groupedProjectRows(
	goals: readonly ProjectGoal[],
	expandedGroups: ReadonlySet<string>,
): DashboardProjectRow[] {
	const sections = goalSections(goals);
	if (isUngroupedList(sections))
		return sections[0].goals.map((goal) => ({
			kind: "goal",
			key: `goal:${goal.id}`,
			goal,
			indented: false,
		}));

	const rows: DashboardProjectRow[] = [];
	for (const section of sections) {
		const collapsed = !expandedGroups.has(section.key);
		rows.push({
			kind: "group",
			key: `group:${section.key}`,
			label: section.label,
			goals: section.goals,
			collapsed,
		});
		if (!collapsed) {
			rows.push(
				...section.goals.map((goal) => ({
					kind: "goal" as const,
					key: `goal:${goal.id}`,
					goal,
					indented: true,
				})),
			);
		}
	}
	return rows;
}

/** An item a dashboard action just created, which the next dashboard must show. */
export interface DashboardReveal {
	scope: "session" | "project";
	id: string;
}

/**
 * The dashboard state that puts a freshly created item on screen.
 *
 * An add is the one action whose result the acting view can hide: the created
 * item carries its own status and group rather than the ones the open filter and
 * collapsed sections were chosen for, so leaving the previous state untouched
 * can return the identical screen with no sign anything was written. Relaxing
 * the filter to All rather than to the item's own status keeps everything that
 * was listed before the add listed after it.
 */
export function revealDashboardState(
	state: DashboardState | undefined,
	reveal: DashboardReveal,
	tasks: readonly SessionTask[],
	goals: readonly ProjectGoal[],
): DashboardState | undefined {
	const base: DashboardState = { ...state, scope: reveal.scope };
	if (reveal.scope === "session") {
		const task = tasks.find((candidate) => candidate.id === reveal.id);
		if (!task) return state;
		const filter = base.sessionFilter ?? "open";
		return {
			...base,
			selectedId: task.id,
			sessionFilter: taskMatchesFilter(task, filter) ? filter : "all",
		};
	}
	const goal = goals.find((candidate) => candidate.id === reveal.id);
	if (!goal) return state;
	const filter = base.projectFilter ?? "open";
	const projectFilter = goalMatchesFilter(goal, filter) ? filter : "all";
	const sections = goalSections(goals.filter((candidate) => goalMatchesFilter(candidate, projectFilter)));
	const section = isUngroupedList(sections) ? undefined : sectionHolding(sections, goal.id);
	const expandedGroups = base.expandedGroups ?? [];
	return {
		...base,
		selectedId: goal.id,
		projectFilter,
		...(section ? { selectedGroup: section.key } : {}),
		expandedGroups:
			section && !expandedGroups.includes(section.key) ? [...expandedGroups, section.key] : expandedGroups,
	};
}

export class Dashboard {
	private scope: "session" | "project";
	private selected = 0;
	private listScroll = 0;
	/** Rows the last render fitted in the list viewport, 0 until it has drawn once. */
	private listHeight = 0;
	private sessionFilter: Exclude<DashboardFilter, "archived">;
	private projectFilter: DashboardFilter;
	private readonly expandedGroups: Set<string>;

	constructor(
		private readonly tasks: SessionTask[],
		private readonly goals: ProjectGoal[],
		private readonly theme: Theme,
		private readonly done: (result: DashboardResult) => void,
		initialState?: DashboardState,
		private readonly now: () => number = Date.now,
		private readonly terminalRows: () => number = () => Number.POSITIVE_INFINITY,
	) {
		this.scope = initialState?.scope ?? "session";
		this.sessionFilter = initialState?.sessionFilter ?? "open";
		this.projectFilter = initialState?.projectFilter ?? "open";
		this.expandedGroups = new Set(initialState?.expandedGroups ?? []);
		this.listScroll = Math.max(0, Math.floor(initialState?.listScroll ?? 0));

		// A state from the pre-collapse dashboard names only a goal. Keep that goal
		// reachable when possible rather than replacing its restored selection with
		// the section header that now starts closed.
		if (initialState?.selectedId && initialState.expandedGroups === undefined) {
			const sections = goalSections(this.visibleGoals());
			if (!isUngroupedList(sections)) {
				for (const section of sections) {
					if (section.goals.some((goal) => goal.id === initialState.selectedId)) {
						this.expandedGroups.add(section.key);
						break;
					}
				}
			}
		}

		const rows = this.rows();
		const selectedItemIndex = rows.findIndex(
			(row) => initialState?.selectedId !== undefined && this.rowItem(row)?.id === initialState.selectedId,
		);
		const selectedGroupIndex = rows.findIndex(
			(row) => row.kind === "group" && row.key === `group:${initialState?.selectedGroup}`,
		);
		const nearestIndex = Math.min(
			Math.max(0, initialState?.selectedIndex ?? 0),
			Math.max(0, rows.length - 1),
		);
		this.selected =
			selectedItemIndex >= 0
				? selectedItemIndex
				: selectedGroupIndex >= 0
					? selectedGroupIndex
					: nearestIndex;
	}

	private visibleTasks(): SessionTask[] {
		return this.tasks.filter((task) => taskMatchesFilter(task, this.sessionFilter));
	}

	/** The goals the Project Goal pane lists, before they are grouped into rows. */
	private visibleGoals(): ProjectGoal[] {
		return this.goals.filter((goal) => goalMatchesFilter(goal, this.projectFilter));
	}

	/**
	 * The roadmap's shape plus how much of it the current filter admits.
	 *
	 * Counted against the filter rather than against the rows on screen, because a
	 * collapsed section holds goals the filter keeps: "match" is the claim this
	 * number can make, and the per-section counts say where those goals are.
	 */
	private goalCountSummary(): string {
		const matching = this.visibleGoals().length;
		const counts = goalCountLine(this.goals);
		return matching === this.goals.length ? counts : `${counts} · ${matching} of ${this.goals.length} match`;
	}

	private rows(): DashboardRow[] {
		if (this.scope === "session") {
			return this.visibleTasks().map((task) => ({ kind: "task", key: `task:${task.id}`, task }));
		}
		return groupedProjectRows(this.visibleGoals(), this.expandedGroups);
	}

	private items(): Array<SessionTask | ProjectGoal> {
		return this.scope === "session" ? this.visibleTasks() : this.visibleGoals();
	}

	private rowItem(row: DashboardRow | undefined): SessionTask | ProjectGoal | undefined {
		if (row?.kind === "task") return row.task;
		if (row?.kind === "goal") return row.goal;
		return undefined;
	}

	private state(): DashboardState {
		const row = this.rows()[this.selected];
		const selectedId = this.rowItem(row)?.id;
		let selectedGroup = row?.kind === "group" ? row.key.slice("group:".length) : undefined;
		if (row?.kind === "goal") {
			const sections = goalSections(this.visibleGoals());
			if (!isUngroupedList(sections)) selectedGroup = sectionHolding(sections, row.goal.id)?.key;
		}
		return {
			scope: this.scope,
			...(selectedId !== undefined ? { selectedId } : {}),
			...(selectedGroup !== undefined ? { selectedGroup } : {}),
			selectedIndex: this.selected,
			sessionFilter: this.sessionFilter,
			projectFilter: this.projectFilter,
			expandedGroups: [...this.expandedGroups],
			listScroll: this.listScroll,
		};
	}

	private finish(action: DashboardAction): void {
		this.done({ action, state: this.state() });
	}

	/** Reorder the selected item within the filtered list it is shown in. */
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
		const index = items.findIndex((candidate) => candidate.id === item.id);
		const anchor = items[index + delta];
		if (!anchor) return undefined;
		return delta < 0
			? { kind: "move", scope: "session", id: item.id, beforeId: anchor.id }
			: { kind: "move", scope: "session", id: item.id, afterId: anchor.id };
	}

	private handleMove(data: string): boolean {
		const delta = matchesKey(data, Key.shift("up"))
			? -1
			: matchesKey(data, Key.shift("down"))
				? 1
				: undefined;
		if (delta === undefined) return false;
		const item = this.rowItem(this.rows()[this.selected]);
		const action = item && this.moveAction(item, this.items(), delta);
		if (action) this.finish(action);
		return true;
	}

	private cycleFilter(): void {
		const rows = this.rows();
		const selectedKey = rows[this.selected]?.key;
		if (this.scope === "session") {
			const index = SESSION_FILTERS.indexOf(this.sessionFilter);
			this.sessionFilter = SESSION_FILTERS[(index + 1) % SESSION_FILTERS.length];
		} else {
			const index = PROJECT_FILTERS.indexOf(this.projectFilter);
			this.projectFilter = PROJECT_FILTERS[(index + 1) % PROJECT_FILTERS.length];
		}
		const nextRows = this.rows();
		const nextIndex = nextRows.findIndex((row) => row.key === selectedKey);
		if (nextIndex >= 0) {
			// The row the cursor is on survived the new filter, so it keeps the screen
			// row it was read on: the offset held is the cursor's place inside the
			// viewport, not the raw list offset, which a filter that drops rows above
			// the cursor would move. Render clamps whatever the shorter list cannot hold.
			this.listScroll = Math.max(0, nextIndex - (this.selected - this.listScroll));
			this.selected = nextIndex;
			return;
		}
		this.selected = 0;
		this.listScroll = 0;
	}

	private toggleSelectedGroup(force?: "expand" | "collapse"): boolean {
		const row = this.rows()[this.selected];
		if (row?.kind !== "group") return false;
		const key = row.key.slice("group:".length);
		const collapse = force === "collapse" || (force === undefined && !row.collapsed);
		if (collapse === row.collapsed) return false;
		if (collapse) this.expandedGroups.delete(key);
		else {
			this.expandedGroups.add(key);
			// Lead the viewport with the header so expanding the last visible row
			// reveals its children instead of leaving every new row below the fold.
			// A section whose children already fit keeps the view it was opened from.
			if (this.selected + row.goals.length >= this.listScroll + this.listHeight) {
				this.listScroll = this.selected;
			}
		}
		return true;
	}

	private enterSelectedGroup(): boolean {
		const row = this.rows()[this.selected];
		if (row?.kind !== "group") return false;
		if (row.collapsed) return this.toggleSelectedGroup("expand");
		const child = this.rows()[this.selected + 1];
		if (child?.kind !== "goal") return false;
		this.selected += 1;
		return true;
	}

	private collapseGoalGroup(): boolean {
		const row = this.rows()[this.selected];
		if (row?.kind !== "goal" || !row.indented) return false;
		const rows = this.rows();
		for (let index = this.selected - 1; index >= 0; index -= 1) {
			const candidate = rows[index];
			if (candidate?.kind !== "group") continue;
			this.selected = index;
			return this.toggleSelectedGroup("collapse");
		}
		return false;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.finish({ kind: "close" });
			return;
		}
		if (matchesKey(data, Key.tab)) {
			this.scope = this.scope === "session" ? "project" : "session";
			this.selected = 0;
			this.listScroll = 0;
			return;
		}
		if (data === "f") {
			this.cycleFilter();
			return;
		}
		if (this.scope === "project" && matchesKey(data, Key.right) && this.enterSelectedGroup()) return;
		if (
			this.scope === "project" &&
			matchesKey(data, Key.left) &&
			(this.toggleSelectedGroup("collapse") || this.collapseGoalGroup())
		)
			return;
		if (this.handleMove(data)) return;

		const rows = this.rows();
		if (matchesKey(data, Key.up) || data === "k") this.selected = Math.max(0, this.selected - 1);
		if (matchesKey(data, Key.down) || data === "j")
			this.selected = Math.min(Math.max(0, rows.length - 1), this.selected + 1);
		// A page is the rows the terminal is showing, less one kept as context, and at
		// least one row: a viewport that holds a single row still pages by that row.
		// Only before the first render, where there is nothing measured, is it a guess.
		const page = this.listHeight > 0 ? Math.max(1, this.listHeight - 1) : 8;
		if (matchesKey(data, Key.pageUp)) this.selected = Math.max(0, this.selected - page);
		if (matchesKey(data, Key.pageDown))
			this.selected = Math.min(Math.max(0, rows.length - 1), this.selected + page);
		if (data === "a") {
			this.finish({ kind: "add", scope: this.scope });
			return;
		}

		const row = this.rows()[this.selected];
		if (row?.kind === "group") {
			if (matchesKey(data, Key.space)) this.toggleSelectedGroup();
			else if (matchesKey(data, Key.enter)) this.enterSelectedGroup();
			return;
		}
		const item = this.rowItem(row);
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

	private renderRow(row: DashboardRow, index: number): string {
		const th = this.theme;
		const prefix = index === this.selected ? th.fg("accent", ">") : " ";
		if (row.kind === "group") {
			const disclosure = row.collapsed ? "▸" : "▾";
			return `${prefix} ${th.bold(`${disclosure} ${compactDescription(row.label)}`)} ${th.fg("dim", `(${row.goals.length})`)}`;
		}
		if (row.kind === "task") {
			const marker = row.task.status === "done" ? "✓" : row.task.status === "doing" ? "●" : "○";
			return `${prefix} ${marker} ${compactDescription(row.task.title)} ${th.fg("dim", row.task.id)}`;
		}

		const goal = row.goal;
		const inset = row.indented ? "  " : "";
		const marker =
			goal.status === "active"
				? th.fg("accent", GOAL_STATUS_MARKERS.active)
				: GOAL_STATUS_MARKERS[goal.status];
		const settled = goal.status === "done" || goal.status === "archived";
		const title = compactDescription(goal.title);
		const styled =
			goal.status === "active" ? th.fg("accent", th.bold(title)) : settled ? th.fg("dim", title) : title;
		const stale = goalStalenessDays(goal, this.now());
		const badge = stale === undefined ? "" : ` ${th.fg("muted", `${stale}d`)}`;
		const blocked = isGoalBlocked(this.goals, goal) ? ` ${th.fg("muted", "blocked")}` : "";
		return `${prefix} ${inset}${marker} ${styled}${badge}${blocked} ${th.fg("dim", goal.id)}`;
	}

	render(width: number): string[] {
		const th = this.theme;
		const rows = this.rows();
		const selectedItem = this.rowItem(rows[this.selected]);
		const filter = this.scope === "session" ? this.sessionFilter : this.projectFilter;
		const title = th.fg("accent", th.bold("Worklist"));
		const tabs = `${this.scope === "session" ? th.fg("accent", "[Session Tasks]") : "Session Tasks"}  ${this.scope === "project" ? th.fg("accent", "[Project Goals]") : "Project Goals"}`;
		const filterLine = th.fg("muted", `Filter: ${DASHBOARD_FILTER_LABELS[filter]} (f to change)`);
		const summary =
			this.scope === "project" && this.goals.length > 0
				? th.fg("muted", `Goals: ${this.goalCountSummary()}`)
				: undefined;
		const selectedDescription =
			selectedItem && "description" in selectedItem ? selectedItem.description : undefined;
		// Reserved for the listed goals rather than filled per row: a row that appears
		// only for a described goal would resize the list as the cursor walks past one,
		// which moves the list under a cursor that did not move. What the filter lists
		// does not change under the cursor, so a roadmap that describes nothing spends
		// nothing on the row.
		const description =
			this.scope === "project" && this.visibleGoals().some((goal) => goal.description)
				? selectedDescription
					? th.fg("muted", `Description: ${compactDescription(selectedDescription)}`)
					: ""
				: undefined;
		const help =
			this.scope === "session"
				? "tab switch  f filter  ↑↓/jk navigate  pgup/pgdn scroll  enter view  space advance  a append  i insert  shift+↑↓ move  e edit  d delete  esc close"
				: "tab switch  f filter  ↑↓/jk navigate  pgup/pgdn scroll  ←→ collapse/open  space advance/toggle section  enter open/view  a add  shift+↑↓ move  e edit  d delete  esc close";

		const terminalHeight = this.terminalRows();
		const targetHeight = Number.isFinite(terminalHeight)
			? Math.max(1, Math.floor(terminalHeight * 0.8))
			: Number.POSITIVE_INFINITY;
		let showTitle = true;
		let showTabs = true;
		let showFilter = true;
		let showSummary = summary !== undefined;
		let showDescription = description !== undefined;
		let showHelp = true;
		const fixedRows = () =>
			Number(showTitle) +
			Number(showTabs) +
			Number(showFilter) +
			Number(showSummary) +
			Number(showDescription) +
			Number(showHelp);
		if (Number.isFinite(targetHeight)) {
			// A list row is the one irreducible part of the dashboard. On a very short
			// terminal, discard optional context and then chrome in priority order so
			// render() never hands Pi more rows than the terminal can display.
			for (const hide of [
				() => {
					showDescription = false;
				},
				() => {
					showSummary = false;
				},
				() => {
					showTitle = false;
				},
				() => {
					showHelp = false;
				},
				() => {
					showTabs = false;
				},
				() => {
					showFilter = false;
				},
			]) {
				if (fixedRows() + 1 <= targetHeight) break;
				hide();
			}
		}

		// The compact overflow row is independent of the full key map. If the key
		// map no longer fits, spend lower-priority chrome on this orientation cue so
		// a clipped list still says that more rows exist and in which direction.
		let showCompactOverflow = !showHelp && rows.length > 1 && targetHeight >= 2;
		if (showCompactOverflow && Number.isFinite(targetHeight)) {
			if (fixedRows() + 2 > targetHeight && showTabs) showTabs = false;
			if (fixedRows() + 2 > targetHeight && showFilter) showFilter = false;
			showCompactOverflow = fixedRows() + 2 <= targetHeight;
		}

		// The key map is the one row that has to be read rather than glanced at, so it
		// is laid out as text: at ordinary widths it needs more than one row, and the
		// hints this pane exists to teach are the ones a single truncated row loses.
		const helpLines = wrapKeyHints(help, Math.max(1, width));
		let helpRows = showHelp ? 1 : 0;
		let overflowRow = false;
		let topSpacer = false;
		let bottomSpacer = false;
		if (!Number.isFinite(targetHeight)) {
			helpRows = showHelp ? Math.min(HELP_ROW_LIMIT, helpLines.length) : 0;
			topSpacer = true;
			bottomSpacer = true;
		} else {
			// Rows the list does not need are spent on the key map and on a row of its
			// own for the overflow count, which would otherwise push the map's first
			// row off screen; whatever is left over keeps the view breathable.
			let spare =
				targetHeight - fixedRows() - Number(showCompactOverflow) - Math.max(1, Math.min(3, rows.length || 1));
			if (showHelp && rows.length > 1 && spare > 0) {
				overflowRow = true;
				spare -= 1;
			}
			while (showHelp && spare > 0 && helpRows < Math.min(HELP_ROW_LIMIT, helpLines.length)) {
				helpRows += 1;
				spare -= 1;
			}
			if (spare > 0) {
				topSpacer = true;
				spare -= 1;
			}
			if (spare > 0) bottomSpacer = true;
		}

		const top = [
			...(showTitle ? [title] : []),
			...(showTabs ? [tabs] : []),
			...(showFilter ? [filterLine] : []),
			...(showSummary && summary !== undefined ? [summary] : []),
			...(topSpacer ? [""] : []),
		];
		const bottom: string[] = [];
		if (bottomSpacer) bottom.push("");
		if (showDescription && description !== undefined) bottom.push(description);
		const overflowIndex = overflowRow ? bottom.push("") - 1 : -1;
		const helpIndex = showHelp ? bottom.length : -1;
		if (showHelp) bottom.push(...helpLines.slice(0, helpRows).map((line) => th.fg("dim", line)));
		if (showCompactOverflow) bottom.push("");

		const listHeight = Number.isFinite(targetHeight)
			? Math.max(1, targetHeight - top.length - bottom.length)
			: Math.max(1, rows.length);
		this.listHeight = listHeight;
		this.listScroll = Math.min(this.listScroll, Math.max(0, rows.length - listHeight));
		if (this.selected < this.listScroll) this.listScroll = this.selected;
		if (this.selected >= this.listScroll + listHeight) this.listScroll = this.selected - listHeight + 1;

		const listLines = rows.length
			? rows
					.slice(this.listScroll, this.listScroll + listHeight)
					.map((row, offset) => this.renderRow(row, this.listScroll + offset))
			: [th.fg("dim", "  No items in this view. Press f to change the filter or a to add one.")];
		const hiddenAbove = this.listScroll;
		const hiddenBelow = Math.max(0, rows.length - (this.listScroll + listLines.length));
		if (hiddenAbove > 0 || hiddenBelow > 0) {
			const overflow = `${hiddenAbove} above · ${hiddenBelow} below`;
			if (overflowIndex >= 0) bottom[overflowIndex] = th.fg("dim", overflow);
			else if (helpIndex >= 0) bottom[helpIndex] = th.fg("dim", `${overflow}  ${helpLines[0]}`);
			else if (showCompactOverflow) bottom[bottom.length - 1] = th.fg("dim", overflow);
		}

		return [...top, ...listLines, ...bottom].map((line) => truncateToWidth(line, width));
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
