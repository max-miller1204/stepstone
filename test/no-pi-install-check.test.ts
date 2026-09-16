import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..");
const script = join(repoRoot, "scripts", "no-pi-install-check.ts");

interface NpmCall {
	args: string[];
	cwd: string;
	execPath: string;
}

let root: string;
let npmEntry: string;

beforeEach(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "stepstone-script-test-")));
	npmEntry = join(root, "parent npm & implementation.cjs");
	await writeFile(join(root, "package.json"), '{"type":"commonjs"}\n');
	await mkdir(join(root, "bin"));
	await mkdir(join(root, "scratch"));
	// No real pack/build runs here: those must not race the compiled CLI suite.
	// This npm records both setup commands and deliberately fails at install.
	await writeFile(
		npmEntry,
		`const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.NPM_CALL_LOG, JSON.stringify({ args, cwd: process.cwd(), execPath: process.execPath }) + "\\n");
if (args[0] === "pack") {
	fs.writeFileSync(path.join(args[2], "fixture.tgz"), "fixture");
} else {
	console.error("FIXTURE_INSTALL_FAILURE");
	process.exit(47);
}
`,
	);
	for (const command of ["npm", "node"]) {
		await writeFile(join(root, "bin", command), "#!/bin/sh\necho WRONG_PATH_COMMAND >&2\nexit 42\n", {
			mode: 0o755,
		});
	}
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

function runCheck(npmExecpath: string | undefined, platform?: string) {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		PATH: join(root, "bin"),
		TMPDIR: join(root, "scratch"),
		TMP: join(root, "scratch"),
		TEMP: join(root, "scratch"),
		NPM_CALL_LOG: join(root, "npm-calls.jsonl"),
	};
	if (npmExecpath === undefined) delete env.npm_execpath;
	else env.npm_execpath = npmExecpath;
	const args = platform
		? [
				"--input-type=module",
				"--eval",
				`Object.defineProperty(process, "platform", { value: ${JSON.stringify(platform)} });
await import(${JSON.stringify(pathToFileURL(script).href)});`,
			]
		: [script];
	return spawnSync(process.execPath, args, { cwd: repoRoot, env, encoding: "utf8", timeout: 10_000 });
}

async function expectSetupCalls() {
	const calls = (await readFile(join(root, "npm-calls.jsonl"), "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as NpmCall);
	expect(calls).toHaveLength(2);
	const [pack, install] = calls as [NpmCall, NpmCall];
	expect(pack).toEqual({
		args: ["pack", "--pack-destination", expect.any(String)],
		cwd: await realpath(repoRoot),
		execPath: process.execPath,
	});
	expect(install).toEqual({
		args: [
			"install",
			join(pack.args[2] as string, "fixture.tgz"),
			"--omit=dev",
			"--omit=peer",
			"--offline",
			"--no-audit",
			"--no-fund",
			"--loglevel=error",
		],
		cwd: resolve(pack.args[2] as string, "..", "install"),
		execPath: process.execPath,
	});
}

describe("no-Pi check npm children", () => {
	it("uses the parent npm entry with the current Node even when PATH shadows npm and node", async () => {
		const result = runCheck(npmEntry);
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("FIXTURE_INSTALL_FAILURE");
		expect(result.stderr).not.toContain("WRONG_PATH_COMMAND");
		await expectSetupCalls();
	});

	it("falls back to npm on PATH when npm_execpath is unset", async () => {
		await writeFile(join(root, "bin", "npm"), `#!${process.execPath}\n${await readFile(npmEntry, "utf8")}`, {
			mode: 0o755,
		});
		const result = runCheck(undefined);
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("FIXTURE_INSTALL_FAILURE");
		await expectSetupCalls();
	});

	it.each(["missing.cjs", ""])("does not fall back for a configured invalid npm path: %j", (path) => {
		const result = runCheck(path === "" ? "" : join(root, path));
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("no-pi-install check failed");
		expect(result.stderr).not.toContain("WRONG_PATH_COMMAND");
	});
});

it.each([true, false])("refuses Windows before setup (parent npm configured: %s)", async (configured) => {
	const result = runCheck(configured ? npmEntry : undefined, "win32");
	expect(result.error).toBeUndefined();
	expect(result.status).toBe(1);
	expect(result.stdout).toBe("");
	expect(result.stderr).toContain("no-pi-install check does not support Windows");
	expect(result.stderr).toMatch(/Node.*\.bat.*\.cmd.*without a shell/);
	expect(result.stderr).toContain("Windows CI");
	expect(result.stderr).not.toContain("EINVAL");
	expect(await readdir(join(root, "scratch"))).toEqual([]);
});
