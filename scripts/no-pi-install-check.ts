/**
 * Proves the published tarballs run with nothing installed but Node.
 *
 *   npm run no-pi-install:check
 *
 * This repository installs every Pi peer as a devDependency, so a Pi import
 * that leaked into the CLI path resolves in this checkout and fails only for
 * someone running `npx` on the published name without Pi - the install this
 * package's own agent skill prescribes. So the check refuses to trust the local
 * tree: it packs the real tarballs, installs them into a scratch directory with
 * no dev dependencies and no Pi packages, and drives the installed bins across
 * the command surface, asserting exit codes and `--json` envelopes rather than
 * only that the process started.
 *
 * The deprecated alias in alias/ is packed and installed alongside even though
 * no release publishes it: it ships by hand exactly once, and nothing here or in
 * release.yml should ever republish it. It is covered here because it reaches
 * the CLI through the published `exports` map rather than through anything the
 * compiler or the test suite can see, which leaves this gate as its only proof.
 *
 * scripts/cli-import-graph.ts catches the same regression from the sources in
 * milliseconds; this is the slower proof that the tarballs a user downloads
 * actually work.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { CLI_COMMAND_CONTRACT } from "../src/cli-contract.ts";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "..");
const aliasRoot = join(repoRoot, "alias", "pi-worklist");
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

/** Packs one package the way publishing does, prepack build included. */
async function packTarball(packageRoot: string, destination: string): Promise<string> {
	await run("npm", ["pack", "--pack-destination", destination], packageRoot);
	const packed = (await readdir(destination)).filter((entry) => entry.endsWith(".tgz"));
	assert.equal(packed.length, 1, `expected exactly one packed tarball, got ${packed.join(", ") || "none"}`);
	return join(destination, packed[0] as string);
}

/**
 * Installs the tarballs on their own. Every Pi peer is declared optional, so npm
 * leaves them out unless something already depends on them, and `--omit=peer`
 * keeps that true even if that ever changes.
 *
 * Both go in through a single command so npm satisfies the alias's dependency
 * on this release from the tarball beside it. Resolving it from the registry
 * would test whatever is already published instead, and before the first
 * release under this name there is nothing there to resolve at all.
 */
async function installTarballs(tarballs: readonly string[], installDir: string): Promise<void> {
	const manifest = { name: "no-pi-install-fixture", version: "0.0.0", private: true };
	await writeFile(join(installDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
	await run(
		"npm",
		["install", ...tarballs, "--omit=dev", "--omit=peer", "--no-audit", "--no-fund", "--loglevel=error"],
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
			`\`${command}\` cannot load ${missing} from a Pi-free install, which is how ` +
			`everyone running \`npx ${binary}\` has it. Something reachable from src/cli.ts imports it at ` +
			"runtime: run `npm run imports:check` to name the module, then make that import type-only or " +
			"move it out of the CLI graph.",
	);
}

/**
 * Turns the alias's own structural failure into a sentence. Its shim reaches
 * the CLI through the published `exports` map, so dropping or repointing that
 * entry breaks every install still on the old name without touching a line the
 * compiler or the test suite reads.
 */
function assertSubpathExported(command: string, stderr: string): void {
	if (!stderr.includes("ERR_PACKAGE_PATH_NOT_EXPORTED")) return;
	throw new Error(
		`${stderr.trim()}\n\n` +
			`\`${command}\` cannot import the CLI, so the deprecated alias is unusable. Keep the \`exports\` ` +
			`entry in package.json that the shim imports pointing at the compiled bin ${binary} ships.`,
	);
}

function cliRunner(binPath: string, cwd: string) {
	// The bin's own name, so a failure names the command that was actually run
	// rather than whichever of the two bins this helper was written for.
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
			assertSubpathExported(invocation, failure.stderr);
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
	const worklistPath = join(workspace, ".pi", "worklist.json");

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

/**
 * Requires the deprecated alias bin to be indistinguishable from the real one.
 *
 * The alias carries no implementation: it imports the published CLI entry point
 * and lets it parse `process.argv`. Nothing else in the repository executes that
 * path, so this is where the two properties the shim is easy to break get
 * pinned. Arguments and exit codes have to survive the extra process, and a
 * redirected stderr has to carry the `--json` failure envelope alone, because
 * the shim's rename notice also goes to stderr and would corrupt the envelope
 * for exactly the scripts still on the old name.
 */
async function assertAliasMatchesRealBin(
	realBin: string,
	aliasBin: string,
	workspace: string,
): Promise<void> {
	const runReal = cliRunner(realBin, workspace);
	const runAlias = cliRunner(aliasBin, workspace);
	// Reads and refusals only: both bins have to see the same worklist for the
	// comparison to mean anything, and none of these mint a timestamp.
	const invocations = [
		["project", "list", "--json"],
		["project", "show", "beta-goal", "--json"],
		["project", "waves", "--json"],
		["project", "show", "missing-goal", "--json"],
		["project", "delete", "beta-goal", "--json"],
		["project", "not-an-action", "--json"],
	];
	for (const args of invocations) {
		const [real, alias] = await Promise.all([runReal(args), runAlias(args)]);
		assert.deepEqual(
			alias,
			real,
			`\`${basename(aliasBin)} ${args.join(" ")}\` must produce the same exit code, stdout, and stderr ` +
				`as \`${basename(realBin)} ${args.join(" ")}\``,
		);
	}
	step(`  ${invocations.length} invocations identical to the real bin`);
}

/**
 * Fails if the alias resolved its own nested copy of the package rather than
 * the tarball under test, which would leave this check green while the shim was
 * really running a release off the registry.
 */
async function assertAliasSharesTheInstall(
	installDir: string,
	aliasName: string,
	packageName: string,
): Promise<void> {
	const nested = join(installDir, "node_modules", aliasName, "node_modules", packageName);
	const resolvedNested = await readdir(nested).then(
		() => true,
		() => false,
	);
	assert.equal(
		resolvedNested,
		false,
		`${aliasName} must forward to the packed ${packageName}, not to a nested copy`,
	);
}

const scratch = await mkdtemp(join(tmpdir(), `${binary}-no-pi-install-`));
const packDir = join(scratch, "pack");
const aliasPackDir = join(scratch, "pack-alias");
const installDir = join(scratch, "install");
const workspace = join(scratch, "workspace");
let succeeded = false;
try {
	await Promise.all(
		[packDir, aliasPackDir, installDir, workspace].map((dir) => mkdir(dir, { recursive: true })),
	);

	const { name, version } = JSON.parse(await readFile(resolve(repoRoot, "package.json"), "utf8")) as {
		name: string;
		version: string;
	};
	const aliasManifest = JSON.parse(await readFile(join(aliasRoot, "package.json"), "utf8")) as {
		name: string;
		bin: Record<string, string>;
	};
	const aliasBinNames = Object.keys(aliasManifest.bin);
	assert.equal(
		aliasBinNames.length,
		1,
		`expected the alias to ship one bin, got ${aliasBinNames.join(", ")}`,
	);
	const aliasBinName = aliasBinNames[0] as string;

	step("Packing the publishable tarballs");
	const tarball = await packTarball(repoRoot, packDir);
	const aliasTarball = await packTarball(aliasRoot, aliasPackDir);

	step(`Installing ${basename(tarball)} and ${basename(aliasTarball)} with no dev dependencies and no Pi`);
	await installTarballs([tarball, aliasTarball], installDir);
	await assertNoPiPackages(installDir);
	await assertAliasSharesTheInstall(installDir, aliasManifest.name, name);

	step("Driving the installed bin");
	await run("git", ["init", "-q", "."], workspace);
	const realBin = join(installDir, "node_modules", ".bin", binary);
	await exerciseCli(realBin, workspace, version);

	step(`Driving the deprecated ${aliasManifest.name} bin`);
	await assertAliasMatchesRealBin(realBin, join(installDir, "node_modules", ".bin", aliasBinName), workspace);

	succeeded = true;
	step(`${name} ${version} runs from a Pi-free install, and ${aliasManifest.name} forwards to it.`);
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
