import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseTape, selectScenarios } from "./contract.mjs";

const tape = await readFile(new URL("./scenarios/workspace-lifecycle/demo.tape", import.meta.url), "utf8");

test("the scenario extracts complete shell commands and render dimensions", () => {
	const result = parseTape(tape);
	assert.equal(result.width, 1600);
	assert.equal(result.height, 1000);
	assert.equal(result.fps, 30);
	assert.ok(result.commands.join("\n").includes('inspect "$run" guide --json \\\n  | jq'));
	assert.ok(
		result.commands.includes(
			'test "$(cat ../workspaces/stepstone-guide/draft.md)" = "Unfinished release notes"',
		),
	);
});

test("scenario selection refuses unknown names and path traversal", () => {
	assert.deepEqual(selectScenarios(["workspace-lifecycle"], "all"), ["workspace-lifecycle"]);
	assert.deepEqual(selectScenarios(["workspace-lifecycle"], "workspace-lifecycle"), ["workspace-lifecycle"]);
	for (const name of ["missing", "../workspace-lifecycle", "foo/bar", "--help"]) {
		assert.throws(() => selectScenarios(["workspace-lifecycle"], name));
	}
});

test("unknown VHS commands cannot be silently omitted from verification", () => {
	for (const line of ["Ctrl+C", "Enter", 'Type "different quoting" Enter', "Source hidden.tape"]) {
		assert.throws(() => parseTape(`${tape}\n${line}\n`), /Unsupported tape line/);
	}
});

test("output paths, duplicate settings, and odd video dimensions fail", () => {
	assert.throws(() => parseTape(tape.replace("Output frames/", "Output elsewhere.mp4")), /Unsupported/);
	assert.throws(() => parseTape(`${tape}\nSet Width 1600\n`), /Duplicate/);
	assert.throws(() => parseTape(tape.replace("Set Width 1600", "Set Width 1599")), /even/);
	assert.throws(() => parseTape(tape.replace("Set Framerate 30", "Set Framerate 100")), /Framerate/);
});

test("error propagation and completion cannot be omitted", () => {
	assert.throws(() => parseTape(tape.replace("Type `set -euo pipefail` Enter", "")), /fail on/);
	assert.throws(
		() => parseTape(tape.replace('Type `touch "$VIDEO_WORKSPACE/complete"` Enter', "")),
		/completion/,
	);
});
