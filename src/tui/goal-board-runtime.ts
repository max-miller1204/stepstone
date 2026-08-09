import { spawn } from "node:child_process";
import { accessSync, constants, type FSWatcher, watch } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import type { WorklistApplicationService, WorklistOperation } from "../application-service.ts";
import { WORKLIST_ERROR_CODES } from "../result-envelope.ts";
import type { ProjectGoal } from "../types.ts";
import type { BoardIntent } from "./goal-board.ts";
import { GoalBoard } from "./goal-board.ts";
import { createPalette, supportsColor } from "./style.ts";
import type { TerminalInput, TerminalOutput } from "./terminal.ts";
import { Terminal } from "./terminal.ts";

/**
 * Runs the Project Goal board: the only part of the standalone UI that performs
 * I/O.
 *
 * Its contract with `GoalBoard` is narrow. The board decides what should happen
 * and returns an intent; this module performs it, feeds the outcome back as a
 * status message, and re-reads canonical state. Every write goes through
 * `WorklistApplicationService`, so the board shares the cross-process lock and
 * atomic replacement with a live Pi session instead of touching the file.
 */

/** Coalescing window for filesystem change notifications, in milliseconds. */
const RELOAD_DEBOUNCE_MS = 120;

/** Fallback refresh cadence when filesystem watches are unavailable or lossy. */
const RELOAD_POLL_MS = 1000;

/** Editors tried when neither $VISUAL nor $EDITOR is set. */
const FALLBACK_EDITORS = ["nano", "vim", "vi"] as const;

export interface GoalBoardRuntimeOptions {
	service: WorklistApplicationService;
	/** Absolute path of `<git-root>/.pi/worklist.json`. */
	projectPath: string;
	/** Repository name shown in the header. */
	repositoryLabel: string;
	initialGoals: ProjectGoal[];
	input: TerminalInput;
	output: TerminalOutput;
	env: NodeJS.ProcessEnv;
}

/** Split a configured editor command into argv, honoring simple quoting. */
export function parseEditorCommand(command: string): string[] {
	const parts: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	for (const character of command.trim()) {
		if (quote) {
			if (character === quote) quote = undefined;
			else current += character;
			continue;
		}
		if (character === '"' || character === "'") {
			quote = character;
			continue;
		}
		if (character === " " || character === "\t") {
			if (current !== "") parts.push(current);
			current = "";
			continue;
		}
		current += character;
	}
	if (current !== "") parts.push(current);
	return parts;
}

function findOnPath(name: string, env: NodeJS.ProcessEnv): boolean {
	for (const entry of (env.PATH ?? "").split(delimiter)) {
		if (entry === "") continue;
		try {
			accessSync(resolve(entry, name), constants.X_OK);
			return true;
		} catch {
			// Not executable here; keep looking.
		}
	}
	return false;
}

/** Resolve the editor argv, preferring the user's configuration over a fallback. */
export function resolveEditorCommand(env: NodeJS.ProcessEnv): string[] | undefined {
	const configured = env.VISUAL?.trim() || env.EDITOR?.trim();
	if (configured) {
		const parsed = parseEditorCommand(configured);
		if (parsed.length > 0) return parsed;
	}
	for (const candidate of FALLBACK_EDITORS) {
		if (findOnPath(candidate, env)) return [candidate];
	}
	return undefined;
}

function runEditor(argv: string[], file: string): Promise<void> {
	return new Promise((resolvePromise, rejectPromise) => {
		const child = spawn(argv[0], [...argv.slice(1), file], { stdio: "inherit" });
		child.on("error", rejectPromise);
		child.on("close", (code) => {
			if (code === 0) resolvePromise();
			else rejectPromise(new Error(`${argv[0]} exited with code ${code ?? "unknown"}`));
		});
	});
}

export async function runGoalBoard(options: GoalBoardRuntimeOptions): Promise<void> {
	const { service, projectPath, env } = options;
	const palette = createPalette(supportsColor(options.output, env));
	const board = new GoalBoard({
		palette,
		repositoryLabel: options.repositoryLabel,
		goals: options.initialGoals,
	});
	const terminal = new Terminal({ input: options.input, output: options.output });

	let running = true;
	let renderScheduled = false;
	let work: Promise<void> = Promise.resolve();
	let projectWatcher: FSWatcher | undefined;
	let parentWatcher: FSWatcher | undefined;
	let reloadTimer: NodeJS.Timeout | undefined;
	let reloadPoller: NodeJS.Timeout | undefined;
	let reloadQueued = false;
	let finish: () => void = () => {};
	const finished = new Promise<void>((resolvePromise) => {
		finish = resolvePromise;
	});

	const draw = (): void => {
		if (!running) return;
		terminal.render(board.render(terminal.columns, terminal.rows));
	};

	const scheduleRender = (): void => {
		if (renderScheduled || !running) return;
		renderScheduled = true;
		setImmediate(() => {
			renderScheduled = false;
			draw();
		});
	};

	const reload = async (): Promise<void> => {
		const envelope = await service.execute({ scope: "project", action: "list" }, { source: "cli" });
		if (!envelope.ok) {
			board.setMessage(envelope.error.message, "error");
			return;
		}
		board.setGoals(envelope.result.goals ?? []);
	};

	const applyOperation = async (operation: WorklistOperation, success: string): Promise<void> => {
		const envelope = await service.execute(operation, { source: "cli" });
		if (envelope.ok) {
			await reload();
			const blockedBy = envelope.result.blockedBy ?? [];
			if (blockedBy.length > 0) {
				board.setMessage(`Warning: ${success}; blocked by ${blockedBy.join(", ")}.`, "info");
			} else board.setMessage(success, "success");
			return;
		}
		// A conflict means another writer moved first; show canonical state, not stale rows.
		if (envelope.error.code === WORKLIST_ERROR_CODES.CONFLICT) await reload();
		board.setMessage(envelope.error.message, "error");
	};

	const editDescription = async (goal: ProjectGoal): Promise<void> => {
		const argv = resolveEditorCommand(env);
		if (!argv) {
			board.setMessage("Set $EDITOR or $VISUAL to edit descriptions.", "error");
			return;
		}
		const directory = await mkdtemp(join(tmpdir(), "stepstone-goal-"));
		const file = join(directory, "description.md");
		const original = goal.description ?? "";
		try {
			await writeFile(file, original, "utf8");
			await terminal.suspend(() => runEditor(argv, file));
			const edited = await readFile(file, "utf8");
			if (edited.trim() === original.trim()) {
				board.setMessage("Description unchanged.", "info");
				return;
			}
			await applyOperation(
				{ scope: "project", action: "update", id: goal.id, description: edited.trim() },
				edited.trim() === "" ? "Description cleared" : "Description updated",
			);
		} catch (error) {
			board.setMessage(error instanceof Error ? error.message : String(error), "error");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	};

	const stop = (): void => {
		if (!running) return;
		running = false;
		if (reloadTimer) clearTimeout(reloadTimer);
		if (reloadPoller) clearInterval(reloadPoller);
		projectWatcher?.close();
		parentWatcher?.close();
		terminal.close();
		finish();
	};

	const perform = (intent: BoardIntent): void => {
		if (intent.kind === "quit") {
			stop();
			return;
		}
		// Serialize side effects so two fast keystrokes cannot interleave writes.
		// Queued work is never abandoned on quit: the user already committed to it,
		// and `runGoalBoard` waits for the chain to drain before returning.
		work = work
			.then(async () => {
				if (intent.kind === "reload") {
					await reload();
					board.setMessage("Reloaded from disk.", "info");
					return;
				}
				if (intent.kind === "operation") {
					await applyOperation(intent.operation, intent.success);
					return;
				}
				if (intent.kind === "reorder") {
					const operation = board.resolveReorder(intent);
					if (!operation) {
						board.setMessage(intent.delta < 0 ? "Already first." : "Already last.", "info");
						return;
					}
					await applyOperation(operation, intent.success);
					return;
				}
				await editDescription(intent.goal);
			})
			.catch((error: unknown) => {
				board.setMessage(error instanceof Error ? error.message : String(error), "error");
			})
			.finally(() => {
				scheduleRender();
			});
	};

	terminal.onKey((key) => {
		if (!running) return;
		const intent = board.handleKey(key);
		if (intent) perform(intent);
		scheduleRender();
	});
	terminal.onResizeRequest(scheduleRender);

	terminal.open();
	draw();

	// A reload already queued behind other work reads the file when it finally
	// runs, so it covers every change requested before then and further requests
	// would only re-read the same state. Coalescing them keeps work that holds the
	// chain for a long time, such as an editor session, from stacking up one
	// redundant read per poll tick.
	const scheduleReload = (): void => {
		if (reloadQueued) return;
		if (reloadTimer) clearTimeout(reloadTimer);
		reloadTimer = setTimeout(() => {
			reloadTimer = undefined;
			reloadQueued = true;
			work = work
				.then(() => {
					reloadQueued = false;
					return reload();
				})
				.catch(() => {})
				.finally(scheduleRender);
		}, RELOAD_DEBOUNCE_MS);
	};

	// Another Pi session or CLI call may rewrite the file underneath the board.
	// The file is replaced by rename, so the directory is what must be watched.
	// A low-frequency read keeps live reload working when inotify instances are
	// exhausted, a watcher errors after creation, or a filesystem drops events.
	reloadPoller = setInterval(scheduleReload, RELOAD_POLL_MS);

	const projectDirectory = dirname(projectPath);
	const attachProjectWatcher = (): void => {
		projectWatcher?.close();
		projectWatcher = undefined;
		try {
			const nextWatcher = watch(projectDirectory, (_event, filename) => {
				if (filename !== null && basename(filename) !== basename(projectPath)) return;
				scheduleReload();
			});
			projectWatcher = nextWatcher;
			nextWatcher.on("error", () => {
				nextWatcher.close();
				if (projectWatcher === nextWatcher) projectWatcher = undefined;
			});
		} catch {
			projectWatcher = undefined;
		}
	};

	try {
		const nextWatcher = watch(dirname(projectDirectory), (_event, filename) => {
			if (filename !== null && basename(filename) !== basename(projectDirectory)) return;
			attachProjectWatcher();
			scheduleReload();
		});
		parentWatcher = nextWatcher;
		nextWatcher.on("error", () => {
			nextWatcher.close();
			if (parentWatcher === nextWatcher) parentWatcher = undefined;
		});
	} catch {
		parentWatcher = undefined;
	}
	attachProjectWatcher();

	try {
		await finished;
	} finally {
		stop();
		await work;
	}
}
