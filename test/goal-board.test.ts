import { describe, expect, it } from "vitest";
import { shadowedWorklistWarning } from "../src/git.ts";
import type { BoardIntent } from "../src/tui/goal-board.ts";
import { GoalBoard } from "../src/tui/goal-board.ts";
import { decodeKeys } from "../src/tui/keys.ts";
import { createPalette } from "../src/tui/style.ts";
import { truncateToWidth, visibleWidth } from "../src/tui/text.ts";
import type { ProjectGoal } from "../src/types.ts";

const ESC = "\u001b";

function goal(overrides: Partial<ProjectGoal> & Pick<ProjectGoal, "id" | "title">): ProjectGoal {
	return {
		status: "open",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-02T00:00:00.000Z",
		...overrides,
	};
}

const GOALS: ProjectGoal[] = [
	goal({
		id: "g-active",
		title: "Replace legacy authentication",
		status: "active",
		description: "Migrate every supported client onto the new token exchange before the old one is retired.",
		createdAt: "2026-01-01T00:00:00.000Z",
	}),
	goal({ id: "g-open-1", title: "Add focus mode", createdAt: "2026-01-02T00:00:00.000Z" }),
	goal({ id: "g-open-2", title: "日本語のタイトルです", createdAt: "2026-01-03T00:00:00.000Z" }),
	goal({ id: "g-done", title: "Ship the CLI", status: "done", createdAt: "2026-01-04T00:00:00.000Z" }),
	goal({ id: "g-archived", title: "Old idea", status: "archived", createdAt: "2026-01-05T00:00:00.000Z" }),
];

/** Fixed clock, a few days after the fixture timestamps, so nothing reads as stale by default. */
const NOW = Date.parse("2026-01-06T00:00:00.000Z");

function createBoard(goals: ProjectGoal[] = GOALS, color = false, now = NOW): GoalBoard {
	return new GoalBoard({
		palette: createPalette(color),
		repositoryLabel: "demo",
		goals,
		now: () => now,
	});
}

/** Feed raw terminal input and collect every intent the board produced. */
function press(board: GoalBoard, input: string): BoardIntent[] {
	const intents: BoardIntent[] = [];
	for (const key of decodeKeys(input)) {
		const intent = board.handleKey(key);
		if (intent) intents.push(intent);
	}
	return intents;
}

function plainFrame(board: GoalBoard, width = 100, rows = 20): string[] {
	// Strip styling so assertions read as the user sees the board.
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping the ESC byte is the point here.
	return board.render(width, rows).lines.map((line) => line.replace(/\u001b\[[0-9;]*m/g, ""));
}

const BORDER_CHARACTERS = ["│", "╭", "╰", "├", "┤", "╮", "╯", "┬", "┴"];

const MARKERS = /[◆○✓◌]/;
const DIM = "\u001b[2m";

/** Every row of the detail pane, trimmed of its borders and trailing padding. */
function detailLines(board: GoalBoard, width = 100, rows = 20): string[] {
	return plainFrame(board, width, rows)
		.map((line) => line.split("│")[2] ?? "")
		.map((cell) => cell.replace(/^ /, "").trimEnd());
}

/** Every goal row of the list pane, reduced to `<marker> <title>` and any badge. */
/** Every list-pane cell, section headers included, as the user sees them. */
function listedCells(board: GoalBoard, width = 100, rows = 20): string[] {
	return plainFrame(board, width, rows)
		.map((line) => line.split("│")[1] ?? "")
		.filter((cell) => cell.trim() !== "");
}

/**
 * Open every section and land back on the first goal, the way a user walks down
 * the list opening what they want to read. Sections start closed, so a test
 * about goal rows says so here rather than opening them one fixture at a time.
 */
function expandAll(board: GoalBoard, steps = 40): void {
	press(board, "g");
	for (let step = 0; step < steps; step += 1) {
		if (board.selectedGoal === undefined) press(board, " ");
		press(board, `${ESC}[B`);
	}
	press(board, "g");
}

function listedRows(board: GoalBoard, width = 100, rows = 20): string[] {
	return plainFrame(board, width, rows)
		.map((line) => line.split("│")[1] ?? "")
		.filter((cell) => MARKERS.test(cell))
		.map((cell) => cell.replace(/^[^◆○✓◌]*([◆○✓◌])\s*/, "$1 ").trimEnd());
}

describe("goal board layout", () => {
	const sizes: Array<[number, number]> = [
		[120, 40],
		[100, 24],
		[80, 24],
		[76, 20],
		[75, 20],
		[60, 16],
		[44, 12],
		[30, 10],
		[20, 8],
	];

	for (const [width, rows] of sizes) {
		it(`fills exactly ${rows} rows without overflowing ${width} columns`, () => {
			const board = createBoard(GOALS, true);
			const frame = board.render(width, rows);
			expect(frame.lines).toHaveLength(rows);
			for (const line of frame.lines) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		});

		it(`aligns every box row to ${width} columns`, () => {
			const board = createBoard(GOALS, true);
			for (const line of board.render(width, rows).lines) {
				if (!BORDER_CHARACTERS.some((character) => line.includes(character))) continue;
				expect(visibleWidth(line), `misaligned row: ${JSON.stringify(line)}`).toBe(width);
			}
		});
	}

	it("splits into two panes when wide and stacks them when narrow", () => {
		expect(plainFrame(createBoard(), 100, 20).some((line) => line.includes("┬"))).toBe(true);
		expect(plainFrame(createBoard(), 60, 20).some((line) => line.includes("┬"))).toBe(false);
		expect(plainFrame(createBoard(), 60, 20).some((line) => line.includes("Detail"))).toBe(true);
	});

	it("keeps rows aligned when a title contains wide characters", () => {
		const board = createBoard(GOALS, true);
		press(board, `${ESC}[B${ESC}[B`);
		const frame = board.render(80, 20);
		expect(plainFrame(board, 80, 20).join("\n")).toContain("日本語");
		for (const line of frame.lines) {
			if (!line.includes("│")) continue;
			expect(visibleWidth(line)).toBe(80);
		}
	});
});

describe("goal board presentation", () => {
	it("shows the file's own order first, and groups by status on request", () => {
		const board = createBoard();
		press(board, "fff");
		expect(listedRows(board).map((row) => row.slice(2))).toEqual([
			"Replace legacy authentication",
			"Add focus mode",
			"日本語のタイトルです",
			"Ship the CLI",
			"Old idea",
		]);

		// A settled goal sitting early in the file stays there until the status
		// order is asked for, which is the whole point of a canonical file order.
		const settledFirst = createBoard([GOALS[3], GOALS[1], GOALS[0]]);
		press(settledFirst, "fff");
		expect(listedRows(settledFirst)[0]).toContain("Ship the CLI");
		press(settledFirst, "o");
		expect(listedRows(settledFirst)[0]).toContain("Replace legacy authentication");
		expect(listedRows(settledFirst).at(-1)).toContain("Ship the CLI");
	});

	it("lifts the active goal above every other row in the derived orders", () => {
		const newest = goal({
			id: "g-late",
			title: "Started last",
			status: "active",
			createdAt: "2026-01-09T00:00:00.000Z",
		});
		const board = createBoard([...GOALS.slice(1), newest]);
		press(board, "fff");
		// File order shows the goal where the file puts it: last.
		expect(listedRows(board).at(-1)).toContain("Started last");
		for (const sort of ["o", "o", "o"]) {
			press(board, sort);
			const rows = listedRows(board);
			// The lifted row also carries its own marker, so it reads as the odd row
			// out with no color at all.
			expect(rows[0]).toContain("Started last");
			expect(rows[0]?.startsWith("◆")).toBe(true);
			expect(rows.slice(1).some((row) => row.startsWith("◆"))).toBe(false);
		}
	});

	it("cycles the order through file, status, recent, and dependency, keeping file order as the tiebreak", () => {
		const board = createBoard();
		const header = () => plainFrame(board)[0] ?? "";
		expect(header()).toContain("⇅ File");
		press(board, "o");
		expect(header()).toContain("⇅ Status");
		press(board, "o");
		expect(header()).toContain("⇅ Recent");
		// Recent puts the most recently touched open goal first, behind the active one.
		const touched = GOALS.map((entry) =>
			entry.id === "g-open-2" ? goal({ ...entry, updatedAt: "2026-01-05T00:00:00.000Z" }) : entry,
		);
		board.setGoals(touched);
		expect(listedRows(board)[1]).toContain("日本語");
		press(board, "o");
		expect(header()).toContain("⇅ Dependency");
		press(board, "o");
		expect(header()).toContain("⇅ File");
		expect(listedRows(board)[1]).toContain("Add focus mode");
	});

	it("orders by the same dependency waves the CLI reports, stuck goals last", () => {
		const board = createBoard([
			goal({ id: "third", title: "Third", dependsOn: ["second"] }),
			goal({ id: "cyclic", title: "Cyclic", dependsOn: ["cyclic-too"] }),
			goal({ id: "cyclic-too", title: "Cyclic too", dependsOn: ["cyclic"] }),
			goal({ id: "second", title: "Second", dependsOn: ["first"] }),
			goal({ id: "first", title: "First" }),
			goal({ id: "landed", title: "Landed", status: "done" }),
		]);
		press(board, "fff");
		press(board, "ooo");
		expect(plainFrame(board)[0]).toContain("⇅ Dependency");
		// Landed work sits ahead of the wave it released; a hand-edited cycle is in
		// no wave at all and sorts last rather than vanishing from the list.
		expect(listedRows(board).map((row) => row.slice(2))).toEqual([
			"Landed",
			"First",
			"Second",
			"Third",
			"Cyclic",
			"Cyclic too",
		]);

		// The file itself is untouched by the view: file order still reads as written.
		press(board, "o");
		expect(listedRows(board)[0]).toContain("Third");
	});

	it("keeps the selection where it is when the filter changes under it", () => {
		const board = createBoard([
			goal({ id: "a1", title: "A one", group: "Alpha" }),
			goal({ id: "b1", title: "B one", group: "Beta" }),
			goal({ id: "b2", title: "B two", group: "Beta", status: "done" }),
		]);
		const pointerRow = () => plainFrame(board, 100, 20).find((line) => line.includes("❯")) ?? "";
		press(board, "j");
		expect(pointerRow()).toContain("Beta");

		// Beta survives the filter, so the cursor has no reason to move: a header is
		// a row like any other, and cycling the filter is the key that changes least.
		press(board, "f");
		expect(pointerRow()).toContain("Beta");

		// Back to open, on the section holding the only open goal.
		press(board, "fff");
		press(board, "g");
		expect(pointerRow()).toContain("Alpha");

		// A section the filter did take off the list is a selection that is gone,
		// which is the one case that lands the cursor somewhere else.
		press(board, "f");
		expect(pointerRow()).toContain("Beta");
	});

	it("describes the selected section, because a closed board is all headers", () => {
		const board = createBoard([
			goal({ id: "one", title: "First", group: "Foundation" }),
			goal({ id: "two", title: "Second", group: "Foundation", status: "done" }),
			goal({ id: "three", title: "Third", group: "Foundation", dependsOn: ["one"] }),
		]);
		press(board, "fff");
		const detail = detailLines(board).filter((line) => line !== "");
		expect(detail[0]).toBe("Foundation");
		expect(detail).toContain("GOALS     3");
		expect(detail).toContain("STATUS    ○ 2 · ✓ 1");
		expect(detail).toContain("BLOCKED   1");
		expect(detail.at(-1)).toBe("Press → to open this section.");

		// Once it is open the same rows stand, and the hint names the way inside.
		press(board, "\r");
		expect(
			detailLines(board)
				.filter((line) => line !== "")
				.at(-1),
		).toBe("Press → to step inside, or ← to close.");

		// A section holding one kind of goal has no breakdown to give.
		const single = createBoard([goal({ id: "solo", title: "Solo", group: "Foundation" })]);
		expect(detailLines(single).filter((line) => line !== "")).toEqual([
			"Foundation",
			"GOALS     1",
			"Press → to open this section.",
		]);
	});

	it("opens with every section closed, so the first screen is the shape of the roadmap", () => {
		const board = createBoard([
			goal({ id: "one", title: "First", group: "Foundation" }),
			goal({ id: "loose", title: "Loose" }),
			goal({ id: "two", title: "Second", group: "Foundation" }),
			goal({ id: "later", title: "Later", group: "Delivery" }),
		]);
		const frame = () => plainFrame(board, 100, 24).join("\n");
		expect(frame()).toMatch(/▸ Foundation\s+\(2\)[\s\S]*▸ Delivery\s+\(1\)[\s\S]*▸ Ungrouped\s+\(1\)/);
		// The counts are the whole of what a closed board says about its goals.
		for (const title of ["First", "Second", "Later", "Loose"]) expect(frame()).not.toContain(title);
		expect(board.selectedGoal).toBeUndefined();

		// Opening them leaves the sections in the order their first goal appears,
		// with the implicit bucket last.
		expandAll(board);
		expect(frame()).toMatch(
			/▾ Foundation\s+\(2\)[\s\S]*First[\s\S]*Second[\s\S]*▾ Delivery\s+\(1\)[\s\S]*Later[\s\S]*▾ Ungrouped\s+\(1\)[\s\S]*Loose/,
		);
	});

	it("collapses and expands the selected section without writing anything", () => {
		const board = createBoard([
			goal({ id: "one", title: "First", group: "Foundation" }),
			goal({ id: "two", title: "Second", group: "Foundation" }),
		]);
		const frame = () => plainFrame(board, 100, 24).join("\n");
		expect(press(board, " ")).toEqual([]);
		expect(frame()).toContain("▾ Foundation");
		expect(frame()).toContain("○ First");
		expect(frame()).toContain("○ Second");

		expect(press(board, " ")).toEqual([]);
		expect(frame()).toContain("▸ Foundation");
		expect(frame()).not.toContain("○ First");
		press(board, "\r");
		expect(frame()).toContain("▾ Foundation");
	});

	it("insets a section's goals under its header, and leaves a plain list flush", () => {
		const board = createBoard([
			goal({ id: "one", title: "First", group: "Foundation" }),
			goal({ id: "loose", title: "Loose" }),
		]);
		expandAll(board);
		const cells = listedCells(board, 100, 24);
		const header = cells.find((cell) => cell.includes("Foundation")) ?? "";
		const child = cells.find((cell) => cell.includes("First")) ?? "";
		expect(header.indexOf("▾")).toBeGreaterThan(0);
		expect(child.indexOf("○")).toBe(header.indexOf("▾") + 2);

		// A roadmap with no sections has no header to be inset from, so its goals
		// keep the column they had before sections existed.
		const plain = createBoard([goal({ id: "only", title: "Only" })]);
		const row = listedCells(plain, 100, 24)[0] ?? "";
		expect(row.indexOf("○")).toBe(header.indexOf("▾"));
	});

	it("leaves a roadmap with no groups as a plain list of goals", () => {
		const board = createBoard([goal({ id: "one", title: "First" }), goal({ id: "two", title: "Second" })]);
		const rows = listedRows(board);
		expect(rows[0]).toContain("First");
		expect(plainFrame(board, 100, 24).join("\n")).not.toContain("Ungrouped");
	});

	it("reads a hand-written blank group as ungrouped rather than a nameless section", () => {
		const board = createBoard([
			goal({ id: "one", title: "First", group: "Foundation" }),
			goal({ id: "blank", title: "Blank", group: "   " }),
			goal({ id: "padded", title: "Padded", group: " Foundation " }),
		]);
		expandAll(board);
		const frame = plainFrame(board, 100, 24).join("\n");
		expect(frame).toMatch(
			/▾ Foundation\s+\(2\)[\s\S]*First[\s\S]*Padded[\s\S]*▾ Ungrouped\s+\(1\)[\s\S]*Blank/,
		);
	});

	it("leads the pane with a section it expands, so the goals revealed are on screen", () => {
		const goals = Array.from({ length: 6 }, (_, index) =>
			goal({ id: `g-${index}`, title: `Goal ${index}`, group: index < 3 ? "Alpha" : "Beta" }),
		);
		const board = createBoard(goals);
		// Open Alpha, which fills the pane and leaves the Beta header on its last row.
		press(board, " ");
		press(board, "jjjj");
		expect(listedCells(board, 100, 10).at(-1)).toContain("▸ Beta");

		// Expanding has to show what it revealed rather than leaving the header
		// pinned to the last row with all three goals still below the fold.
		press(board, " ");
		const cells = listedCells(board, 100, 10);
		const header = cells.findIndex((row) => row.includes("▾ Beta"));
		expect(header).toBeGreaterThanOrEqual(0);
		expect(cells.slice(header + 1).join("\n")).toContain("Goal 3");
	});

	it("fills the pane exactly on a terminal too narrow to carry a section count", () => {
		const board = createBoard([
			goal({ id: "one", title: "First", group: "Foundation" }),
			goal({ id: "l", title: "L" }),
		]);
		for (const width of [8, 10, 12, 20]) {
			const frame = plainFrame(board, width, 10);
			for (const line of frame) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			// The header row is the one that used to overrun the frame it sits in.
			for (const line of frame.filter((candidate) => /[▾▸]/.test(candidate))) {
				expect(visibleWidth(line)).toBe(width);
			}
		}
	});

	it("steps into a section that is already open rather than swallowing the key", () => {
		const board = createBoard([
			goal({ id: "one", title: "First", group: "Foundation" }),
			goal({ id: "two", title: "Second", group: "Foundation" }),
		]);
		// The first key opens the closed section, and the second steps inside it.
		expect(board.selectedGoal).toBeUndefined();
		press(board, "\r");
		expect(board.selectedGoal).toBeUndefined();
		press(board, "\r");
		expect(board.selectedGoal?.id).toBe("one");
	});

	it("shows a search hit that a collapsed section would otherwise hide", () => {
		const board = createBoard([
			goal({ id: "one", title: "First", group: "Foundation" }),
			goal({ id: "loose", title: "Loose" }),
		]);
		const frame = () => plainFrame(board, 100, 24).join("\n");
		expect(frame()).toContain("▸ Foundation");

		// The header reports one match, so the list has to be able to show it.
		press(board, "/First\r");
		expect(frame()).toContain("▾ Foundation");
		expect(frame()).toContain("First");
		expect(board.selectedGoal?.id).toBe("one");

		// Clearing the query hands the section back the collapse it had.
		press(board, ESC);
		expect(frame()).toContain("▸ Foundation");

		// A section the user opened is theirs, so a search and its clearing leave it
		// open rather than closing it back to the board's own default.
		press(board, " ");
		press(board, "/Loose\r");
		press(board, ESC);
		expect(frame()).toContain("▾ Foundation");
	});

	it("says a goal key needs a goal when a section header is selected", () => {
		const board = createBoard([
			goal({ id: "one", title: "First", group: "Foundation" }),
			goal({ id: "loose", title: "Loose" }),
		]);
		expect(board.selectedGoal).toBeUndefined();
		expect(press(board, "c")).toEqual([]);
		expect(plainFrame(board).at(-2)).toContain("is a section. Select a goal first.");
	});

	it("counts hidden goals rather than rows, which is what the pane title counts", () => {
		const goals = Array.from({ length: 4 }, (_, index) =>
			goal({ id: `g-${index}`, title: `Goal ${index}`, group: index < 2 ? "Alpha" : "Beta" }),
		);
		const board = createBoard(goals);
		// Three list rows of four: Alpha and its two goals, leaving the closed Beta
		// header below the fold. One row is hidden, but the two goals it holds are.
		press(board, " ");
		const hint = plainFrame(board, 100, 8).find((line) => line.includes("more"));
		expect(hint).toContain("2 more");
	});

	it("counts every status in the header, where a message cannot cover them", () => {
		const board = createBoard();
		expect(plainFrame(board)[0]).toContain("◆ 1 · ○ 2 · ✓ 1 · ◌ 1");
		board.setMessage("Something happened.", "info");
		expect(plainFrame(board)[0]).toContain("◆ 1 · ○ 2 · ✓ 1 · ◌ 1");
	});

	it("drops the header counts before the filter when the header runs out of room", () => {
		const header = plainFrame(createBoard(), 50, 20)[0] ?? "";
		expect(header).toContain("Open · ⇅ File · 3 of 5");
		expect(header).not.toContain("◆ 1");
	});

	it("names the goal in flight on the status line, and how to pick one when none is", () => {
		const statusLine = (goals: ProjectGoal[]) => plainFrame(createBoard(goals)).at(-2)?.trim();
		const nothingActive = GOALS.map((entry) =>
			entry.status === "active" ? goal({ ...entry, status: "open" }) : entry,
		);
		expect(statusLine(GOALS)).toBe("Active: Replace legacy authentication");
		expect(statusLine(nothingActive)).toBe("No active goal. Press s to make one active.");
		expect(statusLine([])).toBe("No project goals yet. Press a to add one.");
	});

	it("holds a standing notice above the status line, which the alternate screen would otherwise swallow", () => {
		const notice = "Warning: two project worklists exist. /repo/.pi/worklist.json is ignored.";
		const board = new GoalBoard({
			palette: createPalette(false),
			repositoryLabel: "demo",
			notice,
			goals: GOALS,
			now: () => NOW,
		});
		const statusLine = () => plainFrame(board, 120, 20).at(-2)?.trim();
		const noticeRow = () => plainFrame(board, 120, 20).at(-3)?.trim();

		// The notice gets a row of its own, so it does not have to displace the idle
		// summary to be seen.
		expect(noticeRow()).toBe(notice);
		expect(statusLine()).toBe("Active: Replace legacy authentication");

		// A message takes the line while it has something to say, and the standing
		// condition stays put above it rather than being reported once and lost.
		board.setMessage("Added goal.", "success");
		expect(statusLine()).toBe("Added goal.");
		expect(noticeRow()).toBe(notice);
		press(board, "j");
		expect(statusLine()).toBe("Active: Replace legacy authentication");
		expect(noticeRow()).toBe(notice);
	});

	it("wraps the real two-worklist warning so the ignored file and the fix survive 80 columns", () => {
		const currentPath = "/home/dev/service-api/.worklist/worklist.json";
		const legacyPath = "/home/dev/service-api/.pi/worklist.json";
		// The wording every interface shares, composed by its one helper rather than
		// fabricated short here: the board has to hold whatever that helper says.
		const notice = shadowedWorklistWarning({
			path: currentPath,
			source: "current",
			currentPath,
			legacyPath,
			shadowedPath: legacyPath,
		});
		if (notice === undefined) throw new Error("a shadowed worklist must earn a notice");
		const board = new GoalBoard({
			palette: createPalette(false),
			repositoryLabel: "demo",
			notice,
			goals: GOALS,
			now: () => NOW,
		});

		const frame = plainFrame(board, 80, 20);
		const shown = frame.join(" ").replace(/\s+/g, " ");

		// Both halves the notice exists for, not just the prefix and half a path.
		expect(shown).toContain(notice);
		expect(shown).toContain(`${legacyPath} is ignored`);
		expect(shown).toContain("Merge the goals you want to keep into the first file and delete the second.");

		// And it stays inside the terminal, without taking the roadmap off screen.
		expect(frame.every((line) => visibleWidth(line) <= 80)).toBe(true);
		expect(frame.length).toBe(20);
		expect(frame.some((line) => line.includes("Replace legacy authentication"))).toBe(true);
	});

	it("holds the notice's rows while it stands, so a passing message does not reflow the panes", () => {
		const currentPath = "/home/dev/service-api/.worklist/worklist.json";
		const legacyPath = "/home/dev/service-api/.pi/worklist.json";
		const notice = shadowedWorklistWarning({
			path: currentPath,
			source: "current",
			currentPath,
			legacyPath,
			shadowedPath: legacyPath,
		});
		if (notice === undefined) throw new Error("a shadowed worklist must earn a notice");
		const board = new GoalBoard({
			palette: createPalette(false),
			repositoryLabel: "demo",
			notice,
			goals: GOALS,
			now: () => NOW,
		});

		// The notice holds rows of its own above the status line, so a status area
		// budgeted per frame would hand them back the moment a message arrived.
		const standing = plainFrame(board, 80, 20);
		const goalRows = listedRows(board, 80, 20);
		const detail = detailLines(board, 80, 20);
		expect(goalRows.length).toBeGreaterThan(0);

		board.setMessage("Added goal.", "success");
		const withMessage = plainFrame(board, 80, 20);

		// The message keeps the bottom row, and the whole notice keeps the rows above
		// it rather than being wiped off a screen with no scrollback to recover it.
		expect(withMessage.at(-2)?.trim()).toBe("Added goal.");
		const shown = withMessage.join(" ").replace(/\s+/g, " ");
		expect(shown).toContain(notice);
		expect(shown).toContain(`${legacyPath} is ignored`);
		expect(shown).toContain("Merge the goals you want to keep into the first file and delete the second.");

		// Same list, same detail, same geometry: only the bottom row changed.
		expect(listedRows(board, 80, 20)).toEqual(goalRows);
		expect(detailLines(board, 80, 20)).toEqual(detail);
		expect(withMessage).toHaveLength(standing.length);
		expect(withMessage.slice(0, -2)).toEqual(standing.slice(0, -2));
		expect(withMessage.every((line) => visibleWidth(line) <= 80)).toBe(true);
	});

	it("falls back to one truncated notice line on a terminal too short to wrap it", () => {
		const notice =
			"Warning: two project worklists exist. Reading and writing /a/.worklist/worklist.json; /a/.pi/worklist.json is ignored. Merge the goals you want to keep into the first file and delete the second.";
		const board = new GoalBoard({
			palette: createPalette(false),
			repositoryLabel: "demo",
			notice,
			goals: GOALS,
			now: () => NOW,
		});

		// Six rows leave nothing to spare once the header, the pane minimum, and the
		// key bar are paid for, so the goal rows keep the space.
		const frame = plainFrame(board, 80, 6);
		expect(frame.length).toBe(6);
		expect(frame.at(-2)?.trim()).toBe(truncateToWidth(notice, 78));
		expect(frame.every((line) => visibleWidth(line) <= 80)).toBe(true);
	});

	it("dims settled rows only where they sit alongside live work", () => {
		const board = createBoard(GOALS, true);
		press(board, "fff");
		const dimmedTitle = (frame: string[], title: string) =>
			frame.some((line) => line.includes(`${DIM}${title}`));
		expect(dimmedTitle(board.render(100, 20).lines, "Ship the CLI")).toBe(true);
		expect(dimmedTitle(board.render(100, 20).lines, "Add focus mode")).toBe(false);
		press(board, "gjjj\r");
		expect(board.selectedGoal?.id).toBe("g-done");
		expect(dimmedTitle(board.render(100, 20).lines, "Ship the CLI")).toBe(false);

		// A list of nothing but done goals has no live work to recede behind.
		const done = createBoard(GOALS, true);
		press(done, "f");
		expect(dimmedTitle(done.render(100, 20).lines, "Ship the CLI")).toBe(false);
	});

	it("dims a goal waiting on work that has not landed", () => {
		const goals = [
			goal({ id: "g-foundation", title: "Land the foundation" }),
			goal({ id: "g-waiting", title: "Build on it", dependsOn: ["g-foundation"] }),
		];
		const dimmedTitle = (board: GoalBoard, title: string) =>
			board.render(100, 20).lines.some((line) => line.includes(`${DIM}${title}`));

		const board = createBoard(goals, true);
		expect(dimmedTitle(board, "Build on it")).toBe(true);
		expect(dimmedTitle(board, "Land the foundation")).toBe(false);

		// The selected row always keeps full contrast, blocked or not.
		press(board, "j");
		expect(board.selectedGoal?.id).toBe("g-waiting");
		expect(dimmedTitle(board, "Build on it")).toBe(false);

		// Nothing stays marked blocked once the goal holding it up has landed.
		const landed = createBoard([{ ...goals[0], status: "done" as const }, goals[1]], true);
		press(landed, "f");
		expect(dimmedTitle(landed, "Build on it")).toBe(false);
	});

	it("spells out both directions of an edge in the detail pane", () => {
		const goals = [
			goal({ id: "g-done", title: "Land the foundation", status: "done" }),
			goal({ id: "g-open", title: "Ship the schema" }),
			goal({ id: "g-waiting", title: "Build on it", dependsOn: ["g-done", "g-open", "g-gone"] }),
			goal({ id: "g-later", title: "Then this", dependsOn: ["g-waiting"] }),
		];
		const board = createBoard(goals);
		// The default filter hides the done goal, so the waiting one is the second row.
		press(board, "j");
		expect(board.selectedGoal?.id).toBe("g-waiting");
		const detail = detailLines(board);

		expect(detail.some((line) => /STATUS\s+OPEN · blocked/.test(line))).toBe(true);
		expect(detail.find((line) => line.includes("DEPENDS"))).toMatch(/DEPENDS\s+✓ g-done/);
		expect(detail.some((line) => /^\s+○ g-open$/.test(line))).toBe(true);
		// An edge naming no goal can never be satisfied, so it is called out.
		expect(detail.some((line) => /^\s+\? g-gone \(missing\)$/.test(line))).toBe(true);
		// The reverse direction is derived, never stored.
		expect(detail.find((line) => line.includes("BLOCKS"))).toMatch(/BLOCKS\s+○ g-later/);

		const unblocked = createBoard(goals);
		expect(detailLines(unblocked).some((line) => line.includes("DEPENDS"))).toBe(false);
		expect(detailLines(unblocked).some((line) => line.includes("blocked"))).toBe(false);
	});

	it("ages goals still in play, and leaves settled ones alone", () => {
		const later = Date.parse("2026-03-01T00:00:00.000Z");
		const board = createBoard(GOALS, false, later);
		press(board, "fff");
		const rows = listedRows(board);
		expect(rows[0]).toMatch(/Replace legacy authentication\s+58d$/);
		expect(rows.find((row) => row.includes("Ship the CLI"))).not.toMatch(/\d+d$/);
		// The detail pane spells out what the badge on the selected row means.
		press(board, "g");
		expect(plainFrame(board).join("\n")).toContain("58d untouched");
		press(board, "G");
		expect(plainFrame(board).join("\n")).not.toContain("untouched");
	});

	it("keeps a staleness badge off a list too narrow to carry one", () => {
		const later = Date.parse("2026-03-01T00:00:00.000Z");
		const board = createBoard(GOALS, false, later);
		expect(plainFrame(board, 30, 12).join("\n")).toContain("58d");
		expect(plainFrame(board, 20, 8).join("\n")).not.toContain("58d");
	});

	it("always keeps the help and quit hints in the key bar", () => {
		for (const width of [120, 100, 80, 60, 44, 30]) {
			const bar = plainFrame(createBoard(), width, 20).at(-1) ?? "";
			expect(bar, `width ${width}`).toContain("q quit");
			expect(bar, `width ${width}`).toContain("? keys");
		}
	});

	it("shows the selected goal's full description and identity in the detail pane", () => {
		const frame = plainFrame(createBoard()).join("\n");
		expect(frame).toContain("STATUS");
		expect(frame).toContain("ACTIVE");
		expect(frame).toContain("g-active");
		expect(frame).toContain("Migrate every supported client");
	});

	it("spells out the optional fields a goal carries, and omits the ones it does not", () => {
		const bare = plainFrame(createBoard()).join("\n");
		for (const label of ["GROUP", "BRANCH", "DONE", "LINKS"]) expect(bare).not.toContain(label);

		const detailed = createBoard([
			goal({
				id: "g-full",
				title: "Retire the legacy importer",
				status: "done",
				group: "Foundation",
				branch: "feat/retire-importer",
				completedAt: "2026-01-05T09:30:00.000Z",
				links: ["https://example.test/pull/12"],
			}),
		]);
		press(detailed, "f");
		expandAll(detailed);
		const frame = plainFrame(detailed, 120, 24).join("\n");
		expect(frame).toContain("GROUP     Foundation");
		expect(frame).toContain("BRANCH    feat/retire-importer");
		expect(frame).toContain("DONE      2026-01-05");
		expect(frame).toContain("LINKS     https://example.test/pull/12");
	});

	it("offers the right way out of each empty list", () => {
		const empty = createBoard([]);
		expect(plainFrame(empty).join("\n")).toContain("Press a to add one.");

		const archivedOnly = createBoard([goal({ id: "a", title: "Old", status: "archived" })]);
		expect(plainFrame(archivedOnly).join("\n")).toContain("Press f to change the filter.");

		const board = createBoard();
		press(board, "/zzzz");
		expect(plainFrame(board).join("\n")).toContain("Press esc to clear it.");
	});

	it("lists the complete key map in the help overlay", () => {
		const board = createBoard();
		press(board, "?");
		const frame = plainFrame(board, 100, 30).join("\n");
		expect(frame).toContain("Edit the description in $EDITOR");
		expect(frame).toContain("Delete permanently (asks first)");
		press(board, ESC);
		expect(plainFrame(board, 100, 30).join("\n")).not.toContain("Delete permanently");
	});

	it("scrolls the key map so a short terminal cannot hide the way out of it", () => {
		const board = createBoard();
		press(board, "?");
		const short = () => plainFrame(board, 100, 16).join("\n");
		expect(short()).toContain("0 above");
		expect(short()).not.toContain("q / esc");

		press(board, "G");
		expect(short()).toContain("q / esc");
		expect(short()).toContain("Press esc to return");
		expect(short()).toContain("0 below");

		press(board, "g");
		expect(short()).not.toContain("q / esc");
		// Scrolling is not a way out, and reopening starts at the top again.
		expect(plainFrame(board, 100, 16).at(-1)).toContain("esc close");
		press(board, ESC);
		expect(short()).not.toContain("Move the selection");
		press(board, "?");
		expect(short()).toContain("0 above");
	});
});

describe("goal board navigation", () => {
	it("moves the selection and jumps to the ends of the list", () => {
		const board = createBoard();
		expect(board.selectedGoal?.id).toBe("g-active");
		press(board, `${ESC}[B`);
		expect(board.selectedGoal?.id).toBe("g-open-1");
		press(board, "G");
		expect(board.selectedGoal?.id).toBe("g-open-2");
		press(board, "g");
		expect(board.selectedGoal?.id).toBe("g-active");
	});

	it("stops at the ends instead of wrapping", () => {
		const board = createBoard();
		press(board, `${ESC}[A${ESC}[A`);
		expect(board.selectedGoal?.id).toBe("g-active");
		press(board, "jjjjjjjj");
		expect(board.selectedGoal?.id).toBe("g-open-2");
	});

	it("scrolls the detail pane once it has focus, leaving the selection alone", () => {
		const board = createBoard(GOALS, false);
		const before = plainFrame(board, 60, 14);
		press(board, "\r");
		press(board, "jjj");
		expect(board.selectedGoal?.id).toBe("g-active");
		expect(plainFrame(board, 60, 14)).not.toEqual(before);
		press(board, ESC);
		press(board, "j");
		expect(board.selectedGoal?.id).toBe("g-open-1");
	});

	it("cycles the filter through open, done, archived, and all", () => {
		const board = createBoard();
		const label = () => plainFrame(board)[0];
		expect(label()).toContain("Open · ⇅ File · 3 of 5");
		press(board, "f");
		expect(label()).toContain("Done · ⇅ File · 1 of 5");
		press(board, "f");
		expect(label()).toContain("Archived · ⇅ File · 1 of 5");
		press(board, "f");
		expect(label()).toContain("All · ⇅ File · 5 of 5");
		press(board, "f");
		expect(label()).toContain("Open · ⇅ File · 3 of 5");
	});

	it("narrows the list while typing a search and restores it on escape", () => {
		const board = createBoard();
		press(board, "/focus");
		expect(plainFrame(board)[0]).toContain("1 of 5");
		expect(board.selectedGoal?.id).toBe("g-open-1");
		press(board, "\r");
		expect(plainFrame(board)[0]).toContain("/focus");
		press(board, ESC);
		expect(plainFrame(board)[0]).toContain("Open · ⇅ File · 3 of 5");
	});

	it("reopens a search prefilled so the query can be refined", () => {
		const board = createBoard();
		press(board, "/focus\r");
		press(board, "/");
		press(board, " mode");
		expect(plainFrame(board)[0]).toContain("1 of 5");
		press(board, "\r");
		expect(plainFrame(board)[0]).toContain("/focus mode");
	});

	it("reopens a grapheme search with its cursor in bounds", () => {
		const board = createBoard();
		press(board, "/🚀\r/");
		expect(() => board.render(100, 20)).not.toThrow();
	});

	it("keeps the cleared query's goal in view by landing on the section holding it", () => {
		const board = createBoard([
			goal({ id: "one", title: "Alpha one", group: "Alpha" }),
			goal({ id: "two", title: "Alpha two", group: "Alpha" }),
			goal({ id: "far", title: "Beta far", group: "Beta" }),
		]);
		// Search into a closed section: the query overrides the collapse.
		press(board, "/far\r");
		expect(board.selectedGoal?.id).toBe("far");

		// Clearing the query re-collapses Beta, so the goal's row is gone. The
		// selection belongs on its section, not back at the top of the roadmap.
		press(board, ESC);
		expect(board.selectedGoal).toBeUndefined();
		expect(plainFrame(board).at(-2)).not.toContain("Alpha one");
		const selectedRow = plainFrame(board, 100, 20).find((line) => line.includes("❯"));
		expect(selectedRow).toContain("Beta");
	});

	it("abandons a refined search back to the committed query", () => {
		const board = createBoard();
		press(board, "/focus\r");
		press(board, "/ mode and more");
		press(board, ESC);
		expect(plainFrame(board)[0]).toContain("/focus");
		expect(plainFrame(board)[0]).toContain("1 of 5");
	});
});

describe("goal board reordering", () => {
	it("moves the selected goal against its neighbouring row", () => {
		const board = createBoard();
		press(board, `${ESC}[B`);
		expect(board.selectedGoal?.id).toBe("g-open-1");
		expect(press(board, "J")).toEqual([
			{
				kind: "reorder",
				goalId: "g-open-1",
				delta: 1,
				sectionGoalIds: ["g-active", "g-open-1", "g-open-2"],
				success: expect.stringContaining("down"),
				blocked: "Already last.",
			},
		]);
		expect(press(board, "K")).toEqual([
			{
				kind: "reorder",
				goalId: "g-open-1",
				delta: -1,
				sectionGoalIds: ["g-active", "g-open-1", "g-open-2"],
				success: expect.stringContaining("up"),
				blocked: "Already first.",
			},
		]);
	});

	it("accepts shift+arrows for the terminals that report them", () => {
		const board = createBoard();
		expect(press(board, `${ESC}[1;2B`)).toMatchObject([{ kind: "reorder", goalId: "g-active", delta: 1 }]);
		// A plain arrow is still navigation, not a reorder.
		expect(press(board, `${ESC}[B`)).toEqual([]);
		expect(board.selectedGoal?.id).toBe("g-open-1");
		expect(press(board, `${ESC}[1;2A`)).toMatchObject([{ kind: "reorder", goalId: "g-open-1", delta: -1 }]);
	});

	it("anchors on the visible neighbour, skipping the rows a filter hides", () => {
		const board = createBoard();
		press(board, "/日\r");
		// The search leaves one row, so there is nothing to move against.
		expect(press(board, "K")).toEqual([]);
		expect(plainFrame(board).at(-2)).toContain("Already first.");

		const filtered = createBoard();
		press(filtered, `${ESC}[B${ESC}[B`);
		expect(filtered.selectedGoal?.id).toBe("g-open-2");
		// The done and archived goals are hidden, so down is already the end.
		expect(press(filtered, "J")).toEqual([]);
		expect(plainFrame(filtered).at(-2)).toContain("Already last.");
	});

	it("treats a section boundary as an end, since a crossing move would not show", () => {
		const board = createBoard([
			goal({ id: "one", title: "First", group: "Foundation" }),
			goal({ id: "two", title: "Second", group: "Foundation" }),
			goal({ id: "later", title: "Later", group: "Delivery" }),
			goal({ id: "loose", title: "Loose" }),
		]);
		expandAll(board);
		// Down from the section's first goal onto its last, which has nowhere to go.
		press(board, `${ESC}[B`);
		expect(board.selectedGoal?.id).toBe("two");
		expect(press(board, "J")).toEqual([]);
		expect(plainFrame(board).at(-2)).toContain("Already last in Foundation.");

		// Up inside the section still moves, and anchors on the section's own rows.
		expect(press(board, "K")).toEqual([
			{
				kind: "reorder",
				goalId: "two",
				delta: -1,
				sectionGoalIds: ["one", "two"],
				success: expect.stringContaining("up"),
				blocked: "Already first in Foundation.",
			},
		]);

		// An ungrouped goal is at an end of its own implicit section, not of the list.
		press(board, "G");
		expect(board.selectedGoal?.id).toBe("loose");
		expect(press(board, "K")).toEqual([]);
		expect(plainFrame(board).at(-2)).toContain("Already first.");
	});

	it("keeps a section where it was when its own first goal moves down", () => {
		// Foundation and Delivery interleave in file order, so a move written as
		// "source after anchor" would hand Foundation's position to Delivery.
		const goals = [
			goal({ id: "one", title: "First", group: "Foundation" }),
			goal({ id: "later", title: "Later", group: "Delivery" }),
			goal({ id: "two", title: "Second", group: "Foundation" }),
		];
		const board = createBoard(goals);
		expandAll(board);
		const [intent] = press(board, "J");
		if (intent?.kind !== "reorder") throw new Error("Expected reorder intent");
		expect(board.resolveReorder(intent)).toEqual({
			scope: "project",
			action: "move",
			id: "two",
			beforeId: "one",
		});

		// Applying that move keeps Foundation first and swaps its two goals.
		const moved = createBoard([goals[2], goals[0], goals[1]]);
		expandAll(moved);
		const rows = plainFrame(moved, 100, 24).join("\n");
		expect(rows).toMatch(/▾ Foundation[\s\S]*Second[\s\S]*First[\s\S]*▾ Delivery[\s\S]*Later/);
	});

	it("lands a deletion on the neighbouring goal rather than the top of the board", () => {
		const goals = [
			goal({ id: "a1", title: "A one", group: "Alpha" }),
			goal({ id: "b1", title: "B one", group: "Beta" }),
			goal({ id: "b2", title: "B two", group: "Beta" }),
			goal({ id: "c1", title: "C one", group: "Gamma" }),
		];
		const board = createBoard(goals);
		expandAll(board);
		// Rows are [Alpha, a1, Beta, b1, b2, Gamma, c1]; select b2 at index 4.
		press(board, "jjj");
		expect(board.selectedGoal?.id).toBe("b2");

		// Removing it leaves a section header at index 4, which must not send the
		// cursor back to the first goal of the whole roadmap.
		board.setGoals([goals[0], goals[1], goals[3]]);
		expect(board.selectedGoal?.id).toBe("c1");
	});

	it("keeps queued filtered reorder references valid across ID migration", () => {
		const original = [
			goal({ id: "old-a", title: "A" }),
			goal({ id: "hidden", title: "Hidden", status: "done" }),
			goal({ id: "old-b", title: "B" }),
		];
		const board = createBoard(original);
		const [intent] = press(board, "J");
		if (intent?.kind !== "reorder") throw new Error("Expected reorder intent");

		board.setGoals([
			{ ...original[0], id: "new-a", previousIds: ["old-a"] },
			original[1],
			{ ...original[2], id: "new-b", previousIds: ["old-b"] },
		]);

		// A downward move is written as "put the neighbour before the moved goal",
		// which is the same pair order and cannot shift the section it sits in.
		expect(board.resolveReorder(intent)).toEqual({
			scope: "project",
			action: "move",
			id: "new-b",
			beforeId: "new-a",
		});
	});

	it("reorders only in file order, since the other views are not the file", () => {
		const board = createBoard();
		for (const derived of ["status", "recent", "dependency"]) {
			press(board, "o");
			expect(press(board, "J"), derived).toEqual([]);
			expect(plainFrame(board).at(-2)).toContain("Reorder in file order only");
		}
		press(board, "o");
		expect(press(board, "J")).toMatchObject([{ kind: "reorder" }]);
	});
});

describe("goal board editing", () => {
	it("adds a goal from the prompt", () => {
		const board = createBoard();
		expect(press(board, "a")).toEqual([]);
		const intents = press(board, "New goal\r");
		expect(intents).toEqual([
			{
				kind: "operation",
				operation: { scope: "project", action: "add", title: "New goal" },
				success: expect.stringContaining("New goal"),
			},
		]);
	});

	it("cancels an add on escape or empty input", () => {
		const board = createBoard();
		expect(press(board, `aNew goal${ESC}`)).toEqual([]);
		expect(press(board, "a   \r")).toEqual([]);
	});

	it("edits the prompt buffer with cursor and word keys", () => {
		const board = createBoard();
		press(board, "a");
		press(board, "one two");
		press(board, "\u0017");
		const [intent] = press(board, "three\r");
		expect(intent).toMatchObject({ operation: { title: "one three" } });
	});

	it("prefills a rename and treats an unchanged title as no work", () => {
		const board = createBoard();
		press(board, "e");
		expect(plainFrame(board).at(-2)).toContain("Replace legacy authentication");
		expect(press(board, "\r")).toEqual([]);

		// Ctrl+U clears the prefilled title so the new one replaces it outright.
		press(board, "e");
		expect(press(board, "\u0015Renamed\r")).toEqual([
			{
				kind: "operation",
				operation: { scope: "project", action: "update", id: "g-active", title: "Renamed" },
				success: expect.stringContaining("Renamed"),
			},
		]);
	});

	it("hands description editing to the runtime", () => {
		const board = createBoard();
		expect(press(board, "E")).toEqual([{ kind: "edit-description", goal: GOALS[0] }]);
	});

	it("reloads on demand", () => {
		expect(press(createBoard(), "R")).toEqual([{ kind: "reload" }]);
	});
});

describe("goal board lifecycle guardrails", () => {
	it("activates an open goal without asking, since that is not a lifecycle change", () => {
		const board = createBoard();
		press(board, `${ESC}[B`);
		expect(press(board, " ")).toEqual([
			{
				kind: "operation",
				operation: { scope: "project", action: "set_active", id: "g-open-1" },
				success: expect.any(String),
			},
		]);
	});

	it("asks before completing the active goal and passes confirm only after yes", () => {
		const board = createBoard();
		expect(press(board, " ")).toEqual([]);
		expect(plainFrame(board).at(-2)).toContain("Complete");
		expect(plainFrame(board).at(-2)).toContain("[y/N]");
		expect(press(board, "y")).toEqual([
			{
				kind: "operation",
				operation: { scope: "project", action: "complete", id: "g-active", confirm: true },
				success: expect.any(String),
			},
		]);
	});

	it("reopens a settled goal rather than completing it again", () => {
		const board = createBoard();
		press(board, "f");
		expect(board.selectedGoal?.id).toBe("g-done");
		press(board, " ");
		const [intent] = press(board, "y");
		expect(intent).toMatchObject({ operation: { action: "reopen", id: "g-done", confirm: true } });
	});

	it("cancels every lifecycle prompt unless the answer is exactly yes", () => {
		for (const answer of ["n", "N", "\r", ESC, " ", "x", "q"]) {
			const board = createBoard();
			press(board, " ");
			expect(press(board, answer), `answer ${JSON.stringify(answer)} must not confirm`).toEqual([]);
		}
	});

	it("requires confirmation before a permanent delete", () => {
		const board = createBoard();
		expect(press(board, "d")).toEqual([]);
		expect(plainFrame(board).at(-2)).toContain("cannot be undone");
		expect(press(board, "y")).toEqual([
			{
				kind: "operation",
				operation: { scope: "project", action: "delete", id: "g-active", confirm: true },
				success: expect.any(String),
			},
		]);
	});

	it("asks before archiving and before completing through the direct keys", () => {
		for (const [key, action] of [
			["c", "complete"],
			["r", "reopen"],
			["x", "archive"],
		] as const) {
			const board = createBoard();
			expect(press(board, key)).toEqual([]);
			const [intent] = press(board, "y");
			expect(intent).toMatchObject({ operation: { action, confirm: true } });
		}
	});

	it("refuses to re-activate the goal that is already active", () => {
		const board = createBoard();
		expect(press(board, "s")).toEqual([]);
		expect(plainFrame(board).at(-2)).toContain("Already the active goal");
	});
});

describe("goal board state after reload", () => {
	it("keeps the selection on the same goal", () => {
		const board = createBoard();
		press(board, `${ESC}[B`);
		board.setGoals([...GOALS].reverse());
		expect(board.selectedGoal?.id).toBe("g-open-1");
	});

	it("falls back to a neighbor when the selected goal disappears", () => {
		const board = createBoard();
		press(board, `${ESC}[B`);
		expect(board.selectedGoal?.id).toBe("g-open-1");
		board.setGoals(GOALS.filter((entry) => entry.id !== "g-open-1"));
		expect(board.selectedGoal?.id).toBe("g-open-2");
	});

	it("clears the selection when nothing is left", () => {
		const board = createBoard();
		board.setGoals([]);
		expect(board.selectedGoal).toBeUndefined();
		expect(plainFrame(board).join("\n")).toContain("No goal selected.");
	});

	it("shows a message set by the runtime", () => {
		const board = createBoard();
		board.setMessage("Something went wrong.", "error");
		expect(plainFrame(board).at(-2)).toContain("Something went wrong.");
	});
});

describe("goal board exit", () => {
	it("quits on q, on escape from the top level, and on ctrl+c from any mode", () => {
		expect(press(createBoard(), "q")).toEqual([{ kind: "quit" }]);
		expect(press(createBoard(), ESC)).toEqual([{ kind: "quit" }]);
		expect(press(createBoard(), "\u0003")).toEqual([{ kind: "quit" }]);
		expect(press(createBoard(), "a\u0003")).toEqual([{ kind: "quit" }]);
		expect(press(createBoard(), "d\u0003")).toEqual([{ kind: "quit" }]);
	});

	it("uses escape to back out of the detail pane and the search before quitting", () => {
		const board = createBoard();
		press(board, "\r");
		expect(press(board, ESC)).toEqual([]);
		press(board, "/focus\r");
		expect(press(board, ESC)).toEqual([]);
		expect(press(board, ESC)).toEqual([{ kind: "quit" }]);
	});
});
