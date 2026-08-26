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

describe("dashboard ordering controls", () => {
	it("opens details with Enter and reserves Space for status changes", () => {
		const state: DashboardState = { scope: "project", selectedId: "g1" };
		expect(dashboardInput("\r", state)).toEqual({
			action: { kind: "view", scope: "project", id: "g1" },
			state,
		});
		expect(dashboardInput(" ", state)).toEqual({
			action: { kind: "advance", scope: "project", id: "g1" },
			state,
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
			state,
		});
		// A goal moving down is written as the pair it ends up in, so the goal that
		// ends up first keeps the file position its section is placed by.
		expect(dashboardInput("\u001b[1;2B", state, tasks, roadmap)).toEqual({
			action: { kind: "move", scope: "project", id: "g3", beforeId: "g2" },
			state,
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
			state,
		});
		expect(dashboardInput("\u001b[1;2A", state, tasks, roadmap)).toEqual({
			action: { kind: "move", scope: "project", id: "alpha-two", beforeId: "alpha-one" },
			state,
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
		expect(output.indexOf("Alpha two")).toBeLessThan(output.indexOf("Beta one"));
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
		expect(withArchived).toContain("Goals: ○ 1 · ◌ 1 · 1 of 2 listed");
		expect(withArchived).not.toContain("Gone one");

		// Every counted goal is on screen, so there is nothing to reconcile.
		const listedOnly = render([live]);
		expect(listedOnly).toContain("Goals: ○ 1");
		expect(listedOnly).not.toContain("listed");
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

	it("inserts before the selected Session Task and appends separately", () => {
		const state: DashboardState = { scope: "session", selectedId: "t3" };
		expect(dashboardInput("i", state)).toEqual({
			action: { kind: "insert", scope: "session", beforeId: "t3" },
			state,
		});
		expect(dashboardInput("a", state)).toEqual({
			action: { kind: "add", scope: "session" },
			state,
		});
	});

	it("moves the selected Session Task and preserves its selection", () => {
		const state: DashboardState = { scope: "session", selectedId: "t3" };
		expect(dashboardInput("\u001b[1;2A", state)).toEqual({
			action: { kind: "move", scope: "session", id: "t3", beforeId: "t2" },
			state,
		});
		expect(dashboardInput("\u001b[1;2B", state)).toEqual({
			action: { kind: "move", scope: "session", id: "t3", afterId: "t4" },
			state,
		});

		const reordered = [...tasks.slice(0, 2), tasks[3], tasks[2], ...tasks.slice(4)];
		expect(dashboardInput("a", state, reordered)).toEqual({
			action: { kind: "add", scope: "session" },
			state,
		});
	});

	it("does not expose insertion or movement in Project Goal scope", () => {
		const state: DashboardState = { scope: "project", selectedId: "g1" };
		expect(dashboardInput("i", state)).toBeUndefined();
		expect(dashboardInput("\u001b[1;2A", state)).toBeUndefined();
		expect(dashboardInput("a", state)).toEqual({
			action: { kind: "add", scope: "project" },
			state,
		});
	});
});

describe("dashboard project rendering", () => {
	it("groups Project Goals and mirrors board status cues", () => {
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
		const dashboard = new Dashboard(
			[],
			roadmap,
			identityTheme,
			() => {},
			{ scope: "project" },
			() => Date.parse("2026-01-06T00:00:00.000Z"),
		);
		const output = dashboard.render(100).join("\n");

		expect(output).toContain("Goals: ◆ 1 · ○ 1 · ✓ 1 · ◌ 1");
		expect(output).toContain("▾ Foundation (2)");
		expect(output).toContain("▾ Ungrouped (1)");
		expect(output).toContain(">   ◆ Active goal active");
		expect(output).toContain("✓ Done goal done");
		expect(output).toMatch(/○ Waiting goal \d+d waiting/);
		expect(output).not.toContain("Archived goal archived");
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
