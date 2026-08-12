import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { CLI_COMMAND_CONTRACT, WORKLIST_PATH_ENV } from "../src/cli-contract.ts";
import type { ProjectGoal, ProjectWorklist } from "../src/types.ts";

const execFileAsync = promisify(execFile);
const cliPath = resolve("src/cli.ts");

interface CliResult {
	code: number;
	stdout: string;
	stderr: string;
}

function parseJson(text: string): ReturnType<typeof JSON.parse> {
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new Error("Expected valid JSON in CLI test", { cause: error });
	}
}

async function runCli(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<CliResult> {
	const options = { cwd, ...(env ? { env: { ...process.env, ...env } } : {}) };
	try {
		const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...args], options);
		return { code: 0, stdout, stderr };
	} catch (error) {
		const failure = error as CliResult & { code: number | null };
		return { code: failure.code ?? 1, stdout: failure.stdout, stderr: failure.stderr };
	}
}

/**
 * A repository named the way the CLI names it back.
 *
 * `resolveGitRoot` canonicalises the root, so every path the CLI prints or puts
 * in an envelope is symlink-free. The temporary directory is not: on macOS it
 * sits under `/var`, a symlink to `/private/var`. Canonicalising here keeps a
 * path assertion comparing the two paths rather than the two spellings.
 */
async function tempGitRepo(): Promise<string> {
	const root = await realpath(await mkdtemp(join(tmpdir(), "stepstone-cli-")));
	await execFileAsync("git", ["init"], { cwd: root });
	return root;
}

/**
 * The diagnostic a CLI failure prints, without the usage block appended to every
 * one. Asserting against raw stderr would let the flag list in that block stand
 * in for a hint the diagnostic never gave.
 */
function diagnostic(stderr: string): string {
	return stderr.split("\n\nUsage:")[0];
}

async function readGoals(root: string): Promise<ProjectGoal[]> {
	const raw = await readFile(join(root, ".worklist", "worklist.json"), "utf8");
	return (parseJson(raw) as ProjectWorklist).goals;
}

/**
 * Write goal state no CLI action writes: a dispatch branch, or an edge that can
 * never be satisfied.
 *
 * `branch` is the marker a later goal will stamp when work starts, and a
 * mutation refuses a cycle and strips the edges naming a deleted goal, so both
 * only reach a real file this way. Sequencing has to read them regardless.
 */
async function editGoalByHand(root: string, id: string, changes: Partial<ProjectGoal>): Promise<void> {
	const path = join(root, ".worklist", "worklist.json");
	const worklist = parseJson(await readFile(path, "utf8")) as ProjectWorklist;
	const goal = worklist.goals.find((entry) => entry.id === id);
	if (!goal) throw new Error(`No project goal ${id} to edit by hand`);
	Object.assign(goal, changes);
	await writeFile(path, `${JSON.stringify(worklist, null, 2)}\n`);
}

describe("project goal CLI", () => {
	it("adds, lists, updates, and activates goals through the shared store", async () => {
		const root = await tempGitRepo();

		const added = await runCli(root, ["project", "add", "Ship", "the", "CLI", "--", "External agent access"]);
		expect(added.code).toBe(0);
		expect(added.stdout).toContain("Added project goal");

		const goals = await readGoals(root);
		expect(goals).toHaveLength(1);
		expect(goals[0].title).toBe("Ship the CLI");
		expect(goals[0].description).toBe("External agent access");
		expect(goals[0].status).toBe("open");

		const listed = await runCli(root, ["project", "list"]);
		expect(listed.stdout).toContain(`[open] ${goals[0].id}: Ship the CLI`);
		expect(listed.stdout).not.toContain("External agent access");

		const shown = await runCli(root, ["project", "show", goals[0].id]);
		expect(shown.code).toBe(0);
		expect(shown.stdout).toContain(`${goals[0].id}: Ship the CLI`);
		expect(shown.stdout).toContain("status: open");
		expect(shown.stdout).toContain("External agent access");

		const missing = await runCli(root, ["project", "show", "goal-missing"]);
		expect(missing.code).toBe(1);
		expect(missing.stderr).toContain("goal-missing was not found");

		const missingJson = await runCli(root, ["project", "show", "goal-missing", "--json"]);
		expect(missingJson.code).toBe(1);
		expect(missingJson.stdout).toBe("");
		expect(parseJson(missingJson.stderr)).toMatchObject({
			ok: false,
			scope: "project",
			action: "show",
			error: { code: "NOT_FOUND", retryable: false, details: { id: "goal-missing" } },
			meta: { changed: false, semanticNoOp: false, changedFields: [] },
		});

		const updated = await runCli(root, ["project", "update", goals[0].id, "Ship", "it"]);
		expect(updated.code).toBe(0);
		expect((await readGoals(root))[0].title).toBe("Ship it");
		expect((await readGoals(root))[0].description).toBe("External agent access");

		const activated = await runCli(root, ["project", "set_active", goals[0].id]);
		expect(activated.code).toBe(0);
		expect((await readGoals(root))[0].status).toBe("active");
	});

	it("accepts order-independent description flags with flag-looking values", async () => {
		const root = await tempGitRepo();

		const added = await runCli(root, [
			"project",
			"add",
			"--json",
			"Flag-safe",
			"goal",
			"--description",
			"--confirm",
		]);
		expect(added.code).toBe(0);
		const created = parseJson(added.stdout) as { result: { goal: ProjectGoal } };
		expect(created.result.goal).toMatchObject({ title: "Flag-safe goal", description: "--confirm" });

		const replaced = await runCli(root, [
			"project",
			"update",
			"--description",
			"Replacement text mentions --json",
			created.result.goal.id,
			"--json",
		]);
		expect(replaced.code).toBe(0);
		expect((await readGoals(root))[0].description).toBe("Replacement text mentions --json");

		const appended = await runCli(root, [
			"project",
			"update",
			"--json",
			created.result.goal.id,
			"--append-description",
			"--json",
		]);
		expect(appended.code).toBe(0);
		expect((await readGoals(root))[0].description).toBe("Replacement text mentions --json\n\n--json");

		const cleared = await runCli(root, ["project", "update", created.result.goal.id, "--description", ""]);
		expect(cleared.code).toBe(0);
		expect((await readGoals(root))[0].description).toBe("");
	});

	it("refuses words trailing a --description value instead of renaming silently", async () => {
		const root = await tempGitRepo();
		await runCli(root, ["project", "add", "Ship the parser", "--description", "Original prose"]);
		const [goal] = await readGoals(root);

		// Unquoted prose runs past the flag's single token, and the leftovers used to
		// land as a title: exit 0, goal renamed to "long prose", description "Some".
		const spilled = await runCli(root, [
			"project",
			"update",
			goal.id,
			"--description",
			"Some",
			"long",
			"prose",
		]);
		expect(spilled.code).toBe(2);
		expect(diagnostic(spilled.stderr)).toContain("as a new title");
		expect((await readGoals(root))[0]).toMatchObject({
			title: "Ship the parser",
			description: "Original prose",
		});

		// A title written after the value is the same argv shape as that spill.
		const titleAfterValue = await runCli(root, [
			"project",
			"update",
			goal.id,
			"--description",
			"Replacement prose",
			"Renamed",
		]);
		expect(titleAfterValue.code).toBe(2);
		expect((await readGoals(root))[0]).toMatchObject({
			title: "Ship the parser",
			description: "Original prose",
		});

		// Nothing trails the value here, so the combined form stays a single write.
		const combined = await runCli(root, [
			"project",
			"update",
			goal.id,
			"Renamed",
			"--description",
			"Replacement prose",
		]);
		expect(combined.code).toBe(0);
		expect((await readGoals(root))[0]).toMatchObject({
			title: "Renamed",
			description: "Replacement prose",
		});

		const viaSeparator = await runCli(root, [
			"project",
			"update",
			goal.id,
			"Renamed again",
			"--",
			"Separator prose",
		]);
		expect(viaSeparator.code).toBe(0);
		expect((await readGoals(root))[0]).toMatchObject({
			title: "Renamed again",
			description: "Separator prose",
		});
	});

	it("refuses an add title split across a --description value but keeps flag order free", async () => {
		const root = await tempGitRepo();

		const spilled = await runCli(root, [
			"project",
			"add",
			"My",
			"Goal",
			"--description",
			"Some",
			"long",
			"prose",
		]);
		expect(spilled.code).toBe(2);
		expect(diagnostic(spilled.stderr)).toContain("more of the title");
		const listed = await runCli(root, ["project", "list", "--json"]);
		expect(parseJson(listed.stdout).result.goals).toEqual([]);

		const flagFirst = await runCli(root, [
			"project",
			"add",
			"--description",
			"Prose written first",
			"My",
			"Goal",
		]);
		expect(flagFirst.code).toBe(0);
		expect((await readGoals(root))[0]).toMatchObject({
			title: "My Goal",
			description: "Prose written first",
		});

		// Supporting the form above means unquoted prose written the same way is
		// argv-identical to it, so add folds the leftovers into the title instead of
		// refusing. The generated guidance states exactly this; keep the two in step.
		const unquotedFlagFirst = await runCli(root, [
			"project",
			"add",
			"--description",
			"Some",
			"more",
			"words",
		]);
		expect(unquotedFlagFirst.code).toBe(0);
		expect((await readGoals(root)).at(-1)).toMatchObject({
			title: "more words",
			description: "Some",
		});
	});

	it("clears a description through the interactive separator alone", async () => {
		const root = await tempGitRepo();
		await runCli(root, ["project", "add", "Retire the importer", "--", "Prose a human typed"]);
		const [goal] = await readGoals(root);
		expect(goal.description).toBe("Prose a human typed");

		const cleared = await runCli(root, ["project", "update", goal.id, "--"]);
		expect(cleared.code).toBe(0);
		expect((await readGoals(root))[0].description).toBe("");
		expect((await readGoals(root))[0].title).toBe("Retire the importer");
	});

	it("keeps a single active goal", async () => {
		const root = await tempGitRepo();
		await runCli(root, ["project", "add", "First"]);
		await runCli(root, ["project", "add", "Second"]);
		const [first, second] = await readGoals(root);
		await runCli(root, ["project", "set_active", first.id]);
		await runCli(root, ["project", "set_active", second.id]);
		const goals = await readGoals(root);
		expect(goals.find((goal) => goal.id === first.id)?.status).toBe("open");
		expect(goals.find((goal) => goal.id === second.id)?.status).toBe("active");
	});

	it("emits stable machine-readable result envelopes with --json", async () => {
		const root = await tempGitRepo();
		const manifest = parseJson(await readFile(resolve("package.json"), "utf8")) as { version: string };
		const added = await runCli(root, ["project", "add", "--json", "Automate", "--", "Via Claude"]);
		const payload = parseJson(added.stdout) as {
			ok: boolean;
			scope: string;
			action: string;
			result: { goal: ProjectGoal; goals: ProjectGoal[] };
			meta: {
				changed: boolean;
				semanticNoOp: boolean;
				cliVersion: string;
				revisions?: { project?: string };
			};
		};
		expect(payload.ok).toBe(true);
		expect(payload.scope).toBe("project");
		expect(payload.action).toBe("add");
		expect(payload.result.goal.title).toBe("Automate");
		expect(payload.result.goals).toHaveLength(1);
		expect(payload.meta).toMatchObject({
			changed: true,
			semanticNoOp: false,
			cliVersion: manifest.version,
			revisions: { project: "1" },
		});

		// Failures with --json print the full deterministic failure envelope on stderr.
		const refused = await runCli(root, ["project", "complete", payload.result.goal.id, "--json"]);
		expect(refused.code).toBe(3);
		expect(refused.stdout).toBe("");
		const errorPayload = parseJson(refused.stderr) as {
			ok: boolean;
			scope: string;
			action: string;
			error: { code: string; retryable: boolean };
			meta: { changed: boolean; semanticNoOp: boolean; changedFields: string[] };
		};
		expect(errorPayload).toMatchObject({
			ok: false,
			scope: "project",
			action: "complete",
			error: { code: "APPROVAL_REQUIRED", retryable: false },
			meta: {
				changed: false,
				semanticNoOp: false,
				changedFields: [],
				cliVersion: manifest.version,
			},
		});
	});

	it("refuses lifecycle actions without --confirm and leaves the file untouched", async () => {
		const root = await tempGitRepo();
		await runCli(root, ["project", "add", "Guarded"]);
		const [goal] = await readGoals(root);
		for (const action of ["complete", "reopen", "archive", "delete"]) {
			// Each action shares the fixture goal, so the calls stay sequential.
			// pi-lens-ignore: await-in-loop
			const refused = await runCli(root, ["project", action, goal.id]);
			expect(refused.code).toBe(3);
			expect(refused.stderr).toContain("--confirm");
		}
		expect((await readGoals(root))[0].status).toBe("open");

		const completed = await runCli(root, ["project", "complete", goal.id, "--confirm"]);
		expect(completed.code).toBe(0);
		expect((await readGoals(root))[0].status).toBe("done");

		const blocked = await runCli(root, ["project", "set_active", goal.id]);
		expect(blocked.code).toBe(1);
		expect(blocked.stderr).toContain("must be reopened");
		expect(blocked.stderr).toContain(`${CLI_COMMAND_CONTRACT.binary} project reopen ${goal.id} --confirm`);

		const blockedJson = await runCli(root, ["project", "set_active", goal.id, "--json"]);
		expect(blockedJson.code).toBe(1);
		expect(blockedJson.stdout).toBe("");
		expect(parseJson(blockedJson.stderr)).toMatchObject({
			ok: false,
			scope: "project",
			action: "set_active",
			error: { code: "VALIDATION_FAILED", details: { resolution: "reopen-project-goal" } },
			meta: { changed: false, semanticNoOp: false },
		});

		const deleted = await runCli(root, ["project", "delete", goal.id, "--confirm"]);
		expect(deleted.code).toBe(0);
		expect(await readGoals(root)).toHaveLength(0);
	});

	it("blames the spill, not a rename, when --append-description prose runs unquoted", async () => {
		const root = await tempGitRepo();
		await runCli(root, ["project", "add", "Ship it", "--description", "Original prose"]);
		const [goal] = await readGoals(root);

		const spilled = await runCli(root, [
			"project",
			"update",
			goal.id,
			"--append-description",
			"Blocked",
			"on",
			"parser",
		]);
		expect(spilled.code).toBe(2);
		expect(diagnostic(spilled.stderr)).toContain("after an --append-description value");
		expect(diagnostic(spilled.stderr)).toContain("Pass the whole note as one argument");
		expect((await readGoals(root))[0].description).toBe("Original prose");

		// A caller who really did write a title still gets the combination refused.
		const renaming = await runCli(root, [
			"project",
			"update",
			goal.id,
			"Renamed",
			"--append-description",
			"A note",
		]);
		expect(renaming.code).toBe(2);
		expect(diagnostic(renaming.stderr)).toContain("cannot change the title while appending");
		expect((await readGoals(root))[0]).toMatchObject({ title: "Ship it", description: "Original prose" });
	});

	it("appends a paragraph and refuses a change built on a stale read", async () => {
		const root = await tempGitRepo();
		await runCli(root, ["project", "add", "Stage", "E", "--", "First paragraph."]);
		const [baseline] = await readGoals(root);

		const appended = await runCli(root, [
			"project",
			"update",
			baseline.id,
			"--append",
			"--",
			"Stale as of 2026-08-03.",
		]);
		expect(appended.code).toBe(0);
		expect((await readGoals(root))[0].description).toBe("First paragraph.\n\nStale as of 2026-08-03.");

		// The append moved the goal, so the original read is no longer a valid baseline.
		const conflict = await runCli(root, [
			"project",
			"update",
			baseline.id,
			"--expect-updated-at",
			baseline.updatedAt,
			"--json",
			"--",
			"A whole description rebuilt from a stale read",
		]);
		const current = (await readGoals(root))[0];
		expect(conflict.code).toBe(4);
		expect(conflict.stdout).toBe("");
		expect(parseJson(conflict.stderr)).toMatchObject({
			ok: false,
			scope: "project",
			action: "update",
			error: {
				code: "CONFLICT",
				retryable: true,
				conflict: {
					type: "goal-updated-at",
					id: baseline.id,
					expectedUpdatedAt: baseline.updatedAt,
					actualUpdatedAt: current.updatedAt,
					resolution: "refresh-and-retry",
				},
			},
		});
		expect(current.description).toBe("First paragraph.\n\nStale as of 2026-08-03.");

		const retried = await runCli(root, [
			"project",
			"update",
			baseline.id,
			"--expect-updated-at",
			current.updatedAt,
			"--append",
			"--",
			"Added after re-reading.",
		]);
		expect(retried.code).toBe(0);
		expect((await readGoals(root))[0].description).toBe(
			"First paragraph.\n\nStale as of 2026-08-03.\n\nAdded after re-reading.",
		);
	});

	it("guards lifecycle actions and refuses flags the action would ignore", async () => {
		const root = await tempGitRepo();
		await runCli(root, ["project", "add", "Guarded"]);
		const [goal] = await readGoals(root);
		const stale = "1999-01-01T00:00:00.000Z";

		const blocked = await runCli(root, [
			"project",
			"complete",
			goal.id,
			"--confirm",
			"--expect-updated-at",
			stale,
		]);
		expect(blocked.code).toBe(4);
		expect((await readGoals(root))[0].status).toBe("open");

		const activated = await runCli(root, [
			"project",
			"set_active",
			goal.id,
			"--expect-updated-at",
			goal.updatedAt,
		]);
		expect(activated.code).toBe(0);
		expect((await readGoals(root))[0].status).toBe("active");

		const misuses = [
			["project", "list", "--expect-updated-at", stale],
			["project", "list", "--description", "ignored"],
			["project", "add", "Nope", "--append", "--", "text"],
			["project", "add", "Nope", "--description", "first", "--", "second"],
			["project", "update", goal.id, "--append"],
			["project", "update", goal.id, "--append", "--"],
			["project", "update", goal.id, "--description"],
			["project", "update", goal.id, "--append-description", ""],
			["project", "update", goal.id, "--description", "replace", "--append-description", "add"],
			["project", "update", goal.id, "--append", "--description", "note"],
			["project", "update", goal.id, "--append-description", "first", "--", "second"],
			// Appending and renaming in one invocation is refused for both input forms.
			["project", "update", goal.id, "Renamed", "--append", "--", "note"],
			["project", "update", goal.id, "Renamed", "--append-description", "note"],
			// Words trailing a --description value would arrive as a rename.
			["project", "update", goal.id, "--description", "note", "Renamed"],
			["project", "update", goal.id, "--expect-updated-at"],
		];
		for (const args of misuses) {
			// Each misuse is asserted against the same fixture goal, so the calls stay sequential.
			// pi-lens-ignore: await-in-loop
			const refused = await runCli(root, args);
			expect(refused.code, args.join(" ")).toBe(2);
		}
		const unchanged = await readGoals(root);
		expect(unchanged).toHaveLength(1);
		expect(unchanged[0]).toMatchObject({ title: "Guarded", status: "active" });
		expect(unchanged[0].description).toBeUndefined();
	});

	it("names goals after their titles and accepts any unambiguous reference to one", async () => {
		const root = await tempGitRepo();
		await runCli(root, ["project", "add", "Support goal templates"]);
		await runCli(root, ["project", "add", "Support goal templates", "--", "The colliding one"]);
		await runCli(root, ["project", "add", "Ship the CLI"]);
		expect((await readGoals(root)).map((goal) => goal.id)).toEqual([
			"support-goal-templates",
			"support-goal-templates-2",
			"ship-the-cli",
		]);

		const byPrefix = await runCli(root, ["project", "show", "ship"]);
		expect(byPrefix.code).toBe(0);
		expect(byPrefix.stdout).toContain("ship-the-cli: Ship the CLI");

		// An exact ID wins over the longer ID it is a prefix of, so no goal is
		// made unreachable by another goal's collision suffix.
		const exact = await runCli(root, ["project", "show", "support-goal-templates"]);
		expect(exact.stdout).toContain("support-goal-templates: Support goal templates");
		expect(exact.stdout).not.toContain("The colliding one");

		const ambiguous = await runCli(root, ["project", "show", "support", "--json"]);
		expect(ambiguous.code).toBe(1);
		expect(ambiguous.stdout).toBe("");
		expect(parseJson(ambiguous.stderr)).toMatchObject({
			ok: false,
			scope: "project",
			action: "show",
			error: {
				code: "VALIDATION_FAILED",
				details: {
					resolution: "provide-unambiguous-goal-id",
					candidateCount: 2,
					candidates: [{ id: "support-goal-templates" }, { id: "support-goal-templates-2" }],
				},
			},
		});

		// A mutation refuses the same ambiguity rather than picking a goal.
		const ambiguousUpdate = await runCli(root, ["project", "update", "support", "Renamed"]);
		expect(ambiguousUpdate.code).toBe(1);
		expect(ambiguousUpdate.stderr).toContain("Use a longer prefix or the full ID.");
		expect((await readGoals(root)).map((goal) => goal.title)).toEqual([
			"Support goal templates",
			"Support goal templates",
			"Ship the CLI",
		]);

		// Renaming a goal leaves its ID alone, so references stay valid.
		const renamed = await runCli(root, ["project", "update", "ship", "Ship the compiled bin"]);
		expect(renamed.code).toBe(0);
		expect((await readGoals(root))[2]).toMatchObject({
			id: "ship-the-cli",
			title: "Ship the compiled bin",
		});
	});

	it("finds goals by wording without a client-side filter over list", async () => {
		const root = await tempGitRepo();
		await runCli(root, ["project", "add", "Support goal templates", "--", "Reusable outlines"]);
		await runCli(root, ["project", "add", "Ship the CLI", "--", "External agent access"]);

		const byTitle = await runCli(root, ["project", "find", "TEMPLATES"]);
		expect(byTitle.code).toBe(0);
		expect(byTitle.stdout.trim()).toBe("[open] support-goal-templates: Support goal templates");

		const byDescription = await runCli(root, ["project", "find", "external", "agent", "--json"]);
		expect(byDescription.code).toBe(0);
		expect(parseJson(byDescription.stdout)).toMatchObject({
			ok: true,
			scope: "project",
			action: "find",
			result: { goals: [{ id: "ship-the-cli" }] },
			meta: { changed: false },
		});

		const empty = await runCli(root, ["project", "find", "dependency graph"]);
		expect(empty.code).toBe(0);
		expect(empty.stdout.trim()).toBe("No project goals match dependency graph.");

		const missingText = await runCli(root, ["project", "find"]);
		expect(missingText.code).toBe(2);
	});

	it("reserves deleted goal IDs without resolving them to replacements", async () => {
		const root = await tempGitRepo();
		await runCli(root, ["project", "add", "Support goal templates"]);
		await runCli(root, ["project", "delete", "support-goal-templates", "--confirm"]);

		const replacement = await runCli(root, ["project", "add", "Support goal templates"]);
		expect(replacement.code).toBe(0);
		expect((await readGoals(root))[0].id).toBe("support-goal-templates-2");

		const staleReference = await runCli(root, ["project", "show", "support-goal-templates"]);
		expect(staleReference.code).toBe(1);
		expect(staleReference.stderr).toContain("support-goal-templates was not found");

		const staleMutation = await runCli(root, ["project", "update", "support-goal-templates", "Wrong target"]);
		expect(staleMutation.code).toBe(1);
		expect((await readGoals(root))[0].title).toBe("Support goal templates");
	});

	it("applies a JSON plan atomically with deterministic batch dependency resolution", async () => {
		const root = await tempGitRepo();
		await runCli(root, ["project", "add", "Add focus mode"]);
		await runCli(root, ["project", "add", "Shared runtime"]);
		const before = await readFile(join(root, ".worklist", "worklist.json"), "utf8");
		const beforeRevision = (parseJson(before) as ProjectWorklist).revision;
		const planPath = join(root, "plan.json");
		await writeFile(
			planPath,
			`${JSON.stringify([
				{
					title: "Batch foundation",
					description: "Created first but referenced before the batch exists.",
					group: "Capture",
				},
				{ title: "Add focus mode", dependsOn: ["batch-foundation"] },
				{ title: "Dependent feature", dependsOn: ["add-focus-mode", "shared-runtime"] },
			])}\n`,
			"utf8",
		);

		const humanPreview = await runCli(root, ["project", "apply-plan", planPath, "--dry-run"]);
		expect(humanPreview.code).toBe(0);
		expect(humanPreview.stdout).toContain("Would add 3 project goal(s)");
		expect(humanPreview.stderr).toContain(
			"batch dependency add-focus-mode resolves to new goal add-focus-mode-2",
		);
		expect(await readFile(join(root, ".worklist", "worklist.json"), "utf8")).toBe(before);

		const planned = await runCli(root, ["project", "apply-plan", planPath, "--dry-run", "--json"]);
		expect(planned.code).toBe(0);
		expect(planned.stderr).toBe("");
		const preview = parseJson(planned.stdout) as {
			result: {
				addedGoals: ProjectGoal[];
				warnings: Array<Record<string, string>>;
			};
			meta: { changed: boolean; semanticNoOp: boolean; revisions: { project: string } };
		};
		expect(preview.result.addedGoals.map((goal) => goal.id)).toEqual([
			"batch-foundation",
			"add-focus-mode-2",
			"dependent-feature",
		]);
		expect(preview.result.addedGoals[1].dependsOn).toEqual(["batch-foundation"]);
		expect(preview.result.addedGoals[2].dependsOn).toEqual(["add-focus-mode-2", "shared-runtime"]);
		expect(preview.result.warnings).toEqual([
			{
				code: "BATCH_REFERENCE_SHADOWS_EXISTING",
				reference: "add-focus-mode",
				existingGoalId: "add-focus-mode",
				batchGoalId: "add-focus-mode-2",
			},
		]);
		expect(preview.meta).toMatchObject({
			changed: false,
			semanticNoOp: false,
			revisions: { project: String(beforeRevision) },
		});
		expect(await readFile(join(root, ".worklist", "worklist.json"), "utf8")).toBe(before);

		const applied = await runCli(root, ["project", "apply-plan", planPath, "--json"]);
		expect(applied.code).toBe(0);
		const result = parseJson(applied.stdout) as {
			result: { addedGoals: ProjectGoal[]; goals: ProjectGoal[] };
			meta: { changed: boolean; revisions: { project: string } };
		};
		expect(result.result.addedGoals.map((goal) => goal.id)).toEqual(
			preview.result.addedGoals.map((goal) => goal.id),
		);
		expect(result.meta).toMatchObject({
			changed: true,
			revisions: { project: String(Number(beforeRevision) + 1) },
		});
		expect((await readGoals(root)).map((goal) => goal.id)).toEqual([
			"add-focus-mode",
			"shared-runtime",
			"batch-foundation",
			"add-focus-mode-2",
			"dependent-feature",
		]);
	});

	it("rejects an invalid JSON plan without changing the worklist", async () => {
		const root = await tempGitRepo();
		await runCli(root, ["project", "add", "Existing goal"]);
		const worklistPath = join(root, ".worklist", "worklist.json");
		const before = await readFile(worklistPath, "utf8");
		const cases = [
			{
				name: "duplicate pre-collision slug",
				plan: [{ title: "Same slug" }, { title: "Same slug!" }],
				code: "VALIDATION_FAILED",
			},
			{
				name: "unknown reference",
				plan: [{ title: "Unknown dependency", dependsOn: ["missing-goal"] }],
				code: "VALIDATION_FAILED",
			},
			{
				name: "existing prefix instead of exact id",
				plan: [{ title: "Prefix dependency", dependsOn: ["existing"] }],
				code: "VALIDATION_FAILED",
			},
			{
				name: "padded reference instead of exact id",
				plan: [{ title: "Padded dependency", dependsOn: [" existing-goal "] }],
				code: "VALIDATION_FAILED",
			},
			{
				name: "batch cycle",
				plan: [
					{ title: "Cycle A", dependsOn: ["cycle-b"] },
					{ title: "Cycle B", dependsOn: ["cycle-a"] },
				],
				code: "DEPENDENCY_CYCLE",
			},
		] as const;

		for (const testCase of cases) {
			const planPath = join(root, `${testCase.name.replaceAll(" ", "-")}.json`);
			await writeFile(planPath, `${JSON.stringify(testCase.plan)}\n`, "utf8");
			// pi-lens-ignore: await-in-loop
			const rejected = await runCli(root, ["project", "apply-plan", planPath, "--json"]);
			expect(rejected.code, testCase.name).toBe(1);
			expect(parseJson(rejected.stderr), testCase.name).toMatchObject({
				ok: false,
				action: "apply-plan",
				error: { code: testCase.code },
				meta: { changed: false },
			});
			expect(await readFile(worklistPath, "utf8"), testCase.name).toBe(before);
		}

		const malformedPath = join(root, "malformed.json");
		await writeFile(malformedPath, "[{\n", "utf8");
		const malformed = await runCli(root, ["project", "apply-plan", malformedPath, "--json"]);
		expect(malformed.code).toBe(1);
		expect(parseJson(malformed.stderr)).toMatchObject({
			ok: false,
			action: "apply-plan",
			error: { code: "VALIDATION_FAILED", details: { resolution: "fix-json-plan" } },
		});
		expect(await readFile(worklistPath, "utf8")).toBe(before);

		expect((await runCli(root, ["project", "apply-plan"])).code).toBe(2);
		expect((await runCli(root, ["project", "apply-plan", malformedPath, "extra.json"])).code).toBe(2);
	});

	it("migrates generated goal IDs on request and keeps the old ones resolvable", async () => {
		const root = await tempGitRepo();
		await mkdir(join(root, ".worklist"), { recursive: true });
		await writeFile(
			join(root, ".worklist", "worklist.json"),
			`${JSON.stringify({
				version: 1,
				revision: 2,
				retiredIds: ["support-goal-templates"],
				goals: [
					{
						id: "goal-ms6gwxrg-56c1bde6",
						title: "Support goal templates",
						status: "open",
						createdAt: "2026-05-04T09:12:31.004Z",
						updatedAt: "2026-05-04T09:12:31.004Z",
					},
					{
						id: "future-start-goal",
						title: "Already readable",
						status: "archived",
						createdAt: "2026-05-04T09:12:31.004Z",
						updatedAt: "2026-05-04T09:12:31.004Z",
					},
				],
			})}\n`,
			"utf8",
		);

		const planned = await runCli(root, ["project", "migrate_ids", "--dry-run"]);
		expect(planned.code).toBe(0);
		expect(planned.stdout).toContain("1 goal ID(s) would change:");
		expect(planned.stdout).toContain("goal-ms6gwxrg-56c1bde6 -> support-goal-templates-2");
		expect((await readGoals(root)).map((goal) => goal.id)).toEqual([
			"goal-ms6gwxrg-56c1bde6",
			"future-start-goal",
		]);

		const refused = await runCli(root, ["project", "migrate_ids"]);
		expect(refused.code).toBe(3);
		expect((await readGoals(root))[0].id).toBe("goal-ms6gwxrg-56c1bde6");

		const migrated = await runCli(root, ["project", "migrate_ids", "--confirm"]);
		expect(migrated.code).toBe(0);
		expect(migrated.stdout).toContain("Migrated 1 goal ID(s):");
		const goals = await readGoals(root);
		expect(goals.map((goal) => goal.id)).toEqual(["support-goal-templates-2", "future-start-goal"]);
		expect(goals[0].previousIds).toEqual(["goal-ms6gwxrg-56c1bde6"]);

		// Anything still holding the old ID, an evidence file or a PR description,
		// keeps resolving to the same goal.
		const byFormerId = await runCli(root, ["project", "show", "goal-ms6gwxrg-56c1bde6"]);
		expect(byFormerId.code).toBe(0);
		expect(byFormerId.stdout).toContain("support-goal-templates-2: Support goal templates");
		expect(byFormerId.stdout).toContain("former ids: goal-ms6gwxrg-56c1bde6");
		const byRetiredId = await runCli(root, ["project", "show", "support-goal-templates"]);
		expect(byRetiredId.code).toBe(1);

		const rerun = await runCli(root, ["project", "migrate_ids", "--confirm"]);
		expect(rerun.code).toBe(0);
		expect(rerun.stdout.trim()).toBe("No goal IDs need migration.");

		const contradictory = await runCli(root, ["project", "migrate_ids", "--dry-run", "--confirm"]);
		expect(contradictory.code).toBe(2);
		const misplaced = await runCli(root, ["project", "list", "--dry-run"]);
		expect(misplaced.code).toBe(2);
		expect(misplaced.stderr).toContain("--dry-run is only supported by project apply-plan, migrate_ids");
	});

	it("does not migrate a title-derived slug that resembles a generated ID", async () => {
		const root = await tempGitRepo();
		await runCli(root, ["project", "add", "Goal abc deadbeef"]);
		expect((await readGoals(root))[0].id).toBe("goal-abc-deadbeef-2");
		await runCli(root, ["project", "update", "goal-abc-deadbeef-2", "Something unrelated"]);

		const planned = await runCli(root, ["project", "migrate_ids", "--dry-run"]);
		expect(planned.code).toBe(0);
		expect(planned.stdout.trim()).toBe("No goal IDs need migration.");
	});

	it("rejects the session scope and unknown input with usage errors", async () => {
		const root = await tempGitRepo();
		const session = await runCli(root, ["session", "add", "Nope"]);
		expect(session.code).toBe(2);
		expect(session.stderr).toContain("inside a Pi session");

		const unknown = await runCli(root, ["project", "explode"]);
		expect(unknown.code).toBe(2);

		const missingTitle = await runCli(root, ["project", "add"]);
		expect(missingTitle.code).toBe(2);

		const flagAsCwd = await runCli(root, ["project", "list", "--cwd", "--json"]);
		expect(flagAsCwd.code).toBe(2);
		expect(flagAsCwd.stderr).toContain("--cwd requires a directory");
	});

	it("fails cleanly outside a git repository and honors --cwd", async () => {
		const bare = await mkdtemp(join(tmpdir(), "stepstone-nogit-"));
		const helpOutside = await runCli(bare, ["project", "help"]);
		expect(helpOutside.code).toBe(0);
		expect(helpOutside.stdout).toContain(`Usage: ${CLI_COMMAND_CONTRACT.binary} project`);

		const outside = await runCli(bare, ["project", "list"]);
		expect(outside.code).toBe(1);
		expect(outside.stderr).toContain("git repository");

		const outsideJson = await runCli(bare, ["project", "list", "--json"]);
		expect(outsideJson.code).toBe(1);
		expect(outsideJson.stdout).toBe("");
		expect(parseJson(outsideJson.stderr)).toMatchObject({
			ok: false,
			scope: "project",
			action: "list",
			error: { code: "UNAVAILABLE", retryable: false, details: { resolution: "run-inside-git-repository" } },
			meta: { changed: false, semanticNoOp: false, changedFields: [] },
		});

		const root = await tempGitRepo();
		const viaCwd = await runCli(bare, ["project", "add", "From", "elsewhere", "--cwd", root]);
		expect(viaCwd.code).toBe(0);
		expect((await readGoals(root))[0].title).toBe("From elsewhere");
	});

	it("rejects a known flag after the interactive description separator", async () => {
		const root = await tempGitRepo();
		await runCli(root, ["project", "add", "Existing goal"]);

		// This is the original ordering hazard: --json is no longer swallowed into
		// prose with a success exit code and human stdout.
		const swallowed = await runCli(root, [
			"project",
			"add",
			"Ship",
			"the",
			"CLI",
			"--",
			"External agent access",
			"--json",
		]);

		expect(swallowed.code).toBe(2);
		expect(swallowed.stdout).toBe("");
		expect(diagnostic(swallowed.stderr)).toContain("--json came after --");
		expect(diagnostic(swallowed.stderr)).toContain("Use --description <text>");
		expect(await readGoals(root)).toHaveLength(1);

		const valueTakingFlag = await runCli(root, [
			"project",
			"add",
			"Check",
			"cwd",
			"strictness",
			"--",
			"Description",
			"--cwd",
		]);
		expect(valueTakingFlag.code).toBe(2);
		expect(diagnostic(valueTakingFlag.stderr)).toContain("--cwd came after --");
		expect(diagnostic(valueTakingFlag.stderr)).toContain("--description <text>");
		expect(await readGoals(root)).toHaveLength(1);

		const appending = await runCli(root, [
			"project",
			"update",
			"existing-goal",
			"--append",
			"--",
			"Blocked until",
			"--json",
			"lands",
		]);
		expect(appending.code).toBe(2);
		expect(diagnostic(appending.stderr)).toContain("--json came after --");
		// An append steered toward --description alone would overwrite the very prose
		// the caller asked to keep, so the additive escape hatch has to be named too.
		expect(diagnostic(appending.stderr)).toContain("--append-description <text>");
		expect((await readGoals(root))[0].description).toBeUndefined();

		const severalFlags = await runCli(root, [
			"project",
			"add",
			"Count",
			"the",
			"flags",
			"--",
			"Prose",
			"--json",
			"--confirm",
		]);
		expect(severalFlags.code).toBe(2);
		expect(diagnostic(severalFlags.stderr)).toContain("--json, --confirm came after --");
		expect(diagnostic(severalFlags.stderr)).toContain("contains standalone flags");
		expect(diagnostic(severalFlags.stderr)).not.toContain("a standalone flags");
		expect(await readGoals(root)).toHaveLength(1);
	});

	it("keeps JSON failures parseable with a flag-looking description value", async () => {
		const root = await tempGitRepo();
		const result = await runCli(root, [
			"project",
			"update",
			"goal-missing",
			"--description",
			"--confirm",
			"--json",
		]);

		expect(result.code).toBe(1);
		expect(result.stdout).toBe("");
		const payload = parseJson(result.stderr);
		expect(payload).toMatchObject({
			ok: false,
			error: { code: "NOT_FOUND", details: { id: "goal-missing" } },
		});
		expect(payload).not.toHaveProperty("warnings");
	});

	it("accepts interactive description prose that merely mentions a flag", async () => {
		const root = await tempGitRepo();

		const result = await runCli(root, [
			"project",
			"add",
			"Document",
			"the",
			"CLI",
			"--",
			"Explain how `--json` prints the result envelope",
		]);

		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
	});

	it("reorders goals through every documented move form", async () => {
		const root = await tempGitRepo();
		for (const title of ["First", "Second", "Third"]) await runCli(root, ["project", "add", title]);
		const ids = async () => (await readGoals(root)).map((goal) => goal.id);
		expect(await ids()).toEqual(["first", "second", "third"]);

		expect((await runCli(root, ["project", "move", "third", "up"])).code).toBe(0);
		expect(await ids()).toEqual(["first", "third", "second"]);

		expect((await runCli(root, ["project", "move", "first", "down"])).code).toBe(0);
		expect(await ids()).toEqual(["third", "first", "second"]);

		// The anchor resolves through the same selector as the target, so a prefix
		// names a goal here exactly as it does everywhere else.
		expect((await runCli(root, ["project", "move", "sec", "before", "thi"])).code).toBe(0);
		expect(await ids()).toEqual(["second", "third", "first"]);

		expect((await runCli(root, ["project", "move", "second", "after", "first"])).code).toBe(0);
		expect(await ids()).toEqual(["third", "first", "second"]);

		const settled = await runCli(root, ["project", "move", "second", "down", "--json"]);
		expect(settled.code).toBe(0);
		expect(parseJson(settled.stdout)).toMatchObject({
			ok: true,
			action: "move",
			meta: { changed: false, semanticNoOp: true },
		});
		expect(await ids()).toEqual(["third", "first", "second"]);
	});

	it("refuses a move it cannot place and leaves the order alone", async () => {
		const root = await tempGitRepo();
		for (const title of ["First", "Second"]) await runCli(root, ["project", "add", title]);

		const usageErrors: Array<[string[], string]> = [
			[["project", "move"], "requires a goal id"],
			[["project", "move", "first"], "project move <id> up|down|before"],
			[["project", "move", "first", "sideways"], "project move <id> up|down|before"],
			[["project", "move", "first", "before"], "requires an anchor goal id"],
			[["project", "move", "first", "up", "second"], "takes no anchor"],
			[["project", "move", "first", "before", "second", "third"], "takes one placement"],
		];
		for (const [args, message] of usageErrors) {
			const result = await runCli(root, args);
			expect(result.code, args.join(" ")).toBe(2);
			expect(result.stderr, args.join(" ")).toContain(message);
		}

		const missingAnchor = await runCli(root, ["project", "move", "first", "before", "nowhere"]);
		expect(missingAnchor.code).toBe(1);
		expect(missingAnchor.stderr).toContain("Project goal anchor nowhere was not found.");
		expect((await readGoals(root)).map((goal) => goal.id)).toEqual(["first", "second"]);
	});

	it("files goals under a group and shows the fields a lifecycle change stamps", async () => {
		const root = await tempGitRepo();
		const added = await runCli(root, ["project", "add", "Ship", "it", "--group", "Foundation"]);
		expect(added.code).toBe(0);
		expect((await readGoals(root))[0].group).toBe("Foundation");

		const shown = await runCli(root, ["project", "show", "ship-it"]);
		expect(shown.stdout).toContain("group: Foundation");
		expect(shown.stdout).not.toContain("completed:");

		await runCli(root, ["project", "complete", "ship-it", "--confirm"]);
		const completed = await runCli(root, ["project", "show", "ship-it"]);
		expect(completed.stdout).toContain(`completed: ${(await readGoals(root))[0].updatedAt}`);

		const regrouped = await runCli(root, ["project", "update", "ship-it", "--group", "Later"]);
		expect(regrouped.code).toBe(0);
		expect((await readGoals(root))[0].group).toBe("Later");

		const cleared = await runCli(root, ["project", "update", "ship-it", "--group", ""]);
		expect(cleared.code).toBe(0);
		expect((await readGoals(root))[0]).not.toHaveProperty("group");

		// A group is a section name, so omitting it is a usage error rather than a
		// silent way to clear the field.
		const missingValue = await runCli(root, ["project", "update", "ship-it", "--group"]);
		expect(missingValue.code).toBe(2);
		expect(missingValue.stderr).toContain("--group requires a section name");

		const wrongAction = await runCli(root, ["project", "find", "ship", "--group", "Later"]);
		expect(wrongAction.code).toBe(2);
		expect(wrongAction.stderr).toContain("--group is only supported by project add, update");
	});

	it("sets, replaces, clears, validates, and preserves goal links", async () => {
		const root = await tempGitRepo();
		const added = await runCli(root, [
			"project",
			"add",
			"Linked",
			"--link",
			"https://example.com/one",
			"--link",
			"https://example.com/two",
		]);
		expect(added.code).toBe(0);
		expect((await readGoals(root))[0].links).toEqual(["https://example.com/one", "https://example.com/two"]);

		await runCli(root, ["project", "update", "linked", "--group", "Foundation"]);
		expect((await readGoals(root))[0].links).toEqual(["https://example.com/one", "https://example.com/two"]);
		const invalid = await runCli(root, ["project", "update", "linked", "--link", "github.com/example"]);
		expect(invalid.code).toBe(1);
		expect(invalid.stderr).toContain("absolute HTTP or HTTPS URL");
		expect((await readGoals(root))[0].links).toHaveLength(2);

		await runCli(root, ["project", "update", "linked", "--link", "https://example.com/two"]);
		expect((await readGoals(root))[0].links).toEqual(["https://example.com/two"]);
		await runCli(root, ["project", "update", "linked", "--link", ""]);
		expect((await readGoals(root))[0]).not.toHaveProperty("links");
	});

	it("records dependency edges and derives what a goal blocks", async () => {
		const root = await tempGitRepo();
		await runCli(root, ["project", "add", "Slug", "ids"]);
		await runCli(root, ["project", "add", "Schema", "fields"]);
		const added = await runCli(root, [
			"project",
			"add",
			"Dependency",
			"graph",
			"--depends-on",
			"slug",
			"--depends-on",
			"schema-fields",
		]);
		expect(added.code).toBe(0);
		expect((await readGoals(root))[2].dependsOn).toEqual(["slug-ids", "schema-fields"]);

		const shown = await runCli(root, ["project", "show", "dependency-graph"]);
		expect(shown.stdout).toContain("status: open (blocked)");
		expect(shown.stdout).toContain(
			"depends on:\n  slug-ids [open] - waiting\n  schema-fields [open] - waiting",
		);
		const shownJson = await runCli(root, ["project", "show", "dependency-graph", "--json"]);
		expect(parseJson(shownJson.stdout)).toMatchObject({
			result: {
				goal: { id: "dependency-graph", dependsOn: ["slug-ids", "schema-fields"] },
				blocked: true,
				blocks: [],
			},
		});

		// Only the forward direction is stored, so the reverse is derived on read.
		const target = await runCli(root, ["project", "show", "slug-ids"]);
		expect(target.stdout).toContain("blocks:\n  dependency-graph");
		expect(target.stdout).not.toContain("depends on:");
		const targetJson = await runCli(root, ["project", "show", "slug-ids", "--json"]);
		expect(parseJson(targetJson.stdout)).toMatchObject({
			result: {
				goal: { id: "slug-ids" },
				blocked: false,
				blocks: ["dependency-graph"],
			},
		});
		expect((await readGoals(root))[0]).not.toHaveProperty("blocks");
		expect((await readGoals(root))[0]).not.toHaveProperty("blocked");

		await runCli(root, ["project", "complete", "slug-ids", "--confirm"]);
		await runCli(root, ["project", "archive", "schema-fields", "--confirm"]);
		const satisfied = await runCli(root, ["project", "show", "dependency-graph"]);
		expect(satisfied.stdout).toContain("status: open\n");
		expect(satisfied.stdout).toContain("depends on:\n  slug-ids [done]\n  schema-fields [archived]");

		const cleared = await runCli(root, ["project", "update", "dependency-graph", "--depends-on", ""]);
		expect(cleared.code).toBe(0);
		expect((await readGoals(root))[2]).not.toHaveProperty("dependsOn");
	});

	it("refuses edges that cannot hold, and warns rather than refusing a blocked activation", async () => {
		const root = await tempGitRepo();
		await runCli(root, ["project", "add", "Slug", "ids"]);
		await runCli(root, ["project", "add", "Dependency", "graph", "--depends-on", "slug-ids"]);
		const before = await readGoals(root);

		const cycle = await runCli(root, ["project", "update", "slug-ids", "--depends-on", "dependency-graph"]);
		expect(cycle.code).toBe(1);
		expect(cycle.stderr).toContain("cycle: slug-ids -> dependency-graph -> slug-ids");

		const cycleJson = await runCli(root, [
			"project",
			"update",
			"slug-ids",
			"--depends-on",
			"dependency-graph",
			"--json",
		]);
		expect(cycleJson.code).toBe(1);
		expect(parseJson(cycleJson.stderr)).toMatchObject({
			ok: false,
			error: {
				code: "DEPENDENCY_CYCLE",
				details: { cycle: ["slug-ids", "dependency-graph"] },
			},
		});

		const missing = await runCli(root, ["project", "update", "slug-ids", "--depends-on", "nowhere"]);
		expect(missing.code).toBe(1);
		expect(missing.stderr).toContain("Project goal dependency nowhere was not found");
		expect(await readGoals(root)).toEqual(before);

		// Blocked is a reading of the graph, not a veto on saying what is in flight.
		const activated = await runCli(root, ["project", "set_active", "dependency-graph"]);
		expect(activated.code).toBe(0);
		expect(activated.stdout).toContain("Activated project goal dependency-graph");
		expect(activated.stderr).toContain("dependency-graph is blocked; slug-ids has not landed yet");
		expect((await readGoals(root))[1].status).toBe("active");

		// The JSON envelope carries the same fact, so nothing depends on stderr prose.
		const activatedJson = await runCli(root, ["project", "set_active", "dependency-graph", "--json"]);
		expect(activatedJson.stderr).toBe("");
		expect(parseJson(activatedJson.stdout)).toMatchObject({
			ok: true,
			result: { blockedBy: ["slug-ids"] },
		});
	});

	it("drops the edges naming a deleted goal in the same change", async () => {
		const root = await tempGitRepo();
		await runCli(root, ["project", "add", "Slug", "ids"]);
		await runCli(root, ["project", "add", "Dependency", "graph", "--depends-on", "slug-ids"]);

		const deleted = await runCli(root, ["project", "delete", "slug-ids", "--confirm", "--json"]);
		expect(deleted.code).toBe(0);
		expect(parseJson(deleted.stdout)).toMatchObject({
			meta: { changedEntities: { projectGoalIds: ["dependency-graph", "slug-ids"] } },
		});
		// A dangling edge would read as an unsatisfied dependency and block the goal
		// on work nobody can ever finish, so it never reaches the file.
		expect((await readGoals(root))[0]).not.toHaveProperty("dependsOn");
		expect((await runCli(root, ["project", "show", "dependency-graph"])).stdout).toContain("status: open\n");
	});

	it("refuses --depends-on where it would be ignored or contradict itself", async () => {
		const root = await tempGitRepo();
		await runCli(root, ["project", "add", "Slug", "ids"]);

		const missingValue = await runCli(root, ["project", "update", "slug-ids", "--depends-on"]);
		expect(missingValue.code).toBe(2);
		expect(missingValue.stderr).toContain("--depends-on requires a goal id");

		const contradictory = await runCli(root, [
			"project",
			"update",
			"slug-ids",
			"--depends-on",
			"",
			"--depends-on",
			"slug-ids",
		]);
		expect(contradictory.code).toBe(2);
		expect(contradictory.stderr).toContain("cannot be combined with another --depends-on");

		const wrongAction = await runCli(root, ["project", "set_active", "slug-ids", "--depends-on", "slug-ids"]);
		expect(wrongAction.code).toBe(2);
		expect(wrongAction.stderr).toContain("--depends-on is only supported by project add, update");

		const nothingToDo = await runCli(root, ["project", "update", "slug-ids"]);
		expect(nothingToDo.code).toBe(2);
		expect(nothingToDo.stderr).toContain("--depends-on, or --link");
	});

	it("reports malformed files without overwriting them", async () => {
		const root = await tempGitRepo();
		await runCli(root, ["project", "add", "Existing"]);
		const path = join(root, ".worklist", "worklist.json");
		const { writeFile } = await import("node:fs/promises");
		await writeFile(path, "not json\n");
		const result = await runCli(root, ["project", "add", "Another"]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("Malformed");

		for (const args of [
			["project", "show", "existing", "--json"],
			["project", "next", "--json"],
			["project", "ready", "--json"],
			["project", "waves", "--json"],
			["project", "migrate_ids", "--dry-run", "--json"],
		]) {
			const read = await runCli(root, args);
			expect(read.code, args.join(" ")).toBe(1);
			expect(read.stdout).toBe("");
			expect(parseJson(read.stderr)).toMatchObject({
				ok: false,
				error: {
					code: "PERSISTENCE_FAILED",
					retryable: false,
					details: { resolution: "repair-project-file" },
				},
			});
		}
		expect(await readFile(path, "utf8")).toBe("not json\n");
	});

	it("hands out the unblocked frontier and layers the rest behind it", async () => {
		const root = await tempGitRepo();
		await runCli(root, ["project", "add", "Add the parser"]);
		await runCli(root, ["project", "add", "Adopt the parser", "--depends-on", "add-the-parser"]);
		await runCli(root, ["project", "add", "Unrelated cleanup"]);
		await runCli(root, [
			"project",
			"add",
			"Retire the importer",
			"--depends-on",
			"adopt-the-parser",
			"--depends-on",
			"unrelated-cleanup",
		]);

		const ready = await runCli(root, ["project", "ready"]);
		expect(ready.code).toBe(0);
		expect(ready.stdout.trimEnd().split("\n")).toEqual([
			"[open] add-the-parser: Add the parser",
			"[open] unrelated-cleanup: Unrelated cleanup",
		]);

		// next is the first line of ready, so a driver taking one goal and a human
		// reading the frontier are never told two different things.
		const next = await runCli(root, ["project", "next"]);
		expect(next.code).toBe(0);
		expect(next.stdout.trimEnd()).toBe(ready.stdout.trimEnd().split("\n")[0]);

		const waves = await runCli(root, ["project", "waves"]);
		expect(waves.code).toBe(0);
		expect(waves.stdout.trimEnd().split("\n")).toEqual([
			"Wave 1 (2 goals):",
			"  [open] add-the-parser: Add the parser",
			"  [open] unrelated-cleanup: Unrelated cleanup",
			"Wave 2 (1 goal):",
			"  [open] adopt-the-parser: Adopt the parser",
			"Wave 3 (1 goal):",
			"  [open] retire-the-importer: Retire the importer",
		]);

		const wavesJson = parseJson((await runCli(root, ["project", "waves", "--json"])).stdout) as {
			result: { waves: ProjectGoal[][]; unreachableGoals?: ProjectGoal[] };
		};
		expect(wavesJson.result.waves.map((wave) => wave.map((goal) => goal.id))).toEqual([
			["add-the-parser", "unrelated-cleanup"],
			["adopt-the-parser"],
			["retire-the-importer"],
		]);
		expect(wavesJson.result.unreachableGoals).toBeUndefined();
	});

	it("never suggests a goal someone has already taken on", async () => {
		const root = await tempGitRepo();
		await runCli(root, ["project", "add", "Dispatched work"]);
		await runCli(root, ["project", "add", "Activated work"]);
		await runCli(root, ["project", "add", "Free work"]);
		await editGoalByHand(root, "dispatched-work", { branch: "feat/dispatched" });
		await runCli(root, ["project", "set_active", "activated-work"]);

		const next = parseJson((await runCli(root, ["project", "next", "--json"])).stdout) as {
			result: { goal: ProjectGoal };
		};
		expect(next.result.goal.id).toBe("free-work");

		const ready = parseJson((await runCli(root, ["project", "ready", "--json"])).stdout) as {
			result: { goals: ProjectGoal[] };
		};
		expect(ready.result.goals.map((goal) => goal.id)).toEqual(["free-work"]);

		// The schedule still holds claimed work and names what claimed it, so a goal
		// missing from the frontier is never unexplained.
		const waves = await runCli(root, ["project", "waves"]);
		expect(waves.stdout.trimEnd().split("\n")).toEqual([
			"Wave 1 (3 goals):",
			"  [open] dispatched-work: Dispatched work (branch feat/dispatched)",
			"  [active] activated-work: Activated work",
			"  [open] free-work: Free work",
		]);
	});

	it("keeps a wave member on one line when its branch was hand-edited across lines", async () => {
		const root = await tempGitRepo();
		await runCli(root, ["project", "add", "Dispatched work"]);
		await runCli(root, ["project", "add", "Free work"]);
		await editGoalByHand(root, "dispatched-work", { branch: "feat/one\nWave 9 (1 goal):" });

		// The layers are read one goal per line, so a stored newline must not be able
		// to split a member in half or forge a wave header out of the tail.
		const waves = await runCli(root, ["project", "waves"]);
		expect(waves.code).toBe(0);
		expect(waves.stdout.trimEnd().split("\n")).toEqual([
			"Wave 1 (2 goals):",
			"  [open] dispatched-work: Dispatched work (branch feat/one Wave 9 (1 goal):)",
			"  [open] free-work: Free work",
		]);
	});

	it("reports an empty frontier at exit code 0 and says why it is empty", async () => {
		const root = await tempGitRepo();

		for (const action of ["next", "ready", "waves"]) {
			// Each invocation is independent; sequential execution keeps output readable.
			// pi-lens-ignore: await-in-loop
			const empty = await runCli(root, ["project", action]);
			expect(empty.code, action).toBe(0);
			expect(empty.stdout.trimEnd(), action).toBe("No project goals.");
		}

		await runCli(root, ["project", "add", "Blocker"]);
		await runCli(root, ["project", "add", "Waiting", "--depends-on", "blocker"]);
		await runCli(root, ["project", "set_active", "blocker"]);

		const jammed = await runCli(root, ["project", "next"]);
		expect(jammed.code).toBe(0);
		expect(jammed.stdout.trimEnd()).toBe(
			"No project goal is ready; 2 goals unfinished, all blocked or already claimed.",
		);
		const jammedJson = parseJson((await runCli(root, ["project", "next", "--json"])).stdout) as {
			ok: boolean;
			result: { goal?: ProjectGoal };
		};
		expect(jammedJson.ok).toBe(true);
		expect(jammedJson.result.goal).toBeUndefined();

		await runCli(root, ["project", "complete", "blocker", "--confirm"]);
		await runCli(root, ["project", "archive", "waiting", "--confirm"]);
		const finished = await runCli(root, ["project", "ready"]);
		expect(finished.code).toBe(0);
		expect(finished.stdout.trimEnd()).toBe("No project goal is ready; every goal is done or archived.");
		const settled = await runCli(root, ["project", "waves"]);
		expect(settled.code).toBe(0);
		expect(settled.stdout.trimEnd()).toBe("No project goal is waiting; every goal is done or archived.");
	});

	it("keeps a goal no wave can hold in the schedule instead of dropping it", async () => {
		const root = await tempGitRepo();
		await runCli(root, ["project", "add", "Startable"]);
		await runCli(root, ["project", "add", "Stranded"]);
		await editGoalByHand(root, "stranded", { dependsOn: ["vanished"] });

		const waves = await runCli(root, ["project", "waves"]);
		expect(waves.code).toBe(0);
		expect(waves.stdout.trimEnd().split("\n")).toEqual([
			"Wave 1 (1 goal):",
			"  [open] startable: Startable",
			"Unreachable (1 goal), waiting on a cycle or a missing goal:",
			"  [open] stranded: Stranded",
		]);

		const wavesJson = parseJson((await runCli(root, ["project", "waves", "--json"])).stdout) as {
			result: { unreachableGoals: ProjectGoal[] };
		};
		expect(wavesJson.result.unreachableGoals.map((goal) => goal.id)).toEqual(["stranded"]);
		// A goal that can never start is not on offer either, so no driver picks it up.
		const ready = await runCli(root, ["project", "ready"]);
		expect(ready.stdout.trimEnd()).toBe("[open] startable: Startable");
	});
});

/** A worklist written straight to a named directory, as an older release left it. */
async function seedWorklistAt(root: string, directory: string, goalId: string): Promise<string> {
	const path = join(root, directory, "worklist.json");
	await mkdir(join(root, directory), { recursive: true });
	const worklist: ProjectWorklist = {
		version: 1,
		revision: 2,
		goals: [
			{
				id: goalId,
				title: goalId,
				status: "open",
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
			},
		],
	};
	await writeFile(path, `${JSON.stringify(worklist, null, 2)}\n`);
	return path;
}

describe("project goal file resolution", () => {
	it("writes the current path in a repository that has neither file", async () => {
		const root = await tempGitRepo();
		expect((await runCli(root, ["project", "add", "First"])).code).toBe(0);
		expect((await readGoals(root)).map((goal) => goal.id)).toEqual(["first"]);
	});

	it("reads and writes a legacy file rather than splitting the roadmap in two", async () => {
		const root = await tempGitRepo();
		const legacy = await seedWorklistAt(root, ".pi", "already-here");

		const listed = await runCli(root, ["project", "list"]);
		expect(listed.code).toBe(0);
		expect(listed.stdout).toContain("already-here");

		expect((await runCli(root, ["project", "add", "Added later"])).code).toBe(0);
		const worklist = parseJson(await readFile(legacy, "utf8")) as ProjectWorklist;
		expect(worklist.goals.map((goal) => goal.id)).toEqual(["already-here", "added-later"]);
		await expect(readFile(join(root, ".worklist", "worklist.json"), "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("warns on every command while a populated legacy file is passed over, in prose or in the envelope", async () => {
		const root = await tempGitRepo();
		await seedWorklistAt(root, ".pi", "in-the-old-file");
		await seedWorklistAt(root, ".worklist", "in-the-new-file");

		const listed = await runCli(root, ["project", "list"]);
		expect(listed.code).toBe(0);
		expect(listed.stdout).toContain("in-the-new-file");
		expect(listed.stdout).not.toContain("in-the-old-file");
		expect(listed.stderr).toContain(join(root, ".pi", "worklist.json"));
		expect(listed.stderr).toContain("is ignored");

		// A --json caller is told in the envelope instead of in prose, because the
		// failure envelope goes to stderr too and a sentence in front of it would
		// leave that caller nothing it can parse.
		const json = await runCli(root, ["project", "list", "--json"]);
		expect(json.stderr).toBe("");
		expect(parseJson(json.stdout)).toMatchObject({
			ok: true,
			meta: { shadowedWorklistPath: join(root, ".pi", "worklist.json") },
		});

		const failed = await runCli(root, ["project", "show", "nope", "--json"]);
		expect(failed.code).toBe(1);
		expect(parseJson(failed.stderr)).toMatchObject({
			ok: false,
			error: { code: "NOT_FOUND" },
			meta: { shadowedWorklistPath: join(root, ".pi", "worklist.json") },
		});
	});

	it("lets --file and the environment name a goal file outright, with --file winning", async () => {
		const root = await tempGitRepo();
		await seedWorklistAt(root, ".worklist", "the-repository-one");
		const named = await seedWorklistAt(root, "elsewhere", "the-named-one");
		const other = await seedWorklistAt(root, "another", "the-environment-one");

		const byFlag = await runCli(root, ["project", "list", "--file", named]);
		expect(byFlag.stdout).toContain("the-named-one");

		const byEnv = await runCli(root, ["project", "list"], { [WORKLIST_PATH_ENV]: other });
		expect(byEnv.stdout).toContain("the-environment-one");

		const both = await runCli(root, ["project", "list", "--file", named], { [WORKLIST_PATH_ENV]: other });
		expect(both.stdout).toContain("the-named-one");

		// --cwd selects the repository; a relative --file is still the caller's own
		// directory, the same rule apply-plan reads its plan path by.
		const relative = await runCli(root, ["project", "list", "--file", "elsewhere/worklist.json"]);
		expect(relative.stdout).toContain("the-named-one");
	});
});

describe("project goal file migration", () => {
	it("moves a legacy file to the current path and reports both", async () => {
		const root = await tempGitRepo();
		const legacy = await seedWorklistAt(root, ".pi", "carried-across");
		const current = join(root, ".worklist", "worklist.json");

		const preview = await runCli(root, ["project", "migrate_path", "--dry-run"]);
		expect(preview.code).toBe(0);
		expect(preview.stdout.trimEnd()).toBe(`Would move project worklist ${legacy} to ${current}.`);
		expect(await readFile(legacy, "utf8")).toContain("carried-across");

		const unconfirmed = await runCli(root, ["project", "migrate_path"]);
		expect(unconfirmed.code).toBe(3);
		expect(diagnostic(unconfirmed.stderr)).toContain("requires explicit confirmation");

		const migrated = await runCli(root, ["project", "migrate_path", "--confirm", "--json"]);
		expect(migrated.code).toBe(0);
		expect(parseJson(migrated.stdout)).toMatchObject({
			ok: true,
			action: "migrate_path",
			result: { worklistPath: current, previousWorklistPath: legacy },
			meta: {
				changed: true,
				semanticNoOp: false,
				changedFields: ["/worklistPath"],
				revisions: { project: "2" },
			},
		});
		expect((await readGoals(root)).map((goal) => goal.id)).toEqual(["carried-across"]);
		await expect(readFile(legacy, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

		// The goals came across untouched, so the next write continues the same
		// roadmap rather than starting a second one.
		expect((await runCli(root, ["project", "add", "Added after the move"])).code).toBe(0);
		expect((await readGoals(root)).map((goal) => goal.id)).toEqual([
			"carried-across",
			"added-after-the-move",
		]);
	});

	it("reports a repository already at the current path as nothing to do", async () => {
		const root = await tempGitRepo();
		await runCli(root, ["project", "add", "Already home"]);
		const current = join(root, ".worklist", "worklist.json");

		const migrated = await runCli(root, ["project", "migrate_path", "--confirm", "--json"]);
		expect(migrated.code).toBe(0);
		expect(parseJson(migrated.stdout)).toMatchObject({
			ok: true,
			result: { worklistPath: current },
			meta: { changed: false, semanticNoOp: true, changedFields: [] },
		});
		expect(parseJson(migrated.stdout).result.previousWorklistPath).toBeUndefined();

		const human = await runCli(root, ["project", "migrate_path", "--dry-run"]);
		expect(human.stdout.trimEnd()).toBe(`Project worklist is already at ${current}.`);
	});

	it("refuses to merge two worklists, and leaves both exactly as they were", async () => {
		const root = await tempGitRepo();
		const legacy = await seedWorklistAt(root, ".pi", "in-the-old-file");
		const current = await seedWorklistAt(root, ".worklist", "in-the-new-file");
		const before = await Promise.all([readFile(legacy, "utf8"), readFile(current, "utf8")]);

		const refused = await runCli(root, ["project", "migrate_path", "--confirm"]);
		expect(refused.code).toBe(1);
		expect(refused.stderr).toContain(`Project worklist ${current} already exists.`);
		expect(refused.stderr).toContain(`delete ${legacy}`);
		expect(await Promise.all([readFile(legacy, "utf8"), readFile(current, "utf8")])).toEqual(before);
	});

	it("refuses an explicitly named file, which is not a repository to migrate", async () => {
		const root = await tempGitRepo();
		const named = await seedWorklistAt(root, "elsewhere", "the-named-one");

		const byFlag = await runCli(root, ["project", "migrate_path", "--confirm", "--file", named]);
		expect(byFlag.code).toBe(2);
		expect(diagnostic(byFlag.stderr)).toContain("named one outright");

		const byEnv = await runCli(root, ["project", "migrate_path", "--confirm"], {
			[WORKLIST_PATH_ENV]: named,
		});
		expect(byEnv.code).toBe(2);
		expect(await readFile(named, "utf8")).toContain("the-named-one");
	});

	it("refuses to both write and not write", async () => {
		const root = await tempGitRepo();
		const refused = await runCli(root, ["project", "migrate_path", "--dry-run", "--confirm"]);
		expect(refused.code).toBe(2);
		expect(diagnostic(refused.stderr)).toBe("project migrate_path cannot combine --dry-run with --confirm");
	});
});
