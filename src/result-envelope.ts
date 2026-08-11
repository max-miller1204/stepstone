/**
 * Shared result-envelope vocabulary for every worklist interface (tool, command,
 * dashboard, terminal board, CLI). Error code names and string values are a
 * published contract: the CLI maps them to exit codes and emits them verbatim
 * in `--json` envelopes (see docs/cli.md).
 */
export const WORKLIST_ERROR_CODES = {
	UNAVAILABLE: "UNAVAILABLE",
	INVALID_REQUEST: "INVALID_REQUEST",
	VALIDATION_FAILED: "VALIDATION_FAILED",
	NOT_FOUND: "NOT_FOUND",
	/** Dependency edges that would leave the graph unable to say what may start. */
	DEPENDENCY_CYCLE: "DEPENDENCY_CYCLE",
	APPROVAL_REQUIRED: "APPROVAL_REQUIRED",
	CONFLICT: "CONFLICT",
	PERSISTENCE_FAILED: "PERSISTENCE_FAILED",
} as const;

export type WorklistErrorCode = (typeof WORKLIST_ERROR_CODES)[keyof typeof WORKLIST_ERROR_CODES];

/** A whole-store baseline that moved: another writer changed anything at all. */
export interface WorklistRevisionConflictDetails {
	type: "revision";
	expectedRevision?: string;
	actualRevision?: string;
	resolution: "refresh-and-retry";
}

/** One goal's baseline that moved, which a whole-store revision cannot express. */
export interface WorklistGoalConflictDetails {
	type: "goal-updated-at";
	id: string;
	expectedUpdatedAt: string;
	actualUpdatedAt: string;
	resolution: "refresh-and-retry";
}

export type WorklistConflictDetails = WorklistRevisionConflictDetails | WorklistGoalConflictDetails;

export interface WorklistError {
	code: WorklistErrorCode;
	message: string;
	retryable: boolean;
	conflict?: WorklistConflictDetails;
	details?: Record<string, unknown>;
}

export interface WorklistChangedEntities {
	projectGoalIds: string[];
	sessionTaskIds: string[];
}

export interface WorklistRevisionSet {
	project?: string;
	session?: string;
}

export interface WorklistResultMeta {
	changed: boolean;
	/** True only when a valid mutation already matched the requested semantic state. */
	semanticNoOp: boolean;
	/** Sorted, unique JSON Pointer paths. */
	changedFields: string[];
	changedEntities?: WorklistChangedEntities;
	revisions?: WorklistRevisionSet;
	/** Legacy worklist ignored because the canonical path also exists. */
	shadowedWorklistPath?: string;
}

function compareChangedFields(left: string, right: string): number {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}

export function canonicalChangedFields(fields: Iterable<string>): string[] {
	return [...new Set(fields)].sort(compareChangedFields);
}
