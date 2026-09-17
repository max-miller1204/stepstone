import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const log = (await readFile(process.env.VIDEO_COMMAND_LOG, "utf8"))
	.trim()
	.split("\n")
	.map((line) => JSON.parse(line));
assert.deepEqual(
	log.map(({ args }) => args.slice(0, 2).join(" ")),
	[
		"project show",
		"project workspace",
		"project start",
		"project complete",
		"project complete",
		"project ready",
	],
);
assert.deepEqual(
	log.map(({ status }) => status),
	[0, 2, 2, 3, 0, 0],
);
assert.equal(JSON.parse(log[0].stdout).result.goal.branch, "feature/guide");
for (const entry of log.slice(1, 3)) assert.match(entry.stderr, /removed|retired|no longer/i);
assert.match(log[5].stdout, /publish/i);
const fixture = process.env.VIDEO_WORKSPACE;
const repo = join(fixture, "repo");
assert.equal(await readFile(join(fixture, "existing/STEPSTONE_GOAL.md"), "utf8"), "Existing handoff\n");
assert.equal(await readFile(join(fixture, "existing/draft.md"), "utf8"), "Unfinished draft\n");
assert.equal(
	await readFile(join(repo, ".git/stepstone-dispatch/preserved-run.json"), "utf8"),
	'{"version":2,"id":"preserved-run"}\n',
);
assert.equal(
	await readFile(join(repo, ".git/stepstone-dispatch/workspaces/preserved-owner.json"), "utf8"),
	'{"marker":"preserved-owner"}\n',
);
const ownerDirectory = execFileSync(
	"git",
	["-C", join(fixture, "existing"), "rev-parse", "--absolute-git-dir"],
	{ encoding: "utf8" },
).trim();
assert.equal(
	await readFile(join(ownerDirectory, "stepstone-dispatch-owner.json"), "utf8"),
	'{"runId":"preserved-run","goalId":"guide"}\n',
);
const worktrees = execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"], { encoding: "utf8" });
assert.equal(worktrees.split("\n").filter((line) => line.startsWith("worktree ")).length, 2);
assert.match(worktrees, /branch refs\/heads\/feature\/guide/);
const worklist = JSON.parse(await readFile(join(repo, ".worklist/worklist.json"), "utf8"));
assert.equal(worklist.goals.find((goal) => goal.id === "guide").status, "done");
assert.deepEqual(worklist.goals.find((goal) => goal.id === "publish").dependsOn, ["guide"]);
console.log("Verified removed commands, preserved resources, tracker claims, and explicit completion.");
