import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
	LEGACY_WORKLIST_DIRECTORY,
	WORKLIST_DIRECTORY,
	WORKLIST_FILENAME,
	WORKLIST_PATH_ENV,
} from "./cli-contract.ts";
import { singleLine } from "./tui/text.ts";

/** How long any Git command in this module may take before it is killed. */
export const GIT_COMMAND_TIMEOUT_MS = 10000;

/** The errno a run killed for outliving its time limit is reported with. */
const TIMED_OUT_CODE = "ETIMEDOUT";

/**
 * Why a Git command did not answer, kept as the runner reported it rather than
 * flattened to a sentence.
 *
 * The diagnostic alone cannot say which kind of failure happened: a run killed
 * before Git could write anything leaves only "Command failed". Keeping the exit
 * status, the signal, and the timeout separate is what lets a caller tell a
 * verdict Git reached from a run that never reached one.
 */
export interface GitCommandFailure {
	/** Git's own diagnostic, or the runner's when Git never got to speak. */
	message: string;
	/** The status Git exited with, absent when it never exited on its own. */
	exitCode?: number;
	/** The signal that ended the run, when one did. */
	signal?: string;
	/** Whether the run was killed for outliving its time limit. */
	timedOut: boolean;
}

/**
 * Keep whatever the runner reported about how the command ended.
 *
 * A synchronous runner throws an error carrying the whole spawn result, and the
 * timeout marker belongs to that result's own error. Node currently throws that
 * inner error itself, which mirrors the marker to the top level as well, so both
 * places are read rather than relying on the mirror.
 */
function describeCommandFailure(error: unknown): GitCommandFailure {
	const thrown = error as {
		status?: unknown;
		signal?: unknown;
		code?: unknown;
		error?: { code?: unknown };
	};
	return {
		message: error instanceof Error ? error.message : String(error),
		...(typeof thrown.status === "number" ? { exitCode: thrown.status } : {}),
		...(typeof thrown.signal === "string" ? { signal: thrown.signal } : {}),
		timedOut: thrown.code === TIMED_OUT_CODE || thrown.error?.code === TIMED_OUT_CODE,
	};
}

/**
 * Whether asking Git again could plausibly answer differently.
 *
 * A status Git exited with is a verdict it reached and will reach again: an
 * option this Git does not support, or a repository it refuses to read, answers
 * the same way however many times it is asked, and a caller told to retry one of
 * those never stops. A run killed by a timeout or a signal never reached a
 * verdict at all, which is the case retrying is for.
 */
export function isTransientGitFailure(failure: GitCommandFailure): boolean {
	return failure.timedOut || failure.signal !== undefined;
}

/**
 * What a Git failure was, on one line a person reads and a dispatcher can log.
 *
 * Whatever Git wrote to stderr comes first, then how the run ended, because a
 * killed run leaves a bare "Command failed" that says nothing about the kill.
 * Together they tell a timeout apart from a permissions error or a Git too old
 * for the flag being used.
 */
export function describeGitFailure(failure: GitCommandFailure): string {
	const diagnostic = singleLine(failure.message);
	if (failure.timedOut) return `${diagnostic} (the command timed out)`;
	if (failure.signal !== undefined) return `${diagnostic} (killed by ${failure.signal})`;
	if (failure.exitCode !== undefined) return `${diagnostic} (git exited with status ${failure.exitCode})`;
	return diagnostic;
}

/**
 * The evidence every interface reports about a Git command that failed, so one
 * dispatcher parser reads a failed branch lookup, a Git that never ran, and a
 * directory Git refused.
 */
export function gitFailureDetails(resolution: string, failure?: GitCommandFailure): Record<string, unknown> {
	if (!failure) return { resolution };
	return {
		resolution,
		gitError: describeGitFailure(failure),
		gitTimedOut: failure.timedOut,
		...(failure.exitCode !== undefined ? { gitExitCode: failure.exitCode } : {}),
		...(failure.signal !== undefined ? { gitSignal: failure.signal } : {}),
	};
}

export interface GitCommandOptions {
	/** How long to wait for Git. Defaults to `GIT_COMMAND_TIMEOUT_MS`. */
	timeoutMs?: number;
}

/**
 * Which kind of problem stopped a repository lookup.
 *
 * The three are answerable in different ways, which is the whole reason they are
 * kept apart: a directory that is not there is the path the caller named, a Git
 * that never answered is the machine or a moment in it, and a Git that refused is
 * a verdict about the directory.
 */
export type GitRootFailureKind = "unusable-directory" | "git-unavailable" | "git-refused";

export interface GitRootFailure {
	kind: GitRootFailureKind;
	/** One line naming what stopped the lookup, whatever the kind. */
	message: string;
	/** How the Git run ended, absent when Git was never reached. */
	command?: GitCommandFailure;
}

export interface GitRootResult {
	root: string | null;
	isGit: boolean;
	/** Why there is no root, absent when one was found. */
	failure?: GitRootFailure;
}

/**
 * Whether the directory Git would be asked about can be asked about at all.
 *
 * A spawn reports a missing or non-directory working directory with the same
 * ENOENT shape as a missing Git, so the path is checked before Git is blamed for
 * it: a stale worktree passed as `--cwd` is the caller's path, not a broken Git
 * installation.
 */
function unusableDirectory(cwd: string): GitRootFailure | undefined {
	try {
		if (statSync(cwd).isDirectory()) return undefined;
		return { kind: "unusable-directory", message: `${cwd} is not a directory` };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const missing = (error as { code?: unknown }).code === "ENOENT";
		return {
			kind: "unusable-directory",
			message: missing ? `${cwd} does not exist` : `${cwd} cannot be read: ${singleLine(message)}`,
		};
	}
}

/**
 * The repository root `cwd` belongs to, keeping Git's verdict about the directory
 * distinct from Git never giving one.
 *
 * Git is run directly rather than through a shell for the same reason the branch
 * lookup is: a shell answers for Git, turning an absent Git into its own exit
 * status 127 and a signalled Git into 128 + n, which would make both look like
 * Git refusing this directory.
 */
export function resolveGitRoot(cwd: string, options: GitCommandOptions = {}): GitRootResult {
	const unusable = unusableDirectory(cwd);
	if (unusable) return { root: null, isGit: false, failure: unusable };
	try {
		const raw = execFileSync("git", ["rev-parse", "--show-toplevel"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: options.timeoutMs ?? GIT_COMMAND_TIMEOUT_MS,
		});
		const top = raw.trim();
		if (!top) {
			return {
				root: null,
				isGit: false,
				failure: { kind: "git-refused", message: "git named no repository root" },
			};
		}
		const canonical = realpathSync(top);
		return { root: canonical, isGit: true };
	} catch (error) {
		const command = describeCommandFailure(error);
		return {
			root: null,
			isGit: false,
			failure: {
				// A status Git exited with is Git having run and answered, whatever the
				// answer was. No status means Git never got that far.
				kind: command.exitCode === undefined ? "git-unavailable" : "git-refused",
				message: describeGitFailure(command),
				command,
			},
		};
	}
}

export interface CurrentGitBranchResult {
	/** The checked-out branch, or null when HEAD is detached. */
	branch: string | null;
	/** A Git execution failure. Absent when Git successfully reports detached HEAD. */
	error?: GitCommandFailure;
}

/**
 * The branch checked out in `cwd`, keeping detached HEAD distinct from a Git
 * command that failed.
 *
 * `git branch --show-current` exits successfully with an empty answer for a
 * detached HEAD. Execution failures retain how they ended so a caller can report
 * an availability error that says whether retrying can help, instead of
 * misclassifying either one as a request that merely omitted `--branch`.
 *
 * Git is run directly rather than through a shell: a shell reports a signalled
 * child as its own exit status 128 + n, which would hide the one distinction
 * this result exists to keep.
 */
export function currentGitBranch(cwd: string, options: GitCommandOptions = {}): CurrentGitBranchResult {
	try {
		const raw = execFileSync("git", ["branch", "--show-current"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: options.timeoutMs ?? GIT_COMMAND_TIMEOUT_MS,
		});
		return { branch: raw.trim() || null };
	} catch (error) {
		return { branch: null, error: describeCommandFailure(error) };
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

export interface ProjectRootLookup {
	/** The goal file, when Git named the repository. */
	worklist?: LocatedWorklist;
	/** Why there is no goal file, when Git named no repository. */
	failure?: GitRootFailure;
}

/**
 * The goal file for the repository containing `cwd`, for a host that outlives one
 * lookup.
 *
 * An answer is remembered, because neither a repository nor Git's refusal of a
 * directory changes under a running session. A Git that never answered is asked
 * again on the next lookup: the alternative is a session or an MCP server that
 * spends the rest of its life reporting a verdict Git never reached, which no
 * retry could clear.
 */
export function createProjectRootLookup(
	cwd: string,
	options: WorklistLocationOptions = {},
): () => ProjectRootLookup {
	let locate: (() => LocatedWorklist) | undefined;
	let answered: GitRootFailure | undefined;
	return () => {
		if (locate) return { worklist: locate() };
		if (answered) return { failure: answered };
		const result = resolveGitRoot(cwd);
		if (result.root) {
			locate = createWorklistLocator(result.root, options);
			return { worklist: locate() };
		}
		const failure: GitRootFailure = result.failure ?? {
			kind: "git-refused",
			message: "git named no repository root",
		};
		if (failure.kind === "git-refused") answered = failure;
		return { failure };
	};
}
