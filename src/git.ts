import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
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

/** The entry Git looks for when it decides whether a directory is in a repository. */
const GIT_MARKER = ".git";

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
	/**
	 * What Git itself said, on one line, when it said anything.
	 *
	 * Kept apart from `message` because only this part is worth putting in front of
	 * a person: the rest is the invocation and the exit status, which belong in a
	 * machine-read envelope.
	 */
	stderr?: string;
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
		stderr?: unknown;
		error?: { code?: unknown };
	};
	const said = typeof thrown.stderr === "string" ? singleLine(thrown.stderr) : "";
	return {
		message: error instanceof Error ? error.message : String(error),
		...(said ? { stderr: said } : {}),
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
 * Each is answerable in a different way, which is the whole reason they are kept
 * apart: a directory that is not there is the path the caller named, a Git that
 * never answered is the machine or a moment in it, a Git that refused a repository
 * it found is something to repair where it stands, and only the last is the
 * standing verdict that this is no repository at all.
 */
export type GitRootFailureKind =
	| "unusable-directory"
	| "git-unavailable"
	| "git-refused"
	| "not-a-repository";

export interface GitRootFailure {
	kind: GitRootFailureKind;
	/** One line naming what stopped the lookup, whatever the kind. */
	message: string;
	/** How the Git run ended, absent when Git was never reached. */
	command?: GitCommandFailure;
}

export interface GitRootResult {
	root: string | null;
	/** Why there is no root, absent when one was found. */
	failure?: GitRootFailure;
}

/**
 * What to put in front of a person about a Git command.
 *
 * Git's own line where Git said anything, and how the run ended where it did not,
 * because a killed run's only information is that it was killed. The invocation
 * and the exit status stay out of the sentence and in the envelope.
 */
export function gitCommandDiagnostic(failure: GitCommandFailure): string {
	return failure.stderr ?? describeGitFailure(failure);
}

/** The same, for a root lookup that may have failed before Git was reached. */
export function gitRootDiagnostic(failure: GitRootFailure): string {
	return failure.command ? gitCommandDiagnostic(failure.command) : failure.message;
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
 * Whether anything at `cwd` or above it claims to be a repository.
 *
 * Git refuses with the same status 128 for two unlike things: a directory that is
 * no repository, and a repository it will not work in until something is fixed - a
 * config it cannot parse, an owner it does not trust. Only the first is a verdict
 * that cannot change while a host runs, and the `.git` entry Git itself looks for
 * is what tells them apart without reading prose Git may have translated.
 */
function hasRepositoryMarker(cwd: string): boolean {
	let directory = resolve(cwd);
	for (;;) {
		if (existsSync(join(directory, GIT_MARKER))) return true;
		const parent = dirname(directory);
		if (parent === directory) return false;
		directory = parent;
	}
}

/** Which failure a Git run that ended without naming a root amounts to. */
function rootFailureKind(cwd: string, command: GitCommandFailure): GitRootFailureKind {
	// A status Git exited with is Git having run and answered. No status means Git
	// never got that far.
	if (command.exitCode === undefined) return "git-unavailable";
	return hasRepositoryMarker(cwd) ? "git-refused" : "not-a-repository";
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
	if (unusable) return { root: null, failure: unusable };
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
				failure: { kind: "git-refused", message: "git named no repository root" },
			};
		}
		const canonical = realpathSync(top);
		return { root: canonical };
	} catch (error) {
		const command = describeCommandFailure(error);
		return {
			root: null,
			failure: {
				kind: rootFailureKind(cwd, command),
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
 * How long a Git run may take before asking again is worth postponing.
 *
 * Below this, asking again costs nobody anything noticeable, so nothing is held
 * and a repair is picked up by the very next lookup. Above it, the run is the
 * thing a person is waiting on.
 */
const GIT_SLOW_ATTEMPT_MS = 250;

export interface ProjectRootLookupOptions extends WorklistLocationOptions {
	/**
	 * The shortest a recoverable failure is held before Git is asked again.
	 *
	 * Defaults to none, because a slow failure is already held for as long as it
	 * took to fail and a fast one costs nothing to repeat.
	 */
	retryAfterMs?: number;
	/** The clock the hold is measured on. Defaults to the wall clock. */
	now?: () => number;
}

/**
 * The goal file for the repository containing `cwd`, for a host that outlives one
 * lookup.
 *
 * Two answers are remembered for good, because neither can change while the host
 * runs: a repository that was found, and a directory that is in no repository at
 * all. Everything else is something someone can fix without restarting - Git off a
 * PATH, a stalled filesystem, an owner Git did not trust until the command Git
 * suggested was run - so it is asked again rather than settled, or the host spends
 * the rest of its life reporting a verdict Git never reached.
 *
 * Asked again, not asked constantly. Git runs synchronously and may take until the
 * command timeout to be killed, so a failure that took time to arrive is held for
 * as long as it took: a lookup killed on a ten-second timeout cannot be re-run by
 * every reader in a turn, while one that failed at once is asked again at once and
 * costs nothing for it.
 */
export function createProjectRootLookup(
	cwd: string,
	options: ProjectRootLookupOptions = {},
): () => ProjectRootLookup {
	const { retryAfterMs = 0, now = Date.now, ...location } = options;
	let locate: (() => LocatedWorklist) | undefined;
	let settled: GitRootFailure | undefined;
	let held: { failure: GitRootFailure; until: number } | undefined;
	return () => {
		if (locate) return { worklist: locate() };
		if (settled) return { failure: settled };
		if (held && now() < held.until) return { failure: held.failure };
		const startedAt = now();
		const result = resolveGitRoot(cwd);
		if (result.root) {
			locate = createWorklistLocator(result.root, location);
			held = undefined;
			return { worklist: locate() };
		}
		const failure: GitRootFailure = result.failure ?? {
			kind: "git-refused",
			message: "git named no repository root",
		};
		if (failure.kind === "not-a-repository") {
			settled = failure;
			return { failure };
		}
		const finishedAt = now();
		const cost = finishedAt - startedAt;
		const hold = Math.max(retryAfterMs, cost >= GIT_SLOW_ATTEMPT_MS ? cost : 0);
		if (hold > 0) held = { failure, until: finishedAt + hold };
		return { failure };
	};
}
