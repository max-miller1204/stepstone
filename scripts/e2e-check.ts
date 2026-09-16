/** Packed executables + real Pi RPC. Run separately from Vitest's pack/build tests. */
import assert from "node:assert/strict";
import { existsSync, utimesSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { envelope, Harness, readWorklist, repoRoot, withRpc } from "./e2e-harness.ts";

const flags = process.argv.slice(2);
assert.ok(
	flags.length === 0 || (flags.length === 1 && flags[0] === "--fast"),
	"Usage: e2e-check.ts [--fast]",
);
const fast = flags.includes("--fast");
const h = await Harness.create();
let passed = false;

const manifest = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")) as {
	name: string;
	version: string;
	bin: Record<string, string>;
};
const binary = manifest.name;
const install = join(h.root, "install");
const packagePath = join(install, "node_modules", manifest.name);
// Resolve the executable from the packed manifest, never from dist in this checkout.
let bins: Record<string, string>;
const cli = async (cwd: string, args: string[], env?: NodeJS.ProcessEnv) =>
	h.run(process.execPath, [bins[binary] as string, "project", ...args, "--json"], cwd, { env });
const ok = async (cwd: string, args: string[], env?: NodeJS.ProcessEnv) => {
	const value = envelope(await cli(cwd, args, env), args[0] as string);
	assert.equal(value.meta.cliVersion, manifest.version);
	return value;
};
const ids = async (cwd: string, args: string[] = [], env?: NodeJS.ProcessEnv) =>
	(await ok(cwd, ["list", ...args], env)).result.goals.map((goal) => goal.id);
const worklistPath = (cwd: string) => join(cwd, ".worklist", "worklist.json");
const bytes = (cwd: string) => readFile(worklistPath(cwd), "utf8");
const plan = async (cwd: string, name: string, entries: object[]) => {
	const path = join(cwd, `${name}.json`);
	await writeFile(path, JSON.stringify(entries));
	return path;
};

async function installed(): Promise<void> {
	const pack = join(h.root, "pack");
	await mkdir(pack);
	await mkdir(install);
	await h.checked("npm", ["pack", "--offline", "--pack-destination", pack], repoRoot, 120_000);
	const tarballs = (await readdir(pack)).filter((path) => path.endsWith(".tgz"));
	assert.equal(tarballs.length, 1);
	await writeFile(join(install, "package.json"), JSON.stringify({ private: true, name: "e2e-install" }));
	await h.checked(
		"npm",
		[
			"install",
			join(pack, tarballs[0] as string),
			"--offline",
			"--ignore-scripts",
			"--omit=dev",
			"--omit=peer",
			"--no-audit",
			"--no-fund",
		],
		install,
		120_000,
	);
	const installedManifest = JSON.parse(
		await readFile(join(packagePath, "package.json"), "utf8"),
	) as typeof manifest;
	assert.equal(installedManifest.version, manifest.version);
	assert.deepEqual(Object.keys(installedManifest.bin).sort(), [binary]);
	bins = Object.fromEntries(
		Object.entries(installedManifest.bin).map(([name, path]) => [name, join(packagePath, path)]),
	);
	const files = await readdir(join(install, "node_modules"), { recursive: true });
	assert.deepEqual(
		files.filter((path) => /(^|[/\\])(@earendil-works|typebox)([/\\]|$)/.test(path)),
		[],
	);
	// Both project command families must start even in the fast subset. The CLI's
	// top-level help is a usage error, so exercise its normal JSON read instead.
	assert.deepEqual(await ids(await h.repository("installed-bin")), []);
	await h.checked(process.execPath, [bins[binary] as string, "project", "workspace", "--help"], install);
}

async function plansAndConflicts(): Promise<void> {
	const cwd = await h.repository("approved-plan");
	assert.deepEqual(await ids(cwd), []);
	assert.equal(existsSync(worklistPath(cwd)), false, "reads must not initialize storage");
	const baseline = (await ok(cwd, ["add", "Foundation"])).result.goal;
	assert.equal((await readWorklist(cwd)).revision, 1);
	const approved = await plan(cwd, "approved", [
		{ title: "Build feature", group: "Delivery", dependsOn: [baseline.id] },
		{ title: "Ship feature", group: "Delivery", dependsOn: ["build-feature"] },
	]);
	const before = await bytes(cwd);
	const preview = await ok(cwd, ["apply-plan", approved, "--dry-run"]);
	assert.equal(preview.meta.changed, false);
	assert.equal(await bytes(cwd), before);
	assert.deepEqual(
		preview.result.addedGoals.map((goal) => goal.id),
		["build-feature", "ship-feature"],
	);
	const applied = await ok(cwd, ["apply-plan", approved]);
	assert.equal(applied.meta.revisions.project, "2");
	assert.deepEqual(
		applied.result.addedGoals.map((goal) => goal.id),
		["build-feature", "ship-feature"],
	);
	assert.deepEqual(
		(await readWorklist(cwd)).goals.map((goal) => goal.dependsOn ?? []),
		[[], ["foundation"], ["build-feature"]],
	);
	const invalid = await plan(cwd, "invalid", [
		{ title: "Valid first" },
		{ title: "Invalid second", dependsOn: ["missing"] },
	]);
	const after = await bytes(cwd);
	envelope(await cli(cwd, ["apply-plan", invalid]), "apply-plan", { exit: 1, code: "VALIDATION_FAILED" });
	assert.equal(await bytes(cwd), after, "invalid batch must not partially apply");
	envelope(await cli(cwd, ["complete", baseline.id]), "complete", { exit: 3, code: "APPROVAL_REQUIRED" });
	assert.equal(await bytes(cwd), after);
	// A stale, known timestamp avoids assumptions about clock resolution between processes.
	const conflict = envelope(
		await cli(cwd, [
			"update",
			baseline.id,
			"--expect-updated-at",
			"2000-01-01T00:00:00.000Z",
			"--description",
			"Must not land",
		]),
		"update",
		{ exit: 4, code: "CONFLICT" },
	);
	assert.equal(conflict.error.retryable, true);
	assert.equal(await bytes(cwd), after);
	const completed = await ok(cwd, [
		"complete",
		baseline.id,
		"--confirm",
		"--expect-updated-at",
		baseline.updatedAt,
	]);
	assert.equal(completed.result.goal.status, "done");
	assert.deepEqual(
		(await ok(cwd, ["ready"])).result.goals.map((goal) => goal.id),
		["build-feature"],
	);
}

async function locations(): Promise<void> {
	const cwd = await h.repository("locations");
	const nested = join(cwd, "nested");
	await mkdir(nested);
	await ok(nested, ["add", "Legacy", "--file", "../.pi/worklist.json"]);
	assert.deepEqual(await ids(nested), ["legacy"]);
	await ok(nested, ["add", "Legacy append"]);
	assert.equal(existsSync(worklistPath(cwd)), false);
	await ok(cwd, ["add", "Canonical", "--file", ".worklist/worklist.json"]);
	assert.deepEqual(await ids(nested), ["canonical"]);
	const environment = { STEPSTONE_WORKLIST: "env/goals.json" };
	await ok(nested, ["add", "Environment"], environment);
	assert.deepEqual(await ids(nested, [], environment), ["environment"]);
	await ok(nested, ["add", "Explicit", "--file", "explicit/goals.json"], environment);
	assert.deepEqual(await ids(nested, ["--file", "explicit/goals.json", "--cwd", cwd], environment), [
		"explicit",
	]);
	assert.deepEqual(await ids(nested, ["--cwd", cwd], environment), ["environment"]);
	assert.deepEqual(await ids(cwd), ["canonical"]);
	assert.deepEqual(await ids(cwd, ["--file", ".pi/worklist.json"]), ["legacy", "legacy-append"]);
}

async function locking(): Promise<void> {
	const cwd = await h.repository("locking");
	await ok(cwd, ["add", "Seed"]);
	const before = await bytes(cwd);
	// The documented directory lock is held before the process is launched.
	// Keep its mtime fresh until the child's bounded retries are exhausted.
	const lock = join(cwd, ".worklist", ".worklist.lock");
	await mkdir(lock);
	const heartbeat = setInterval(() => {
		const now = new Date();
		utimesSync(lock, now, now);
	}, 500);
	try {
		envelope(await cli(cwd, ["add", "Locked out"]), "add", { exit: 1, code: "PERSISTENCE_FAILED" });
		assert.equal(await bytes(cwd), before);
	} finally {
		clearInterval(heartbeat);
		await rm(lock, { recursive: true });
	}
	const batches = await Promise.all(
		["Left", "Right", "Third"].map((side) =>
			plan(
				cwd,
				side,
				Array.from({ length: 20 }, (_, index) => ({ title: `${side} ${index}` })),
			),
		),
	);
	let running = true;
	let samples = 0;
	// Observe on-disk JSON while independent processes replace it. Every visible
	// state must contain whole batches and a matching revision, never a prefix.
	const observe = async () => {
		while (running) {
			const snapshot = await readWorklist(cwd);
			assert.equal(snapshot.goals.length, 1 + (snapshot.revision - 1) * 20);
			for (const side of ["Left", "Right", "Third"]) {
				const count = snapshot.goals.filter((goal) => goal.title.startsWith(`${side} `)).length;
				assert.ok(count === 0 || count === 20);
			}
			samples++;
			await delay(2);
		}
	};
	const observer = observe();
	const writers = Promise.allSettled(batches.map((path) => ok(cwd, ["apply-plan", path]))).finally(() => {
		running = false;
	});
	const [written, observed] = await Promise.allSettled([writers, observer]);
	if (observed.status === "rejected") throw observed.reason;
	if (written.status === "rejected") throw written.reason;
	const results = written.value;
	const revisions = results.map((result) => {
		if (result.status === "rejected") throw result.reason;
		return result.value.meta.revisions.project;
	});
	assert.deepEqual(revisions.sort(), ["2", "3", "4"]);
	assert.ok(samples > 0);
	const final = await readWorklist(cwd);
	assert.equal(final.revision, 4);
	assert.equal(new Set(final.goals.map((goal) => goal.id)).size, 61);
	assert.deepEqual((await readdir(dirname(worklistPath(cwd)))).sort(), ["worklist.json"]);
}

async function linkedWorktree(): Promise<void> {
	const cwd = await h.repository("linked-main");
	await ok(cwd, ["add", "Canonical"]);
	await h.checked("git", ["add", ".worklist"], cwd);
	await h.checked("git", ["commit", "-qm", "Seed"], cwd);
	const linked = join(h.root, "linked-worktree");
	await h.checked("git", ["worktree", "add", "-b", "linked", linked], cwd);
	const before = await bytes(cwd);
	assert.deepEqual(await ids(linked), ["canonical"]);
	const refusal = envelope(await cli(linked, ["add", "Refused"]), "add", { exit: 1, code: "UNAVAILABLE" });
	assert.equal(refusal.error.details.resolution, "run-from-main-worktree");
	assert.equal(refusal.error.details.mainWorktree, cwd);
	const preview = await plan(linked, "preview", [{ title: "Preview only" }]);
	await ok(linked, ["apply-plan", preview, "--dry-run"]);
	assert.equal((await ok(linked, ["move", "canonical", "up"])).meta.changed, false);
	assert.equal(await bytes(linked), before);
	assert.equal(await bytes(cwd), before);
	await ok(linked, ["add", "External", "--file", "scratch/goals.json"]);
	assert.deepEqual(await ids(linked, ["--file", "scratch/goals.json"]), ["external"]);
	assert.equal(await bytes(linked), before);
}

async function roadmap(): Promise<void> {
	const cwd = await h.repository("generated-roadmap");
	// The generator is intentionally repository-only. Invoke its actual script
	// in a disposable source copy; the harness never imports its renderer.
	await cp(join(repoRoot, "src"), join(cwd, "src"), { recursive: true });
	await mkdir(join(cwd, "scripts"));
	await cp(join(repoRoot, "scripts/generate-docs.ts"), join(cwd, "scripts/generate-docs.ts"));
	await cp(join(repoRoot, "package.json"), join(cwd, "package.json"));
	await ok(cwd, ["add", "Roadmap proof", "--group", "Quality"]);
	const generate = [join(cwd, "scripts/generate-docs.ts")];
	await h.checked(process.execPath, generate, cwd);
	const initial = await readFile(join(cwd, "docs/ROADMAP.md"), "utf8");
	assert.match(initial, /Roadmap proof/);
	assert.match(initial, /Quality/);
	await h.checked(process.execPath, [...generate, "--check"], cwd);
	await ok(cwd, ["complete", "roadmap-proof", "--confirm"]);
	const stale = await h.run(process.execPath, [...generate, "--check"], cwd);
	assert.equal(stale.code, 1);
	assert.match(stale.stderr, /Stale generated file\(s\): docs\/ROADMAP.md/);
	await h.checked(process.execPath, generate, cwd);
	const current = await readFile(join(cwd, "docs/ROADMAP.md"), "utf8");
	assert.notEqual(current, initial);
	assert.match(current, /done/);
	await h.checked(process.execPath, [...generate, "--check"], cwd);
	await h.checked(process.execPath, generate, cwd);
	assert.equal(await readFile(join(cwd, "docs/ROADMAP.md"), "utf8"), current);
}

async function workspacePreparation(): Promise<void> {
	const cwd = await h.repository("dispatch");
	await ok(cwd, ["add", "Prepared goal", "--description", "Verify installed workspace handoff."]);
	await h.checked("git", ["add", ".worklist"], cwd);
	await h.checked("git", ["commit", "-qm", "Seed"], cwd);
	const parent = join(h.root, "prepared-workspaces");
	await mkdir(parent);
	const result = await h.checked(
		process.execPath,
		[
			bins[binary] as string,
			"project",
			"workspace",
			"start",
			"--goal",
			"prepared-goal",
			"--workspace-parent",
			parent,
			"--json",
		],
		cwd,
	);
	const receipt = JSON.parse(result) as {
		ok: boolean;
		result: { id: string; entries: Record<string, { phase: string; goalFile: string }> };
	};
	assert.equal(receipt.ok, true);
	const entry = receipt.result.entries["prepared-goal"];
	assert.equal(entry?.phase, "prepared");
	assert.equal(entry?.goalFile, join(parent, "stepstone-prepared-goal", "STEPSTONE_GOAL.md"));
	assert.match(await readFile(entry.goalFile, "utf8"), /Verify installed workspace handoff/);
	const workspace = dirname(entry.goalFile);
	assert.equal(
		(await h.checked("git", ["branch", "--show-current"], workspace)).trim(),
		"stepstone/prepared-goal",
	);
	assert.equal((await readWorklist(cwd)).goals[0]?.branch, "stepstone/prepared-goal");
	assert.equal(
		(await h.checked("git", ["check-ignore", "STEPSTONE_GOAL.md"], workspace)).trim(),
		"STEPSTONE_GOAL.md",
	);
	const status = JSON.parse(
		await h.checked(
			process.execPath,
			[bins[binary] as string, "project", "workspace", "status", receipt.result.id, "--json"],
			cwd,
		),
	);
	assert.equal(status.ok, true);
	assert.equal(status.result.length, 1);
	assert.equal(status.result[0].id, receipt.result.id);
	assert.equal(status.result[0].entries["prepared-goal"].phase, "prepared");
}

async function piRpc(): Promise<void> {
	const cwd = await h.repository("pi-rpc");
	await withRpc(h, cwd, packagePath, async (request) => {
		const commands = (await request({ type: "get_commands" })).data as {
			commands: { name: string; sourceInfo?: { path?: string } }[];
		};
		assert.ok(
			commands.commands.some(
				(command) => command.name === "tasks" && command.sourceInfo?.path?.startsWith(packagePath),
			),
		);
		await request({ type: "prompt", message: "/tasks session add Packed RPC task" });
		const snapshots = async () => {
			const data = (await request({ type: "get_entries" })).data as {
				entries: {
					type: string;
					customType?: string;
					data?: { version: number; tasks: { title: string; status: string }[] };
				}[];
			};
			return data.entries.filter(
				(entry) => entry.type === "custom" && entry.customType === "worklist-session-snapshot",
			);
		};
		assert.deepEqual(
			(await snapshots()).at(-1)?.data?.tasks.map((task) => [task.title, task.status]),
			[["Packed RPC task", "todo"]],
		);
		assert.equal((await snapshots()).at(-1)?.data?.version, 3);
		await request({ type: "prompt", message: "/tasks project add RPC goal" });
		assert.deepEqual(await ids(cwd), ["rpc-goal"]);
		await ok(cwd, ["add", "CLI goal"]);
		await request({ type: "prompt", message: "/tasks project add Second RPC goal" });
		assert.deepEqual(await ids(cwd), ["rpc-goal", "cli-goal", "second-rpc-goal"]);
		assert.equal((await readWorklist(cwd)).revision, 3);
		if (!fast) {
			// Same long-lived extension must re-resolve after storage changes.
			await mkdir(join(cwd, ".pi"));
			await rename(worklistPath(cwd), join(cwd, ".pi/worklist.json"));
			await request({ type: "prompt", message: "/tasks project add Legacy RPC goal" });
			assert.equal(existsSync(worklistPath(cwd)), false);
			assert.deepEqual(await ids(cwd), ["rpc-goal", "cli-goal", "second-rpc-goal", "legacy-rpc-goal"]);
			await ok(cwd, ["add", "New canonical", "--file", ".worklist/worklist.json"]);
			await request({ type: "prompt", message: "/tasks project add Resolved again" });
			assert.deepEqual(await ids(cwd), ["new-canonical", "resolved-again"]);
		}
		const before = await ids(cwd);
		await request({ type: "new_session" });
		assert.equal((await snapshots()).length, 0);
		assert.deepEqual(await ids(cwd), before);
	});
}

try {
	const scenarios = [
		installed,
		plansAndConflicts,
		piRpc,
		...(fast ? [] : [locations, locking, linkedWorktree, roadmap, workspacePreparation]),
	];
	for (const scenario of scenarios) {
		console.log(`e2e ${fast ? "fast" : "full"}: ${scenario.name}`);
		await scenario();
	}
	passed = true;
	console.log(`E2E ${fast ? "fast" : "full"} passed (${scenarios.length} scenarios).`);
} catch (error) {
	await writeFile(
		join(h.root, "failure.txt"),
		error instanceof Error ? (error.stack ?? error.message) : String(error),
	);
	console.error(error);
	process.exitCode = 1;
} finally {
	await h.finish(passed);
}
