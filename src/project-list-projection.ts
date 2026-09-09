import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
	jsonEncodedStringBytes,
	TEXT_TRUNCATION_MARKER,
	truncateTextToJsonBytes,
	utf8Bytes,
} from "./bounded-text.ts";
import { compactDescription, GOAL_STATUS_ORDER, goalSection, goalStatusCounts } from "./format.ts";
import type {
	ProjectGoal,
	ProjectGoalListPage,
	ProjectGoalStatus,
	ProjectGoalSummary,
	WorklistOperationResult,
} from "./types.ts";

/** Fixed limits for one Project Goal list result sent to a Pi model. */
export const PROJECT_GOAL_LIST_LIMITS = {
	defaultItems: 20,
	maxItems: 50,
	titleBytes: 192,
	groupBytes: 256,
	cursorBytes: 1024,
	totalBytes: 4096,
} as const;

export interface ProjectGoalListRequest {
	statuses?: ProjectGoalStatus[];
	group?: string;
	limit?: number;
	cursor?: string;
}

interface ProjectGoalListCursor {
	version: 1;
	revision: string;
	snapshot: string;
	offset: number;
	statuses: ProjectGoalStatus[] | null;
	group: string | null;
}

export class ProjectGoalListValidationError extends Error {
	readonly field: "cursor" | "group" | "limit" | "statuses";
	readonly resolution: string;

	constructor(message: string, field: ProjectGoalListValidationError["field"], resolution: string) {
		super(message);
		this.name = "ProjectGoalListValidationError";
		this.field = field;
		this.resolution = resolution;
	}
}

export class ProjectGoalListCursorConflictError extends Error {
	readonly expectedRevision: string;
	readonly actualRevision: string;

	constructor(expectedRevision: string, actualRevision: string) {
		super(
			`Project Goal list cursor does not match the current roadmap (cursor revision ${expectedRevision}, current revision ${actualRevision}). Restart project list.`,
		);
		this.name = "ProjectGoalListCursorConflictError";
		this.expectedRevision = expectedRevision;
		this.actualRevision = actualRevision;
	}
}

function canonicalStatuses(statuses: readonly ProjectGoalStatus[]): ProjectGoalStatus[] {
	return GOAL_STATUS_ORDER.filter((status) => statuses.includes(status));
}

function validateStatuses(value: ProjectGoalListRequest["statuses"]): ProjectGoalStatus[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length === 0) {
		throw new ProjectGoalListValidationError(
			"statuses must contain at least one Project Goal status for project list.",
			"statuses",
			"provide-project-goal-statuses",
		);
	}
	if (value.some((status) => !GOAL_STATUS_ORDER.includes(status))) {
		throw new ProjectGoalListValidationError(
			"statuses contains an unsupported Project Goal status.",
			"statuses",
			"provide-project-goal-statuses",
		);
	}
	if (new Set(value).size !== value.length) {
		throw new ProjectGoalListValidationError(
			"statuses must not contain duplicate Project Goal statuses.",
			"statuses",
			"remove-duplicate-project-goal-statuses",
		);
	}
	return canonicalStatuses(value);
}

function validateGroup(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") {
		throw new ProjectGoalListValidationError(
			"group must be a string for project list.",
			"group",
			"provide-project-goal-group-filter",
		);
	}
	const group = value.trim();
	if (jsonEncodedStringBytes(group) > PROJECT_GOAL_LIST_LIMITS.groupBytes) {
		throw new ProjectGoalListValidationError(
			`group exceeds ${PROJECT_GOAL_LIST_LIMITS.groupBytes} encoded UTF-8 bytes for project list.`,
			"group",
			"shorten-project-goal-group-filter",
		);
	}
	return group;
}

function validateLimit(value: number | undefined): number {
	if (value === undefined) return PROJECT_GOAL_LIST_LIMITS.defaultItems;
	if (!Number.isSafeInteger(value) || value < 1 || value > PROJECT_GOAL_LIST_LIMITS.maxItems) {
		throw new ProjectGoalListValidationError(
			`limit must be an integer from 1 through ${PROJECT_GOAL_LIST_LIMITS.maxItems} for project list.`,
			"limit",
			"provide-bounded-project-goal-limit",
		);
	}
	return value;
}

function encodeCursor(cursor: ProjectGoalListCursor): string {
	return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function invalidCursor(): ProjectGoalListValidationError {
	return new ProjectGoalListValidationError(
		"cursor is not a valid Project Goal list cursor.",
		"cursor",
		"restart-project-goal-list",
	);
}

function decodeCursor(value: string): ProjectGoalListCursor {
	if (!value || utf8Bytes(value) > PROJECT_GOAL_LIST_LIMITS.cursorBytes || !/^[A-Za-z0-9_-]+$/.test(value)) {
		throw invalidCursor();
	}
	let parsed: unknown;
	try {
		const decoded = Buffer.from(value, "base64url").toString("utf8");
		if (Buffer.from(decoded, "utf8").toString("base64url") !== value) throw invalidCursor();
		parsed = JSON.parse(decoded);
	} catch (error) {
		if (error instanceof ProjectGoalListValidationError) throw error;
		throw invalidCursor();
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw invalidCursor();
	const cursor = parsed as Record<string, unknown>;
	const allowed = ["group", "offset", "revision", "snapshot", "statuses", "version"];
	if (Object.keys(cursor).some((key) => !allowed.includes(key))) throw invalidCursor();
	if (
		cursor.version !== 1 ||
		typeof cursor.revision !== "string" ||
		typeof cursor.snapshot !== "string" ||
		!/^[a-f0-9]{64}$/.test(cursor.snapshot) ||
		!Number.isSafeInteger(cursor.offset) ||
		(cursor.offset as number) < 0 ||
		!(cursor.group === null || typeof cursor.group === "string") ||
		!(cursor.statuses === null || Array.isArray(cursor.statuses))
	) {
		throw invalidCursor();
	}
	const statuses =
		cursor.statuses === null ? undefined : validateStatuses(cursor.statuses as ProjectGoalStatus[]);
	if (statuses && JSON.stringify(statuses) !== JSON.stringify(cursor.statuses)) throw invalidCursor();
	const group = cursor.group === null ? undefined : validateGroup(cursor.group as string);
	if (group !== undefined && group !== cursor.group) throw invalidCursor();
	return {
		version: 1,
		revision: cursor.revision,
		snapshot: cursor.snapshot,
		offset: cursor.offset as number,
		statuses: statuses ?? null,
		group: group ?? null,
	};
}

function summary(goal: ProjectGoal): { goal: ProjectGoalSummary; titleTruncated: boolean } {
	const title = truncateTextToJsonBytes(compactDescription(goal.title), PROJECT_GOAL_LIST_LIMITS.titleBytes);
	return {
		goal: { id: goal.id, title: title.value, status: goal.status },
		titleTruncated: title.truncated,
	};
}

function statusCountText(page: ProjectGoalListPage): string {
	return page.statusCounts.map(({ status, count }) => `${status} ${count}`).join(", ");
}

/** Text placed in the tool result and sent to the model. */
export function formatProjectGoalListPage(page: ProjectGoalListPage): string {
	const counts = statusCountText(page);
	const filterNote = page.matched === page.total ? "" : ` ${page.matched} match the filters.`;
	const lines = [`Project goals: ${page.total} total${counts ? ` (${counts})` : ""}.${filterNote}`];
	if (page.returned === 0) {
		lines.push(
			page.matched === 0 ? "No project goals match the filters." : "This page has no project goals.",
		);
		return lines.join("\n");
	}
	lines.push(`Showing ${page.offset + 1}-${page.offset + page.returned} of ${page.matched} matching goals.`);
	for (const goal of page.goals) lines.push(`[${goal.status}] ${goal.id}: ${goal.title}`);
	if (page.omitted > 0) lines.push(`${page.omitted} matching goal(s) remain after this page.`);
	if (page.nextCursor) lines.push(`Continue with cursor: ${page.nextCursor}`);
	if (page.truncatedTitleGoalIds?.length) {
		lines.push(`Truncated title goal IDs: ${page.truncatedTitleGoalIds.join(", ")}`);
	}
	return lines.join("\n");
}

function resultBytes(page: ProjectGoalListPage): number {
	const result: WorklistOperationResult = {
		scope: "project",
		action: "list",
		projectGoalList: page,
	};
	return utf8Bytes(JSON.stringify(result));
}

function fits(page: ProjectGoalListPage): boolean {
	return (
		resultBytes(page) <= PROJECT_GOAL_LIST_LIMITS.totalBytes &&
		utf8Bytes(formatProjectGoalListPage(page)) <= PROJECT_GOAL_LIST_LIMITS.totalBytes
	);
}

/** Build one revision-bound, canonical-order page without exposing full goal objects. */
export function projectProjectGoalList(
	goals: readonly ProjectGoal[],
	revision: string,
	request: ProjectGoalListRequest,
): ProjectGoalListPage {
	const limit = validateLimit(request.limit);
	if (request.cursor !== undefined && (request.statuses !== undefined || request.group !== undefined)) {
		throw new ProjectGoalListValidationError(
			"cursor cannot be combined with statuses or group for project list.",
			"cursor",
			"use-cursor-filters",
		);
	}

	const decoded = request.cursor === undefined ? undefined : decodeCursor(request.cursor);
	// Revision counters belong to one worklist. Bind pages to its content as well.
	const snapshot = createHash("sha256").update(JSON.stringify(goals)).digest("hex");
	if (decoded && (decoded.revision !== revision || decoded.snapshot !== snapshot)) {
		throw new ProjectGoalListCursorConflictError(decoded.revision, revision);
	}
	const statuses = decoded?.statuses ?? validateStatuses(request.statuses);
	const group = decoded ? (decoded.group ?? undefined) : validateGroup(request.group);
	const offset = decoded?.offset ?? 0;
	const filtered = goals.filter((goal) => {
		if (statuses && !statuses.includes(goal.status)) return false;
		if (group !== undefined) {
			const section = goalSection(goal);
			if (group === "" ? section !== undefined : section !== group) return false;
		}
		return true;
	});
	if (offset > filtered.length) throw invalidCursor();

	const statusCounts = goalStatusCounts(goals);
	const projected: ProjectGoalSummary[] = [];
	const truncatedTitleGoalIds: string[] = [];
	const available = filtered.slice(offset, offset + limit);
	for (const candidate of available) {
		const item = summary(candidate);
		const candidateGoals = [...projected, item.goal];
		const candidateTruncated = item.titleTruncated
			? [...truncatedTitleGoalIds, candidate.id]
			: truncatedTitleGoalIds;
		const nextOffset = offset + candidateGoals.length;
		const page: ProjectGoalListPage = {
			goals: candidateGoals,
			statusCounts,
			...(statuses ? { statuses } : {}),
			...(group !== undefined ? { group } : {}),
			total: goals.length,
			matched: filtered.length,
			offset,
			returned: candidateGoals.length,
			omitted: filtered.length - nextOffset,
			...(candidateTruncated.length > 0 ? { truncatedTitleGoalIds: candidateTruncated } : {}),
			...(nextOffset < filtered.length
				? {
						nextCursor: encodeCursor({
							version: 1,
							revision,
							snapshot,
							offset: nextOffset,
							statuses: statuses ?? null,
							group: group ?? null,
						}),
					}
				: {}),
		};
		if (!fits(page)) break;
		projected.push(item.goal);
		if (item.titleTruncated) truncatedTitleGoalIds.push(candidate.id);
	}

	if (available.length > 0 && projected.length === 0) {
		throw new ProjectGoalListValidationError(
			`Project Goal ${available[0]?.id ?? "at the page boundary"} cannot fit in the bounded list result.`,
			"cursor",
			"shorten-project-goal-id",
		);
	}
	const nextOffset = offset + projected.length;
	const page: ProjectGoalListPage = {
		goals: projected,
		statusCounts,
		...(statuses ? { statuses } : {}),
		...(group !== undefined ? { group } : {}),
		total: goals.length,
		matched: filtered.length,
		offset,
		returned: projected.length,
		omitted: filtered.length - nextOffset,
		...(truncatedTitleGoalIds.length > 0 ? { truncatedTitleGoalIds } : {}),
		...(nextOffset < filtered.length
			? {
					nextCursor: encodeCursor({
						version: 1,
						revision,
						snapshot,
						offset: nextOffset,
						statuses: statuses ?? null,
						group: group ?? null,
					}),
				}
			: {}),
	};
	if (!fits(page)) {
		throw new Error(`Project Goal list projection exceeds ${PROJECT_GOAL_LIST_LIMITS.totalBytes} bytes.`);
	}
	return page;
}

export { TEXT_TRUNCATION_MARKER as PROJECT_GOAL_LIST_TRUNCATION_MARKER };
