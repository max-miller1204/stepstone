import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { parseTasksCommand, WORKLIST_PROMPT_GUIDELINES } from "../src/extension.ts";
import { addProjectGoal, moveProjectGoal, readProjectGoals } from "../src/project-mutations.ts";
import { readProjectWorklist } from "../src/project-store.ts";
import { renderRoadmapMarkdown } from "../src/roadmap.ts";
import type { ProjectGoal, SessionTask } from "../src/types.ts";
import {
	buildPromptSummary,
	buildWidgetLines,
	Dashboard,
	type DashboardAction,
	DashboardDetail,
	type DashboardResult,
	type DashboardState,
} from "../src/ui.ts";

const tasks: SessionTask[] = Array.from({ length: 6 }, (_, index) => ({
	id: `t${index}`,
	title: `Task ${index}`,
	status: index === 0 ? "done" : index === 1 ? "doing" : "todo",
}));
const goals: ProjectGoal[] = [
	{
		id: "g1",
		title: "Ship v1",
		description: "Release the first stable version",
		status: "active",
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
	},
];

const identityTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

describe("widget and prompt summary", () => {
	it("caps the widget and hides completed tasks", () => {
		const lines = buildWidgetLines(tasks, goals);
		expect(lines).toHaveLength(6);
		expect(lines[0]).toBe("◆ Active: Ship v1");
		expect(lines[1]).toBe("Goals: ◆ 1");
		expect(lines.join("\n")).not.toContain("Task 0");
		expect(lines.at(-1)).toBe("+2 more");
	});

	it("shows compact Project Goal status counts even without an active goal", () => {
		const lines = buildWidgetLines(
			[],
			[
				{ ...goals[0], status: "open" },
				{ ...goals[0], id: "done", title: "Done", status: "done" },
				{ ...goals[0], id: "archived", title: "Archived", status: "archived" },
			],
		);
		expect(lines).toEqual(["Goals: ○ 1 · ✓ 1 · ◌ 1"]);
	});

	it("caps prompt task detail", () => {
		const summary = buildPromptSummary(tasks, goals, 2);
		expect(summary).toContain("Ship v1 - Release the first stable version");
		expect(summary).toContain("Task 1");
		expect(summary).toContain("and 3 more");
		expect(summary).not.toContain("Task 4");
	});

	it("preserves canonical relative order when completed tasks are filtered", () => {
		const reordered = [tasks[4], tasks[0], tasks[2], tasks[1]];
		expect(buildWidgetLines(reordered, []).map((line) => line.slice(2))).toEqual([
			"Task 4",
			"Task 2",
			"Task 1",
		]);
		const summary = buildPromptSummary(reordered, []);
		expect(summary.indexOf("Task 4")).toBeLessThan(summary.indexOf("Task 2"));
		expect(summary.indexOf("Task 2")).toBeLessThan(summary.indexOf("Task 1"));
		expect(summary).not.toContain("Task 0");
	});

	it("hides an empty worklist", () => {
		expect(buildWidgetLines([], [])).toEqual([]);
		expect(buildPromptSummary([], [])).toBe("");
	});
});

function dashboardInput(
	data: string,
	initialState?: DashboardState,
	taskItems: SessionTask[] = tasks,
	goalItems: ProjectGoal[] = goals,
): DashboardResult | undefined {
	let result: DashboardResult | undefined;
	const dashboard = new Dashboard(
		taskItems,
		goalItems,
		{} as Theme,
		(value) => {
			result = value;
		},
		initialState,
	);
	dashboard.handleInput(data);
	return result;
}

function restoredDashboardState(
	state: DashboardState,
	selectedIndex: number,
	expandedGroups: string[] = [],
	selectedGroup?: string,
): DashboardState {
	return {
		...state,
		...(selectedGroup === undefined ? {} : { selectedGroup }),
		selectedIndex,
		sessionFilter: "open",
		projectFilter: "open",
		expandedGroups,
		listScroll: 0,
	};
}

describe("dashboard ordering controls", () => {
	it("opens details with Enter and reserves Space for status changes", () => {
		const state: DashboardState = { scope: "project", selectedId: "g1" };
		expect(dashboardInput("\r", state)).toEqual({
			action: { kind: "view", scope: "project", id: "g1" },
			state: restoredDashboardState(state, 0),
		});
		expect(dashboardInput(" ", state)).toEqual({
			action: { kind: "advance", scope: "project", id: "g1" },
			state: restoredDashboardState(state, 0),
		});
	});

	it("moves the selected Project Goal with the same keys as a Session Task", () => {
		const roadmap: ProjectGoal[] = ["g1", "g2", "g3"].map((id) => ({
			...goals[0],
			id,
			title: `Goal ${id}`,
			status: "open",
		}));
		const state: DashboardState = { scope: "project", selectedId: "g2" };
		expect(dashboardInput("\u001b[1;2A", state, tasks, roadmap)).toEqual({
			action: { kind: "move", scope: "project", id: "g2", beforeId: "g1" },
			state: restoredDashboardState(state, 1),
		});
		// A goal moving down is written as the pair it ends up in, so the goal that
		// ends up first keeps the file position its section is placed by.
		expect(dashboardInput("\u001b[1;2B", state, tasks, roadmap)).toEqual({
			action: { kind: "move", scope: "project", id: "g3", beforeId: "g2" },
			state: restoredDashboardState(state, 1),
		});

		// The ends of the list have no neighbour to anchor against, so nothing moves.
		const first: DashboardState = { scope: "project", selectedId: "g1" };
		expect(dashboardInput("\u001b[1;2A", first, tasks, roadmap)).toBeUndefined();
	});

	it("targets actions and moves to the rendered grouped Project Goal order", () => {
		const roadmap: ProjectGoal[] = [
			{ ...goals[0], id: "alpha-one", title: "Alpha one", group: "Alpha", status: "open" },
			{ ...goals[0], id: "beta-one", title: "Beta one", group: "Beta", status: "open" },
			{ ...goals[0], id: "alpha-two", title: "Alpha two", group: "Alpha", status: "open" },
		];
		const state: DashboardState = { scope: "project", selectedId: "alpha-two" };

		expect(dashboardInput("\r", state, tasks, roadmap)).toEqual({
			action: { kind: "view", scope: "project", id: "alpha-two" },
			state: restoredDashboardState(state, 2, ["Alpha"], "Alpha"),
		});
		expect(dashboardInput("\u001b[1;2A", state, tasks, roadmap)).toEqual({
			action: { kind: "move", scope: "project", id: "alpha-two", beforeId: "alpha-one" },
			state: restoredDashboardState(state, 2, ["Alpha"], "Alpha"),
		});

		const dashboard = new Dashboard(
			tasks,
			roadmap,
			identityTheme,
			() => {},
			state,
			() => Date.parse("2026-01-06T00:00:00.000Z"),
		);
		const output = dashboard.render(100).join("\n");
		expect(output).toContain("  ○ Alpha one alpha-one");
		expect(output).toContain(">   ○ Alpha two alpha-two");
		expect(output.indexOf("Alpha two")).toBeLessThan(output.indexOf("Beta"));
	});

	it("says how many of the counted Project Goals the pane lists", () => {
		const render = (roadmap: ProjectGoal[]) =>
			new Dashboard(
				tasks,
				roadmap,
				identityTheme,
				() => {},
				{ scope: "project" },
				() => Date.parse("2026-01-06T00:00:00.000Z"),
			)
				.render(100)
				.join("\n");
		const live: ProjectGoal = { ...goals[0], id: "live-one", title: "Live one", status: "open" };
		const archived: ProjectGoal = { ...goals[0], id: "gone-one", title: "Gone one", status: "archived" };

		const withArchived = render([live, archived]);
		expect(withArchived).toContain("Goals: ○ 1 · ◌ 1 · 1 of 2 match");
		expect(withArchived).not.toContain("Gone one");

		// Every counted goal is on screen, so there is nothing to reconcile.
		const listedOnly = render([live]);
		expect(listedOnly).toContain("Goals: ○ 1");
		expect(listedOnly).not.toContain("match");
	});

	it("stops grouped Project Goal moves at section boundaries", () => {
		const roadmap: ProjectGoal[] = [
			{ ...goals[0], id: "alpha-one", title: "Alpha one", group: "Alpha", status: "open" },
			{ ...goals[0], id: "beta-one", title: "Beta one", group: "Beta", status: "open" },
			{ ...goals[0], id: "alpha-two", title: "Alpha two", group: "Alpha", status: "open" },
			{ ...goals[0], id: "loose-one", title: "Loose one", status: "open" },
		];

		expect(
			dashboardInput("\u001b[1;2B", { scope: "project", selectedId: "alpha-two" }, tasks, roadmap),
		).toBeUndefined();
		expect(
			dashboardInput("\u001b[1;2A", { scope: "project", selectedId: "beta-one" }, tasks, roadmap),
		).toBeUndefined();
		expect(
			dashboardInput("\u001b[1;2A", { scope: "project", selectedId: "loose-one" }, tasks, roadmap),
		).toBeUndefined();
	});

	it("keeps section order when a grouped Project Goal steps down its own section", async () => {
		const path = join(await mkdtemp(join(tmpdir(), "stepstone-dashboard-")), ".worklist", "worklist.json");
		await addProjectGoal(path, "Alpha one", { group: "Alpha" });
		await addProjectGoal(path, "Beta one", { group: "Beta" });
		await addProjectGoal(path, "Alpha two", { group: "Alpha" });
		const { goals: roadmap } = await readProjectGoals(path);

		const result = dashboardInput(
			"\u001b[1;2B",
			{ scope: "project", selectedId: "alpha-one" },
			tasks,
			roadmap,
		);
		const action = result?.action as Extract<DashboardAction, { kind: "move" }> | undefined;
		expect(action).toEqual({ kind: "move", scope: "project", id: "alpha-two", beforeId: "alpha-one" });
		expect(result?.state.selectedId).toBe("alpha-one");
		if (action?.beforeId === undefined) throw new Error("expected a before-anchored move");

		const moved = await moveProjectGoal(path, action.id, { beforeId: action.beforeId });
		expect(moved.goals.map((goal) => goal.id)).toEqual(["alpha-two", "alpha-one", "beta-one"]);

		// The generated page is where a crossed section order would be committed, so
		// the move is checked against its headings rather than the file order alone.
		const { data } = await readProjectWorklist(path);
		const headings = renderRoadmapMarkdown(data)
			.split("\n")
			.filter((line) => line.startsWith("## "));
		expect(headings).toEqual(["## Alpha", "## Beta"]);
	});

	it("returns no entry carrying a newline from stored goal and group text", () => {
		const multiline: ProjectGoal = {
			...goals[0],
			id: "multi",
			title: "Two\nlines",
			group: "Pi\nSurfaces",
			status: "active",
			description: "Line one\nline two",
		};

		const widget = buildWidgetLines([], [multiline]);
		expect(widget.every((line) => !line.includes("\n"))).toBe(true);
		expect(widget[0]).toBe("◆ Active: Two lines");

		const dashboard = new Dashboard(
			[],
			[multiline],
			identityTheme,
			() => {},
			{ scope: "project", selectedId: "multi" },
			() => Date.parse("2026-01-06T00:00:00.000Z"),
		);
		const output = dashboard.render(100);
		expect(output.every((line) => !line.includes("\n"))).toBe(true);
		expect(output.join("\n")).toContain("▾ Pi Surfaces");
		expect(output.join("\n")).toContain("◆ Two lines multi");
		expect(output.join("\n")).toContain("Description: Line one line two");
	});

	it("inserts before the selected Session Task and appends separately", () => {
		const state: DashboardState = { scope: "session", selectedId: "t3" };
		expect(dashboardInput("i", state)).toEqual({
			action: { kind: "insert", scope: "session", beforeId: "t3" },
			state: restoredDashboardState(state, 2),
		});
		expect(dashboardInput("a", state)).toEqual({
			action: { kind: "add", scope: "session" },
			state: restoredDashboardState(state, 2),
		});
	});

	it("moves the selected Session Task and preserves its selection", () => {
		const state: DashboardState = { scope: "session", selectedId: "t3" };
		expect(dashboardInput("\u001b[1;2A", state)).toEqual({
			action: { kind: "move", scope: "session", id: "t3", beforeId: "t2" },
			state: restoredDashboardState(state, 2),
		});
		expect(dashboardInput("\u001b[1;2B", state)).toEqual({
			action: { kind: "move", scope: "session", id: "t3", afterId: "t4" },
			state: restoredDashboardState(state, 2),
		});

		const reordered = [...tasks.slice(0, 2), tasks[3], tasks[2], ...tasks.slice(4)];
		expect(dashboardInput("a", state, reordered)).toEqual({
			action: { kind: "add", scope: "session" },
			state: restoredDashboardState(state, 1),
		});
	});

	it("does not expose insertion or movement in Project Goal scope", () => {
		const state: DashboardState = { scope: "project", selectedId: "g1" };
		expect(dashboardInput("i", state)).toBeUndefined();
		expect(dashboardInput("\u001b[1;2A", state)).toBeUndefined();
		expect(dashboardInput("a", state)).toEqual({
			action: { kind: "add", scope: "project" },
			state: restoredDashboardState(state, 0),
		});
	});
});

describe("dashboard navigation and project rendering", () => {
	const roadmap: ProjectGoal[] = [
		{
			...goals[0],
			id: "active",
			title: "Active goal",
			group: "Foundation",
			status: "active",
		},
		{
			...goals[0],
			id: "done",
			title: "Done goal",
			group: "Foundation",
			status: "done",
		},
		{
			...goals[0],
			id: "waiting",
			title: "Waiting goal",
			status: "open",
			updatedAt: "2025-12-01T00:00:00.000Z",
		},
		{
			...goals[0],
			id: "archived",
			title: "Archived goal",
			group: "Retired",
			status: "archived",
		},
	];

	it("opens grouped Project Goals collapsed and expands the selected section", () => {
		const dashboard = new Dashboard(
			[],
			roadmap,
			identityTheme,
			() => {},
			{ scope: "project" },
			() => Date.parse("2026-01-06T00:00:00.000Z"),
		);
		const collapsed = dashboard.render(100).join("\n");

		expect(collapsed).toContain("Filter: Open (f to change)");
		expect(collapsed).toContain("Goals: ◆ 1 · ○ 1 · ✓ 1 · ◌ 1 · 2 of 4 match");
		expect(collapsed).toContain("> ▸ Foundation (1)");
		expect(collapsed).toContain("  ▸ Ungrouped (1)");
		expect(collapsed).not.toContain("Active goal active");

		dashboard.handleInput(" ");
		const expanded = dashboard.render(100).join("\n");
		expect(expanded).toContain("> ▾ Foundation (1)");
		expect(expanded).toContain("    ◆ Active goal active");
		expect(expanded).not.toContain("Waiting goal waiting");

		dashboard.handleInput("\u001b[B");
		dashboard.handleInput("\u001b[B");
		dashboard.handleInput(" ");
		expect(dashboard.render(100).join("\n")).toMatch(/○ Waiting goal \d+d waiting/);

		dashboard.handleInput("\u001b[A");
		dashboard.handleInput("\u001b[A");
		dashboard.handleInput(" ");
		expect(dashboard.render(100).join("\n")).not.toContain("Active goal active");
	});

	it("cycles open, done, archived, and all Project Goal filters and preserves view state", () => {
		let result: DashboardResult | undefined;
		const dashboard = new Dashboard(
			[],
			roadmap,
			identityTheme,
			(value) => {
				result = value;
			},
			{ scope: "project" },
		);
		dashboard.handleInput(" ");
		dashboard.handleInput("f");
		const done = dashboard.render(100).join("\n");
		expect(done).toContain("Filter: Done (f to change)");
		expect(done).toContain("▾ Foundation (1)");
		expect(done).toContain("✓ Done goal done");
		expect(done).not.toContain("Active goal active");

		dashboard.handleInput("a");
		expect(result?.state).toMatchObject({
			scope: "project",
			projectFilter: "done",
			expandedGroups: ["Foundation"],
		});
		const restored = new Dashboard([], roadmap, identityTheme, () => {}, result?.state);
		expect(restored.render(100).join("\n")).toContain("✓ Done goal done");

		dashboard.handleInput("f");
		expect(dashboard.render(100).join("\n")).toContain("Filter: Archived (f to change)");
		dashboard.handleInput("f");
		expect(dashboard.render(100).join("\n")).toContain("Filter: All (f to change)");
		dashboard.handleInput("f");
		expect(dashboard.render(100).join("\n")).toContain("Filter: Open (f to change)");
	});

	it("reveals children when a section at the viewport bottom expands", () => {
		const grouped = Array.from(
			{ length: 5 },
			(_, index): ProjectGoal => ({
				...goals[0],
				id: `group-goal-${index}`,
				title: `Grouped goal ${index}`,
				group: `Group ${index}`,
				status: "open",
			}),
		);
		const dashboard = new Dashboard(
			[],
			grouped,
			identityTheme,
			() => {},
			{ scope: "project" },
			Date.now,
			() => 12,
		);
		dashboard.render(72);
		dashboard.handleInput("\u001b[B");
		dashboard.handleInput("\u001b[B");
		dashboard.render(72);
		dashboard.handleInput(" ");
		const expanded = dashboard.render(72).join("\n");

		expect(expanded).toContain("> ▾ Group 2 (1)");
		expect(expanded).toContain("Grouped goal 2");
		// The child had nowhere to land inside the old viewport, so the header leads it.
		expect(expanded).toContain("2 above · 1 below");
		expect(expanded).not.toContain("Group 0");
	});

	it("keeps the viewport where it was when an expanded section already fits", () => {
		const grouped = Array.from(
			{ length: 5 },
			(_, index): ProjectGoal => ({
				...goals[0],
				id: `group-goal-${index}`,
				title: `Grouped goal ${index}`,
				group: `Group ${index}`,
				status: "open",
			}),
		);
		const dashboard = new Dashboard(
			[],
			grouped,
			identityTheme,
			() => {},
			{ scope: "project" },
			Date.now,
			() => 12,
		);
		dashboard.render(72);
		dashboard.handleInput("\u001b[B");
		dashboard.render(72);
		dashboard.handleInput(" ");
		const expanded = dashboard.render(72).join("\n");

		// The one child lands on a row the viewport already showed, so nothing above
		// the opened section has to scroll away to reveal it.
		expect(expanded).toContain("> ▾ Group 1 (1)");
		expect(expanded).toContain("Grouped goal 1");
		expect(expanded).toContain("▸ Group 0 (1)");
		expect(expanded).toContain("0 above · 3 below");
	});

	it("never stacks a blank spacer on the reserved description row", () => {
		const blankRuns = (lines: string[]) =>
			lines.filter((line, index) => line === "" && lines[index + 1] === "").length;

		const grouped: ProjectGoal[] = Array.from(
			{ length: 9 },
			(_, index): ProjectGoal => ({
				...goals[0],
				id: `stack-${index}`,
				title: `Stacked goal ${index}`,
				group: ["Alpha", "Beta", "Gamma"][index % 3],
				status: "open",
				description: "Every goal on this roadmap is described",
			}),
		);
		// A grouped roadmap opens collapsed, so the cursor is on a header and the
		// reserved row can only render blank: it must not sit under a second blank.
		const collapsed = new Dashboard(
			[],
			grouped,
			identityTheme,
			() => {},
			{ scope: "project" },
			Date.now,
			() => 24,
		).render(90);
		expect(collapsed.filter((line) => line.includes("Stacked goal "))).toHaveLength(0);
		expect(blankRuns(collapsed)).toBe(0);

		const ungrouped: ProjectGoal[] = Array.from(
			{ length: 5 },
			(_, index): ProjectGoal => ({
				...goals[0],
				id: `single-${index}`,
				title: `Single goal ${index}`,
				status: "open",
				description: index === 0 ? "Only the first goal is described" : undefined,
			}),
		);
		const dashboard = new Dashboard(
			[],
			ungrouped,
			identityTheme,
			() => {},
			{ scope: "project" },
			Date.now,
			() => 24,
		);
		expect(blankRuns(dashboard.render(80))).toBe(0);
		dashboard.handleInput("\u001b[B");
		const onUndescribed = dashboard.render(80);
		expect(onUndescribed.join("\n")).not.toContain("Description:");
		expect(blankRuns(onUndescribed)).toBe(0);
	});

	it("keeps the count and the key hints whole when rows are scarce", () => {
		const many: SessionTask[] = Array.from({ length: 20 }, (_, index) => ({
			id: `scarce-${index}`,
			title: `Scarce task ${index}`,
			status: "todo",
		}));
		const scarce = new Dashboard(
			many,
			[],
			identityTheme,
			() => {},
			{ scope: "session" },
			Date.now,
			() => 10,
		).render(80);
		// The count gets its row before the key map grows, so the map's first row
		// still reads as whole hints instead of being cut through one.
		expect(scarce).toContain("0 above · 17 below");
		expect(scarce.some((line) => line.includes("enter view"))).toBe(true);
		expect(scarce.some((line) => line.endsWith("..."))).toBe(false);

		const grouped: ProjectGoal[] = Array.from(
			{ length: 5 },
			(_, index): ProjectGoal => ({
				...goals[0],
				id: `tight-goal-${index}`,
				title: `Tight goal ${index}`,
				group: `Tight ${index}`,
				status: "open",
			}),
		);
		const dashboard = new Dashboard(
			[],
			grouped,
			identityTheme,
			() => {},
			{ scope: "project" },
			Date.now,
			() => 12,
		);
		dashboard.render(72);
		dashboard.handleInput("\u001b[B");
		dashboard.handleInput("\u001b[B");
		dashboard.render(72);
		dashboard.handleInput(" ");
		const shared = dashboard.render(72);

		// Nothing was left to give the count a row here, so it shares the map's
		// first row - which is re-packed to whole hints rather than truncated.
		const sharedRow = shared.find((line) => line.includes("above ·"));
		expect(sharedRow).toBeDefined();
		expect(sharedRow?.startsWith("2 above · 1 below  tab switch")).toBe(true);
		expect(sharedRow?.endsWith("...")).toBe(false);
		expect(sharedRow?.endsWith("navigate")).toBe(true);
	});

	it("spends no row on a count when every row of the list is on screen", () => {
		const render = (count: number) =>
			new Dashboard(
				Array.from({ length: count }, (_, index) => ({
					id: `fits-${index}`,
					title: `Fits task ${index}`,
					status: "todo" as const,
				})),
				[],
				identityTheme,
				() => {},
				{ scope: "session" },
				Date.now,
				() => 24,
			).render(80);

		const shortList = render(10);
		expect(shortList.filter((line) => line.includes("Fits task "))).toHaveLength(10);
		expect(shortList.some((line) => line.includes("above ·"))).toBe(false);
		// A row reserved for a count that can never be written is a blank row, and
		// two blanks in a row is the shape that reads as a rendering fault.
		expect(shortList.some((line, index) => line === "" && shortList[index + 1] === "")).toBe(false);

		// At the tipping point the reservation used to create the overflow it then
		// reported: every task still fits, so nothing is hidden and nothing says so.
		const tipping = render(12);
		expect(tipping.filter((line) => line.includes("Fits task "))).toHaveLength(12);
		expect(tipping.some((line) => line.includes("above ·"))).toBe(false);
	});

	it("spends the blank spacers on the key map before the list gives up a row", () => {
		const roadmap: ProjectGoal[] = Array.from(
			{ length: 30 },
			(_, index): ProjectGoal => ({
				...goals[0],
				id: `dense-${String(index).padStart(2, "0")}`,
				title: `Dense goal ${String(index).padStart(2, "0")}`,
				status: "open",
				description: undefined,
			}),
		);
		const lines = new Dashboard(
			[],
			roadmap,
			identityTheme,
			() => {},
			{ scope: "project" },
			Date.now,
			() => 16,
		).render(80);

		expect(lines.length).toBeLessThanOrEqual(12);
		// Nothing the list wants is spent on breathing room, so the rows the wrapped
		// key map needs come out of the spacers first.
		expect(lines.some((line) => line === "")).toBe(false);
		expect(lines.filter((line) => line.includes("Dense goal "))).toHaveLength(4);
		expect(lines).toContain("0 above · 26 below");
		expect(lines.join(" ")).toContain("space advance/toggle section");
		expect(lines.join(" ")).toContain("esc close");
	});

	it("keeps every key hint on screen at an ordinary terminal width", () => {
		const many: SessionTask[] = Array.from({ length: 30 }, (_, index) => ({
			id: `key-${String(index).padStart(2, "0")}`,
			title: `Key task ${String(index).padStart(2, "0")}`,
			status: "todo",
		}));
		const sessionLines = new Dashboard(
			many,
			[],
			identityTheme,
			() => {},
			{ scope: "session" },
			Date.now,
			() => 24,
		).render(80);

		expect(sessionLines.every((line) => visibleWidth(line) <= 80)).toBe(true);
		for (const hint of ["tab switch", "space advance", "shift+↑↓ move", "e edit", "esc close"]) {
			expect(sessionLines.join("\n")).toContain(hint);
		}
		// The count that says the list continues has a row of its own, so it cannot
		// push the first row of the key map off the screen.
		expect(sessionLines.some((line) => /^\d+ above · \d+ below$/.test(line))).toBe(true);
		expect(sessionLines.some((line) => line.includes("above ·") && line.includes("tab switch"))).toBe(false);

		const roadmap: ProjectGoal[] = Array.from(
			{ length: 30 },
			(_, index): ProjectGoal => ({
				...goals[0],
				id: `key-goal-${String(index).padStart(2, "0")}`,
				title: `Key goal ${String(index).padStart(2, "0")}`,
				status: "open",
				description: undefined,
			}),
		);
		const projectLines = new Dashboard(
			[],
			roadmap,
			identityTheme,
			() => {},
			{ scope: "project" },
			Date.now,
			() => 24,
		).render(80);

		expect(projectLines.every((line) => visibleWidth(line) <= 80)).toBe(true);
		// The hint this pane exists to teach: Space means one thing on a goal and
		// another on a section header, and both readings have to reach the screen.
		expect(projectLines.join("\n")).toContain("space advance/toggle section");
		expect(projectLines.join("\n")).toContain("esc close");
		expect(projectLines.some((line) => /^\d+ above · \d+ below$/.test(line))).toBe(true);
	});

	it("stays inside a short terminal however narrow the key map has to wrap", () => {
		const many: SessionTask[] = Array.from({ length: 30 }, (_, index) => ({
			id: `tight-${String(index).padStart(2, "0")}`,
			title: `Tight task ${String(index).padStart(2, "0")}`,
			status: "todo",
		}));
		for (const [terminalRows, width] of [
			[24, 30],
			[10, 30],
			[6, 40],
			[4, 24],
		] as const) {
			const lines = new Dashboard(
				many,
				[],
				identityTheme,
				() => {},
				{ scope: "session" },
				Date.now,
				() => terminalRows,
			).render(width);
			expect(lines.length).toBeLessThanOrEqual(Math.max(1, Math.floor(terminalRows * 0.8)));
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
			expect(lines.some((line) => line.includes("Tight task "))).toBe(true);
		}
	});

	it("spends no row on descriptions when the listed goals have none", () => {
		const build = (described: boolean): ProjectGoal[] =>
			Array.from(
				{ length: 12 },
				(_, index): ProjectGoal => ({
					...goals[0],
					id: `plain-${String(index).padStart(2, "0")}`,
					title: `Plain goal ${String(index).padStart(2, "0")}`,
					status: "open",
					description: described && index === 0 ? "The only description on this roadmap" : undefined,
				}),
			);
		const render = (roadmap: ProjectGoal[]) =>
			new Dashboard(
				[],
				roadmap,
				identityTheme,
				() => {},
				{ scope: "project" },
				Date.now,
				() => 20,
			).render(72);

		const withDescriptions = render(build(true)).join("\n");
		expect(withDescriptions).toContain("Description: The only description on this roadmap");
		expect(withDescriptions).toContain("0 above · 5 below");

		// Nothing to describe, so the row goes back to the list rather than sitting
		// blank above the key map for the life of the roadmap.
		const withoutDescriptions = render(build(false)).join("\n");
		expect(withoutDescriptions).not.toContain("Description:");
		expect(withoutDescriptions).toContain("0 above · 4 below");
	});

	it("keeps the Project Goal list the same height across described and plain goals", () => {
		const roadmap: ProjectGoal[] = Array.from(
			{ length: 12 },
			(_, index): ProjectGoal => ({
				...goals[0],
				id: `goal-${String(index).padStart(2, "0")}`,
				title: `Goal ${String(index).padStart(2, "0")}`,
				status: "open",
				description: index === 0 ? "Only this goal carries a description" : undefined,
			}),
		);
		const dashboard = new Dashboard(
			[],
			roadmap,
			identityTheme,
			() => {},
			{ scope: "project" },
			Date.now,
			() => 20,
		);
		const described = dashboard.render(72);
		expect(described.join("\n")).toContain("Description: Only this goal carries a description");
		expect(described.join("\n")).toContain("0 above · 5 below");
		expect(described.join("\n")).toContain("Goal 06");
		expect(described.join("\n")).not.toContain("Goal 07");

		// Moving onto a goal with nothing to describe must not hand the list the row
		// the description gave up, or the rows below the cursor shift under it.
		dashboard.handleInput("\u001b[B");
		const plain = dashboard.render(72);
		expect(plain).toHaveLength(described.length);
		expect(plain.join("\n")).not.toContain("Description:");
		expect(plain.join("\n")).toContain("0 above · 5 below");
		expect(plain.join("\n")).toContain("Goal 06");
		expect(plain.join("\n")).not.toContain("Goal 07");

		// The reserved row is still the first chrome a short terminal gives up.
		const short = new Dashboard(
			[],
			roadmap,
			identityTheme,
			() => {},
			{ scope: "project" },
			Date.now,
			() => 6,
		).render(72);
		expect(short.length).toBeLessThanOrEqual(6);
		expect(short.join("\n")).not.toContain("Description:");
	});

	it("never renders beyond a short terminal, even with Project Goal details", () => {
		const described: ProjectGoal = {
			...goals[0],
			id: "described",
			title: "Described goal",
			description: "A description that belongs below the selected goal.",
			status: "open",
		};
		const renderAt = (height: number) =>
			new Dashboard(
				[],
				[described],
				identityTheme,
				() => {},
				{ scope: "project", selectedId: described.id },
				Date.now,
				() => height,
			).render(60);

		const tenRows = renderAt(10);
		expect(tenRows.length).toBeLessThanOrEqual(10);
		expect(tenRows.join("\n")).toContain("Description: A description");

		const fiveRows = renderAt(5);
		expect(fiveRows.length).toBeLessThanOrEqual(5);
		expect(fiveRows.join("\n")).toContain("Described goal");
		expect(fiveRows.every((line) => visibleWidth(line) <= 60)).toBe(true);
	});

	it("lands the returned cursor near where an action removed it from the filter", () => {
		const longTasks: SessionTask[] = Array.from({ length: 20 }, (_, index) => ({
			id: `sel-${index}`,
			title: `Selectable task ${index}`,
			status: "todo",
		}));
		let result: DashboardResult | undefined;
		const dashboard = new Dashboard(
			longTasks,
			[],
			identityTheme,
			(value) => {
				result = value;
			},
			{ scope: "session", selectedId: "sel-15" },
		);
		dashboard.handleInput(" ");
		expect(result?.action).toEqual({ kind: "advance", scope: "session", id: "sel-15" });

		// Completing Task 15 leaves the Open filter under the same state: the
		// cursor falls onto the row that took its place rather than back to the top.
		const completed = longTasks.map((task) =>
			task.id === "sel-15" ? { ...task, status: "done" as const } : task,
		);
		let viewed: string | undefined;
		const viewer = new Dashboard(
			completed,
			[],
			identityTheme,
			(value) => {
				viewed = value.action.kind === "view" ? value.action.id : undefined;
			},
			result?.state,
		);
		viewer.handleInput("\r");
		expect(viewed).toBe("sel-16");
	});

	it("lands the cursor on the goal that replaced a removed one inside its section", () => {
		const roadmap: ProjectGoal[] = ["Alpha one", "Alpha two", "Alpha three", "Beta one"].map(
			(title, index) => ({
				...goals[0],
				id: `grp-${index}`,
				title,
				description: undefined,
				status: "open" as const,
				group: index === 3 ? "Beta" : "Alpha",
			}),
		);
		const openAt = (state: DashboardState, goalItems: ProjectGoal[]) => {
			let result: DashboardResult | undefined;
			const dashboard = new Dashboard(
				[],
				goalItems,
				identityTheme,
				(value) => {
					result = value;
				},
				state,
			);
			return { dashboard, result: () => result };
		};
		const selected: DashboardState = {
			scope: "project",
			selectedId: "grp-1",
			selectedGroup: "Alpha",
			selectedIndex: 2,
			expandedGroups: ["Alpha"],
		};

		// Deleting the middle goal of an expanded section leaves the cursor on the
		// goal that took its row, not back up on the section header.
		const deleting = openAt(selected, roadmap);
		deleting.dashboard.handleInput("d");
		expect(deleting.result()?.action).toEqual({ kind: "delete", scope: "project", id: "grp-1" });
		const afterDelete = openAt(
			deleting.result()!.state,
			roadmap.filter((goal) => goal.id !== "grp-1"),
		);
		expect(afterDelete.dashboard.render(60).find((line) => line.startsWith(">"))).toContain(
			"Alpha three",
		);
		afterDelete.dashboard.handleInput("\r");
		expect(afterDelete.result()?.action).toEqual({ kind: "view", scope: "project", id: "grp-2" });

		// Completing it out of the Open filter is the same removal.
		const advancing = openAt(selected, roadmap);
		advancing.dashboard.handleInput(" ");
		expect(advancing.result()?.action).toEqual({ kind: "advance", scope: "project", id: "grp-1" });
		const afterAdvance = openAt(
			advancing.result()!.state,
			roadmap.map((goal) => (goal.id === "grp-1" ? { ...goal, status: "done" as const } : goal)),
		);
		afterAdvance.dashboard.handleInput("\r");
		expect(afterAdvance.result()?.action).toEqual({ kind: "view", scope: "project", id: "grp-2" });

		// A cursor that genuinely sat on the header still restores onto the header.
		const onHeader = openAt(
			{ scope: "project", selectedGroup: "Beta", selectedIndex: 4, expandedGroups: ["Alpha"] },
			roadmap,
		);
		expect(onHeader.dashboard.render(60).find((line) => line.startsWith(">"))).toContain(
			"▸ Beta (1)",
		);

		// A goal the cursor is on that is still listed but sits inside a closed
		// section restores onto that section rather than an unrelated row.
		const collapsed = openAt(
			{ scope: "project", selectedId: "grp-1", selectedGroup: "Alpha", selectedIndex: 2, expandedGroups: [] },
			roadmap,
		);
		expect(collapsed.dashboard.render(60).find((line) => line.startsWith(">"))).toContain(
			"▸ Alpha (3)",
		);
	});

	it("filters Session Tasks between open, done, and all", () => {
		const dashboard = new Dashboard(tasks, [], identityTheme, () => {}, { scope: "session" });
		const open = dashboard.render(80).join("\n");
		expect(open).toContain("Filter: Open (f to change)");
		expect(open).not.toContain("Task 0");
		expect(open).toContain("Task 1");

		dashboard.handleInput("f");
		const done = dashboard.render(80).join("\n");
		expect(done).toContain("Filter: Done (f to change)");
		expect(done).toContain("Task 0");
		expect(done).not.toContain("Task 1");

		dashboard.handleInput("f");
		const all = dashboard.render(80).join("\n");
		expect(all).toContain("Filter: All (f to change)");
		expect(all).toContain("Task 0");
		expect(all).toContain("Task 1");
	});

	it("holds the viewport steady when a filter cycle keeps the selected row", () => {
		const mixed: SessionTask[] = [
			...Array.from({ length: 20 }, (_, index) => ({
				id: `open-${index}`,
				title: `Open task ${index}`,
				status: "todo" as const,
			})),
			...Array.from({ length: 5 }, (_, index) => ({
				id: `done-${index}`,
				title: `Done task ${index}`,
				status: "done" as const,
			})),
		];
		let result: DashboardResult | undefined;
		const dashboard = new Dashboard(
			mixed,
			[],
			identityTheme,
			(value) => {
				result = value;
			},
			{ scope: "session", sessionFilter: "all" },
			Date.now,
			() => 12,
		);
		dashboard.handleInput("\u001b[6~");
		dashboard.handleInput("\u001b[B");
		dashboard.render(72);
		dashboard.handleInput("\u001b[A");
		dashboard.handleInput("\u001b[A");
		expect(dashboard.render(72).join("\n")).toContain("7 above · 15 below");

		// Dropping the done tasks leaves the cursor on the row it was already on, so
		// the rows around it stay where they were instead of sliding under it.
		dashboard.handleInput("f");
		const cycled = dashboard.render(72).join("\n");
		expect(cycled).toContain("Filter: Open (f to change)");
		expect(cycled).toContain("7 above · 10 below");
		dashboard.handleInput("\r");
		expect(result?.action).toEqual({ kind: "view", scope: "session", id: "open-7" });
	});

	it("returns from an action to the same viewport the action was taken from", () => {
		const longTasks: SessionTask[] = Array.from({ length: 20 }, (_, index) => ({
			id: `long-${index}`,
			title: `Long task ${index}`,
			status: "todo",
		}));
		let result: DashboardResult | undefined;
		const dashboard = new Dashboard(
			longTasks,
			[],
			identityTheme,
			(value) => {
				result = value;
			},
			{ scope: "session" },
			Date.now,
			() => 12,
		);
		dashboard.handleInput("\u001b[6~");
		dashboard.handleInput("\u001b[B");
		dashboard.render(72);
		dashboard.handleInput("\u001b[A");
		dashboard.handleInput("\u001b[A");
		const before = dashboard.render(72).join("\n");
		expect(before).toContain("Long task 7");
		expect(before).toContain("Long task 9");
		expect(before).not.toContain("Long task 6");

		dashboard.handleInput("\r");
		expect(result?.action).toEqual({ kind: "view", scope: "session", id: "long-7" });

		// Reopening after the detail view must not slide the list under a cursor
		// that never moved: the restored viewport is the one that was acted from.
		const after = new Dashboard(
			longTasks,
			[],
			identityTheme,
			() => {},
			result?.state,
			Date.now,
			() => 12,
		)
			.render(72)
			.join("\n");
		expect(after).toBe(before);
	});

	it("pages one item at a time when the terminal fits a single list row", () => {
		const paged: SessionTask[] = Array.from({ length: 20 }, (_, index) => ({
			id: `one-${String(index).padStart(2, "0")}`,
			title: `Single task ${String(index).padStart(2, "0")}`,
			status: "todo",
		}));
		let result: DashboardResult | undefined;
		const dashboard = new Dashboard(
			paged,
			[],
			identityTheme,
			(value) => {
				result = value;
			},
			{ scope: "session" },
			Date.now,
			() => 4,
		);
		const first = dashboard.render(72);
		expect(first.join("\n")).toContain("0 above · 19 below");
		expect(first.filter((line) => line.includes("Single task "))).toHaveLength(1);

		// One row is the whole screenful, so a page is one item: nothing may be
		// stepped over that the viewport never drew.
		dashboard.handleInput("\u001b[6~");
		expect(dashboard.render(72).join("\n")).toContain("Single task 01");
		dashboard.handleInput("\u001b[6~");
		expect(dashboard.render(72).join("\n")).toContain("Single task 02");
		dashboard.handleInput("\u001b[5~");
		expect(dashboard.render(72).join("\n")).toContain("Single task 01");
		dashboard.handleInput("\r");
		expect(result?.action).toEqual({ kind: "view", scope: "session", id: "one-01" });
	});

	it("pages by the rows the terminal is showing, not a fixed step", () => {
		const paged: SessionTask[] = Array.from({ length: 40 }, (_, index) => ({
			id: `page-${String(index).padStart(2, "0")}`,
			title: `Paged task ${String(index).padStart(2, "0")}`,
			status: "todo",
		}));
		let shortResult: DashboardResult | undefined;
		const shortTerminal = new Dashboard(
			paged,
			[],
			identityTheme,
			(value) => {
				shortResult = value;
			},
			{ scope: "session" },
			Date.now,
			() => 12,
		);
		const shortFirst = shortTerminal.render(72);
		expect(shortFirst.join("\n")).toContain("0 above · 37 below");

		shortTerminal.handleInput("\u001b[6~");
		const shortPaged = shortTerminal.render(72).join("\n");
		expect(shortPaged).toContain("Paged task 02");
		expect(shortPaged).not.toContain("Paged task 03");

		// A second page must not leap over rows the first page never drew.
		shortTerminal.handleInput("\u001b[6~");
		const shortSecond = shortTerminal.render(72).join("\n");
		expect(shortSecond).toContain("Paged task 03");
		expect(shortSecond).toContain("Paged task 04");
		shortTerminal.handleInput("\r");
		expect(shortResult?.action).toEqual({ kind: "view", scope: "session", id: "page-04" });

		shortTerminal.handleInput("\u001b[5~");
		shortTerminal.render(72);
		shortTerminal.handleInput("\r");
		expect(shortResult?.action).toEqual({ kind: "view", scope: "session", id: "page-02" });

		let tallResult: DashboardResult | undefined;
		const tallTerminal = new Dashboard(
			paged,
			[],
			identityTheme,
			(value) => {
				tallResult = value;
			},
			{ scope: "session" },
			Date.now,
			() => 40,
		);
		const drawn = tallTerminal.render(72).filter((line) => line.includes("Paged task ")).length;
		// A taller terminal has to page further, or the keys stop paging at all.
		expect(drawn).toBeGreaterThan(9);
		tallTerminal.handleInput("\u001b[6~");
		tallTerminal.handleInput("\r");
		expect(tallResult?.action).toEqual({
			kind: "view",
			scope: "session",
			id: `page-${String(drawn - 1).padStart(2, "0")}`,
		});
	});

	it("keeps the selected row on its screen line when a filter drops rows above it", () => {
		const mixed: SessionTask[] = Array.from({ length: 25 }, (_, index) => ({
			id: `mix-${String(index).padStart(2, "0")}`,
			title: `Mixed task ${String(index).padStart(2, "0")}`,
			status: index < 5 ? "done" : "todo",
		}));
		const dashboard = new Dashboard(
			mixed,
			[],
			identityTheme,
			() => {},
			{ scope: "session", sessionFilter: "all", selectedId: "mix-10", listScroll: 8 },
			Date.now,
			() => 12,
		);
		const before = dashboard.render(72);
		expect(before.join("\n")).toContain("8 above · 14 below");
		expect(before.find((line) => line.startsWith(">"))).toContain("mix-10");
		expect(before.filter((line) => line.includes("Mixed task ")).at(-1)).toContain("mix-10");

		// Dropping the five done tasks moves the row five places up the list, but not
		// one place across the screen: it is still the bottom row of the viewport.
		dashboard.handleInput("f");
		const cycled = dashboard.render(72);
		expect(cycled.join("\n")).toContain("Filter: Open (f to change)");
		expect(cycled.join("\n")).toContain("3 above · 14 below");
		expect(cycled.find((line) => line.startsWith(">"))).toContain("mix-10");
		expect(cycled.filter((line) => line.includes("Mixed task ")).at(-1)).toContain("mix-10");
	});

	it("keeps a long list within the terminal viewport and scrolls the selection", () => {
		const longTasks: SessionTask[] = Array.from({ length: 20 }, (_, index) => ({
			id: `long-${index}`,
			title: `Long task ${index}`,
			status: "todo",
		}));
		let result: DashboardResult | undefined;
		const dashboard = new Dashboard(
			longTasks,
			[],
			identityTheme,
			(value) => {
				result = value;
			},
			{ scope: "session" },
			Date.now,
			() => 12,
		);
		const first = dashboard.render(72);
		expect(first).toHaveLength(9);
		expect(first.join("\n")).toContain("0 above · 17 below");
		expect(first.join("\n")).toContain("Long task 0");

		dashboard.handleInput("\u001b[6~");
		dashboard.handleInput("\u001b[B");
		const scrolled = dashboard.render(72);
		expect(scrolled).toHaveLength(9);
		expect(scrolled.join("\n")).toContain("above");
		expect(scrolled.join("\n")).toContain("Long task 3");
		expect(scrolled.join("\n")).not.toContain("Long task 0");
		expect(scrolled.every((line) => visibleWidth(line) <= 72)).toBe(true);

		dashboard.handleInput("\r");
		expect(result?.action).toEqual({ kind: "view", scope: "session", id: "long-3" });

		const tiny = new Dashboard(
			longTasks,
			[],
			identityTheme,
			() => {},
			{ scope: "session" },
			Date.now,
			() => 4,
		).render(72);
		expect(tiny.length).toBeLessThanOrEqual(4);
		expect(tiny.join("\n")).toContain("0 above · 19 below");
	});
});

describe("dashboard detail view", () => {
	const theme = identityTheme;

	it("wraps and displays the complete Project Goal description", () => {
		const goal = {
			...goals[0],
			description:
				"A complete description that should wrap across several terminal lines without being truncated or hidden.\n\nSecond paragraph remains separate.",
		};
		const detail = new DashboardDetail({
			item: { scope: "project", goal },
			goals: [goal],
			theme,
			terminalRows: () => 40,
			done: () => {},
		});
		const lines = detail.render(42);
		const output = lines.join("\n");

		expect(output).toContain("Project Goal Details");
		expect(output).toContain("A complete description that should");
		expect(output).toContain("wrap across several terminal lines");
		expect(output).toContain("Second paragraph remains separate.");
		expect(output).toContain(goal.id);
		expect(lines.every((line) => visibleWidth(line) <= 42)).toBe(true);
	});

	it("shows the associated Project Goal details for a Session Task", () => {
		const task = { ...tasks[1], goalId: goals[0].id };
		const detail = new DashboardDetail({
			item: { scope: "session", task, goal: goals[0] },
			goals,
			theme,
			terminalRows: () => 40,
			done: () => {},
		});
		const output = detail.render(60).join("\n");

		expect(output).toContain("Session Task Details");
		expect(output).toContain("Associated Project Goal");
		expect(output).toContain(goals[0].description);
	});

	it("surfaces Project Goal grouping, dependencies, completion time, and links", () => {
		const dependency: ProjectGoal = {
			...goals[0],
			id: "dependency",
			title: "Dependency",
			status: "done",
			completedAt: "2026-01-03T12:00:00.000Z",
		};
		const goal: ProjectGoal = {
			...goals[0],
			id: "delivery",
			title: "Delivery",
			status: "done",
			group: "Delivery",
			completedAt: "2026-01-04T09:30:00.000Z",
			dependsOn: [dependency.id],
			links: ["https://example.com/evidence"],
		};
		const dependent: ProjectGoal = {
			...goals[0],
			id: "dependent",
			title: "Dependent",
			status: "open",
			dependsOn: [goal.id],
		};
		const detail = new DashboardDetail({
			item: { scope: "project", goal },
			goals: [dependency, goal, dependent],
			theme,
			terminalRows: () => 40,
			done: () => {},
		});
		const output = detail.render(72).join("\n");

		expect(output).toContain("Group");
		expect(output).toContain("Delivery");
		expect(output).toContain("Completed");
		expect(output).toContain("2026-01-04");
		expect(output).toContain("Depends on");
		expect(output).toContain("✓ dependency (satisfied)");
		expect(output).toContain("Blocks");
		expect(output).toContain("○ dependent");
		expect(output).toContain("https://example.com/evidence");
	});

	it("scrolls long details and closes with Escape", () => {
		let closed = false;
		const goal = { ...goals[0], description: "line ".repeat(200) };
		const detail = new DashboardDetail({
			item: { scope: "project", goal },
			goals: [goal],
			theme,
			terminalRows: () => 12,
			done: () => {
				closed = true;
			},
		});
		const before = detail.render(42).join("\n");
		detail.handleInput("\u001b[B");
		const after = detail.render(42).join("\n");
		detail.handleInput("\u001b");

		expect(before).not.toBe(after);
		expect(after).toContain("above");
		expect(closed).toBe(true);
	});
});

describe("command parser", () => {
	it("keeps multi-word titles", () => {
		expect(parseTasksCommand("session add write regression tests")).toMatchObject({
			scope: "session",
			action: "add",
			title: "write regression tests",
		});
	});

	it("parses relative insertion and movement", () => {
		expect(parseTasksCommand("session add --before task-1 write regression tests")).toEqual({
			scope: "session",
			action: "add",
			beforeId: "task-1",
			title: "write regression tests",
		});
		expect(parseTasksCommand("session add --after task-1 verify the fix")).toEqual({
			scope: "session",
			action: "add",
			afterId: "task-1",
			title: "verify the fix",
		});
		expect(parseTasksCommand("session move task-2 --before task-1")).toEqual({
			scope: "session",
			action: "move",
			id: "task-2",
			beforeId: "task-1",
		});
		expect(parseTasksCommand("session move task-2 --after task-1")).toEqual({
			scope: "session",
			action: "move",
			id: "task-2",
			afterId: "task-1",
		});
	});

	it("accepts a trailing anchor flag", () => {
		expect(parseTasksCommand("session add write regression tests --before task-1")).toEqual({
			scope: "session",
			action: "add",
			beforeId: "task-1",
			title: "write regression tests",
		});
		expect(parseTasksCommand("session add verify the fix --after task-1")).toEqual({
			scope: "session",
			action: "add",
			afterId: "task-1",
			title: "verify the fix",
		});
		expect(parseTasksCommand("project add another goal --after goal-1")).toEqual({
			scope: "project",
			action: "add",
			afterId: "goal-1",
			title: "another goal",
		});
	});

	it("rejects malformed or unsupported placement syntax", () => {
		expect(parseTasksCommand("session add --before task-1 --after task-2 title")).toBeNull();
		expect(parseTasksCommand("session add title --before task-1 --after task-2")).toBeNull();
		expect(parseTasksCommand("session add --before")).toBeNull();
		expect(parseTasksCommand("session add write tests --before")).toBeNull();
		expect(parseTasksCommand("session add write --before task-1 more tests")).toBeNull();
		expect(parseTasksCommand("session move task-1")).toBeNull();
		expect(parseTasksCommand("session move task-1 --before task-2 extra")).toBeNull();
		expect(parseTasksCommand("session list --before task-1")).toBeNull();
		expect(parseTasksCommand("session update task-1 --after task-2")).toBeNull();
		expect(parseTasksCommand("project delete goal-1 --before goal-2")).toBeNull();
	});

	it("passes Project Goal ordering syntax to runtime rejection", () => {
		expect(parseTasksCommand("project move goal-1 --before goal-2")).toEqual({
			scope: "project",
			action: "move",
			id: "goal-1",
			beforeId: "goal-2",
		});
		expect(parseTasksCommand("project add --after goal-1 another goal")).toEqual({
			scope: "project",
			action: "add",
			afterId: "goal-1",
			title: "another goal",
		});
	});

	it("rejects descriptions for session tasks", () => {
		expect(parseTasksCommand("session add write regression tests -- Cover RPC and TUI usage")).toBeNull();
		expect(parseTasksCommand("session update task-1 -- Replacement context")).toBeNull();
	});

	it("parses optional project goal descriptions", () => {
		expect(parseTasksCommand("project add ship stable release -- Cover RPC and TUI usage")).toEqual({
			scope: "project",
			action: "add",
			title: "ship stable release",
			description: "Cover RPC and TUI usage",
		});
		expect(parseTasksCommand("project update goal-1 -- Replacement context")).toEqual({
			scope: "project",
			action: "update",
			id: "goal-1",
			description: "Replacement context",
		});
	});

	it("treats typed project lifecycle commands as explicit intent", () => {
		expect(parseTasksCommand("project complete goal-1")).toEqual({
			scope: "project",
			action: "complete",
			id: "goal-1",
			confirm: true,
		});
	});

	it("rejects unknown syntax", () => {
		expect(parseTasksCommand("global add nope")).toBeNull();
	});
});

describe("model guidance", () => {
	it("directs agents to split broad work into small session chunks", () => {
		const guidance = WORKLIST_PROMPT_GUIDELINES.join("\n");
		expect(guidance).toContain("several small, concrete, independently completable Session Tasks");
		expect(guidance).toContain("Do not create one Session Task");
		expect(guidance).toContain("Session Tasks do not have descriptions");
		expect(guidance).toContain("Broad outcomes belong in Project Goals");
	});
});
