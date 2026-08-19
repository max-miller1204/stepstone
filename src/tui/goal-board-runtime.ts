import { spawn } from "node:child_process";
import { accessSync, constants, type FSWatcher, watch } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import type { WorklistApplicationService, WorklistOperation } from "../application-service.ts";
import { CLI_COMMAND_CONTRACT } from "../cli-contract.ts";
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

/** Where the goals are right now, and what the user has to know about that. */
export interface BoardWorklistLocation {
	/** Absolute path of the goal file, as the shared resolution order chose it. */
	path: string;
	/**
	 * A standing condition about that file, shown while the board is open.
	 *
	 * Composed by the caller so no two interfaces word the same condition
	 * differently, and re-read with the path because merging the two files
	 * resolves it as surely as the board's own writes create it.
	 */
	notice?: string;
}

export interface GoalBoardRuntimeOptions {
	service: WorklistApplicationService;
	/**
	 * Ask again, rather than remember, where the goals are.
	 *
	 * The board holds the terminal until the user quits, which makes it the one
	 * command that outlives a `migrate_path` run in another terminal. A
	 * remembered path would then be a file that no longer exists: the board would
	 * blank, and the next goal it added would recreate the old file beside the
	 * migrated one, splitting the roadmap in two. Every reload asks, so the file
	 * the board watches, reads, and writes is the one the repository resolves to
	 * now.
	 *
	 * `createWorklistLocator` composes one of these; a host that builds its own
	 * is answering a question two interfaces already agree on.
	 */
	resolveLocation: () => BoardWorklistLocation;
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
	const { service, env } = options;
	// Pointed here rather than by the caller: every write then lands in the file
	// the board resolved for its own reads, and no host can wire the two halves
	// to different answers.
	service.setProjectPathResolver(() => options.resolveLocation().path);
	const palette = createPalette(supportsColor(options.output, env));
	let location = options.resolveLocation();
	const board = new GoalBoard({
		palette,
		repositoryLabel: options.repositoryLabel,
		...(location.notice !== undefined ? { notice: location.notice } : {}),
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

	// Declared before `reload` so a re-resolution can retarget the watchers, and
	// assigned after them, because they are what it retargets.
	let retargetWatchers: (directory: string) => void = () => {};

	/**
	 * Re-read where the goals are, and follow them if they moved.
	 *
	 * Every reload asks, so a `migrate_path` in another terminal is picked up by
	 * the same poll that would otherwise have read the file it moved.
	 */
	const relocate = (): void => {
		const next = options.resolveLocation();
		const moved = next.path !== location.path;
		location = next;
		board.setNotice(next.notice);
		if (moved) retargetWatchers(dirname(next.path));
	};

	const reload = async (): Promise<void> => {
		relocate();
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
		const directory = await mkdtemp(join(tmpdir(), `${CLI_COMMAND_CONTRACT.binary}-goal-`));
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
						// The board decided this wording when it read the section; repeating
						// it here keeps a move that raced a reload from answering the same
						// condition differently than the next keypress will.
						board.setMessage(intent.blocked, "info");
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

	let projectDirectory = dirname(location.path);
	const attachProjectWatcher = (): void => {
		projectWatcher?.close();
		projectWatcher = undefined;
		try {
			const watched = projectDirectory;
			const nextWatcher = watch(watched, (_event, filename) => {
				if (filename !== null && basename(filename) !== basename(location.path)) return;
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

	const attachParentWatcher = (): void => {
		parentWatcher?.close();
		parentWatcher = undefined;
		try {
			const watched = projectDirectory;
			const nextWatcher = watch(dirname(watched), (_event, filename) => {
				if (filename !== null && basename(filename) !== basename(watched)) return;
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
	};

	// A goal file that moved is in another directory, so the watches that would
	// have reported the next change are watching the wrong one until they follow.
	retargetWatchers = (directory: string): void => {
		if (!running || directory === projectDirectory) return;
		projectDirectory = directory;
		attachParentWatcher();
		attachProjectWatcher();
	};

	attachParentWatcher();
	attachProjectWatcher();

	try {
		await finished;
	} finally {
		stop();
		await work;
	}
}
