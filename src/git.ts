import { execSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
	LEGACY_WORKLIST_DIRECTORY,
	WORKLIST_DIRECTORY,
	WORKLIST_FILENAME,
	WORKLIST_PATH_ENV,
} from "./cli-contract.ts";

export interface GitRootResult {
	root: string | null;
	isGit: boolean;
	error?: string;
}

export function resolveGitRoot(cwd: string): GitRootResult {
	try {
		const raw = execSync("git rev-parse --show-toplevel", {
			cwd,
			encoding: "utf8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout: 10000,
		});
		const top = raw.trim();
		if (!top) return { root: null, isGit: false, error: "not a git repository" };
		const canonical = realpathSync(top);
		return { root: canonical, isGit: true };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { root: null, isGit: false, error: message };
	}
}

/** Which rule in the resolution order chose the path. */
export type WorklistPathSource = "override" | "current" | "legacy" | "default";

export interface WorklistLocation {
	/** Absolute path every interface reads from and writes to. */
	path: string;
	/** The rule that chose `path`, which is what `migrate_path` acts on. */
	source: WorklistPathSource;
	/** Absolute canonical path, whether or not a file is there yet. */
	currentPath: string;
	/** Absolute legacy path, whether or not a file is there yet. */
	legacyPath: string;
	/**
	 * A worklist that resolution passed over, present whenever both files exist,
	 * whether or not the passed-over one holds any goals.
	 *
	 * Two files are two roadmaps, and reading one while the other quietly rots is
	 * indistinguishable from losing the goals in it, so every interface reports
	 * this rather than picking a winner in silence.
	 */
	shadowedPath?: string;
}

export interface WorklistLocationOptions {
	/** An explicit path, from `--file`; resolved against the process directory. */
	override?: string;
	/** Environment to read the override variable from. */
	env?: NodeJS.ProcessEnv;
	/** Directory an override is resolved against. Defaults to the process directory. */
	overrideBase?: string;
}

/**
 * The one resolution order, shared by the CLI, the board, the Pi extension, and
 * anything else that has to name the goal file.
 *
 * An explicit override wins, then the canonical path, then the legacy path.
 * A repository with neither file resolves to the canonical path, so a first
 * write lands there; a repository with only the legacy file keeps using it,
 * because writing the other one instead would split one roadmap into two.
 */
export function resolveWorklistLocation(
	gitRoot: string,
	options: WorklistLocationOptions = {},
): WorklistLocation {
	const currentPath = resolve(gitRoot, WORKLIST_DIRECTORY, WORKLIST_FILENAME);
	const legacyPath = resolve(gitRoot, LEGACY_WORKLIST_DIRECTORY, WORKLIST_FILENAME);
	const override = options.override?.trim() || options.env?.[WORKLIST_PATH_ENV]?.trim();
	if (override) {
		const base = options.overrideBase ?? process.cwd();
		return {
			path: isAbsolute(override) ? override : resolve(base, override),
			source: "override",
			currentPath,
			legacyPath,
		};
	}
	const hasCurrent = existsSync(currentPath);
	const hasLegacy = existsSync(legacyPath);
	if (hasCurrent) {
		return {
			path: currentPath,
			source: "current",
			currentPath,
			legacyPath,
			...(hasLegacy ? { shadowedPath: legacyPath } : {}),
		};
	}
	if (hasLegacy) return { path: legacyPath, source: "legacy", currentPath, legacyPath };
	return { path: currentPath, source: "default", currentPath, legacyPath };
}

/**
 * The warning a shadowed legacy worklist earns, or nothing.
 *
 * Rendered here rather than at each interface so the CLI, the board, and the Pi
 * session cannot describe the same two files differently.
 */
export function shadowedWorklistWarning(location: WorklistLocation): string | undefined {
	if (!location.shadowedPath) return undefined;
	return (
		`Warning: two project worklists exist. Reading and writing ${location.path}; ` +
		`${location.shadowedPath} is ignored. Merge the goals you want to keep into the first file and delete the second.`
	);
}

/** A resolution, carrying whatever the user has to be told about it. */
export interface LocatedWorklist extends WorklistLocation {
	/** The standing warning this resolution earns, from the one helper that words it. */
	notice?: string;
}

/**
 * Ask where the goals are and what must be said about that, as one answer.
 *
 * This lives beside the resolution order and the warning wording rather than in
 * the board, because the Pi session needs the same pairing and reaching into the
 * TUI for it would drag the board's I/O into the extension. Every interface that
 * outlives its own resolution asks again rather than remembering: the board
 * across a `migrate_path` in another terminal, a session across a branch
 * checkout that lands a second worklist. Because both halves come from one
 * resolution, the notice cannot describe a file other than the one in use.
 */
export function createWorklistLocator(
	gitRoot: string,
	options: WorklistLocationOptions = {},
): () => LocatedWorklist {
	return () => {
		const location = resolveWorklistLocation(gitRoot, options);
		const notice = shadowedWorklistWarning(location);
		return { ...location, ...(notice !== undefined ? { notice } : {}) };
	};
}
