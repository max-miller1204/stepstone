import type { WorklistOperation } from "../application-service.ts";
import { dependencyWaves, dependentGoals, isGoalBlocked, resolveDependencies } from "../dependencies.ts";
import { GOAL_STATUS_RANK, goalStatusCounts } from "../format.ts";
import { findGoalByStoredId, matchesGoalQuery } from "../goal-selection.ts";
import type { ProjectGoal, ProjectGoalStatus } from "../types.ts";
import type { KeyEvent } from "./keys.ts";
import { isInterrupt } from "./keys.ts";
import type { Palette, Style } from "./style.ts";
import type { Frame } from "./terminal.ts";
import { fitToWidth, singleLine, truncateToWidth, visibleWidth, wrapText, wrapToLines } from "./text.ts";

/**
 * The Project Goal board: all state and rendering, no input or output.
 *
 * Every side effect leaves as a `BoardIntent` for the runtime to perform, and
 * every frame is a pure function of state plus the terminal size. That keeps the
 * whole interaction model testable by feeding keys in and reading frames back,
 * without a pseudo-terminal.
 *
 * Mutating intents carry a ready-made `WorklistOperation` so the runtime can
 * hand it straight to `WorklistApplicationService`, which is the only path
 * allowed to write the goal file.
 */

export const GOAL_FILTERS = ["open", "done", "archived", "all"] as const;
export type GoalFilter = (typeof GOAL_FILTERS)[number];

/** Rows the panes are never squeezed below, however much else wants the space. */
const BODY_MIN_ROWS = 3;

/**
 * Rows the standing notice may take.
 *
 * Four holds the two-worklist warning whole at eighty columns for an ordinary
 * repository path. A deep one - a cloud-synced folder, a checkout nested a few
 * levels down - still runs past four rows and is cut at the last of them. The
 * ceiling stays here anyway, because every row above it is a goal row taken
 * from the list, and this is a rare condition that one merge clears for good.
 */
const NOTICE_MAX_ROWS = 4;

const FILTER_LABELS: Readonly<Record<GoalFilter, string>> = {
	open: "Open",
	done: "Done",
	archived: "Archived",
	all: "All",
};

/**
 * How the list is arranged, cycled with `o`.
 *
 * `file` is first and is the default because it is the roadmap's canonical
 * order: it is what the file stores, what `move` edits, and what every other
 * reader of the worklist sees. The rest are views over that same order, which
 * stays their tiebreak, so switching back never loses the arrangement.
 *
 * `dependency` is the schedule the graph implies rather than a fourth way to
 * arrange the file: it ranks each goal by the wave `project waves` puts it in, so
 * the board and the CLI read the edges the same way, and the file the user
 * arranged is left exactly as it is. Sections still partition the list, so the
 * waves order the goals inside each section rather than flattening the roadmap
 * into one frontier - the same relationship status and recent order have to
 * sections, and `project waves` stays the flat read of the whole graph.
 */
export const GOAL_SORTS = ["file", "status", "recent", "dependency"] as const;
export type GoalSort = (typeof GOAL_SORTS)[number];

const SORT_LABELS: Readonly<Record<GoalSort, string>> = {
	file: "⇅ File",
	status: "⇅ Status",
	recent: "⇅ Recent",
	dependency: "⇅ Dependency",
};

/**
 * Where the goals no wave holds sort in dependency order.
 *
 * A done or archived goal is already behind everything it released, so it sits
 * ahead of the first wave rather than being given a layer of its own. A goal on
 * a hand-edited cycle, or waiting on an edge that names no goal, is in no wave
 * at all and sorts last, so the list reads as the schedule and then what is
 * stuck rather than quietly dropping the goals nobody can start.
 */
const SETTLED_WAVE = 0;
const UNREACHABLE_WAVE = Number.MAX_SAFE_INTEGER;

/**
 * One glyph per status.
 *
 * The active goal gets a diamond rather than a fourth circle so the pinned row
 * still reads as the odd one out on a terminal with no color at all.
 */
const STATUS_MARKERS: Readonly<Record<ProjectGoalStatus, string>> = {
	active: "◆",
	open: "○",
	done: "✓",
	archived: "◌",
};

/** A goal still in play and untouched for this long is worth pointing at. */
const STALE_AFTER_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Narrower than this and a row drops its staleness badge rather than its title. */
const MIN_BADGED_TITLE_WIDTH = 12;

/** Columns a goal is inset by under its section header, so the list reads as a tree. */
const SECTION_INDENT = 2;

/** Below this width the two panes stack instead of sitting side by side. */
const MIN_SPLIT_WIDTH = 76;
const MIN_LIST_WIDTH = 24;
const MAX_LIST_WIDTH = 54;
const LIST_WIDTH_RATIO = 0.42;
const DETAIL_LABEL_WIDTH = 10;
const PAGE_STEP = 8;
const MESSAGE_TITLE_LIMIT = 48;

/** Divider between compact facts in the header, detail pane, and key bar. */
const SEPARATOR = " · ";

export type MessageTone = "info" | "success" | "error";

export interface BoardMessage {
	text: string;
	tone: MessageTone;
}

export type BoardIntent =
	| { kind: "quit" }
	| { kind: "reload" }
	| {
			kind: "reorder";
			goalId: string;
			delta: -1 | 1;
			/** The goals of the moved goal's own section, in the order the list showed them. */
			sectionGoalIds: string[];
			success: string;
			/** What to say if the anchor is gone by the time the move is written. */
			blocked: string;
	  }
	| { kind: "operation"; operation: WorklistOperation; success: string }
	| { kind: "edit-description"; goal: ProjectGoal };

interface PromptState {
	label: string;
	/** One entry per grapheme, so cursor movement is never split mid-character. */
	cells: string[];
	cursor: number;
	submit: (value: string) => BoardIntent | undefined;
}

interface SearchState {
	cells: string[];
	cursor: number;
	/** Restored when the search is abandoned with Escape. */
	previousQuery: string;
}

interface ConfirmState {
	question: string;
	intent: BoardIntent;
	openedByInputBatch?: number;
}

type BoardMode =
	| { kind: "browse" }
	| { kind: "prompt"; prompt: PromptState }
	| { kind: "search"; search: SearchState }
	| { kind: "confirm"; confirm: ConfirmState }
	| { kind: "help" };

type ListRow =
	| { kind: "group"; key: string; label: string; goals: readonly ProjectGoal[]; collapsed: boolean }
	/** `indented` is false only where the whole list is one plain run of goals. */
	| { kind: "goal"; key: string; goal: ProjectGoal; indented: boolean };

const UNGROUPED_KEY = "\u0000ungrouped";
const UNGROUPED_LABEL = "Ungrouped";

/** The list row key for a section, whose name shares a namespace with goal ids. */
function groupRowKey(sectionKey: string): string {
	return `group:${sectionKey}`;
}

function goalRowKey(goal: ProjectGoal): string {
	return `goal:${goal.id}`;
}

/**
 * The section a goal reads as being filed under.
 *
 * A goal file is editable by hand and the schema only requires a string here, so
 * a blank or padded group is normalized the way a written one would have been
 * rather than rendering a header with no name on it.
 */
function goalSection(goal: ProjectGoal): string | undefined {
	return goal.group?.trim() || undefined;
}

/** Where a selection key sits among rows, or -1 when nothing is selected. */
function rowIndexOf(rows: readonly ListRow[], key: string | undefined): number {
	if (key === undefined) return -1;
	return rows.findIndex((row) => row.key === key);
}

/** The first row that holds a goal, or -1 where every row is a section header. */
function firstGoalIndex(rows: readonly ListRow[]): number {
	return rows.findIndex((row) => row.kind === "goal");
}

/** The last row that holds a goal, or -1 where every row is a section header. */
function lastGoalIndex(rows: readonly ListRow[]): number {
	for (let index = rows.length - 1; index >= 0; index -= 1) {
		if (rows[index].kind === "goal") return index;
	}
	return -1;
}

export interface GoalBoardOptions {
	palette: Palette;
	/** Shown in the header so a board opened with `--cwd` names its repository. */
	repositoryLabel: string;
	/**
	 * A standing condition about the file behind the board, shown whenever the
	 * status line is otherwise idle.
	 *
	 * The board owns the whole screen, so a warning written before it opened is
	 * on a buffer the user cannot see; anything they have to know while the board
	 * is up has to be part of a frame. It is composed by the caller so no two
	 * interfaces word the same condition differently.
	 */
	notice?: string;
	goals?: ProjectGoal[];
	/**
	 * Current time in epoch milliseconds, read only to age goals.
	 *
	 * It is injectable so a frame stays a pure function of state plus size in
	 * tests, which is the one thing keeping the board testable without a
	 * pseudo-terminal.
	 */
	now?: () => number;
}

interface HelpEntry {
	keys: string;
	description: string;
}

const HELP_ENTRIES: readonly HelpEntry[] = [
	{ keys: "↑ ↓ / j k", description: "Move the selection, or scroll the detail pane" },
	{ keys: "← → / tab", description: "Move focus between the list and the detail pane" },
	{ keys: "enter", description: "Focus the detail pane, or open the selected section" },
	{ keys: "← / → / space", description: "Collapse or expand the selected section header" },
	{ keys: "g / G", description: "Jump to the first or last goal" },
	{ keys: "pgup / pgdn", description: "Page through the list or the detail pane" },
	{ keys: "space", description: "Advance: open activates, active completes, done reopens" },
	{ keys: "s", description: "Make the selected goal the single active goal" },
	{ keys: "a", description: "Add a goal" },
	{ keys: "e", description: "Rename the selected goal" },
	{ keys: "E", description: "Edit the description in $EDITOR" },
	{ keys: "c / r / x", description: "Complete, reopen, or archive (asks first)" },
	{ keys: "d", description: "Delete permanently (asks first)" },
	{ keys: "f", description: "Cycle the status filter" },
	{ keys: "o", description: "Cycle the order: file, status, recent, dependency" },
	{ keys: "K / J", description: "Move the selected goal within its section (file order only)" },
	{ keys: "/", description: "Search titles and descriptions" },
	{ keys: "R", description: "Reload from disk" },
	{ keys: "?", description: "Show this help" },
	{ keys: "q / esc", description: "Quit" },
];

/**
 * Why a move stopped, named once so the board and the runtime's fallback for a
 * reorder that raced a reload cannot answer the same condition two ways.
 */
export function sectionEdgeMessage(goal: ProjectGoal, delta: -1 | 1): string {
	const edge = delta < 0 ? "Already first" : "Already last";
	const section = goalSection(goal);
	return section === undefined ? `${edge}.` : `${edge} in ${section}.`;
}

/** The browse keys that act on one goal, and so have nothing to act on from a header. */
const GOAL_KEYS: ReadonlySet<string> = new Set(["s", "e", "E", "c", "r", "x", "d"]);

function matchesFilter(goal: ProjectGoal, filter: GoalFilter): boolean {
	if (filter === "all") return true;
	if (filter === "open") return goal.status === "open" || goal.status === "active";
	if (filter === "done") return goal.status === "done";
	return goal.status === "archived";
}

/** The one goal in flight, which every derived order lifts to the top. */
function isActive(goal: ProjectGoal): boolean {
	return goal.status === "active";
}

/**
 * Whole days since a goal was last touched, once that crosses the threshold.
 *
 * Only work still in play can go stale: a done or archived goal is finished
 * rather than neglected, so its age says nothing the board should nag about.
 */
function stalenessDays(goal: ProjectGoal, now: number): number | undefined {
	if (goal.status !== "open" && goal.status !== "active") return undefined;
	const updated = Date.parse(goal.updatedAt);
	if (!Number.isFinite(updated)) return undefined;
	const days = Math.floor((now - updated) / DAY_MS);
	return days >= STALE_AFTER_DAYS ? days : undefined;
}

/** Render an ISO timestamp as local `YYYY-MM-DD HH:MM`, or pass it through unchanged. */
function formatTimestamp(value: string): string {
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) return value;
	const pad = (part: number) => String(part).padStart(2, "0");
	const date = `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`;
	return `${date} ${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
}

function quoteTitle(title: string): string {
	return `"${truncateToWidth(singleLine(title), MESSAGE_TITLE_LIMIT)}"`;
}

/**
 * The reorder step a key asks for, or undefined when it asks for something else.
 *
 * Shift+arrows are the idiom the Pi dashboard already uses, and `K` and `J` are
 * the fallback for the terminals that never report a modifier on an arrow key.
 */
function readReorderStep(key: KeyEvent): -1 | 1 | undefined {
	if (key.char === "K" || (key.shift && key.name === "up")) return -1;
	if (key.char === "J" || (key.shift && key.name === "down")) return 1;
	return undefined;
}

/** Text that carries no styling of its own, so a caller can stay uniform. */
const plain: Style = (text) => text;

function toCellArray(value: string): string[] {
	return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)].map(
		(entry) => entry.segment,
	);
}

export class GoalBoard {
	private readonly palette: Palette;
	private readonly repositoryLabel: string;
	private notice: string | undefined;
	private readonly now: () => number;
	private goals: ProjectGoal[];
	private filter: GoalFilter = "open";
	private sort: GoalSort = "file";
	private query = "";
	private selectedKey: string | undefined;
	private focus: "list" | "detail" = "list";
	private listScroll = 0;
	private detailScroll = 0;
	private helpScroll = 0;
	private mode: BoardMode = { kind: "browse" };
	private message: BoardMessage | undefined;
	/** Where the selection sat before a reload, so a deletion lands on a neighbor. */
	private lastSelectedIndex = 0;
	/**
	 * Group names expanded during this board run. Never persisted.
	 *
	 * Sections start closed, so the board opens on the shape of the roadmap - the
	 * sections and how much each holds - rather than on every goal in it, and a
	 * roadmap grows sections without ever growing the screenful the board opens
	 * on. Held as the expanded set rather than the collapsed one so a section name
	 * the board was never asked to open - one arriving from a reload, or a group
	 * written in another terminal - starts closed like every other section instead
	 * of opening on arrival. A name the user did open is remembered by name, so a
	 * section that empties out and later comes back comes back open.
	 */
	private readonly expandedGroups = new Set<string>();

	/** Wave numbers for `dependency` order, rebuilt whenever the goals are replaced. */
	private waveRanks: { goals: readonly ProjectGoal[]; ranks: Map<string, number> } | undefined;

	constructor(options: GoalBoardOptions) {
		this.palette = options.palette;
		this.repositoryLabel = options.repositoryLabel;
		this.notice = options.notice;
		this.now = options.now ?? (() => Date.now());
		this.goals = options.goals ? [...options.goals] : [];
		this.selectFirstGoal();
	}

	/**
	 * Replace the standing notice, or clear it.
	 *
	 * The condition it describes is about the file behind the board, and that
	 * file can move or be merged while the board is open, so the notice is state
	 * the runtime re-derives rather than a fact fixed when the board opened.
	 */
	setNotice(notice: string | undefined): void {
		this.notice = notice;
	}

	/** Replace the goal set, keeping the selection on the same goal when it survives. */
	setGoals(goals: ProjectGoal[]): void {
		const previousIndex = this.selectedIndex();
		if (previousIndex >= 0) this.lastSelectedIndex = previousIndex;
		this.goals = [...goals];
		const rows = this.listRows();
		if (this.selectedKey !== undefined && rows.some((row) => row.key === this.selectedKey)) return;
		this.selectNearestGoal(this.lastSelectedIndex);
		this.detailScroll = 0;
	}

	setMessage(text: string, tone: MessageTone): void {
		this.message = { text, tone };
	}

	/**
	 * The file move that lands the reorder the user asked for on screen.
	 *
	 * The pair is always rewritten as "put the goal that ends up first immediately
	 * before the goal that ends up second", never as "put the moved goal after its
	 * neighbour". Both spell the same two-goal order, but only the first leaves a
	 * section where it was: sections are ordered by the earliest file position any
	 * of their goals holds, so re-inserting a section's own first goal further down
	 * hands that position to whatever goal happens to sit between them and makes an
	 * unrelated section jump the queue. Inserting at a position the section already
	 * occupies cannot move the section at all.
	 */
	resolveReorder(intent: Extract<BoardIntent, { kind: "reorder" }>): WorklistOperation | undefined {
		const sectionIds = new Set(
			intent.sectionGoalIds.flatMap((id) => {
				const goal = findGoalByStoredId(this.goals, id);
				return goal ? [goal.id] : [];
			}),
		);
		const section = this.goals.filter((goal) => sectionIds.has(goal.id));
		const source = findGoalByStoredId(this.goals, intent.goalId);
		if (!source) {
			return {
				scope: "project",
				action: "move",
				id: intent.goalId,
				direction: intent.delta < 0 ? "up" : "down",
			};
		}
		const sourceIndex = section.findIndex((goal) => goal.id === source.id);
		const anchor = section[sourceIndex + intent.delta];
		if (!anchor) return undefined;
		const [first, second] = intent.delta < 0 ? [source, anchor] : [anchor, source];
		return { scope: "project", action: "move", id: first.id, beforeId: second.id };
	}

	get selectedGoal(): ProjectGoal | undefined {
		const row = this.selectedRow();
		return row?.kind === "goal" ? row.goal : undefined;
	}

	/**
	 * The goals on screen, in the order the current sort puts them.
	 *
	 * File order is the tiebreak of every sort and the whole of the `file` sort,
	 * so the arrangement a user built with `K` and `J` survives a trip through the
	 * other views. The active goal is lifted to the top of the derived orders but
	 * not of `file`: that view is a faithful picture of the file, which is exactly
	 * what makes reordering in it land where the user watched it land.
	 */
	private visibleGoals(): ProjectGoal[] {
		const fileOrder = new Map(this.goals.map((goal, index) => [goal.id, index]));
		const rank = (goal: ProjectGoal): number => fileOrder.get(goal.id) ?? 0;
		const waves = this.sort === "dependency" ? this.dependencyRanks() : undefined;
		const wave = (goal: ProjectGoal): number => waves?.get(goal.id) ?? SETTLED_WAVE;
		return this.goals
			.filter((goal) => matchesFilter(goal, this.filter) && matchesGoalQuery(goal, this.query))
			.sort((left, right) => {
				if (this.sort === "file") return rank(left) - rank(right);
				if (isActive(left) !== isActive(right)) return isActive(left) ? -1 : 1;
				if (this.sort === "status") {
					const status = GOAL_STATUS_RANK[left.status] - GOAL_STATUS_RANK[right.status];
					if (status !== 0) return status;
				} else if (this.sort === "dependency") {
					const layer = wave(left) - wave(right);
					if (layer !== 0) return layer;
				} else {
					const updated = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
					if (Number.isFinite(updated) && updated !== 0) return updated;
				}
				return rank(left) - rank(right);
			});
	}

	/**
	 * Each unfinished goal's wave number, as `dependency` order reads it.
	 *
	 * The layers come from `dependencyWaves`, so the board orders the roadmap by
	 * the same schedule `project waves` prints instead of a second reading of the
	 * same edges. Goals the schedule cannot place - settled ones, which are behind
	 * it, and unreachable ones, which no wave releases - are absent here and take
	 * their rank from the constants beside it.
	 *
	 * Cached against the goal array itself, which is replaced wholesale on every
	 * load, so the one invalidation trigger is the one thing that can change the
	 * graph. That is what makes a cache safe here where `listRows` deliberately
	 * has none: this answer depends on the goals and on nothing else about the
	 * view, and it is recomputed several times per keystroke without it.
	 */
	private dependencyRanks(): Map<string, number> {
		if (this.waveRanks?.goals !== this.goals) {
			const ranks = new Map<string, number>();
			const { waves, unreachable } = dependencyWaves(this.goals);
			waves.forEach((wave, index) => {
				for (const goal of wave) ranks.set(goal.id, index + 1);
			});
			for (const goal of unreachable) ranks.set(goal.id, UNREACHABLE_WAVE);
			this.waveRanks = { goals: this.goals, ranks };
		}
		return this.waveRanks.ranks;
	}

	/**
	 * Group filtered goals in first-appearance order, with ungrouped goals last.
	 *
	 * The implicit bucket is kept beside the named sections rather than inside
	 * them, so a goal filed under a group that happens to spell the bucket's own
	 * key cannot overwrite it and disappear from the board.
	 *
	 * A roadmap where nothing is grouped is a plain list rather than one section
	 * holding everything: a header that is the only header says nothing, and it
	 * would cost every existing roadmap a row and put an unselectable row above
	 * the first goal.
	 *
	 * Deliberately recomputed on every access, including several times while
	 * handling one keystroke, rather than cached. A cache here would have to be
	 * invalidated on the goals, the filter, the sort, the query, and the expanded
	 * set, which is five triggers mutated from call sites all over this class, and
	 * a stale row list is a wrong selection rather than a slow one. The whole
	 * keystroke-and-render path measures about 1ms on this project's own 70-goal
	 * roadmap, 5ms at 700 goals, and stays under a 60fps frame's 16.7ms until
	 * somewhere past 1500. Measure before trading that correctness for speed.
	 */
	private listRows(): ListRow[] {
		const named = new Map<string, ProjectGoal[]>();
		const ungrouped: ProjectGoal[] = [];
		for (const goal of this.visibleGoals()) {
			const section = goalSection(goal);
			if (section === undefined) {
				ungrouped.push(goal);
				continue;
			}
			const existing = named.get(section);
			if (existing) existing.push(goal);
			else named.set(section, [goal]);
		}
		const sections: { key: string; label: string; goals: ProjectGoal[] }[] = [...named].map(
			([label, goals]) => ({ key: label, label, goals }),
		);
		if (ungrouped.length > 0) {
			if (sections.length === 0) {
				return ungrouped.map((goal) => ({
					kind: "goal" as const,
					key: goalRowKey(goal),
					goal,
					indented: false,
				}));
			}
			sections.push({ key: UNGROUPED_KEY, label: UNGROUPED_LABEL, goals: ungrouped });
		}

		const rows: ListRow[] = [];
		for (const section of sections) {
			// A search overrides collapse rather than clearing it: every section shown
			// under a query holds a match, so hiding one would report a hit the list
			// does not show, and the collapse the user set returns when the query does.
			const collapsed = this.query === "" && !this.expandedGroups.has(section.key);
			rows.push({
				kind: "group",
				key: groupRowKey(section.key),
				label: section.label,
				goals: section.goals,
				collapsed,
			});
			if (!collapsed) {
				rows.push(
					...section.goals.map((goal) => ({
						kind: "goal" as const,
						key: goalRowKey(goal),
						goal,
						indented: true,
					})),
				);
			}
		}
		return rows;
	}

	private selectedRow(): ListRow | undefined {
		const rows = this.listRows();
		return rows[rowIndexOf(rows, this.selectedKey)];
	}

	/**
	 * Collapse or expand the selected section, reporting whether anything moved.
	 *
	 * A caller that would otherwise fall through to a second meaning for the same
	 * key needs to know the difference: collapsing an already-collapsed section is
	 * not a key the board has consumed, it is a key the board ignored.
	 */
	private toggleSelectedGroup(force?: "expand" | "collapse"): boolean {
		const rows = this.listRows();
		const index = rowIndexOf(rows, this.selectedKey);
		const row = rows[index];
		if (row?.kind !== "group") return false;
		const groupKey = row.key.slice("group:".length);
		const collapse = force === "collapse" || (force === undefined && !row.collapsed);
		if (collapse === row.collapsed) return false;
		if (collapse) this.expandedGroups.delete(groupKey);
		else this.expandedGroups.add(groupKey);
		// Expanding leads the pane with the header, so the goals it just revealed are
		// what fills the rows below it. Left alone, a header sitting on the last row
		// stays there and expanding it shows the user nothing at all; reset to the
		// top instead and the render clamp drags that same header back down to the
		// bottom. Collapsing keeps the scroll it had, which the clamp already bounds.
		if (!collapse) this.listScroll = index;
		return true;
	}

	/**
	 * Move the selection onto the first goal of the selected, expanded section.
	 *
	 * This is what `→` and `enter` mean once a section is already open: the same
	 * step-inside a tree makes, rather than a dead key or a detail pane with no
	 * goal to show.
	 */
	private enterSelectedGroup(): boolean {
		const rows = this.listRows();
		const index = rowIndexOf(rows, this.selectedKey);
		const row = rows[index];
		if (row?.kind !== "group" || row.collapsed) return false;
		const child = rows[index + 1];
		if (child?.kind !== "goal") return false;
		this.selectIndex(index + 1);
		return true;
	}

	private selectedIndex(): number {
		return rowIndexOf(this.listRows(), this.selectedKey);
	}

	private selectIndex(index: number): void {
		const rows = this.listRows();
		if (rows.length === 0) {
			this.selectedKey = undefined;
			return;
		}
		const bounded = Math.min(Math.max(0, index), rows.length - 1);
		const next = rows[bounded];
		if (next.key !== this.selectedKey) this.detailScroll = 0;
		this.selectedKey = next.key;
		this.lastSelectedIndex = bounded;
	}

	private selectFirstGoal(): void {
		const rows = this.listRows();
		this.selectIndex(Math.max(0, firstGoalIndex(rows)));
	}

	/**
	 * Land on the goal closest to a row index, preferring the one after it.
	 *
	 * A deletion should leave the cursor beside the goal that went, so an index
	 * that now holds a section header walks outward to a goal rather than falling
	 * back to the top of the board and losing the user's place entirely.
	 */
	private selectNearestGoal(index: number): void {
		const rows = this.listRows();
		if (rows.length === 0) {
			this.selectedKey = undefined;
			return;
		}
		const bounded = Math.min(Math.max(0, index), rows.length - 1);
		for (let reach = 0; reach < rows.length; reach += 1) {
			for (const candidate of [bounded + reach, bounded - reach]) {
				if (rows[candidate]?.kind === "goal") {
					this.selectIndex(candidate);
					return;
				}
			}
		}
		this.selectIndex(bounded);
	}

	/**
	 * Keep the selection on the goal a cleared query was sitting on.
	 *
	 * The query overrode collapse to show that goal, so clearing it can hide the
	 * row again. Landing on the section that holds it says where the goal went,
	 * where falling back to the first row would drop the user at the top of the
	 * roadmap with no way to tell that anything moved.
	 */
	private restoreSelection(goal: ProjectGoal | undefined): void {
		const rows = this.listRows();
		if (goal !== undefined) {
			const wanted = [goalRowKey(goal), groupRowKey(goalSection(goal) ?? UNGROUPED_KEY)];
			for (const key of wanted) {
				const index = rows.findIndex((row) => row.key === key);
				if (index >= 0) {
					this.selectIndex(index);
					return;
				}
			}
		}
		this.selectIndex(this.selectedIndex());
	}

	private moveSelection(delta: number): void {
		const current = this.selectedIndex();
		this.selectIndex((current < 0 ? 0 : current) + delta);
	}

	// ------------------------------------------------------------------ input

	handleKey(key: KeyEvent): BoardIntent | undefined {
		if (isInterrupt(key)) return { kind: "quit" };
		if (key.paste && this.mode.kind !== "prompt" && this.mode.kind !== "search") return undefined;
		if (this.mode.kind === "prompt") return this.handlePromptKey(key, this.mode.prompt);
		if (this.mode.kind === "search") return this.handleSearchKey(key, this.mode.search);
		if (this.mode.kind === "confirm") return this.handleConfirmKey(key, this.mode.confirm);
		if (this.mode.kind === "help") return this.handleHelpKey(key);
		return this.handleBrowseKey(key);
	}

	/**
	 * Read the key map, which scrolls because it is longer than a short terminal.
	 *
	 * The overlay used to drop whatever did not fit, and what fell off the end was
	 * the way out of it. Scrolling keeps every binding reachable at any height, so
	 * the one screen a stuck user opens can always answer them.
	 */
	private handleHelpKey(key: KeyEvent): BoardIntent | undefined {
		if (key.name === "up" || key.char === "k") this.helpScroll = Math.max(0, this.helpScroll - 1);
		else if (key.name === "down" || key.char === "j") this.helpScroll += 1;
		else if (key.name === "pageup") this.helpScroll = Math.max(0, this.helpScroll - PAGE_STEP);
		else if (key.name === "pagedown") this.helpScroll += PAGE_STEP;
		else if (key.name === "home" || key.char === "g") this.helpScroll = 0;
		else if (key.name === "end" || key.char === "G") this.helpScroll = Number.MAX_SAFE_INTEGER;
		else {
			this.mode = { kind: "browse" };
			this.helpScroll = 0;
		}
		return undefined;
	}

	private handleConfirmKey(key: KeyEvent, confirm: ConfirmState): BoardIntent | undefined {
		if (
			key.inputBatch !== undefined &&
			confirm.openedByInputBatch !== undefined &&
			key.inputBatch === confirm.openedByInputBatch
		) {
			return undefined;
		}
		if (key.char === "y" || key.char === "Y") {
			this.mode = { kind: "browse" };
			return confirm.intent;
		}
		// Anything other than an explicit yes cancels: a lifecycle change must never
		// happen because a stray key looked close enough to consent.
		this.mode = { kind: "browse" };
		this.message = { text: "Cancelled.", tone: "info" };
		return undefined;
	}

	/** Shared line-editing behavior for the add, rename, and search inputs. */
	private editCells(
		key: KeyEvent,
		state: { cells: string[]; cursor: number },
	): "edited" | "submit" | "cancel" | "ignored" {
		if (key.name === "escape") return "cancel";
		if (key.name === "enter") return "submit";
		if (key.name === "backspace") {
			if (state.cursor > 0) {
				state.cells.splice(state.cursor - 1, 1);
				state.cursor -= 1;
			}
			return "edited";
		}
		if (key.name === "delete") {
			if (state.cursor < state.cells.length) state.cells.splice(state.cursor, 1);
			return "edited";
		}
		if (key.name === "left") {
			state.cursor = Math.max(0, state.cursor - 1);
			return "edited";
		}
		if (key.name === "right") {
			state.cursor = Math.min(state.cells.length, state.cursor + 1);
			return "edited";
		}
		if (key.name === "home") {
			state.cursor = 0;
			return "edited";
		}
		if (key.name === "end") {
			state.cursor = state.cells.length;
			return "edited";
		}
		if (key.ctrl && key.char === "u") {
			state.cells.splice(0, state.cursor);
			state.cursor = 0;
			return "edited";
		}
		if (key.ctrl && key.char === "k") {
			state.cells.splice(state.cursor);
			return "edited";
		}
		if (key.ctrl && key.char === "w") {
			let index = state.cursor;
			while (index > 0 && state.cells[index - 1] === " ") index -= 1;
			while (index > 0 && state.cells[index - 1] !== " ") index -= 1;
			state.cells.splice(index, state.cursor - index);
			state.cursor = index;
			return "edited";
		}
		if (!key.ctrl && !key.alt && key.char !== undefined) {
			state.cells.splice(state.cursor, 0, key.char);
			state.cursor += 1;
			return "edited";
		}
		return "ignored";
	}

	private handlePromptKey(key: KeyEvent, prompt: PromptState): BoardIntent | undefined {
		const outcome = this.editCells(key, prompt);
		if (outcome === "cancel") {
			this.mode = { kind: "browse" };
			return undefined;
		}
		if (outcome !== "submit") return undefined;
		this.mode = { kind: "browse" };
		const value = prompt.cells.join("").trim();
		if (value === "") {
			this.message = { text: "Cancelled: nothing entered.", tone: "info" };
			return undefined;
		}
		return prompt.submit(value);
	}

	private handleSearchKey(key: KeyEvent, search: SearchState): BoardIntent | undefined {
		const outcome = this.editCells(key, search);
		if (outcome === "cancel") {
			const previous = this.selectedGoal;
			this.query = search.previousQuery;
			this.mode = { kind: "browse" };
			this.restoreSelection(previous);
			return undefined;
		}
		if (outcome === "submit") {
			this.mode = { kind: "browse" };
			return undefined;
		}
		// Filter as the user types so the list narrows under the cursor.
		this.query = search.cells.join("");
		if (this.selectedIndex() < 0 || this.selectedGoal === undefined) this.selectFirstGoal();
		return undefined;
	}

	private handleBrowseKey(key: KeyEvent): BoardIntent | undefined {
		this.message = undefined;
		// Reordering is checked before navigation, because Shift+Up is still an
		// up arrow and would otherwise be swallowed as a plain selection move.
		const reorder = readReorderStep(key);
		if (reorder !== undefined) return this.reorder(reorder);
		const navigated = this.handleNavigationKey(key);
		if (navigated) return undefined;

		if (key.char === "q") return { kind: "quit" };
		if (key.name === "escape") return this.handleEscape();
		if (key.char === "?") {
			this.mode = { kind: "help" };
			return undefined;
		}
		if (key.char === "f") {
			this.cycleFilter();
			return undefined;
		}
		if (key.char === "o") {
			this.cycleSort();
			return undefined;
		}
		if (key.char === "/") {
			const cells = toCellArray(this.query);
			this.mode = {
				kind: "search",
				search: { cells, cursor: cells.length, previousQuery: this.query },
			};
			return undefined;
		}
		if (key.char === "R" || (key.ctrl && key.char === "r")) return { kind: "reload" };
		if (key.char === "a") {
			this.openAddPrompt();
			return undefined;
		}
		return this.handleGoalKey(key);
	}

	private handleNavigationKey(key: KeyEvent): boolean {
		const detailFocused = this.focus === "detail";
		if (key.name === "up" || key.char === "k") {
			if (detailFocused) this.detailScroll = Math.max(0, this.detailScroll - 1);
			else this.moveSelection(-1);
			return true;
		}
		if (key.name === "down" || key.char === "j") {
			if (detailFocused) this.detailScroll += 1;
			else this.moveSelection(1);
			return true;
		}
		if (key.name === "pageup") {
			if (detailFocused) this.detailScroll = Math.max(0, this.detailScroll - PAGE_STEP);
			else this.moveSelection(-PAGE_STEP);
			return true;
		}
		if (key.name === "pagedown") {
			if (detailFocused) this.detailScroll += PAGE_STEP;
			else this.moveSelection(PAGE_STEP);
			return true;
		}
		if (key.name === "home" || key.char === "g") {
			if (detailFocused) this.detailScroll = 0;
			else this.selectIndex(Math.max(0, firstGoalIndex(this.listRows())));
			return true;
		}
		if (key.name === "end" || key.char === "G") {
			if (detailFocused) this.detailScroll = Number.MAX_SAFE_INTEGER;
			else {
				const rows = this.listRows();
				const last = lastGoalIndex(rows);
				this.selectIndex(last >= 0 ? last : rows.length - 1);
			}
			return true;
		}
		if (key.name === "left" || key.char === "h") {
			if (!detailFocused && this.toggleSelectedGroup("collapse")) return true;
			this.focus = "list";
			return true;
		}
		if (key.name === "right" || key.char === "l" || key.name === "enter") {
			// On a section header the key opens the section, then steps inside it, and
			// only reaches the detail pane once there is a goal for the pane to show.
			if (!detailFocused && (this.toggleSelectedGroup("expand") || this.enterSelectedGroup())) return true;
			this.focus = "detail";
			return true;
		}
		if (key.name === "tab") {
			this.focus = this.focus === "list" ? "detail" : "list";
			return true;
		}
		return false;
	}

	private handleEscape(): BoardIntent | undefined {
		if (this.focus === "detail") {
			this.focus = "list";
			return undefined;
		}
		if (this.query !== "") {
			const previous = this.selectedGoal;
			this.query = "";
			this.restoreSelection(previous);
			return undefined;
		}
		return { kind: "quit" };
	}

	private handleGoalKey(key: KeyEvent): BoardIntent | undefined {
		const row = this.selectedRow();
		if (row?.kind === "group") {
			if (key.name === "space") {
				this.toggleSelectedGroup();
				return undefined;
			}
			// Every key below acts on a goal, and a header has none. Saying so beats a
			// redraw that leaves the user unable to tell an unbound key from a wedged
			// board or a lifecycle action that silently failed.
			if (GOAL_KEYS.has(key.char ?? "")) {
				this.message = { text: `${quoteTitle(row.label)} is a section. Select a goal first.`, tone: "info" };
			}
			return undefined;
		}
		const goal = this.selectedGoal;
		if (!goal) return undefined;
		if (key.name === "space") return this.advance(goal, key.inputBatch);
		if (key.char === "s") return this.activate(goal);
		if (key.char === "e") {
			this.openRenamePrompt(goal);
			return undefined;
		}
		if (key.char === "E") return { kind: "edit-description", goal };
		if (key.char === "c") return this.confirmLifecycle(goal, "complete", key.inputBatch);
		if (key.char === "r") return this.confirmLifecycle(goal, "reopen", key.inputBatch);
		if (key.char === "x") return this.confirmLifecycle(goal, "archive", key.inputBatch);
		if (key.char === "d") {
			this.mode = {
				kind: "confirm",
				confirm: {
					question: `Permanently delete ${quoteTitle(goal.title)}? This cannot be undone.`,
					openedByInputBatch: key.inputBatch,
					intent: {
						kind: "operation",
						operation: { scope: "project", action: "delete", id: goal.id, confirm: true },
						success: `Deleted ${quoteTitle(goal.title)}`,
					},
				},
			};
			return undefined;
		}
		return undefined;
	}

	private cycleFilter(): void {
		const index = GOAL_FILTERS.indexOf(this.filter);
		this.filter = GOAL_FILTERS[(index + 1) % GOAL_FILTERS.length];
		this.listScroll = 0;
		// Only a selection the new filter took off the list is worth moving. A
		// section header is a row like any other, and sections outlive a filter, so
		// resetting to the top because the cursor was not on a goal would throw away
		// the user's place on every press of the key that changes the least.
		if (this.selectedIndex() < 0) this.selectFirstGoal();
	}

	private cycleSort(): void {
		const index = GOAL_SORTS.indexOf(this.sort);
		this.sort = GOAL_SORTS[(index + 1) % GOAL_SORTS.length];
		this.listScroll = 0;
	}

	/** The visible goals filed under the same section as this one, in list order. */
	private sectionGoals(goal: ProjectGoal): ProjectGoal[] {
		const section = goalSection(goal);
		return this.visibleGoals().filter((candidate) => goalSection(candidate) === section);
	}

	/**
	 * Move the selected goal one row through the section it is shown in.
	 *
	 * The anchor is the neighboring visible row inside the goal's own section
	 * rather than a file index, so a move under a filter or a search lands beside
	 * the goal the user can actually see instead of stepping over hidden ones, and
	 * a move in a grouped board is a step the board can show: anchoring on the next
	 * visible row regardless of section would write a file order the sections put
	 * back exactly as it was, reporting a move that never appears. A section
	 * boundary is therefore an end of the list, and says which section it ended.
	 * Only the `file` sort can reorder: in a derived order the rows are not where
	 * the file puts them, so a move would edit an arrangement the screen is not
	 * showing.
	 */
	private reorder(delta: -1 | 1): BoardIntent | undefined {
		const goal = this.selectedGoal;
		if (!goal) return undefined;
		if (this.sort !== "file") {
			this.message = { text: `Reorder in file order only. Press o until ${SORT_LABELS.file}.`, tone: "info" };
			return undefined;
		}
		const section = this.sectionGoals(goal);
		const sourceIndex = section.findIndex((candidate) => candidate.id === goal.id);
		const anchor = section[sourceIndex + delta];
		if (!anchor) {
			this.message = { text: sectionEdgeMessage(goal, delta), tone: "info" };
			return undefined;
		}
		return {
			kind: "reorder",
			goalId: goal.id,
			delta,
			sectionGoalIds: section.map((candidate) => candidate.id),
			success: `Moved ${quoteTitle(goal.title)} ${delta < 0 ? "up" : "down"}`,
			blocked: sectionEdgeMessage(goal, delta),
		};
	}

	private openAddPrompt(): void {
		this.mode = {
			kind: "prompt",
			prompt: {
				label: "Add goal",
				cells: [],
				cursor: 0,
				submit: (title) => ({
					kind: "operation",
					operation: { scope: "project", action: "add", title },
					success: `Added ${quoteTitle(title)} - press E to write its description`,
				}),
			},
		};
	}

	private openRenamePrompt(goal: ProjectGoal): void {
		const initial = toCellArray(singleLine(goal.title));
		this.mode = {
			kind: "prompt",
			prompt: {
				label: "Rename goal",
				cells: initial,
				cursor: initial.length,
				submit: (title) =>
					title === goal.title
						? undefined
						: {
								kind: "operation",
								operation: { scope: "project", action: "update", id: goal.id, title },
								success: `Renamed to ${quoteTitle(title)}`,
							},
			},
		};
	}

	/** Mirror Pi's dashboard: open activates, active completes, anything settled reopens. */
	private advance(goal: ProjectGoal, inputBatch?: number): BoardIntent | undefined {
		if (goal.status === "open") return this.activate(goal);
		if (goal.status === "active") return this.confirmLifecycle(goal, "complete", inputBatch);
		return this.confirmLifecycle(goal, "reopen", inputBatch);
	}

	private activate(goal: ProjectGoal): BoardIntent | undefined {
		if (goal.status === "active") {
			this.message = { text: "Already the active goal.", tone: "info" };
			return undefined;
		}
		return {
			kind: "operation",
			operation: { scope: "project", action: "set_active", id: goal.id },
			success: `Activated ${quoteTitle(goal.title)}`,
		};
	}

	/**
	 * Stage a lifecycle change behind a yes-or-no prompt.
	 *
	 * The prompt is the explicit user intent the application service requires;
	 * `confirm` is only ever set on the intent the prompt returns.
	 */
	private confirmLifecycle(
		goal: ProjectGoal,
		action: "complete" | "reopen" | "archive",
		openedByInputBatch?: number,
	): BoardIntent | undefined {
		const outcome = action === "complete" ? "done" : action === "reopen" ? "open" : "archived";
		this.mode = {
			kind: "confirm",
			confirm: {
				question: `${action[0].toUpperCase()}${action.slice(1)} ${quoteTitle(goal.title)}?`,
				openedByInputBatch,
				intent: {
					kind: "operation",
					operation: { scope: "project", action, id: goal.id, confirm: true },
					success: `${quoteTitle(goal.title)} is now ${outcome}`,
				},
			},
		};
		return undefined;
	}

	// ----------------------------------------------------------------- render

	render(width: number, rows: number): Frame {
		const statusRows = this.reservedStatusRows(width, rows);
		const bodyRows = Math.max(BODY_MIN_ROWS, rows - 2 - statusRows);
		const body =
			this.mode.kind === "help" ? this.renderHelp(width, bodyRows) : this.renderPanes(width, bodyRows);
		const status = this.renderStatus(width, statusRows);
		// Anything shorter than the reservation sits at the bottom of it, so a prompt
		// and its cursor stay on the row directly above the key bar.
		const statusBlock = [
			...new Array<string>(Math.max(0, statusRows - status.lines.length)).fill(""),
			...status.lines,
		];
		const lines = [this.renderHeader(width), ...body, ...statusBlock, this.renderKeyBar(width)];
		// The frame is exactly the size it was asked for, whatever the panes produced,
		// so the status lines and key bar always land on the last rows.
		const tail = statusBlock.length + 1;
		while (lines.length < rows) lines.splice(lines.length - tail, 0, "");
		if (lines.length > rows) lines.splice(rows - tail, lines.length - rows);
		return {
			lines,
			...(status.cursorColumn === undefined
				? {}
				: { cursor: { row: rows - 2, column: status.cursorColumn } }),
		};
	}

	private renderHeader(width: number): string {
		const { accent, bold, muted, dim } = this.palette;
		const total = this.goals.length;
		const shown = this.visibleGoals().length;
		const left = ` ${accent(bold("Project Goals"))} ${dim("·")} ${muted(this.repositoryLabel)}`;
		const search = this.query === "" ? "" : ` ${dim("·")} ${accent(`/${singleLine(this.query)}`)}`;
		const view = `${muted(FILTER_LABELS[this.filter])} ${dim("·")} ${muted(SORT_LABELS[this.sort])} ${dim("·")} ${muted(`${shown} of ${total}`)} `;
		const counts = this.renderStatusCounts(this.goals);
		const chips = counts === "" ? "" : `${counts}${dim(SEPARATOR)}`;
		// Counts are the first thing dropped when the header runs out of room:
		// which goals are on screen right now outranks the shape of the roadmap.
		const used = visibleWidth(left) + visibleWidth(search) + visibleWidth(view);
		const right = used + visibleWidth(chips) < width ? `${chips}${view}` : view;
		const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(search) - visibleWidth(right));
		return truncateToWidth(`${left}${search}${" ".repeat(gap)}${right}`, width);
	}

	/**
	 * Per-status counts across the whole roadmap.
	 *
	 * They live in the header rather than the status line because the list is
	 * filtered and the status line is not always free: a message or an open
	 * prompt would otherwise take the roadmap's shape off the screen with it.
	 */
	private renderStatusCounts(goals: readonly ProjectGoal[]): string {
		const { dim } = this.palette;
		return goalStatusCounts(goals)
			.map((entry) => this.statusStyle(entry.status)(`${STATUS_MARKERS[entry.status]} ${entry.count}`))
			.join(dim(SEPARATOR));
	}

	private renderPanes(width: number, bodyRows: number): string[] {
		const contentRows = Math.max(1, bodyRows - 2);
		const listWidth = Math.min(
			MAX_LIST_WIDTH,
			Math.max(MIN_LIST_WIDTH, Math.round((width - 3) * LIST_WIDTH_RATIO)),
		);
		const detailWidth = width - 3 - listWidth;
		if (width >= MIN_SPLIT_WIDTH && detailWidth >= MIN_LIST_WIDTH) {
			return this.renderSplit(listWidth, detailWidth, contentRows);
		}
		return this.renderStacked(width, bodyRows);
	}

	private renderSplit(listWidth: number, detailWidth: number, contentRows: number): string[] {
		const { border } = this.palette;
		const listRows = this.renderListContent(listWidth, contentRows);
		const detailRows = this.renderDetailContent(detailWidth, contentRows);
		const lines = [
			border("╭") +
				this.renderBorderRule(listWidth, { text: this.listTitle(), focused: this.focus === "list" }) +
				border("┬") +
				this.renderBorderRule(detailWidth, { text: " Detail ", focused: this.focus === "detail" }) +
				border("╮"),
		];
		for (let row = 0; row < contentRows; row += 1) {
			lines.push(border("│") + listRows.lines[row] + border("│") + detailRows.lines[row] + border("│"));
		}
		lines.push(
			border("╰") +
				this.renderBorderRule(listWidth, undefined, listRows.hint) +
				border("┴") +
				this.renderBorderRule(detailWidth, undefined, detailRows.hint) +
				border("╯"),
		);
		return lines;
	}

	private renderStacked(width: number, bodyRows: number): string[] {
		const { border } = this.palette;
		const inner = width - 2;
		// Three rows go to the top border, the divider, and the bottom border.
		const usable = Math.max(2, bodyRows - 3);
		const listRowCount = Math.max(1, Math.min(usable - 1, Math.round(usable * 0.5)));
		const detailRowCount = Math.max(1, usable - listRowCount);
		const listRows = this.renderListContent(inner, listRowCount);
		const detailRows = this.renderDetailContent(inner, detailRowCount);
		const lines = [
			border("╭") +
				this.renderBorderRule(inner, { text: this.listTitle(), focused: this.focus === "list" }) +
				border("╮"),
		];
		for (const line of listRows.lines) lines.push(border("│") + line + border("│"));
		// The divider carries the list's scroll hint, which has no border of its own here.
		lines.push(
			border("├") +
				this.renderBorderRule(inner, { text: " Detail ", focused: this.focus === "detail" }, listRows.hint) +
				border("┤"),
		);
		for (const line of detailRows.lines) lines.push(border("│") + line + border("│"));
		lines.push(border("╰") + this.renderBorderRule(inner, undefined, detailRows.hint) + border("╯"));
		return lines;
	}

	private listTitle(): string {
		const visible = this.visibleGoals().length;
		return ` ${FILTER_LABELS[this.filter]} goals (${visible}) `;
	}

	/**
	 * Draw one pane border: a horizontal rule with an optional title on the left
	 * and an optional scroll hint on the right, filling exactly `width` cells.
	 */
	private renderBorderRule(width: number, title?: { text: string; focused: boolean }, hint?: string): string {
		const { border, accent, bold } = this.palette;
		const titleText =
			title && title.text.trim() !== "" ? truncateToWidth(title.text, Math.max(0, width - 2)) : "";
		const hintBudget = Math.max(0, width - visibleWidth(titleText) - 2);
		const hintText = hint && hint.trim() !== "" ? truncateToWidth(hint, hintBudget) : "";
		const styledTitle = title?.focused ? accent(bold(titleText)) : border(titleText);
		const fill = Math.max(0, width - visibleWidth(titleText) - visibleWidth(hintText) - 1);
		return `${border("─")}${styledTitle}${border("─".repeat(fill))}${border(hintText)}`;
	}

	private statusStyle(status: ProjectGoalStatus): Style {
		const { accent, muted, success, dim } = this.palette;
		if (status === "active") return accent;
		if (status === "done") return success;
		if (status === "archived") return dim;
		return muted;
	}

	private renderListContent(width: number, height: number): { lines: string[]; hint: string } {
		const { dim } = this.palette;
		const rows = this.listRows();
		const available = Math.max(1, width - 2);

		if (rows.length === 0) {
			// The way out of an empty list depends on why it is empty: a search that
			// matched nothing, a filter hiding real goals, or a genuinely empty roadmap.
			const [empty, wayOut] =
				this.query !== ""
					? ["Nothing matches this search.", "Press esc to clear it."]
					: this.goals.length === 0
						? ["No goals here yet.", "Press a to add one."]
						: [`No ${FILTER_LABELS[this.filter].toLowerCase()} goals.`, "Press f to change the filter."];
			const lines = [
				` ${dim(truncateToWidth(empty, available))}`,
				` ${dim(truncateToWidth(wayOut, available))}`,
			];
			while (lines.length < height) lines.push("");
			return { lines: lines.slice(0, height).map((line) => fitToWidth(line, width)), hint: "" };
		}

		const selected = Math.max(0, this.selectedIndex());
		this.listScroll = Math.min(this.listScroll, Math.max(0, rows.length - height));
		if (selected < this.listScroll) this.listScroll = selected;
		if (selected >= this.listScroll + height) this.listScroll = selected - height + 1;

		const lines: string[] = [];
		for (let offset = 0; offset < height; offset += 1) {
			const index = this.listScroll + offset;
			const row = rows[index];
			if (!row) {
				lines.push(fitToWidth("", width));
				continue;
			}
			lines.push(
				row.kind === "group"
					? this.renderGroupRow(row, width, index === selected)
					: this.renderGoalRow(row, width, available, index === selected),
			);
		}

		// Counted in goals rather than rows, because the pane title counts goals and
		// "3 more" beside "Open goals (4)" reads as three goals. A collapsed section
		// below the fold contributes the goals it holds rather than its one row.
		const hidden = rows
			.slice(this.listScroll + height)
			.reduce((total, row) => total + (row.kind === "goal" ? 1 : row.collapsed ? row.goals.length : 0), 0);
		const hint = hidden > 0 ? ` ${hidden} more ` : "";
		return { lines, hint };
	}

	private renderGroupRow(
		row: Extract<ListRow, { kind: "group" }>,
		width: number,
		isSelected: boolean,
	): string {
		const { accent, bold, muted } = this.palette;
		// The leading space is the goal row's, so the pointer never hops a column or
		// sits against the pane border as the selection crosses a header.
		const pointer = isSelected ? (this.focus === "list" ? accent("❯") : muted("❯")) : " ";
		const disclosure = row.collapsed ? "▸" : "▾";
		const count = `(${row.goals.length})`;
		const countSlot = visibleWidth(count) + 1;
		const label = truncateToWidth(singleLine(row.label), Math.max(1, width - countSlot - 5));
		const text = ` ${pointer} ${disclosure} ${label}`;
		// A pane too narrow to carry the count drops it rather than overrunning the
		// frame; fitToWidth then guarantees the row is exactly `width` cells either way.
		if (width - visibleWidth(text) - countSlot < 1) return fitToWidth(bold(text), width);
		const gap = " ".repeat(width - visibleWidth(text) - countSlot);
		return fitToWidth(bold(`${text}${gap}${count} `), width);
	}

	/**
	 * One list row: pointer, status marker, title, and a staleness badge pushed to
	 * the right edge. The row always fills exactly `width` cells so the pane
	 * borders stay aligned whatever the title and the badge turn out to be.
	 *
	 * A goal under a section header is inset from it, so the list reads as a tree
	 * rather than as headers and goals sharing one column. The pointer stays where
	 * it is: it is the cursor, and a cursor that changes column as the selection
	 * crosses a header reads as the list shifting rather than the selection moving.
	 */
	private renderGoalRow(
		row: Extract<ListRow, { kind: "goal" }>,
		width: number,
		available: number,
		isSelected: boolean,
	): string {
		const { accent, muted, dim, bold, warning } = this.palette;
		const goal = row.goal;
		const inset = row.indented ? " ".repeat(SECTION_INDENT) : "";
		// What the title and the badge share, once the pointer, the marker, their
		// spaces, and the inset have taken theirs.
		const titleSpace = available - 4 - visibleWidth(inset);
		const stale = stalenessDays(goal, this.now());
		const badge = stale === undefined ? "" : `${stale}d`;
		// A space on each side keeps the badge off both the title and the border.
		// It is a nudge, though, so a list too narrow to carry one goes without.
		const slot = badge === "" ? 0 : visibleWidth(badge) + 2;
		const badgeSlot = titleSpace - slot >= MIN_BADGED_TITLE_WIDTH ? slot : 0;
		const pointer = isSelected ? (this.focus === "list" ? accent("❯") : muted("❯")) : " ";
		const marker = this.statusStyle(goal.status)(STATUS_MARKERS[goal.status]);
		const title = truncateToWidth(singleLine(goal.title), Math.max(1, titleSpace - badgeSlot));
		// Settled work recedes only where it sits alongside live work, and the
		// selected row always keeps full contrast so the cursor is never the dim one.
		const emphasized = isSelected && this.focus === "list";
		const settled = goal.status === "done" || goal.status === "archived";
		// A goal waiting on work that has not landed recedes for the same reason
		// settled work does: it is not what can be picked up right now. The detail
		// pane says which edges are holding it, so the dimming is never unexplained.
		const blocked = isGoalBlocked(this.goals, goal);
		const dimmed = !isSelected && ((this.filter === "all" && settled) || blocked);
		const label = isActive(goal)
			? accent(emphasized ? bold(title) : title)
			: emphasized
				? bold(title)
				: dimmed
					? dim(title)
					: title;
		const line = ` ${pointer} ${inset}${marker} ${label}`;
		if (badgeSlot === 0) return fitToWidth(line, width);
		const pad = " ".repeat(badgeSlot - visibleWidth(badge) - 1);
		return `${fitToWidth(line, width - badgeSlot)}${pad}${warning(badge)} `;
	}

	/** One `LABEL value` row of the detail pane, whatever the pane is describing. */
	private detailField(label: string, value: string, style: Style): string {
		const { muted } = this.palette;
		return `${muted(label.padEnd(DETAIL_LABEL_WIDTH))}${style(value)}`;
	}

	/**
	 * The detail pane for a section header.
	 *
	 * Sections start closed, so this is the first thing the pane shows and it has
	 * to earn the space: what the section holds, how much of it is waiting, and
	 * the key that opens it. The goals counted are the ones the section is showing
	 * rather than every goal filed under it, so a filtered or searched board never
	 * reports goals its own list is hiding.
	 */
	private buildSectionDetailLines(row: Extract<ListRow, { kind: "group" }>, width: number): string[] {
		const { accent, bold, dim, warning } = this.palette;
		const lines = wrapText(row.label, width).map((line) => accent(bold(line)));
		lines.push("");
		lines.push(this.detailField("GOALS", `${row.goals.length}`, plain));
		// A breakdown of one status is the count above spelled a second way, so the
		// row appears only where the section actually holds a mix.
		if (goalStatusCounts(row.goals).length > 1) {
			lines.push(this.detailField("STATUS", this.renderStatusCounts(row.goals), plain));
		}
		// Only worth a row where something is actually waiting; the number is what
		// the section costs to start, which is what the header count cannot say.
		const blocked = row.goals.filter((goal) => isGoalBlocked(this.goals, goal)).length;
		// Marked the way a blocked goal is marked in its own pane, rather than dimmed
		// the way the list recedes one: a count of what cannot start is worth reading.
		if (blocked > 0) lines.push(this.detailField("BLOCKED", `${blocked}`, warning));
		lines.push("");
		lines.push(
			dim(row.collapsed ? "Press → to open this section." : "Press → to step inside, or ← to close."),
		);
		return lines;
	}

	private buildDetailLines(width: number): string[] {
		const { accent, bold, muted, dim, warning, danger } = this.palette;
		const row = this.selectedRow();
		if (row?.kind === "group") return this.buildSectionDetailLines(row, width);
		// Read from the row already in hand rather than `selectedGoal`, which would
		// rebuild the whole row list a second time for every frame.
		const goal = row?.goal;
		if (!goal) return [dim("No goal selected.")];

		const lines: string[] = [];
		for (const line of wrapText(goal.title, width)) lines.push(accent(bold(line)));
		lines.push("");

		const field = (label: string, value: string, style: Style) => this.detailField(label, value, style);

		/**
		 * A marked goal ID under a label, wrapped rather than cut.
		 *
		 * These IDs are what every CLI command takes, so a narrow pane must still
		 * hand back one that can be typed; a blank label continues the list above.
		 */
		const pushDetailIdRows = (label: string, marker: string, id: string, style: Style): void => {
			const indent = DETAIL_LABEL_WIDTH + 2;
			for (const [index, chunk] of wrapText(id, Math.max(1, width - indent)).entries()) {
				const lead =
					index === 0 ? `${muted(label.padEnd(DETAIL_LABEL_WIDTH))}${marker} ` : " ".repeat(indent);
				lines.push(`${lead}${style(chunk)}`);
			}
		};
		// The dimmed row says only that a goal is not startable; the status line here
		// says so in words, and the DEPENDS rows below say what it is waiting on.
		const blockedNote = isGoalBlocked(this.goals, goal) ? warning(`${SEPARATOR}blocked`) : "";
		lines.push(field("STATUS", goal.status.toUpperCase(), this.statusStyle(goal.status)) + blockedNote);
		if (goal.group !== undefined) lines.push(field("GROUP", singleLine(goal.group), muted));
		if (goal.branch !== undefined) lines.push(field("BRANCH", singleLine(goal.branch), accent));
		// The badge in the list is only a number; spell out what it means here.
		const stale = stalenessDays(goal, this.now());
		const note = stale === undefined ? "" : `${SEPARATOR}${stale}d untouched`;
		lines.push(field("UPDATED", formatTimestamp(goal.updatedAt), dim) + warning(note));
		lines.push(field("CREATED", formatTimestamp(goal.createdAt), dim));
		if (goal.completedAt !== undefined) {
			lines.push(field("DONE", formatTimestamp(goal.completedAt), dim));
		}
		// The ID is what every CLI command takes, so it must be readable in full.
		for (const [index, chunk] of wrapText(goal.id, Math.max(1, width - DETAIL_LABEL_WIDTH)).entries()) {
			lines.push(index === 0 ? field("ID", chunk, dim) : `${" ".repeat(DETAIL_LABEL_WIDTH)}${dim(chunk)}`);
		}
		// A dependency's own status marker says whether it is still in the way, in
		// the same visual language as the list: ✓ and ◌ are settled, ◆ and ○ are not.
		// Only the forward direction is stored, so the goals this one blocks are
		// derived here from everyone else's edges rather than read from a field.
		for (const [index, entry] of resolveDependencies(this.goals, goal).entries()) {
			const marker = entry.goal
				? this.statusStyle(entry.goal.status)(STATUS_MARKERS[entry.goal.status])
				: danger("?");
			// An edge naming no goal can never be satisfied, so it is called out rather
			// than listed as though something will eventually finish it.
			const text = entry.goal ? entry.id : `${entry.id} (missing)`;
			const style = entry.goal ? (entry.satisfied ? dim : plain) : danger;
			pushDetailIdRows(index === 0 ? "DEPENDS" : "", marker, text, style);
		}
		for (const [index, blocked] of dependentGoals(this.goals, goal).entries()) {
			const marker = this.statusStyle(blocked.status)(STATUS_MARKERS[blocked.status]);
			pushDetailIdRows(index === 0 ? "BLOCKS" : "", marker, blocked.id, plain);
		}
		// Links are informational, so they are listed verbatim and wrapped rather
		// than shortened: a URL cut in half is a URL nobody can follow.
		for (const [index, link] of (goal.links ?? []).entries()) {
			for (const [chunkIndex, chunk] of wrapText(link, Math.max(1, width - DETAIL_LABEL_WIDTH)).entries()) {
				const leading = index === 0 && chunkIndex === 0;
				lines.push(leading ? field("LINKS", chunk, dim) : `${" ".repeat(DETAIL_LABEL_WIDTH)}${dim(chunk)}`);
			}
		}
		lines.push("");

		const description = goal.description?.trim();
		if (description) for (const line of wrapText(description, width)) lines.push(line);
		else lines.push(dim("No description. Press E to write one."));
		return lines;
	}

	private renderDetailContent(width: number, height: number): { lines: string[]; hint: string } {
		const available = Math.max(1, width - 2);
		const content = this.buildDetailLines(available);
		const maxScroll = Math.max(0, content.length - height);
		this.detailScroll = Math.min(this.detailScroll, maxScroll);
		const visible = content.slice(this.detailScroll, this.detailScroll + height);
		const lines: string[] = [];
		for (let row = 0; row < height; row += 1) lines.push(fitToWidth(` ${visible[row] ?? ""}`, width));
		const remaining = maxScroll - this.detailScroll;
		const hint = maxScroll > 0 ? ` ${this.detailScroll} above · ${remaining} below ` : "";
		return { lines, hint };
	}

	private renderHelp(width: number, bodyRows: number): string[] {
		const { border, accent, bold, muted } = this.palette;
		const inner = Math.max(20, width - 2);
		const keyWidth = Math.min(14, Math.max(...HELP_ENTRIES.map((entry) => entry.keys.length)) + 1);
		const lines = [
			border("╭") + this.renderBorderRule(inner, { text: " Keys ", focused: true }) + border("╮"),
		];
		const rows = Math.max(1, bodyRows - 2);
		const body: string[] = [];
		for (const entry of HELP_ENTRIES) {
			body.push(` ${accent(entry.keys.padEnd(keyWidth))}${muted(entry.description)}`);
		}
		body.push("");
		body.push(` ${bold("Press esc to return, ↑ ↓ to scroll.")}`);
		const maxScroll = Math.max(0, body.length - rows);
		this.helpScroll = Math.min(this.helpScroll, maxScroll);
		const visible = body.slice(this.helpScroll, this.helpScroll + rows);
		for (let row = 0; row < rows; row += 1)
			lines.push(border("│") + fitToWidth(visible[row] ?? "", inner) + border("│"));
		const remaining = maxScroll - this.helpScroll;
		const hint = maxScroll > 0 ? ` ${this.helpScroll} above · ${remaining} below ` : "";
		lines.push(border("╰") + this.renderBorderRule(inner, undefined, hint) + border("╯"));
		return lines;
	}

	/**
	 * Rows the status area holds while the standing notice is up.
	 *
	 * Budgeted from the condition rather than from whatever is on the line this
	 * frame, so a passing message cannot reflow the list and detail panes on the
	 * keystroke that raises it and again on the one that clears it. The notice
	 * gets rows of its own above the status line rather than sharing it, which is
	 * what lets a message take that line without wiping the warning off a screen
	 * that has no scrollback to recover it. A frame with nothing to spare falls
	 * back to one row, and there the notice shares the line as it used to.
	 */
	private reservedStatusRows(width: number, rows: number): number {
		if (this.notice === undefined) return 1;
		const spare = rows - 1 - BODY_MIN_ROWS - 1 - 1;
		if (spare < 1) return 1;
		const budget = Math.min(NOTICE_MAX_ROWS, spare);
		return wrapToLines(this.notice, Math.max(1, width - 2), budget).length + 1;
	}

	/**
	 * The whole status block: the standing notice, and whatever needs the line.
	 *
	 * A message, a prompt, or a confirmation keeps the bottom row, so what the
	 * board is asking or reporting stays where the eye already looks. The notice
	 * takes the reserved rows above it rather than pushing it aside, because the
	 * board owns the screen and a warning cleared by a passing message would have
	 * nowhere to be read again.
	 */
	private renderStatus(width: number, statusRows: number): { lines: string[]; cursorColumn?: number } {
		const noticeRows = statusRows - 1;
		const line = this.renderStatusLine(width, noticeRows < 1);
		return {
			lines: [...this.renderNoticeRows(width, noticeRows), line.line],
			...(line.cursorColumn === undefined ? {} : { cursorColumn: line.cursorColumn }),
		};
	}

	/**
	 * The standing notice, wrapped into the rows it was given.
	 *
	 * It wraps rather than being cut at the first line, because the two things it
	 * exists to convey - which file is being ignored, and that the fix is to merge
	 * by hand and delete - both sit past one line's worth of an absolute path.
	 */
	private renderNoticeRows(width: number, rows: number): string[] {
		if (this.notice === undefined || rows <= 0) return [];
		const { warning } = this.palette;
		return wrapToLines(this.notice, Math.max(1, width - 2), rows).map((line) => ` ${warning(line)}`);
	}

	/**
	 * The bottom row of the status block.
	 *
	 * Carries the cursor column when input is open, which is why it stays the last
	 * row of the block. `mayHoldNotice` is set only on a frame too short to give
	 * the notice a row of its own, where it falls back to taking this one.
	 */
	private renderStatusLine(width: number, mayHoldNotice: boolean): { line: string; cursorColumn?: number } {
		const { accent, muted, dim, success, danger, warning, bold } = this.palette;
		const inner = Math.max(1, width - 2);
		if (this.mode.kind === "prompt") {
			return this.renderInputLine(`${this.mode.prompt.label}: `, this.mode.prompt, width, accent);
		}
		if (this.mode.kind === "search") {
			return this.renderInputLine("/", this.mode.search, width, accent);
		}
		if (this.mode.kind === "confirm") {
			const suffix = ` ${dim("[")}${bold("y")}${dim("/")}N${dim("]")}`;
			const question = truncateToWidth(this.mode.confirm.question, Math.max(1, width - 8));
			return { line: ` ${warning(question)}${suffix}` };
		}
		if (this.message) {
			const style =
				this.message.tone === "error" ? danger : this.message.tone === "success" ? success : muted;
			return { line: ` ${style(truncateToWidth(this.message.text, inner))}` };
		}
		// With no row of its own, a standing condition outranks the idle summary: the
		// summary describes the roadmap on screen, and the notice is the reason that
		// roadmap may not be all of them.
		if (mayHoldNotice && this.notice !== undefined) {
			return { line: ` ${warning(truncateToWidth(this.notice, inner))}` };
		}
		return { line: ` ${dim(truncateToWidth(this.idleSummary(), inner))}` };
	}

	/**
	 * What the board says when nothing else needs the line.
	 *
	 * Roadmap counts moved to the header, where messages cannot cover them, so this
	 * line answers what the header cannot: which goal is in flight, named in full
	 * even while the list is filtered or scrolled away from the pinned row.
	 */
	private idleSummary(): string {
		if (this.goals.length === 0) return "No project goals yet. Press a to add one.";
		const active = this.goals.find(isActive);
		if (!active) return "No active goal. Press s to make one active.";
		return `Active: ${singleLine(active.title)}`;
	}

	/**
	 * Draw a single-line editor, scrolling horizontally so the cursor stays visible
	 * even when the value is longer than the terminal is wide.
	 */
	private renderInputLine(
		prefix: string,
		state: { cells: string[]; cursor: number },
		width: number,
		style: Style,
	): { line: string; cursorColumn: number } {
		const prefixWidth = visibleWidth(prefix) + 1;
		const available = Math.max(1, width - prefixWidth - 1);
		let start = 0;
		let cursorOffset = 0;
		for (let index = 0; index < state.cursor; index += 1) {
			cursorOffset += visibleWidth(state.cells[index]);
		}
		while (cursorOffset - start >= available) start += 1;
		let rendered = "";
		let used = 0;
		let skipped = 0;
		for (const cell of state.cells) {
			const cellWidth = visibleWidth(cell);
			if (skipped < start) {
				skipped += cellWidth;
				continue;
			}
			if (used + cellWidth > available) break;
			rendered += cell;
			used += cellWidth;
		}
		return {
			line: ` ${style(prefix)}${rendered}`,
			cursorColumn: prefixWidth + (cursorOffset - start),
		};
	}

	private renderKeyBar(width: number): string {
		const { dim } = this.palette;
		if (this.mode.kind === "prompt" || this.mode.kind === "search") {
			return ` ${dim(truncateToWidth("enter confirm · esc cancel", Math.max(1, width - 2)))}`;
		}
		if (this.mode.kind === "confirm") {
			return ` ${dim(truncateToWidth("y confirm · any other key cancels", Math.max(1, width - 2)))}`;
		}
		if (this.mode.kind === "help") {
			return ` ${dim(truncateToWidth("↑↓ scroll · esc close", Math.max(1, width - 2)))}`;
		}
		// `? keys` and `q quit` are the two hints a stuck user needs, so they are
		// reserved first and the rest fill whatever width is left.
		const reserved = ["? keys", "q quit"];
		const optional = [
			"↑↓ move",
			"tab pane",
			"space advance",
			"a add",
			"e rename",
			"E describe",
			"f filter",
			"o order",
			"KJ reorder",
			"/ search",
		];
		const available = Math.max(1, width - 2);
		const chosen: string[] = [];
		for (const part of optional) {
			if (visibleWidth([...chosen, part, ...reserved].join(SEPARATOR)) > available) break;
			chosen.push(part);
		}
		return ` ${dim(truncateToWidth([...chosen, ...reserved].join(SEPARATOR), available))}`;
	}
}
