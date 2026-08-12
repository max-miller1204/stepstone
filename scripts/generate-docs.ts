/**
 * Writes every artifact generated from src/cli-contract.ts, refreshes only the
 * marker-delimited Stepstone block in this repository's AGENTS.md, and renders
 * the roadmap from this repository's own goal file.
 *
 *   npm run docs         # write the files
 *   npm run docs:check   # exit 1 if a committed file is stale
 *
 * The committed files are also asserted byte-for-byte in test/cli-contract.test.ts
 * and test/roadmap.test.ts, so CI catches drift through `npm run check` even
 * without the explicit check.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { AGENTS_PATH, AgentsBlockError, agentsFileNeedsRefresh, refreshAgentsFile } from "../src/agents.ts";
import { DOCS_PATH, renderCliGuide, renderSkillMarkdown, SKILL_PATH } from "../src/cli-contract.ts";
import { createWorklistLocator } from "../src/git.ts";
import { readProjectWorklist } from "../src/project-store.ts";
import { ROADMAP_PATH, renderRoadmapMarkdown } from "../src/roadmap.ts";

const repoRoot = resolve(import.meta.dirname, "..");

/**
 * This repository's goals, read through the resolution order every interface
 * shares rather than by joining the path here.
 *
 * A read that fails, and a read that finds no file at all, both stop the run:
 * writing a roadmap from the empty worklist either one reports would silently
 * replace the committed page with an empty one, which is the shape of the goal
 * file's own data loss. A missing file is not an error to `readProjectWorklist`,
 * because a repository writes its first goal into a file that is not there yet,
 * so the requirement this page adds - the goals it projects have to exist - is
 * stated here rather than assumed from the absence of an error.
 */
const located = createWorklistLocator(repoRoot)();
if (located.notice) process.stderr.write(`${located.notice}\n`);
if (!existsSync(located.path)) {
	process.stderr.write(`No goal file at ${located.path}; refusing to blank ${ROADMAP_PATH}.\n`);
	process.exit(1);
}
const worklist = await readProjectWorklist(located.path);
if (worklist.error) {
	process.stderr.write(`${worklist.error}\n`);
	process.exit(1);
}

const artifacts = [
	{ path: DOCS_PATH, render: renderCliGuide },
	{ path: SKILL_PATH, render: renderSkillMarkdown },
	{ path: ROADMAP_PATH, render: () => renderRoadmapMarkdown(worklist.data) },
];
const check = process.argv.includes("--check");
const stale: string[] = [];

for (const artifact of artifacts) {
	const target = resolve(repoRoot, artifact.path);
	const expected = artifact.render();
	if (check) {
		// Each artifact is read independently; sequential execution keeps output readable.
		// pi-lens-ignore: await-in-loop
		const actual = await readFile(target, "utf8").catch(() => null);
		if (actual !== expected) {
			stale.push(artifact.path);
		}
		continue;
	}
	// pi-lens-ignore: await-in-loop
	await mkdir(dirname(target), { recursive: true });
	// pi-lens-ignore: await-in-loop
	await writeFile(target, expected, "utf8");
	process.stdout.write(`Wrote ${target}\n`);
}

/**
 * A marker layout, encoding, or file type no regeneration can resolve, reported
 * as this script's own failure rather than as an unhandled rejection: the file
 * holds authored prose, so naming what has to be repaired by hand is the whole
 * of the remedy.
 */
try {
	if (check) {
		if (await agentsFileNeedsRefresh(repoRoot)) stale.push(AGENTS_PATH);
	} else {
		const refreshed = await refreshAgentsFile(repoRoot);
		process.stdout.write(
			refreshed.changed
				? `Refreshed the generated Stepstone block in ${refreshed.path}\n`
				: `Generated Stepstone block is up to date in ${refreshed.path}\n`,
		);
	}
} catch (error) {
	if (!(error instanceof AgentsBlockError)) throw error;
	process.stderr.write(`${error.message}\nRepair it by hand, then rerun.\n`);
	process.exit(1);
}

if (check) {
	if (stale.length > 0) {
		process.stderr.write(
			`Stale generated file(s): ${stale.join(", ")}\nRun \`npm run docs\` and commit the result.\n`,
		);
		process.exit(1);
	}
	process.stdout.write("Generated files are up to date.\n");
}
