import { GENERATOR_PATH, WORKLIST_RELATIVE_PATH } from "./cli-contract.ts";
import { isGoalBlocked, resolveDependencies } from "./dependencies.ts";
import { compactDescription, goalCount, goalSection, goalStatusCounts } from "./format.ts";
import type { ProjectGoal, ProjectWorklist } from "./types.ts";

/**
 * The roadmap page, rendered from a repository's own goal file.
 *
 * The goal file is the roadmap and this page is a projection of it, so the
 * render is pure: it takes a worklist and returns Markdown, while the generator
 * script owns reading the file. That keeps the page derivable from a worklist a
 * test holds in memory, and keeps this module out of the resolution order every
 * interface shares.
 *
 * Nothing here is a second opinion about goals. Status, blocked, and the edges a
 * goal waits on all come from the helpers every other interface reads them
 * through, so a goal that reads as blocked at the terminal cannot read as ready
 * on GitHub.
 */

/** Repository-relative path of the generated roadmap page. */
export const ROADMAP_PATH = "docs/ROADMAP.md";

/**
 * Section a goal lands in when it names no group.
 *
 * A group exists exactly when some goal names it, so there is no list of groups
 * to consult and no group a goal belongs to by default. The page still has to
 * carry those goals, and naming the section for what it is beats filing them
 * under whichever group happens to be declared first.
 */
const UNGROUPED_HEADING = "Ungrouped";

/** Indent that keeps a continuation block inside the list item it belongs to. */
const ITEM_INDENT = "  ";

/** One heading and the goals filed under it, in canonical file order. */
interface RoadmapSection {
	heading: string;
	goals: ProjectGoal[];
}

/**
 * The page's sections, in the order their groups first appear in the file.
 *
 * File order is the roadmap's own order, so sections follow it rather than being
 * sorted: a group is placed by the first goal that names it, and the goals
 * inside one stay in the order somebody arranged them in.
 */
function roadmapGroupHeading(group: string): string {
	return group
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.join(" ");
}

function roadmapSections(goals: readonly ProjectGoal[]): RoadmapSection[] {
	const sections = new Map<string, RoadmapSection>();
	for (const goal of goals) {
		const section = goalSection(goal);
		const key = section ?? UNGROUPED_HEADING;
		const heading = section === undefined ? UNGROUPED_HEADING : roadmapGroupHeading(section);
		const existing = sections.get(key) ?? { heading, goals: [] };
		existing.goals.push(goal);
		sections.set(key, existing);
	}
	return [...sections.values()];
}

/**
 * One line naming how much of the roadmap sits in each state.
 *
 * The counts and the order they read in come from the shared helper the board
 * header counts through, so the page and the terminal cannot state the same
 * roadmap's shape differently, and the total here stays the sum of the parts.
 */
function renderSummary(goals: readonly ProjectGoal[]): string {
	if (goals.length === 0) return "No project goals.";
	const counted = goalStatusCounts(goals);
	return `${goalCount(goals.length)}: ${counted.map(({ status, count }) => `${count} ${status}`).join(", ")}.`;
}

/**
 * A goal's state as the page states it: its status, and whether it is waiting.
 *
 * Blocked is derived from the edges on every read rather than stored, so it is
 * computed here from the goals the page was handed instead of read off a field.
 */
function renderStatus(
	goals: readonly ProjectGoal[],
	goal: ProjectGoal,
	retiredIds: readonly string[],
): string {
	return isGoalBlocked(goals, goal, retiredIds) ? `${goal.status}, blocked` : goal.status;
}

/**
 * What a goal waits on, each edge named with the state of the goal it names.
 *
 * An edge that resolves to nothing is called out as missing rather than dropped:
 * it can only come from a hand-edited file, and it holds its dependent forever.
 */
function renderDependencies(
	goals: readonly ProjectGoal[],
	goal: ProjectGoal,
	retiredIds: readonly string[],
): string | undefined {
	const dependencies = resolveDependencies(goals, goal, retiredIds);
	if (dependencies.length === 0) return undefined;
	const named = dependencies.map((entry) => `\`${entry.id}\` (${entry.goal?.status ?? "missing"})`);
	return `Depends on ${named.join(", ")}.`;
}

/**
 * A description, indented to stay inside the list item it describes.
 *
 * Descriptions are free-form prose somebody typed, sometimes several paragraphs
 * and sometimes a list, so the structure is preserved and only indented. A blank
 * line stays empty, because indentation on it would be trailing whitespace no
 * reader asked for.
 */
function renderDescription(description: string): string[] {
	return description
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => (line.trim() === "" ? "" : `${ITEM_INDENT}${line.trimEnd()}`));
}

/** One goal: its state and identity on the item line, everything else beneath. */
function renderGoal(
	goals: readonly ProjectGoal[],
	goal: ProjectGoal,
	retiredIds: readonly string[],
): string[] {
	// The title is flattened because the item line is the goal's identity: a
	// stored newline would break it in half and the tail would read as prose.
	const title = compactDescription(goal.title);
	const lines = [`- **[${renderStatus(goals, goal, retiredIds)}]** ${title} - \`${goal.id}\``];
	const description = goal.description?.trim();
	if (description) lines.push("", ...renderDescription(description));
	const dependencies = renderDependencies(goals, goal, retiredIds);
	if (dependencies) lines.push("", `${ITEM_INDENT}${dependencies}`);
	return lines;
}

/**
 * The whole roadmap page, written to ROADMAP_PATH by the generator.
 *
 * The header says outright that a description is a record rather than an
 * instruction, because goal prose is data the documentation sweep exempts from
 * the names the contract renders: an old description may still spell a path or a
 * package a rename has since moved, and a reader here has no other way to know
 * that the page is quoting the roadmap rather than telling them what to type.
 */
export function renderRoadmapMarkdown(worklist: ProjectWorklist): string {
	const { goals } = worklist;
	const retiredIds = worklist.retiredIds ?? [];
	const sections = roadmapSections(goals).flatMap((section) => [
		`## ${section.heading}`,
		"",
		...section.goals.flatMap((goal) => [...renderGoal(goals, goal, retiredIds), ""]),
	]);
	return [
		`<!-- Generated from ${WORKLIST_RELATIVE_PATH} by ${GENERATOR_PATH}. Do not edit manually. -->`,
		"",
		"# Roadmap",
		"",
		`Every Project Goal in this repository, rendered from \`${WORKLIST_RELATIVE_PATH}\` so the roadmap reads here without a terminal.`,
		"Each section is a group goals are filed under, and the goals inside one are in the roadmap's canonical file order.",
		"Every goal states its status, whether the dependency graph has it waiting, and the goals it waits on.",
		"A goal's description is a record of what was decided when it was written rather than a current instruction, so an older one may still name a path, a package, or a directory this project has since renamed.",
		"",
		renderSummary(goals),
		"",
		...sections,
	].join("\n");
}
