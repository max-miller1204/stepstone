import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { LEGACY_WORKLIST_DIRECTORY, WORKLIST_DIRECTORY, WORKLIST_FILENAME } from "./cli-contract.ts";
import {
	canonicalPath,
	GIT_MARKER,
	type GitCommandFailure,
	gitCommandDiagnostic,
	isTransientGitFailure,
	type MainWorktreeFailure,
	resolveMainWorktree,
} from "./git.ts";
import { findGoalByStoredId } from "./goal-selection.ts";
import type { ProjectWorklist, RevisionedProjectWorklist } from "./types.ts";
import { PROJECT_WORKLIST_VERSION } from "./types.ts";

export interface ProjectStoreResult<T> {
	data: T;
	revision?: number;
	error?: string;
	/** Present and false only when a successful mutation made no canonical change. */
	changed?: false;
}

/** The caller's baseline for one goal, as read from that goal's `updatedAt`. */
export interface ProjectGoalPrecondition {
	id: string;
	updatedAt: string;
}

export interface ProjectMutationOptions {
	expectedRevision?: string;
	expectedGoal?: ProjectGoalPrecondition;
}

export type ProjectMutation<T> = (current: RevisionedProjectWorklist) => {
	worklist: RevisionedProjectWorklist;
	result: T;
	/** Set false when validation produced a result without a canonical state change. */
	changed?: boolean;
};

/**
 * A mutation refused on its own terms, rather than one that failed to persist.
 *
 * `mutateProjectWorklist` turns an unexpected throw into a persistence error,
 * because a caller cannot act on a stack trace from the middle of a write. A
 * refusal is different: it is the answer, decided under the lock against
 * canonical state, so it is rethrown unchanged and keeps its type all the way to
 * the interface that has to explain it. Every deliberate rejection a mutation
 * raises must extend this, or it arrives as an unexplained persistence failure.
 */
export class ProjectMutationRefusedError extends Error {}

export class ProjectRevisionConflictError extends ProjectMutationRefusedError {
	readonly expectedRevision: string;
	readonly actualRevision: string;

	constructor(expectedRevision: string, actualRevision: string) {
		super(`Project worklist revision changed from ${expectedRevision} to ${actualRevision}.`);
		this.name = "ProjectRevisionConflictError";
		this.expectedRevision = expectedRevision;
		this.actualRevision = actualRevision;
	}
}

/**
 * A path migration refused before it moved anything.
 *
 * Both reasons are answers rather than failures to persist: a source that is
 * gone names no worklist to move, and a destination that already exists holds a
 * second roadmap that only a person can reconcile. Overwriting it would be the
 * data loss the migration exists to avoid.
 */
export class ProjectWorklistMoveRefusedError extends ProjectMutationRefusedError {
	readonly reason: "source-missing" | "destination-exists";
	readonly fromPath: string;
	readonly toPath: string;

	constructor(reason: "source-missing" | "destination-exists", fromPath: string, toPath: string) {
		super(
			reason === "source-missing"
				? `Project worklist ${fromPath} no longer exists.`
				: `Project worklist ${toPath} already exists.`,
		);
		this.name = "ProjectWorklistMoveRefusedError";
		this.reason = reason;
		this.fromPath = fromPath;
		this.toPath = toPath;
	}
}
/**
 * A committed roadmap write attempted from a linked worktree.
 *
 * Reads and explicit files outside the two repository roadmap locations remain
 * available there. A canonical write would instead create a second valid
 * roadmap and a second lock, so the refusal names the sole worktree that may
 * perform it.
 */
export class ProjectWorklistLinkedWorktreeRefusedError extends ProjectMutationRefusedError {
	readonly worklistPath: string;
	readonly currentWorktree: string;
	readonly mainWorktree: string;

	constructor(worklistPath: string, currentWorktree: string, mainWorktree: string) {
		super(
			`Project worklist ${worklistPath} cannot be changed from linked worktree ${currentWorktree}. Run this mutation from the main worktree ${mainWorktree}.`,
		);
		this.name = "ProjectWorklistLinkedWorktreeRefusedError";
		this.worklistPath = worklistPath;
		this.currentWorktree = currentWorktree;
		this.mainWorktree = mainWorktree;
	}
}

/**
 * A committed roadmap write that could not be shown to be safe, because Git never
 * named the main worktree.
 *
 * The guard fails closed: a write let through on a lookup that did not answer is
 * exactly the silent fork it exists to prevent, and the roadmap is left as it was
 * either way.
 *
 * `retryable` follows how the Git run ended rather than the bare fact that it
 * failed. A status Git exited with is a verdict it will reach again - an option
 * this Git is too old for, a repository it refuses to read - and a dispatcher told
 * to retry one of those never stops. Only a run killed before Git answered can
 * answer differently next time.
 */
export class ProjectWorklistWorktreeLookupError extends ProjectMutationRefusedError {
	readonly worklistPath: string;
	readonly retryable: boolean;
	/** How the Git run ended, absent when Git answered but named no worktree. */
	readonly commandFailure?: GitCommandFailure;

	constructor(worklistPath: string, failure: MainWorktreeFailure) {
		const retryable = failure.command !== undefined && isTransientGitFailure(failure.command);
		const diagnostic = failure.command ? gitCommandDiagnostic(failure.command) : failure.message;
		super(
			`Git could not determine the main worktree for ${worklistPath}: ${diagnostic}. ` +
				`${
					retryable ? "Retry the change." : "Make `git worktree list --porcelain -z` answer here, then retry."
				}`,
		);
		this.name = "ProjectWorklistWorktreeLookupError";
		this.worklistPath = worklistPath;
		this.retryable = retryable;
		if (failure.command) this.commandFailure = failure.command;
	}
}

export class ProjectGoalConflictError extends ProjectMutationRefusedError {
	readonly goalId: string;
	readonly expectedUpdatedAt: string;
	readonly actualUpdatedAt: string;

	constructor(goalId: string, expectedUpdatedAt: string, actualUpdatedAt: string) {
		super(`Project goal ${goalId} changed from ${expectedUpdatedAt} to ${actualUpdatedAt}.`);
		this.name = "ProjectGoalConflictError";
		this.goalId = goalId;
		this.expectedUpdatedAt = expectedUpdatedAt;
		this.actualUpdatedAt = actualUpdatedAt;
	}
}

/**
 * Two timestamps naming the same instant, so a caller that echoes back a goal's
 * `updatedAt` in a different but equivalent ISO 8601 spelling is not told its
 * baseline moved. Unparseable values only match themselves, which fails closed.
 */
function isSameInstant(left: string, right: string): boolean {
	if (left === right) return true;
	const leftTime = Date.parse(left);
	return !Number.isNaN(leftTime) && leftTime === Date.parse(right);
}

/**
 * Rejects a mutation whose caller read the target goal before someone else
 * changed it.
 *
 * The whole-store revision cannot express this: it moves for every goal, so
 * guarding one goal with it rejects unrelated concurrent work, while guarding
 * nothing lets two readers of the same goal silently clobber each other. A goal
 * that no longer exists is left to the mutation itself, whose not-found is more
 * precise than a conflict about a timestamp nothing carries any more.
 */
function assertGoalPrecondition(
	worklist: RevisionedProjectWorklist,
	precondition: ProjectGoalPrecondition | undefined,
): void {
	if (!precondition) return;
	const target = findGoalByStoredId(worklist.goals, precondition.id, worklist.retiredIds ?? []);
	if (!target || isSameInstant(precondition.updatedAt, target.updatedAt)) return;
	throw new ProjectGoalConflictError(target.id, precondition.updatedAt, target.updatedAt);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/** Optional goal fields carrying a single string, validated the same way. */
const OPTIONAL_GOAL_STRING_FIELDS = ["description", "group", "completedAt", "branch"] as const;

/** Optional goal fields carrying a list of strings. */
const OPTIONAL_GOAL_STRING_ARRAY_FIELDS = ["links", "previousIds", "dependsOn"] as const;

export function isProjectWorklist(value: unknown): value is ProjectWorklist {
	if (typeof value !== "object" || value === null) return false;
	const obj = value as Record<string, unknown>;
	if (obj.version !== PROJECT_WORKLIST_VERSION) return false;
	if (obj.revision !== undefined && (!Number.isSafeInteger(obj.revision) || Number(obj.revision) < 0)) {
		return false;
	}
	if (obj.retiredIds !== undefined && !isStringArray(obj.retiredIds)) return false;
	if (!Array.isArray(obj.goals)) return false;
	for (const g of obj.goals) {
		if (typeof g !== "object" || g === null) return false;
		const goal = g as Record<string, unknown>;
		if (typeof goal.id !== "string") return false;
		if (typeof goal.title !== "string") return false;
		if (!["open", "active", "done", "archived"].includes(goal.status as string)) return false;
		if (typeof goal.createdAt !== "string") return false;
		if (typeof goal.updatedAt !== "string") return false;
		for (const field of OPTIONAL_GOAL_STRING_FIELDS) {
			if (goal[field] !== undefined && typeof goal[field] !== "string") return false;
		}
		for (const field of OPTIONAL_GOAL_STRING_ARRAY_FIELDS) {
			if (goal[field] !== undefined && !isStringArray(goal[field])) return false;
		}
	}
	return true;
}

function isRevisionedProjectWorklist(value: unknown): value is RevisionedProjectWorklist {
	return isProjectWorklist(value) && value.revision !== undefined;
}

export function createEmptyWorklist(): RevisionedProjectWorklist {
	return { version: PROJECT_WORKLIST_VERSION, revision: 0, goals: [] };
}

/**
 * One worklist, read out of text a caller already holds.
 *
 * A move has to write the same bytes it validated, so the check cannot be a
 * second read of a file another process may have replaced in between. Every
 * read reaches the schema through here, which is what keeps a move accepting
 * exactly the files a read does, down to the message a malformed one earns.
 */
function parseProjectWorklist(text: string, path: string): ProjectStoreResult<RevisionedProjectWorklist> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return {
			data: createEmptyWorklist(),
			error: `Malformed project file ${path}: invalid JSON`,
		};
	}
	if (!isProjectWorklist(parsed)) {
		return {
			data: createEmptyWorklist(),
			error: `Malformed or unsupported schema in ${path}. Fix the file manually; it will not be overwritten.`,
		};
	}
	return { data: { ...parsed, revision: parsed.revision ?? 0 } };
}

export async function readProjectWorklist(
	path: string,
): Promise<ProjectStoreResult<RevisionedProjectWorklist>> {
	try {
		const text = await readFile(path, "utf8");
		return parseProjectWorklist(text, path);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			return { data: createEmptyWorklist() };
		}
		return {
			data: createEmptyWorklist(),
			error: `Cannot read project file ${path}: ${String(err)}`,
		};
	}
}
/**
 * Refuse a write to either committed roadmap path from a linked worktree.
 *
 * Asked of the write rather than of each interface, so every path that changes a
 * roadmap - a mutation and a migration alike - is held to it, and a new interface
 * cannot forget to ask.
 *
 * Paths outside the current and legacy roadmap locations are explicit
 * non-roadmap stores. They intentionally remain writable from any worktree.
 */
function assertCommittedRoadmapWriteAllowed(path: string): void {
	const worklistPath = resolve(path);
	const worklistDirectory = dirname(worklistPath);
	const directoryName = basename(worklistDirectory);
	if (
		basename(worklistPath) !== WORKLIST_FILENAME ||
		(directoryName !== WORKLIST_DIRECTORY && directoryName !== LEGACY_WORKLIST_DIRECTORY)
	) {
		return;
	}

	const currentWorktree = canonicalPath(dirname(worklistDirectory));
	if (!existsSync(resolve(currentWorktree, GIT_MARKER))) return;
	const main = resolveMainWorktree(currentWorktree);
	if (main.path === null) throw new ProjectWorklistWorktreeLookupError(worklistPath, main.failure);
	if (currentWorktree !== main.path) {
		throw new ProjectWorklistLinkedWorktreeRefusedError(worklistPath, currentWorktree, main.path);
	}
}

/** Name of the cross-process lock every writer to one worklist directory takes. */
const LOCK_FILENAME = ".worklist.lock";

/**
 * Take the cross-process lock guarding one worklist directory.
 *
 * Every writer, in this process or another, agrees on the lock only by agreeing
 * on where it lives, so the convention is spelled out once here rather than at
 * each call site.
 */
async function lockWorklistDirectory(dir: string): Promise<() => Promise<void>> {
	await mkdir(dir, { recursive: true });
	return lockfile.lock(dir, {
		lockfilePath: resolve(dir, LOCK_FILENAME),
		retries: { retries: 20, factor: 1.5, minTimeout: 10, maxTimeout: 250 },
		stale: 10000,
	});
}

/** Both absolute paths a migration moves the worklist between. */
export interface ProjectWorklistMove {
	fromPath: string;
	toPath: string;
}

/**
 * Move the worklist to another path without ever leaving it in two places.
 *
 * The file lands at the destination the same way every other write does, by
 * renaming a temporary file over it, and only then is the source removed, so a
 * crash mid-migration leaves a repository with either the old file or the new
 * one and never a half-written third. Both directory locks are held across the
 * whole move, taken destination-first so two concurrent migrations queue rather
 * than deadlock, which keeps a writer in another process from appending a goal
 * to a file that is about to disappear.
 */
export async function moveProjectWorklist(
	fromPath: string,
	toPath: string,
): Promise<ProjectStoreResult<ProjectWorklistMove>> {
	const fromDir = dirname(fromPath);
	const toDir = dirname(toPath);
	const releaseDestination = await lockWorklistDirectory(toDir);
	let releaseSource: (() => Promise<void>) | undefined;
	let tempName: string | undefined;

	try {
		if (fromDir !== toDir) releaseSource = await lockWorklistDirectory(fromDir);
		let contents: string;
		try {
			contents = await readFile(fromPath, "utf8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") {
				throw new ProjectWorklistMoveRefusedError("source-missing", fromPath, toPath);
			}
			throw err;
		}
		// Validating before the move keeps a corrupt file where the user last saw
		// it, named by the path their editor already has open. It validates the
		// bytes already in hand rather than reading the file a second time, so the
		// content that lands at the destination is the content that passed, and
		// the revision reported back is the revision that travelled.
		const readResult = parseProjectWorklist(contents, fromPath);
		if (readResult.error) return { data: { fromPath, toPath }, error: readResult.error };
		// Checked under both locks, so nothing can create the destination between
		// the look and the rename that would otherwise overwrite it.
		const destination = await stat(toPath).catch(() => undefined);
		if (destination) throw new ProjectWorklistMoveRefusedError("destination-exists", fromPath, toPath);

		// Both ends, because a move writes both: it removes one roadmap and creates
		// the other. Checking only the source would let a caller outside the CLI's
		// own `migrate_path` land a committed roadmap in a linked worktree from a
		// store the guard does not cover.
		assertCommittedRoadmapWriteAllowed(fromPath);
		assertCommittedRoadmapWriteAllowed(toPath);

		tempName = resolve(toDir, `.worklist-${randomBytes(8).toString("hex")}.tmp`);
		await writeFile(tempName, contents, "utf8");
		await rename(tempName, toPath);
		tempName = undefined;
		await rm(fromPath, { force: true });
		return { data: { fromPath, toPath }, revision: readResult.data.revision };
	} catch (err) {
		if (err instanceof ProjectMutationRefusedError) throw err;
		return {
			data: { fromPath, toPath },
			error: `Project worklist move failed: ${String(err)}`,
		};
	} finally {
		if (tempName) await rm(tempName, { force: true });
		try {
			await releaseSource?.();
		} finally {
			await releaseDestination();
		}
	}
}

export async function mutateProjectWorklist<T>(
	path: string,
	mutate: ProjectMutation<T>,
	options: ProjectMutationOptions = {},
): Promise<ProjectStoreResult<T>> {
	const dir = dirname(path);
	const release = await lockWorklistDirectory(dir);
	let tempName: string | undefined;

	try {
		const readResult = await readProjectWorklist(path);
		if (readResult.error) {
			return { data: undefined as unknown as T, error: readResult.error };
		}

		const actualRevision = String(readResult.data.revision);
		if (options.expectedRevision !== undefined && options.expectedRevision !== actualRevision) {
			throw new ProjectRevisionConflictError(options.expectedRevision, actualRevision);
		}
		assertGoalPrecondition(readResult.data, options.expectedGoal);

		const { worklist, result, changed = true } = mutate(readResult.data);
		if (!isRevisionedProjectWorklist(worklist)) {
			return {
				data: undefined as unknown as T,
				error: "Project mutation produced an invalid worklist",
			};
		}
		if (!changed) return { data: result, revision: readResult.data.revision, changed: false };

		assertCommittedRoadmapWriteAllowed(path);

		const revision = readResult.data.revision + 1;
		if (!Number.isSafeInteger(revision)) {
			return {
				data: undefined as unknown as T,
				error: "Project worklist revision cannot be incremented safely",
			};
		}
		const revisedWorklist = { ...worklist, revision };

		tempName = resolve(dir, `.worklist-${randomBytes(8).toString("hex")}.tmp`);
		await writeFile(tempName, `${JSON.stringify(revisedWorklist, null, 2)}\n`, "utf8");
		await rename(tempName, path);
		tempName = undefined;
		return { data: result, revision };
	} catch (err) {
		if (err instanceof ProjectMutationRefusedError) throw err;
		return {
			data: undefined as unknown as T,
			error: `Project mutation failed: ${String(err)}`,
		};
	} finally {
		if (tempName) await rm(tempName, { force: true });
		await release();
	}
}
