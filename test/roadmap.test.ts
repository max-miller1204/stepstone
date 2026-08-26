import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CLI_COMMAND_CONTRACT, GENERATOR_PATH, WORKLIST_RELATIVE_PATH } from "../src/cli-contract.ts";
import { createWorklistLocator } from "../src/git.ts";
import { readProjectWorklist } from "../src/project-store.ts";
import { ROADMAP_PATH, renderRoadmapMarkdown } from "../src/roadmap.ts";
import type { ProjectGoal, ProjectWorklist } from "../src/types.ts";
import { PROJECT_WORKLIST_VERSION } from "../src/types.ts";

/** This checkout, named from the test file rather than from the process directory. */
const repoRoot = resolve(import.meta.dirname, "..");

function goal(overrides: Partial<ProjectGoal> & Pick<ProjectGoal, "id" | "title">): ProjectGoal {
	return {
		status: "open",
		createdAt: "2026-05-04T09:12:31.004Z",
		updatedAt: "2026-05-04T09:12:31.004Z",
		...overrides,
	};
}

function worklist(goals: ProjectGoal[], retiredIds?: string[]): ProjectWorklist {
	return {
		version: PROJECT_WORKLIST_VERSION,
		revision: 7,
		goals,
		...(retiredIds ? { retiredIds } : {}),
	};
}

/** The line one goal's list item starts with, so a test can assert on it alone. */
function itemLine(markdown: string, id: string): string | undefined {
	return markdown.split("\n").find((line) => line.startsWith("- ") && line.endsWith(`\`${id}\``));
}

/** Every `## heading` the page renders, in page order. */
function sectionHeadings(markdown: string): string[] {
	return markdown
		.split("\n")
		.filter((line) => line.startsWith("## "))
		.map((line) => line.slice(3));
}

describe("generated roadmap", () => {
	it("keeps the committed roadmap page byte-identical to a render of the committed goals", async () => {
		// The page is a projection of the goal file, so the two drift apart on any
		// mutation that is not followed by a regeneration; that is the whole failure
		// this assertion exists to name.
		const located = createWorklistLocator(repoRoot)();
		const stored = await readProjectWorklist(located.path);
		expect(stored.error, `${located.path} could not be read`).toBeUndefined();
		// A read that finds no file reports an empty worklist without an error, so
		// without this the assertion below would pass on a page blanked from one:
		// both sides would be the empty render rather than this repository's goals.
		expect(stored.data.goals.length, `${located.path} holds no goals`).toBeGreaterThan(0);
		const committed = await readFile(resolve(repoRoot, ROADMAP_PATH), "utf8");
		expect(committed, `${ROADMAP_PATH} is stale; run \`npm run docs\` to regenerate it`).toBe(
			renderRoadmapMarkdown(stored.data),
		);
	});

	it("names the file it was rendered from and the script that writes it", () => {
		const markdown = renderRoadmapMarkdown(worklist([]));
		expect(markdown.split("\n")[0]).toBe(
			`<!-- Generated from ${WORKLIST_RELATIVE_PATH} by ${GENERATOR_PATH}. Do not edit manually. -->`,
		);
		expect(markdown).toContain("# Roadmap");
		expect(markdown).toContain("No project goals.");
	});

	it("keeps the prose it authors free of a cache-unsafe invocation", () => {
		// Goal prose is data and is exempt from the documentation sweep, so the
		// sentences this renderer writes are checked here instead of nowhere.
		const markdown = renderRoadmapMarkdown(worklist([goal({ id: "a-goal", title: "A goal" })]));
		expect(markdown).not.toMatch(
			new RegExp(String.raw`\b${CLI_COMMAND_CONTRACT.binary} ${CLI_COMMAND_CONTRACT.scope}\b`),
		);
	});

	it("sections goals by group in the order the groups first appear in the file", () => {
		const markdown = renderRoadmapMarkdown(
			worklist([
				goal({ id: "first-foundation", title: "First foundation", group: "Foundation" }),
				goal({ id: "first-harness", title: "First harness", group: "Harness" }),
				goal({ id: "second-foundation", title: "Second foundation", group: "Foundation" }),
			]),
		);
		expect(sectionHeadings(markdown)).toEqual(["Foundation", "Harness"]);
		const foundation = markdown.split("\n## Harness\n")[0] ?? "";
		// File order inside a section, so the page cannot re-sort the roadmap.
		expect(foundation.indexOf("`first-foundation`")).toBeLessThan(foundation.indexOf("`second-foundation`"));
		expect(foundation).not.toContain("`first-harness`");
	});

	it("gives goals that name no group a section of their own, after every named one", () => {
		const markdown = renderRoadmapMarkdown(
			worklist([
				goal({ id: "no-group", title: "No group" }),
				goal({ id: "blank-group", title: "Blank group", group: "   " }),
				goal({ id: "grouped", title: "Grouped", group: "Foundation" }),
			]),
		);
		// The implicit bucket comes last, as it does on the board and the dashboard,
		// rather than where its first goal happens to appear in the file.
		expect(sectionHeadings(markdown)).toEqual(["Foundation", "Ungrouped"]);
		const ungrouped = markdown.split("\n## Ungrouped\n")[1] ?? "";
		expect(ungrouped).toContain("`no-group`");
		expect(ungrouped).toContain("`blank-group`");
	});

	it("keeps a group literally named Ungrouped apart from the implicit bucket", () => {
		const markdown = renderRoadmapMarkdown(
			worklist([
				goal({ id: "ungrouped-goal", title: "No group" }),
				goal({ id: "named-ungrouped", title: "Named Ungrouped", group: "Ungrouped" }),
				goal({ id: "grouped", title: "Grouped", group: "Foundation" }),
			]),
		);
		// The shared sentinel key decides identity, so a group someone actually named
		// "Ungrouped" is its own section even though both headings spell the same;
		// the page never interleaves the two groups' goals under one heading.
		expect(sectionHeadings(markdown)).toEqual(["Ungrouped", "Foundation", "Ungrouped"]);
		const sections = markdown.split("\n## Ungrouped\n").slice(1);
		expect(sections).toHaveLength(2);
		expect(sections[0]).toContain("`named-ungrouped`");
		expect(sections[0]).not.toContain("`ungrouped-goal`");
		expect(sections[1]).toContain("`ungrouped-goal`");
		expect(sections[1]).not.toContain("`named-ungrouped`");
	});

	it("uses shared group identity while flattening headings enough to be markdown", () => {
		const markdown = renderRoadmapMarkdown(
			worklist([
				goal({ id: "multiline", title: "Multiline", group: "Later\n## Foundation" }),
				goal({ id: "single-spaced", title: "Single spaced", group: "Pi Surfaces" }),
				goal({ id: "spaced", title: "Spaced", group: "  Pi  Surfaces  " }),
			]),
		);
		// A heading is the page's only structural element, so a stored newline may
		// neither open a section nobody named nor leave prose outside a list item.
		expect(markdown.split("\n").filter((line) => line.startsWith("#"))).toEqual([
			"# Roadmap",
			"## Later ## Foundation",
			"## Pi Surfaces",
			"## Pi  Surfaces",
		]);
		// Group identity matches the board and Pi dashboard: trimming alone decides
		// whether names are the same, so internal whitespace does not merge sections.
		const singleSpacedSection = markdown.split("\n## Pi  Surfaces\n")[0] ?? "";
		expect(singleSpacedSection).toContain("`single-spaced`");
		expect(singleSpacedSection).not.toContain("`spaced`");
		const doubleSpacedSection = markdown.split("\n## Pi  Surfaces\n")[1] ?? "";
		expect(doubleSpacedSection).toContain("`spaced`");
		expect(doubleSpacedSection).not.toContain("`single-spaced`");
	});

	it("states each goal's status, and that the graph has it waiting", () => {
		const markdown = renderRoadmapMarkdown(
			worklist([
				goal({ id: "landed", title: "Landed", status: "done" }),
				goal({ id: "in-flight", title: "In flight", status: "active" }),
				goal({ id: "waiting", title: "Waiting", dependsOn: ["in-flight"] }),
				goal({ id: "released", title: "Released", dependsOn: ["landed"] }),
				goal({ id: "shelved", title: "Shelved", status: "archived" }),
			]),
		);
		expect(itemLine(markdown, "landed")).toBe("- **[done]** Landed - `landed`");
		expect(itemLine(markdown, "in-flight")).toBe("- **[active]** In flight - `in-flight`");
		expect(itemLine(markdown, "waiting")).toBe("- **[open, blocked]** Waiting - `waiting`");
		expect(itemLine(markdown, "released")).toBe("- **[open]** Released - `released`");
		expect(itemLine(markdown, "shelved")).toBe("- **[archived]** Shelved - `shelved`");
	});

	it("counts the roadmap by status without printing a status nothing is in", () => {
		const markdown = renderRoadmapMarkdown(
			worklist([
				goal({ id: "one", title: "One", status: "active" }),
				goal({ id: "two", title: "Two" }),
				goal({ id: "three", title: "Three" }),
			]),
		);
		expect(markdown).toContain("3 goals: 1 active, 2 open.");
		expect(markdown).not.toContain("0 done");
		expect(renderRoadmapMarkdown(worklist([goal({ id: "only", title: "Only" })]))).toContain(
			"1 goal: 1 open.",
		);
	});

	it("names every dependency with the state of the goal it names", () => {
		const markdown = renderRoadmapMarkdown(
			worklist([
				goal({ id: "landed", title: "Landed", status: "done" }),
				goal({ id: "pending", title: "Pending" }),
				goal({ id: "waiting", title: "Waiting", dependsOn: ["landed", "pending", "deleted-goal"] }),
			]),
		);
		// One line naming the whole set in stored order, indented into the item. The
		// dangling edge is called out rather than dropped: it can only come from a
		// hand-edited file, and reading it as satisfied would quietly release a goal
		// nothing ever finished.
		expect(markdown).toContain(
			"\n  Depends on `landed` (done), `pending` (open), `deleted-goal` (missing).\n",
		);
		// A goal with no edges says nothing about dependencies at all.
		const independent = renderRoadmapMarkdown(worklist([goal({ id: "alone", title: "Alone" })]));
		expect(independent).not.toContain("Depends on");
	});

	it("resolves an edge naming an ID its goal has since been renamed off", () => {
		const markdown = renderRoadmapMarkdown(
			worklist([
				goal({ id: "renamed", title: "Renamed", status: "done", previousIds: ["goal-abc123"] }),
				goal({ id: "waiting", title: "Waiting", dependsOn: ["goal-abc123"] }),
			]),
		);
		expect(markdown).toContain("Depends on `goal-abc123` (done).");
		expect(itemLine(markdown, "waiting")).toBe("- **[open]** Waiting - `waiting`");
	});

	it("keeps a description's own paragraphs and lists inside the goal's item", () => {
		const markdown = renderRoadmapMarkdown(
			worklist([
				goal({
					id: "detailed",
					title: "Detailed",
					description: "First paragraph.\n\nEvidence:\n- one \n- two\n\n",
					dependsOn: [],
				}),
			]),
		);
		expect(markdown).toContain(
			[
				"- **[open]** Detailed - `detailed`",
				"",
				"  First paragraph.",
				"",
				"  Evidence:",
				"  - one",
				"  - two",
			].join("\n"),
		);
		// A blank line inside a description stays empty rather than carrying the indent.
		expect(markdown).not.toMatch(/ +$/m);
	});

	it("flattens a title so a stored newline cannot break the item line", () => {
		const markdown = renderRoadmapMarkdown(
			worklist([goal({ id: "multiline", title: "Broken\ntitle   with   space" })]),
		);
		expect(itemLine(markdown, "multiline")).toBe("- **[open]** Broken title with space - `multiline`");
	});

	it("ends with exactly one newline and no trailing blank line", () => {
		const markdown = renderRoadmapMarkdown(
			worklist([goal({ id: "last", title: "Last", description: "Prose." })]),
		);
		expect(markdown.endsWith("\n")).toBe(true);
		expect(markdown.endsWith("\n\n")).toBe(false);
	});
});
