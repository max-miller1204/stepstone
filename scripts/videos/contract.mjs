import assert from "node:assert/strict";

export const VHS_VERSION = "0.12.0";

export function selectScenarios(available, requested) {
	assert.ok(available.length > 0, "No video scenarios found.");
	if (requested === undefined || requested === "all") return available;
	assert.match(requested, /^[a-z][a-z0-9-]*$/, "Invalid scenario name.");
	assert.ok(available.includes(requested), `Unknown video scenario: ${requested}`);
	return [requested];
}

/** Replay only the documented shell-command subset of VHS. Reject other input. */
export function parseTape(source) {
	const commands = [];
	const settings = new Map();
	let outputs = 0;
	for (const [index, line] of source.split("\n").entries()) {
		if (!line.trim() || line.startsWith("#")) continue;
		if (line === "Output frames/") {
			outputs++;
			continue;
		}
		const typed = /^Type `([^`]*)` Enter$/.exec(line);
		if (typed) {
			commands.push(typed[1]);
			continue;
		}
		const setting = /^Set (\w+) (.+)$/.exec(line);
		if (setting) {
			assert.ok(!settings.has(setting[1]), `Duplicate setting: ${setting[1]}`);
			settings.set(setting[1], setting[2]);
			continue;
		}
		if (/^(Hide|Show|Require [a-z][a-z0-9-]*|Sleep [0-9]+(?:ms|s))$/.test(line)) continue;
		throw new Error(`Unsupported tape line ${index + 1}: ${line}`);
	}
	assert.equal(outputs, 1, "Tape must write exactly one Output frames/ directory.");
	assert.equal(settings.get("Shell"), '"bash"', "Tape must use Bash.");
	assert.ok(commands.length > 0, "Tape has no commands.");
	const number = (key) => {
		assert.match(settings.get(key) ?? "", /^\d+$/, `Missing integer setting: ${key}`);
		const value = Number(settings.get(key));
		assert.ok(value > 0 && value <= 4096, `Invalid setting: ${key}`);
		return value;
	};
	const width = number("Width");
	const height = number("Height");
	const fps = number("Framerate");
	assert.equal(width % 2, 0, "Width must be even for H.264.");
	assert.equal(height % 2, 0, "Height must be even for H.264.");
	assert.ok(fps <= 60, "Framerate must not exceed 60.");
	assert.equal(commands[0], "set -euo pipefail", "Tape must fail on shell and pipeline errors.");
	assert.equal(
		commands.at(-1),
		'touch "$VIDEO_WORKSPACE/complete"',
		"Tape must end with its completion marker.",
	);
	return { commands, width, height, fps };
}
