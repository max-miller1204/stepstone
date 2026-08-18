/**
 * Proves the published tarball runs with nothing installed but Node.
 *
 *   npm run no-pi-install:check
 *
 * This repository installs every Pi peer as a devDependency, so a Pi import
 * that leaked into an executable path resolves in this checkout and fails only
 * for someone running the published package without Pi. The check therefore
 * refuses to trust the local tree: it packs the real tarball, installs it into a
 * scratch directory with no dev dependencies and no Pi packages, and drives
 * every executable, asserting behavior rather than only that a process started.
 *
 * Which executables those are comes from package.json's `bin` map rather than
 * from a list written here, so a newly published bin cannot be packed and left
 * unstarted by a check that does not know it exists.
 *
 * scripts/cli-import-graph.ts catches the same regression from the sources in
 * milliseconds; this is the slower proof that the tarball a user downloads
 * actually works.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { CLI_COMMAND_CONTRACT, DISPATCH_BINARY } from "../src/cli-contract.ts";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "..");
const { binary } = CLI_COMMAND_CONTRACT;

interface CliResult {
	code: number;
	stdout: string;
	stderr: string;
}

interface Envelope {
	ok: boolean;
	scope: string;
	action: string;
	result?: Record<string, unknown>;
	error?: { code: string };
	meta?: { cliVersion?: string; changed?: boolean };
}

/** An envelope the CLI reported as a success, so `result` and `meta` are there. */
interface SuccessEnvelope extends Envelope {
	result: Record<string, unknown>;
	meta: { cliVersion?: string; changed?: boolean };
}

/** Drives one installed executable in a scratch repository of its own. */
type BinExercise = (binPath: string, workspace: string, version: string) => Promise<void>;

// `execFile` hands the child a stdin pipe nothing ever ends, so a bin that reads
// stdin instead of exiting would leave this job hanging until the CI runner's
// own timeout. Bounding every child turns that back into a failed assertion.
const SETUP_TIMEOUT_MS = 10 * 60_000;
const CLI_TIMEOUT_MS = 60_000;

function step(message: string): void {
	process.stdout.write(`${message}\n`);
}

/** Reports a child killed for outlasting its budget as the failure it is. */
function assertNotTimedOut(error: unknown, command: string, timeoutMs: number): void {
	const failure = error as { killed?: boolean; code?: unknown };
	if (failure.killed !== true && failure.code !== "ETIMEDOUT") return;
	throw new Error(
		`\`${command}\` was killed after ${Math.round(timeoutMs / 1000)}s without exiting. The installed bin has ` +
			"to run to completion with no input, so something on this path is waiting on stdin or blocked.",
	);
}

async function run(command: string, args: string[], cwd: string): Promise<void> {
	try {
		await execFileAsync(command, args, { cwd, maxBuffer: 32 * 1024 * 1024, timeout: SETUP_TIMEOUT_MS });
	} catch (error) {
		assertNotTimedOut(error, `${command} ${args.join(" ")}`, SETUP_TIMEOUT_MS);
		throw error;
	}
}

/** Packs the tarball the way publishing does, prepack build included. */
async function packTarball(destination: string): Promise<string> {
	await run("npm", ["pack", "--pack-destination", destination], repoRoot);
	const packed = (await readdir(destination)).filter((entry) => entry.endsWith(".tgz"));
	assert.equal(packed.length, 1, `expected exactly one packed tarball, got ${packed.join(", ") || "none"}`);
	return join(destination, packed[0] as string);
}

/**
 * Installs the tarball on its own. Every Pi peer is declared optional, so npm
 * leaves them out unless something already depends on them, and `--omit=peer`
 * keeps that true even if that ever changes.
 *
 * `--offline` is a second assertion rather than a convenience: every runtime
 * dependency is bundled into the tarball, so an install that still needs the
 * registry is an install that would fail for someone without one. It is also
 * what lets the pre-push hook, which runs this check, promise that it reaches
 * no network at all.
 */
async function installTarball(tarball: string, installDir: string): Promise<void> {
	const manifest = { name: "no-pi-install-fixture", version: "0.0.0", private: true };
	await writeFile(join(installDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
	await run(
		"npm",
		[
			"install",
			tarball,
			"--omit=dev",
			"--omit=peer",
			"--offline",
			"--no-audit",
			"--no-fund",
			"--loglevel=error",
		],
		installDir,
	);
}

/** Fails on a Pi package anywhere in the installed tree, hoisted or nested. */
async function assertNoPiPackages(installDir: string): Promise<void> {
	const modules = join(installDir, "node_modules");
	const entries = await readdir(modules, { recursive: true });
	const pi = entries.filter((entry) => entry.split(/[\\/]/).includes("@earendil-works"));
	assert.deepEqual(pi, [], "the installed tree must contain no Pi packages");
	step(
		`  installed ${entries.filter((entry) => entry.endsWith("package.json")).length} packages, none from Pi`,
	);
}

const UNRESOLVED_IMPORT = /Cannot find (?:package|module) '([^']+)'/;

/**
 * Turns the one failure this check exists to catch into a sentence. Without it
 * a leaked Pi import surfaces as an exit code mismatch under a resolver stack,
 * which reads as a broken test rather than as the shipped bin being unusable.
 */
function assertNothingUnresolved(command: string, stderr: string): void {
	// `MODULE_NOT_FOUND` covers both spellings Node prints: the ESM
	// `ERR_MODULE_NOT_FOUND` and the bare CJS code a `createRequire` call raises.
	if (!stderr.includes("MODULE_NOT_FOUND") && !stderr.includes("ERR_REQUIRE_ESM")) return;
	// The resolver line names both the package and the compiled file that wanted
	// it; the stack under it is all Node internals.
	const detail =
		stderr
			.split("\n")
			.find((line) => UNRESOLVED_IMPORT.test(line))
			?.trim() ?? stderr.trim();
	const missing = UNRESOLVED_IMPORT.exec(detail)?.[1] ?? "a package outside its dependencies";
	throw new Error(
		`${detail}\n\n` +
			`\`${command}\` cannot load ${missing} from a Pi-free install, which is how the published ` +
			"executables are installed. Something reachable from its source entry imports it at runtime: " +
			"run `npm run imports:check` to name the module, then make that import type-only or move it " +
			"out of the executable graph.",
	);
}

function cliRunner(binPath: string, cwd: string) {
	// The bin's own name, so a failure names the command that was actually run
	// without spelling the published name here as a literal.
	const command = basename(binPath);
	return async function runCli(args: string[]): Promise<CliResult> {
		const invocation = `${command} ${args.join(" ")}`;
		try {
			const { stdout, stderr } = await execFileAsync(binPath, args, {
				cwd,
				maxBuffer: 32 * 1024 * 1024,
				timeout: CLI_TIMEOUT_MS,
			});
			assertNothingUnresolved(invocation, stderr);
			return { code: 0, stdout, stderr };
		} catch (error) {
			assertNotTimedOut(error, invocation, CLI_TIMEOUT_MS);
			const failure = error as CliResult & { code: number | null };
			if (typeof failure.stderr !== "string") throw error;
			assertNothingUnresolved(invocation, failure.stderr);
			return { code: failure.code ?? 1, stdout: failure.stdout, stderr: failure.stderr };
		}
	};
}

function parseEnvelope(text: string, label: string): Envelope {
	try {
		return JSON.parse(text) as Envelope;
	} catch (error) {
		throw new Error(`${label} did not print a JSON envelope:\n${text}`, { cause: error });
	}
}

/**
 * Reads a successful envelope off stdout. A Pi peer reaching the bin surfaces
 * here as a module-not-found stack on stderr, so the stream check is what turns
 * that into a clear failure instead of a confusing parse error.
 */
function okEnvelope(result: CliResult, action: string, version: string): SuccessEnvelope {
	assert.equal(result.code, 0, `project ${action} exited ${result.code}\n${result.stderr}`);
	const envelope = parseEnvelope(result.stdout, `project ${action}`);
	assert.deepEqual(
		{
			ok: envelope.ok,
			scope: envelope.scope,
			action: envelope.action,
			cliVersion: envelope.meta?.cliVersion,
		},
		{ ok: true, scope: "project", action, cliVersion: version },
	);
	assert.ok(envelope.result, `project ${action} reported success without a result`);
	assert.ok(envelope.meta, `project ${action} reported success without meta`);
	return envelope as SuccessEnvelope;
}

/** Reads a failure envelope off stderr, where the CLI contract puts it. */
function failedEnvelope(result: CliResult, action: string, code: number, errorCode: string): Envelope {
	assert.equal(result.code, code, `project ${action} exited ${result.code}, expected ${code}`);
	assert.equal(result.stdout, "", `project ${action} must keep a failure off stdout`);
	const envelope = parseEnvelope(result.stderr, `project ${action}`);
	assert.deepEqual(
		{ ok: envelope.ok, action: envelope.action, code: envelope.error?.code },
		{ ok: false, action, code: errorCode },
	);
	return envelope;
}

function goalIds(envelope: SuccessEnvelope): string[] {
	return (envelope.result.goals as Array<{ id: string }>).map((goal) => goal.id);
}

/** Drives the whole read, write, sequencing, and refusal surface of the bin. */
async function exerciseCli(binPath: string, workspace: string, version: string): Promise<void> {
	const runCli = cliRunner(binPath, workspace);
	const worklistPath = join(workspace, ".worklist", "worklist.json");

	step("  list, add, show, find");
	assert.deepEqual(goalIds(okEnvelope(await runCli(["project", "list", "--json"]), "list", version)), []);

	const added = okEnvelope(
		await runCli(["project", "add", "Alpha goal", "--description", "First goal", "--json"]),
		"add",
		version,
	);
	const { createdAt, updatedAt, ...storedGoal } = added.result.goal as Record<string, unknown>;
	assert.deepEqual(storedGoal, {
		id: "alpha-goal",
		title: "Alpha goal",
		description: "First goal",
		status: "open",
	});
	for (const stamp of [createdAt, updatedAt]) assert.match(String(stamp), /^\d{4}-\d{2}-\d{2}T.*Z$/);
	assert.equal(added.meta.changed, true);

	okEnvelope(
		await runCli(["project", "add", "Beta goal", "--depends-on", "alpha-goal", "--json"]),
		"add",
		version,
	);
	assert.deepEqual(goalIds(okEnvelope(await runCli(["project", "list", "--json"]), "list", version)), [
		"alpha-goal",
		"beta-goal",
	]);

	const shown = okEnvelope(await runCli(["project", "show", "alpha", "--json"]), "show", version);
	assert.equal((shown.result.goal as { description: string }).description, "First goal");

	assert.deepEqual(
		goalIds(okEnvelope(await runCli(["project", "find", "Beta", "--json"]), "find", version)),
		["beta-goal"],
	);

	step("  next, ready, waves");
	const next = okEnvelope(await runCli(["project", "next", "--json"]), "next", version);
	assert.equal((next.result.goal as { id: string }).id, "alpha-goal");
	assert.deepEqual(goalIds(okEnvelope(await runCli(["project", "ready", "--json"]), "ready", version)), [
		"alpha-goal",
	]);
	const waves = okEnvelope(await runCli(["project", "waves", "--json"]), "waves", version);
	assert.deepEqual(
		(waves.result.waves as Array<Array<{ id: string }>>).map((wave) => wave.map((goal) => goal.id)),
		[["alpha-goal"], ["beta-goal"]],
	);

	step("  apply-plan --dry-run writes nothing");
	const planPath = join(workspace, "plan.json");
	const plan = [{ title: "Gamma goal", group: "Later", dependsOn: ["beta-goal"] }];
	await writeFile(planPath, `${JSON.stringify(plan)}\n`, "utf8");
	const beforePlan = await readFile(worklistPath, "utf8");
	const previewed = okEnvelope(
		await runCli(["project", "apply-plan", "plan.json", "--dry-run", "--json"]),
		"apply-plan",
		version,
	);
	assert.equal(previewed.result.dryRun, true);
	assert.deepEqual(
		(previewed.result.addedGoals as Array<{ id: string }>).map((goal) => goal.id),
		["gamma-goal"],
	);
	assert.equal(previewed.meta.changed, false);
	assert.equal(await readFile(worklistPath, "utf8"), beforePlan, "a dry run must not touch the worklist");

	step("  guarded mutation refuses, then lands with --confirm");
	failedEnvelope(
		await runCli(["project", "complete", "alpha-goal", "--json"]),
		"complete",
		3,
		"APPROVAL_REQUIRED",
	);
	assert.equal(
		await readFile(worklistPath, "utf8"),
		beforePlan,
		"a refused mutation must not touch the worklist",
	);

	const completed = okEnvelope(
		await runCli(["project", "complete", "alpha-goal", "--confirm", "--json"]),
		"complete",
		version,
	);
	assert.equal((completed.result.goal as { status: string }).status, "done");
	assert.equal(completed.meta.changed, true);
	assert.deepEqual(
		goalIds(okEnvelope(await runCli(["project", "ready", "--json"]), "ready", version)),
		["beta-goal"],
		"completing a dependency must release what it blocked",
	);

	step("  typed failures instead of stack traces");
	failedEnvelope(await runCli(["project", "show", "missing-goal", "--json"]), "show", 1, "NOT_FOUND");

	// The board is the module most likely to reach for Pi's TUI, and the bin
	// imports it eagerly, so a clean refusal here proves it loaded without Pi.
	const board = await runCli(["project", "ui"]);
	assert.equal(board.code, 1);
	assert.match(board.stderr, /needs an interactive terminal/);
}

async function exerciseDispatch(binPath: string, workspace: string): Promise<void> {
	const runDispatch = cliRunner(binPath, workspace);
	const help = await runDispatch(["--help"]);
	assert.equal(help.code, 0, "installed dispatch executable --help must succeed");
	assert.match(help.stdout, /resume <run-id>/, "dispatch help must expose resumable operation");
	const status = await runDispatch(["status", "--json"]);
	assert.equal(status.code, 0, "installed dispatch executable status must succeed");
	const envelope = JSON.parse(status.stdout) as { ok?: unknown; result?: unknown };
	assert.equal(envelope.ok, true);
	assert.deepEqual(envelope.result, []);
}
/**
 * How each published executable is driven once it is installed, keyed by the
 * command name the manifest's `bin` map puts on a user's PATH. The manifest is
 * the list of executables an install exposes, so this check compares itself
 * against that map instead of naming the bins twice.
 */
const BIN_EXERCISES: Record<string, BinExercise> = {
	[binary]: exerciseCli,
	[DISPATCH_BINARY]: exerciseDispatch,
};

const scratch = await mkdtemp(join(tmpdir(), `${binary}-no-pi-install-`));
const packDir = join(scratch, "pack");
const installDir = join(scratch, "install");
let succeeded = false;
try {
	await Promise.all([packDir, installDir].map((dir) => mkdir(dir, { recursive: true })));

	const { name, version, bin } = JSON.parse(await readFile(resolve(repoRoot, "package.json"), "utf8")) as {
		name: string;
		version: string;
		bin?: Record<string, string>;
	};

	// Before spending minutes on a pack and an install: a bin this check never
	// starts is packed without anyone proving it loads from a Pi-free install,
	// which is the one regression this whole job exists to catch.
	assert.deepEqual(
		Object.keys(bin ?? {}).sort(),
		Object.keys(BIN_EXERCISES).sort(),
		"package.json's `bin` map and BIN_EXERCISES in scripts/no-pi-install-check.ts must name the " +
			"same executables. A published bin with no exercise here ships unstarted, and an exercise " +
			"for a bin the manifest no longer publishes drives nothing.",
	);

	step("Packing the publishable tarball");
	const tarball = await packTarball(packDir);

	step(`Installing ${basename(tarball)} with no dev dependencies and no Pi`);
	await installTarball(tarball, installDir);
	await assertNoPiPackages(installDir);

	step(`Driving every published bin: ${Object.keys(BIN_EXERCISES).join(", ")}`);
	for (const [command, exercise] of Object.entries(BIN_EXERCISES)) {
		// Each bin gets its own repository, so one bin's writes can never stand in
		// for a second bin that never wrote anything.
		const workspace = join(scratch, `workspace-${command}`);
		// pi-lens-ignore: await-in-loop
		await mkdir(workspace, { recursive: true });
		// pi-lens-ignore: await-in-loop
		await run("git", ["init", "-q", "."], workspace);
		// pi-lens-ignore: await-in-loop
		await exercise(join(installDir, "node_modules", ".bin", command), workspace, version);
	}

	succeeded = true;
	step(`${name} ${version} runs from a Pi-free install.`);
} catch (error) {
	// The message is the finding; a stack through this script's own helpers only
	// buries which part of the installed surface stopped working.
	process.exitCode = 1;
	process.stderr.write(`\nno-pi-install check failed.\n\n${(error as Error).message}\n`);
} finally {
	// A failed run leaves the scratch tree behind so the install can be inspected.
	if (succeeded) await rm(scratch, { recursive: true, force: true });
	else process.stderr.write(`Left the failed install at ${scratch}\n`);
}
