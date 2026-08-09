#!/usr/bin/env node
/**
 * The deprecated `pi-worklist` bin, forwarding to the `stepstone` CLI.
 *
 * Importing the CLI entry point runs it: it parses `process.argv` and exits at
 * the top level, so this shim adds no argument handling of its own and cannot
 * fall behind the real command surface.
 */
import { writeSync } from "node:fs";

// Only a human sees this. The CLI writes its `--json` failure envelope to
// stderr, so prepending a line whenever stderr is redirected would break every
// script that parses it - which is exactly the audience still on this alias.
if (process.stderr.isTTY) {
	writeSync(2, "pi-worklist has been renamed to stepstone. Run stepstone instead; this alias is frozen.\n");
}

await import("stepstone/cli");
