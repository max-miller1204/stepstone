import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const root = process.env.VIDEO_REPOSITORY;
const log = process.env.VIDEO_COMMAND_LOG;
if (!root || !log) throw new Error("Run the video CLI through scripts/videos/run.mjs.");
const args = process.argv.slice(2);
const result = spawnSync(process.execPath, [join(root, "dist/cli.js"), ...args], {
	encoding: "utf8",
	timeout: 30000,
	maxBuffer: 10 * 1024 * 1024,
});
if (result.error) throw result.error;
if (result.signal || result.status === null) throw new Error(`CLI interrupted: ${result.signal}`);
appendFileSync(
	log,
	`${JSON.stringify({ args, cwd: process.cwd(), status: result.status, stdout: result.stdout, stderr: result.stderr })}\n`,
);
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.status;
