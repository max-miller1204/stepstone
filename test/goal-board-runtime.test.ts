import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorklistApplicationService } from "../src/application-service.ts";
import { resolveWorklistLocation, shadowedWorklistWarning } from "../src/git.ts";
import { parseEditorCommand, resolveEditorCommand, runGoalBoard } from "../src/tui/goal-board-runtime.ts";
import type { ProjectGoal, ProjectWorklist } from "../src/types.ts";

/**
 * How `fs.watch` behaves for the board under test. `real` is the host's own
 * watcher, `throw` is a host whose inotify instances are exhausted so no watcher
 * can be created, and `error` is a watcher that is created and then fails, which
 * stands in for the one that quietly stops delivering events too.
 */
const fsWatch = vi.hoisted(() => ({ mode: "real" as "real" | "throw" | "error" }));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const watch = (...args: Parameters<typeof actual.watch>) => {
		if (fsWatch.mode === "real") return actual.watch(...args);
		if (fsWatch.mode === "throw") {
			const failure: NodeJS.ErrnoException = new Error("EMFILE: inotify instance limit reached");
			failure.code = "EMFILE";
			throw failure;
		}
		const watcher = Object.assign(new EventEmitter(), { close: () => {} });
		setTimeout(() => watcher.emit("error", new Error("inotify watch was dropped")), 0);
		return watcher as unknown as ReturnType<typeof actual.watch>;
	};
	return { ...actual, watch: watch as unknown as typeof actual.watch };
});

const execFileAsync = promisify(execFile);
const cliPath = resolve("src/cli.ts");
const ESC = "\u001b";

/**
 * End-to-end coverage for the board as a user drives it: real keystrokes in,
 * real goal file out, through the same application service, lock, and
 * atomic replacement a live Pi session uses.
 */

class FakeOutput extends EventEmitter {
	readonly chunks: string[] = [];
	columns = 100;
	rows = 26;
	isTTY = true;

	write(chunk: string): boolean {
		this.chunks.push(chunk);
		return true;
	}

	/** Everything drawn so far, with styling and cursor moves removed. */
	get text(): string {
		// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping the ESC byte is the point here.
		return this.chunks.join("").replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, "");
	}
}

interface Harness {
	root: string;
	projectPath: string;
	input: PassThrough;
	output: FakeOutput;
	done: Promise<void>;
	send(keys: string): void;
	goals(): Promise<ProjectGoal[]>;
}

async function tempGitRepo(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "stepstone-board-"));
	await execFileAsync("git", ["init", "-q"], { cwd: root });
	return root;
}

async function seed(root: string, args: string[]): Promise<void> {
	await execFileAsync(process.execPath, [cliPath, "project", ...args], { cwd: root });
}

function parseJson<T>(text: string): T {
	try {
		return JSON.parse(text) as T;
	} catch (error) {
		throw new Error("Expected valid JSON in goal board runtime test", { cause: error });
	}
}

async function readGoals(root: string): Promise<ProjectGoal[]> {
	try {
		const raw = await readFile(join(root, ".worklist", "worklist.json"), "utf8");
		return parseJson<ProjectWorklist>(raw).goals;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

/**
 * The board over a repository, driven the way `project ui` drives it: through
 * the shared resolution order rather than a path fixed when the board opened,
 * so a goal file that moves under it moves the test's board too.
 */
async function openBoard(root: string, env: NodeJS.ProcessEnv = {}): Promise<Harness> {
	const projectPath = join(root, ".worklist", "worklist.json");
	const locate = () => resolveWorklistLocation(root, { env: {} });
	const resolveLocation = () => {
		const current = locate();
		const notice = shadowedWorklistWarning(current);
		return { path: current.path, ...(notice !== undefined ? { notice } : {}) };
	};
	const service = new WorklistApplicationService({});
	service.setProjectPathResolver(() => locate().path);
	const input = new PassThrough();
	const output = new FakeOutput();
	const initialGoals = await readGoals(root);
	const done = runGoalBoard({
		service,
		resolveLocation,
		repositoryLabel: "fixture",
		initialGoals,
		input,
		output,
		env,
	});
	return {
		root,
		projectPath,
		input,
		output,
		done,
		send: (keys: string) => input.write(keys),
		goals: () => readGoals(root),
	};
}

async function waitFor(check: () => boolean | Promise<boolean>, description: string): Promise<void> {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		if (await check()) return;
		// Polling keeps the assertion independent of internal scheduling.
		// pi-lens-ignore: await-in-loop
		await new Promise((settle) => setTimeout(settle, 20));
	}
	throw new Error(`Timed out waiting for ${description}`);
}

describe("goal board runtime", () => {
	afterEach(() => {
		fsWatch.mode = "real";
	});

	it("adds a goal through the prompt and writes it to the shared project file", async () => {
		const root = await tempGitRepo();
		const board = await openBoard(root);
		board.send("aShip the terminal board\rq");
		await board.done;

		const goals = await board.goals();
		expect(goals).toHaveLength(1);
		expect(goals[0]).toMatchObject({ title: "Ship the terminal board", status: "open" });
	});

	it("activates an open goal with space, without any confirmation", async () => {
		const root = await tempGitRepo();
		await seed(root, ["add", "Replace legacy auth"]);
		const board = await openBoard(root);
		board.send(" q");
		await board.done;

		expect((await board.goals())[0].status).toBe("active");
	});

	it("warns when activating a blocked goal while preserving success", async () => {
		const root = await tempGitRepo();
		await seed(root, ["add", "Slug ids"]);
		await seed(root, ["add", "Dependency graph", "--depends-on", "slug-ids"]);
		const board = await openBoard(root);
		board.send(`${ESC}[B `);
		await waitFor(
			() =>
				board.output.text.includes("Warning: Activated") && board.output.text.includes("blocked by slug-ids"),
			"the blocked activation warning",
		);
		board.send("q");
		await board.done;

		expect((await board.goals()).find((goal) => goal.id === "dependency-graph")?.status).toBe("active");
	});

	it("completes the active goal only after an explicit yes", async () => {
		const root = await tempGitRepo();
		await seed(root, ["add", "Replace legacy auth"]);
		const goalId = (await readGoals(root))[0].id;
		await seed(root, ["set_active", goalId]);

		const refused = await openBoard(root);
		refused.send("c");
		refused.send("nq");
		await refused.done;
		expect((await refused.goals())[0].status, "n must not complete the goal").toBe("active");

		const accepted = await openBoard(root);
		accepted.send("c");
		accepted.send("yq");
		await accepted.done;
		expect((await accepted.goals())[0].status).toBe("done");
	});

	it("reorders the roadmap on disk, and says so when there is nowhere to go", async () => {
		const root = await tempGitRepo();
		for (const title of ["First", "Second", "Third"]) await seed(root, ["add", title]);

		const board = await openBoard(root);
		board.send("J");
		await waitFor(
			async () => (await board.goals()).map((goal) => goal.id).join() === "second,first,third",
			"the moved goal to land in the file",
		);
		// The selection follows the goal, so a second press keeps moving the same one.
		board.send("J");
		await waitFor(
			async () => (await board.goals()).map((goal) => goal.id).join() === "second,third,first",
			"the second move to land",
		);
		board.send("J");
		await waitFor(() => board.output.text.includes("Already last."), "the end-of-list message");
		board.send("q");
		await board.done;

		expect((await board.goals()).map((goal) => goal.id)).toEqual(["second", "third", "first"]);
	});

	it("resolves rapid reorder keys against each preceding queued move", async () => {
		const root = await tempGitRepo();
		for (const title of ["First", "Second", "Third"]) await seed(root, ["add", title]);

		const board = await openBoard(root);
		board.send("JJq");
		await board.done;

		expect((await board.goals()).map((goal) => goal.id)).toEqual(["second", "third", "first"]);
	});

	it("deletes only after an explicit yes", async () => {
		const root = await tempGitRepo();
		await seed(root, ["add", "Throwaway"]);

		const refused = await openBoard(root);
		refused.send("d");
		refused.send(`${ESC}q`);
		await refused.done;
		expect(await refused.goals()).toHaveLength(1);

		const accepted = await openBoard(root);
		accepted.send("d");
		accepted.send("yq");
		await accepted.done;
		expect(await accepted.goals()).toHaveLength(0);
	});

	it("does not accept confirmation from the input chunk that opened it", async () => {
		const root = await tempGitRepo();
		await seed(root, ["add", "Keep this"]);
		const board = await openBoard(root);

		board.send("dy");
		board.send("nq");
		await board.done;

		expect(await board.goals()).toHaveLength(1);
	});

	it("treats bracketed paste as editor text, never browse commands", async () => {
		const root = await tempGitRepo();
		await seed(root, ["add", "Keep this"]);
		const board = await openBoard(root);

		board.send(`${ESC}[200~dy${ESC}[201~a${ESC}[200~Pasted title${ESC}[201~\rq`);
		await board.done;

		expect((await board.goals()).map((goal) => goal.title)).toEqual(["Keep this", "Pasted title"]);
	});

	it("renames a goal without touching its description", async () => {
		const root = await tempGitRepo();
		await seed(root, ["add", "Old title", "--", "Keep this description"]);
		const board = await openBoard(root);
		board.send("e\u0015New title\rq");
		await board.done;

		expect((await board.goals())[0]).toMatchObject({
			title: "New title",
			description: "Keep this description",
		});
	});

	it("shows the service error instead of pretending the change landed", async () => {
		const root = await tempGitRepo();
		await seed(root, ["add", "Finished work"]);
		const goalId = (await readGoals(root))[0].id;
		await seed(root, ["set_active", goalId]);
		await seed(root, ["complete", goalId, "--confirm"]);

		const board = await openBoard(root);
		// `s` on a done goal is refused by the service, which asks for a reopen first.
		board.send("fs");
		await waitFor(() => board.output.text.includes("reopen"), "the refusal message");
		board.send("q");
		await board.done;

		expect((await board.goals())[0].status).toBe("done");
	});

	it("picks up a change written by another process while the board is open", async () => {
		const root = await tempGitRepo();
		await seed(root, ["add", "First goal"]);
		const board = await openBoard(root);
		await waitFor(() => board.output.text.includes("First goal"), "the initial render");

		await seed(root, ["add", "Added from another process"]);
		await waitFor(
			() => board.output.text.includes("Added from another process"),
			"the externally added goal to appear",
		);

		board.send("q");
		await board.done;
	});

	it("starts live reload when another process creates the missing worklist directory", async () => {
		const root = await tempGitRepo();
		const board = await openBoard(root);

		await seed(root, ["add", "Created after the board opened"]);
		await waitFor(
			() => board.output.text.includes("Created after the board opened"),
			"the first externally added goal to appear",
		);

		board.send("q");
		await board.done;
	});

	it("follows the goal file a migrate_path moves out from under it, instead of splitting the roadmap", async () => {
		const root = await tempGitRepo();
		// A repository an older release wrote: the board opens on the legacy file,
		// which is the only state where the file can move while the board is up.
		const legacyPath = join(root, ".pi", "worklist.json");
		await mkdir(join(root, ".pi"), { recursive: true });
		await writeFile(legacyPath, `${JSON.stringify({ version: 1, goals: [] })}\n`);
		await seed(root, ["add", "Written before the move"]);
		expect(parseJson<ProjectWorklist>(await readFile(legacyPath, "utf8")).goals).toHaveLength(1);

		const board = await openBoard(root);
		await waitFor(() => board.output.text.includes("Written before the move"), "the initial render");

		await seed(root, ["migrate_path", "--confirm"]);
		// A goal written to the migrated file appears on screen only if the board
		// is reading the path the repository resolves to now.
		await seed(root, ["add", "Added to the migrated file"]);
		await waitFor(
			() => board.output.text.includes("Added to the migrated file"),
			"the board to read the migrated file",
		);

		board.send("aAdded from the board\rq");
		await board.done;

		// And it wrote there too, so the repository still has exactly one roadmap.
		expect((await board.goals()).map((goal) => goal.title)).toEqual([
			"Written before the move",
			"Added to the migrated file",
			"Added from the board",
		]);
		await expect(readFile(legacyPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("raises the two-worklist notice that appears while it is open", async () => {
		const root = await tempGitRepo();
		await seed(root, ["add", "On the current file"]);
		const board = await openBoard(root);
		await waitFor(() => board.output.text.includes("On the current file"), "the initial render");
		expect(board.output.text).not.toContain("two project worklists exist");

		// A second roadmap can appear at any moment: a branch checkout, a merge, or
		// a colleague's older release writing the legacy path.
		await mkdir(join(root, ".pi"), { recursive: true });
		await writeFile(join(root, ".pi", "worklist.json"), `${JSON.stringify({ version: 1, goals: [] })}\n`);
		await waitFor(
			() => board.output.text.includes("two project worklists exist"),
			"the notice to appear without reopening the board",
		);

		board.send("q");
		await board.done;
	});

	it("picks up a change when no filesystem watcher can be created", async () => {
		const root = await tempGitRepo();
		await seed(root, ["add", "First goal"]);
		fsWatch.mode = "throw";
		const board = await openBoard(root);
		await waitFor(() => board.output.text.includes("First goal"), "the initial render");

		await seed(root, ["add", "Added with watches unavailable"]);
		await waitFor(
			() => board.output.text.includes("Added with watches unavailable"),
			"the externally added goal to appear without any watcher",
		);

		board.send("q");
		await board.done;
	});

	it("keeps picking up changes after a watcher fails and stops reporting", async () => {
		const root = await tempGitRepo();
		await seed(root, ["add", "First goal"]);
		fsWatch.mode = "error";
		const board = await openBoard(root);
		await waitFor(() => board.output.text.includes("First goal"), "the initial render");

		await seed(root, ["add", "Added after the watcher failed"]);
		await waitFor(
			() => board.output.text.includes("Added after the watcher failed"),
			"the externally added goal to appear after the watcher failed",
		);

		board.send("q");
		await board.done;
	});

	it("edits a description through $EDITOR and stores the result", async () => {
		const root = await tempGitRepo();
		await seed(root, ["add", "Needs detail"]);
		const editor = join(root, "fake-editor.sh");
		await writeFile(editor, "#!/bin/sh\nprintf 'Written by the editor' > \"$1\"\n", "utf8");
		await chmod(editor, 0o755);

		const board = await openBoard(root, { EDITOR: editor });
		board.send("E");
		await waitFor(async () => (await board.goals())[0]?.description !== undefined, "the stored description");
		board.send("q");
		await board.done;

		expect((await board.goals())[0].description).toBe("Written by the editor");
	});

	it("reports a missing editor instead of failing silently", async () => {
		const root = await tempGitRepo();
		await seed(root, ["add", "Needs detail"]);
		const board = await openBoard(root, { PATH: join(root, "empty") });
		board.send("E");
		await waitFor(() => board.output.text.includes("$EDITOR"), "the missing editor message");
		board.send("q");
		await board.done;
	});

	it("restores the terminal on exit", async () => {
		const root = await tempGitRepo();
		const board = await openBoard(root);
		board.send("q");
		await board.done;

		const raw = board.output.chunks.join("");
		expect(raw, "must enter the alternate buffer").toContain(`${ESC}[?1049h`);
		expect(raw, "must leave the alternate buffer").toContain(`${ESC}[?1049l`);
		expect(raw, "must restore the cursor").toContain(`${ESC}[?25h`);
		expect(raw, "must restore auto-wrap").toContain(`${ESC}[?7h`);
		expect(raw, "must enable bracketed paste").toContain(`${ESC}[?2004h`);
		expect(raw, "must disable bracketed paste").toContain(`${ESC}[?2004l`);
	});

	it("quits on ctrl+c", async () => {
		const root = await tempGitRepo();
		const board = await openBoard(root);
		board.send("\u0003");
		await board.done;
		expect(board.output.chunks.join("")).toContain(`${ESC}[?1049l`);
	});
});

describe("editor resolution", () => {
	it("splits a configured command into argv, honoring quotes", () => {
		expect(parseEditorCommand("code --wait")).toEqual(["code", "--wait"]);
		expect(parseEditorCommand('"/opt/my editor/bin" -f')).toEqual(["/opt/my editor/bin", "-f"]);
		expect(parseEditorCommand("   ")).toEqual([]);
	});

	it("prefers VISUAL over EDITOR", () => {
		expect(resolveEditorCommand({ VISUAL: "visual-editor", EDITOR: "fallback" })).toEqual(["visual-editor"]);
		expect(resolveEditorCommand({ EDITOR: "fallback -w" })).toEqual(["fallback", "-w"]);
	});

	it("reports no editor when nothing is configured or installed", () => {
		expect(resolveEditorCommand({ PATH: "/nonexistent-directory" })).toBeUndefined();
	});
});

describe("project ui command guards", () => {
	async function runCli(cwd: string, args: string[]): Promise<{ code: number; stderr: string }> {
		try {
			await execFileAsync(process.execPath, [cliPath, ...args], { cwd });
			return { code: 0, stderr: "" };
		} catch (error) {
			const failure = error as { code: number | null; stderr: string };
			return { code: failure.code ?? 1, stderr: failure.stderr };
		}
	}

	it("refuses to open without a terminal, pointing at the scriptable read path", async () => {
		const root = await tempGitRepo();
		const result = await runCli(root, ["project", "ui"]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("interactive terminal");
		expect(result.stderr).toContain("project list --json");
	});

	it("rejects --json as a usage error rather than opening a board", async () => {
		const root = await tempGitRepo();
		const result = await runCli(root, ["project", "ui", "--json"]);
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("cannot be combined with --json");
	});

	it("still requires a git repository", async () => {
		const outside = await mkdtemp(join(tmpdir(), "stepstone-not-a-repo-"));
		const result = await runCli(outside, ["project", "ui"]);
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("git repository");
	});
});
