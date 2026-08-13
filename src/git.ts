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
export const GIT_MARKER = ".git";

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

/**
 * The canonical form of a path, or the path itself when it cannot be resolved.
 *
 * Two paths naming one directory only compare equal once symlinks are gone, and a
 * directory Git named that is no longer there is still Git's answer: falling back
 * keeps a comparison against it honest instead of turning a stale worktree into a
 * throw from the middle of an unrelated operation.
 */
export function canonicalPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

export interface MainWorktreeFailure {
	/** One line naming what stopped the lookup, whatever the kind. */
	message: string;
	/**
	 * The Git command that did not answer, written the way someone would type it.
	 *
	 * Two unlike commands stand between a committed roadmap write and its verdict -
	 * the listing that locates the main checkout, and the lookup that places the
	 * current one - so a refusal naming only one of them would send whoever has to
	 * repair it to a command that works.
	 */
	invocation: string;
	/** How the Git run ended, absent when Git answered but named no worktree. */
	command?: GitCommandFailure;
}

/**
 * What Git's first worktree record amounts to.
 *
 * A repository cloned or initialised bare has no main checkout at all: its first
 * record names the Git directory, which holds no working tree and can hold no
 * file anyone commits. That is a different answer from a main worktree Git named
 * and from a lookup Git never answered, and a caller that cannot tell them apart
 * ends up naming a destination nobody can write in.
 *
 * A first record naming a Git directory does not by itself mean the repository
 * has no main checkout: whenever a checkout's `.git` is a gitdir link, Git prints
 * that Git directory here instead of the checkout, so a submodule working tree
 * and a `git init --separate-git-dir` repository read the same way a bare one
 * does. Which of those it is, is `resolveWorktreePlacement`'s question, not this
 * lookup's.
 */
export type MainWorktreeResult =
	/** Git named a main worktree that holds a checkout. */
	| { kind: "checkout"; path: string }
	/** Git named a main worktree that holds no working tree, so nothing can be written there. */
	| { kind: "no-checkout"; gitDirectory: string }
	/** Git named no main worktree at all. */
	| { kind: "unavailable"; failure: MainWorktreeFailure };

/** The prefix `git worktree list --porcelain` gives the attribute naming a worktree. */
const WORKTREE_ATTRIBUTE = "worktree ";

/** The listing that locates the main checkout, as someone would type it. */
const WORKTREE_LIST_COMMAND = "git worktree list --porcelain -z";

/** The lookup that places the current checkout in its repository, likewise. */
const WORKTREE_PLACEMENT_COMMAND = "git rev-parse --git-dir --git-common-dir";

/**
 * The status Git's option parser exits with when it will not take the command
 * line it was given.
 */
const GIT_USAGE_ERROR_STATUS = 129;

type WorktreeListRun =
	| { output: string; failure?: undefined }
	| { output?: undefined; failure: GitCommandFailure };

/** One `git worktree list` run, kept as either its output or how it ended. */
function runWorktreeList(cwd: string, args: string[], timeoutMs: number): WorktreeListRun {
	try {
		return {
			output: execFileSync("git", ["worktree", "list", ...args], {
				cwd,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				timeout: timeoutMs,
			}),
		};
	} catch (error) {
		return { failure: describeCommandFailure(error) };
	}
}

/**
 * What the first record of a porcelain listing says the main worktree is.
 *
 * Only the first attribute is read, and it is the same `worktree <path>` line in
 * both spellings of the format: the separator is all that differs.
 *
 * Whether that worktree holds a checkout is asked of the directory rather than of
 * the porcelain `bare` attribute, which is not there to be read in every layout: a
 * repository whose config says `core.bare` can still print a `HEAD` and a `branch`
 * for its first record and no `bare` line at all. The `.git` entry Git itself looks
 * for is present in every worktree that has one, including one whose Git directory
 * lives elsewhere, and absent from a Git directory standing alone.
 */
function mainWorktreeFromListing(raw: string, separator: string): MainWorktreeResult {
	const attributeEnd = raw.indexOf(separator);
	const attribute = attributeEnd === -1 ? raw : raw.slice(0, attributeEnd);
	if (!attribute.startsWith(WORKTREE_ATTRIBUTE)) {
		return {
			kind: "unavailable",
			failure: { message: "git worktree list named no main worktree", invocation: WORKTREE_LIST_COMMAND },
		};
	}
	const main = canonicalPath(attribute.slice(WORKTREE_ATTRIBUTE.length));
	if (!existsSync(join(main, GIT_MARKER))) return { kind: "no-checkout", gitDirectory: main };
	return { kind: "checkout", path: main };
}

/**
 * The main worktree of the repository containing `cwd`.
 *
 * `git worktree list` defines its first record as the main worktree, which is the
 * only reason this is answerable at all: `--git-common-dir` names the shared Git
 * directory, and for a repository created with `git init --separate-git-dir` that
 * directory is nowhere near any checkout.
 *
 * `-z` terminates each attribute with a NUL instead of a newline, so the first
 * field is the whole first `worktree <path>` attribute even for a worktree whose
 * path contains a newline - the one case the newline-delimited form cannot be
 * parsed out of. Git has only taken `-z` here since 2.36, and this lookup stands
 * in front of every committed roadmap write, so an older Git would refuse them
 * all rather than the linked ones. It is therefore asked again without `-z`, and
 * only in the one case that can mean: a status Git's option parser exits with,
 * having read the command line and declined it, for an invocation whose only
 * other option long predates that parser knowing this one. Any other way the
 * first run ended is Git's answer and is returned as it stands, and a second run
 * that fails too reports the first failure rather than its own, so nothing about
 * a Git that is broken for some unrelated reason is swapped for a story about
 * `-z`. On that older Git a main worktree whose path contains a newline reads
 * back truncated, which fails closed into a refusal rather than a write.
 *
 * Git is run directly rather than through a shell, for the same reason every
 * other lookup here is: a shell answers for Git, turning an absent Git into its
 * own exit status 127 and a signalled Git into 128 + n, which would make a run
 * that never reached a verdict look like a verdict Git reached.
 */
export function resolveMainWorktree(cwd: string, options: GitCommandOptions = {}): MainWorktreeResult {
	const timeoutMs = options.timeoutMs ?? GIT_COMMAND_TIMEOUT_MS;
	const nulSeparated = runWorktreeList(cwd, ["--porcelain", "-z"], timeoutMs);
	if (nulSeparated.output !== undefined) return mainWorktreeFromListing(nulSeparated.output, "\0");

	const unavailable: MainWorktreeResult = {
		kind: "unavailable",
		failure: {
			message: describeGitFailure(nulSeparated.failure),
			invocation: WORKTREE_LIST_COMMAND,
			command: nulSeparated.failure,
		},
	};
	if (nulSeparated.failure.exitCode !== GIT_USAGE_ERROR_STATUS) return unavailable;

	const lineSeparated = runWorktreeList(cwd, ["--porcelain"], timeoutMs);
	if (lineSeparated.output === undefined) return unavailable;
	return mainWorktreeFromListing(lineSeparated.output, "\n");
}

/**
 * Where a checkout sits in the repository it belongs to.
 *
 * A linked worktree is the one checkout that must not write a file the repository
 * commits, and comparing a path against the porcelain listing cannot pick it out
 * on its own: whenever a checkout's `.git` is a gitdir link - a submodule working
 * tree, or a repository made with `git init --separate-git-dir` - the listing's
 * first record is the Git directory rather than the checkout, so an ordinary main
 * checkout reads exactly like a worktree the listing did not name.
 */
export type WorktreePlacement =
	/** The repository's ordinary main checkout, however its Git directory is reached. */
	| { kind: "main" }
	/** A worktree added with `git worktree add`, which has a main checkout elsewhere or none. */
	| { kind: "linked" }
	/** Git said neither, so nothing about this checkout is known. */
	| { kind: "unavailable"; failure: MainWorktreeFailure };

/**
 * Whether `cwd` is its repository's main checkout or a linked worktree.
 *
 * `git worktree add` gives each worktree it adds a Git directory of its own
 * beneath the shared one, and leaves every other checkout using the shared one
 * directly. So the two directories being the same directory is what says this
 * checkout is not a linked worktree - a question about this checkout alone, which
 * is why it can be answered without a path to compare against.
 *
 * That is all these two directories are asked for. Neither says where the main
 * checkout is - `--git-common-dir` names the shared Git directory, which for a
 * repository created with `git init --separate-git-dir` is nowhere near any
 * checkout - and locating it stays with the porcelain listing.
 *
 * Each answer is resolved against `cwd` before they are compared, because Git
 * prints either one relative to the current directory when it can, which is the
 * same directory arriving spelled two ways. A Git directory whose path contains a
 * newline reads back truncated - `git rev-parse` has no NUL-separated form - and
 * so compares unequal, which fails closed into a refusal rather than a write.
 *
 * Git is run directly rather than through a shell, for the same reason every
 * other lookup here is: a shell answers for Git, turning an absent Git into its
 * own exit status 127 and a signalled Git into 128 + n, which would make a run
 * that never reached a verdict look like a verdict Git reached.
 */
export function resolveWorktreePlacement(cwd: string, options: GitCommandOptions = {}): WorktreePlacement {
	let raw: string;
	try {
		raw = execFileSync("git", ["rev-parse", "--git-dir", "--git-common-dir"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: options.timeoutMs ?? GIT_COMMAND_TIMEOUT_MS,
		});
	} catch (error) {
		const command = describeCommandFailure(error);
		return {
			kind: "unavailable",
			failure: {
				message: describeGitFailure(command),
				invocation: WORKTREE_PLACEMENT_COMMAND,
				command,
			},
		};
	}
	const [own = "", shared = ""] = raw.split("\n").map((line) => line.trim());
	if (!own || !shared) {
		return {
			kind: "unavailable",
			failure: {
				message: "git rev-parse named no Git directory",
				invocation: WORKTREE_PLACEMENT_COMMAND,
			},
		};
	}
	return canonicalPath(resolve(cwd, own)) === canonicalPath(resolve(cwd, shared))
		? { kind: "main" }
		: { kind: "linked" };
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
 * How long a lookup Git never answered is held before Git is asked again.
 *
 * A run that was killed rather than answered spent the time it was allowed to
 * spend, and asking again would spend it again, so the answer stands for that long
 * rather than for a measured interval that depends on what else the machine was
 * doing.
 */
export const GIT_RETRY_HOLD_MS = GIT_COMMAND_TIMEOUT_MS;

export interface ProjectRootLookupOptions extends WorklistLocationOptions {
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
 * Asked again, not asked constantly. Git runs synchronously, so a lookup Git never
 * answered - killed by the timeout or by a signal - is the one that blocks a host
 * long enough to matter, and repeating it blocks again for the same reason. That
 * one is held for `GIT_RETRY_HOLD_MS` before Git is asked once more, keyed on the
 * evidence the failure already carries rather than on how long this machine
 * happened to take. A failure Git returned by itself cost nothing to get and costs
 * nothing to ask about again, so it is not held at all and a repair is picked up by
 * the very next reader.
 */
export function createProjectRootLookup(
	cwd: string,
	options: ProjectRootLookupOptions = {},
): () => ProjectRootLookup {
	const { now = Date.now, ...location } = options;
	let locate: (() => LocatedWorklist) | undefined;
	let settled: GitRootFailure | undefined;
	let held: { failure: GitRootFailure; until: number } | undefined;
	return () => {
		if (locate) return { worklist: locate() };
		if (settled) return { failure: settled };
		if (held && now() < held.until) return { failure: held.failure };
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
		held =
			failure.command && isTransientGitFailure(failure.command)
				? { failure, until: now() + GIT_RETRY_HOLD_MS }
				: undefined;
		return { failure };
	};
}
