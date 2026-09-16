import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const log = (await readFile(process.env.VIDEO_COMMAND_LOG, "utf8"))
	.trim()
	.split("\n")
	.map((line) => JSON.parse(line));
assert.equal(log.length, 11, "Expected the complete recorded CLI workflow.");
assert.deepEqual(
	log.map(({ args }) => args.slice(0, args[1] === "workspace" ? 3 : 2).join(" ")),
	[
		"project ready",
		"project workspace start",
		"project workspace status",
		"project workspace status",
		"project workspace inspect",
		"project workspace inspect",
		"project workspace recover",
		"project workspace cleanup",
		"project ready",
		"project workspace cleanup",
		"project workspace status",
	],
);
for (const entry of log) {
	assert.equal(entry.status, 0, `CLI failed: ${entry.args.join(" ")}`);
	assert.equal(entry.stderr, "", "Unexpected CLI diagnostic.");
}
assert.match(log[1].stdout, /Prepared: guide\./);
const fresh = JSON.parse(log[4].stdout).result.claimEvidence;
assert.equal(fresh.assessment, "recent-claim");
assert.equal(fresh.canonical.state, "matches");
assert.equal(fresh.workspace.hasUncommittedChanges, false);
assert.equal(JSON.parse(log[5].stdout).result.claimEvidence.workspace.hasUncommittedChanges, true);
assert.match(log[6].stdout, /cleanup-pending/);
assert.match(log[6].stdout, /draft\.md/);
assert.match(log[7].stdout, /guide: cleaned: Released and cleaned\./);
assert.match(log[8].stdout, /\[open\] guide: Guide/);
assert.deepEqual(JSON.parse(log[10].stdout).result, []);
const repo = join(process.env.VIDEO_WORKSPACE, "repo");
const worktrees = execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"], { encoding: "utf8" });
assert.equal(worktrees.split("\n").filter((line) => line.startsWith("worktree ")).length, 1);
assert.equal(
	execFileSync("git", ["-C", repo, "branch", "--list", "stepstone/guide"], { encoding: "utf8" }),
	"",
);
console.log("Verified preparation, inspection, dirty-work refusal, release, cleanup, and run removal.");
