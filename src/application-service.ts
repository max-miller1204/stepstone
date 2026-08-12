import { formatDependencyCycle, unsatisfiedDependencies } from "./dependencies.ts";
import {
	MAX_REPORTED_GOAL_CANDIDATES,
	resolveGoalSelector,
	type UnresolvedGoalSelector,
} from "./goal-selection.ts";
import {
	activateProjectGoal,
	addProjectGoal,
	applyProjectPlan,
	deleteProjectGoal,
	listProjectGoals,
	migrateProjectGoalIds,
	migrateProjectWorklistPath,
	moveProjectGoal,
	PROJECT_LIFECYCLE_TARGET_STATUS,
	ProjectGoalActivationBlockedError,
	ProjectGoalAnchorNotFoundError,
	ProjectGoalDependencyCycleError,
	ProjectGoalDependencyNotFoundError,
	ProjectGoalNotFoundError,
	ProjectGoalPlanValidationError,
	type ProjectGoalUpdate,
	readProjectGoals,
	transitionProjectGoal,
	updateProjectGoal,
} from "./project-mutations.ts";
import {
	ProjectGoalConflictError,
	type ProjectGoalPrecondition,
	type ProjectMutationOptions,
	ProjectRevisionConflictError,
	ProjectWorklistMoveRefusedError,
} from "./project-store.ts";
import {
	canonicalChangedFields,
	WORKLIST_ERROR_CODES,
	type WorklistChangedEntities,
	type WorklistError,
	type WorklistResultMeta,
} from "./result-envelope.ts";
import type { SessionStore } from "./session-store.ts";
import type {
	ProjectGoal,
	ProjectGoalDirection,
	ProjectGoalPlacement,
	ProjectGoalPlanEntry,
	ProjectGoalStatus,
	SessionTask,
	SessionTaskPlacement,
	SessionTaskStatus,
	WorklistOperationResult,
} from "./types.ts";

export type WorklistOperationSource = "tool" | "command" | "dashboard" | "cli";

export interface WorklistOperationContext {
	source: WorklistOperationSource;
}

export interface WorklistOperation {
	scope: "session" | "project";
	action: string;
	id?: string;
	title?: string;
	description?: string;
	/** Project Goal only: append a paragraph instead of replacing the description. */
	appendDescription?: string;
	/** Project Goal only: the section it belongs to. The empty string clears it. */
	group?: string;
	/** Project Goal only: the complete set of informational HTTP(S) URLs. An empty array clears it. */
	links?: string[];
	/**
	 * Project Goal only: the complete set of goals that must land first.
	 *
	 * The whole set rather than an addition, so what a caller sends is what the
	 * goal ends up with; an empty array clears every edge. Add resolves only
	 * existing goals before minting the new ID, while update treats the goal's
	 * own existing ID as a dependency cycle.
	 */
	dependsOn?: string[];
	/** Project apply-plan only: the parsed plain JSON document. */
	plan?: unknown;
	/** Project apply-plan only: validate and project without writing. */
	dryRun?: boolean;
	/**
	 * Project migrate_path only: the path the goal file should end up at.
	 *
	 * Named by the caller, like the path the service reads from, because the
	 * resolution order that decides both lives in one place outside the service
	 * and is shared by every interface.
	 */
	targetPath?: string;
	status?: SessionTaskStatus | ProjectGoalStatus;
	goalId?: string;
	beforeId?: string;
	afterId?: string;
	/** Project move only: step one place through canonical file order. */
	direction?: ProjectGoalDirection;
	confirm?: boolean;
	expectedRevision?: string;
	/** Project Goal only: the target goal's `updatedAt` as the caller last read it. */
	expectedUpdatedAt?: string;
}

interface WorklistApplicationResultBase {
	scope: WorklistOperation["scope"];
	action: string;
	meta: WorklistResultMeta;
}

interface SessionExecutionResult {
	result: WorklistOperationResult;
	revision: string;
	projectRevision?: string;
	changed: boolean;
	changedTaskIds?: string[];
}

interface ProjectExecutionResult {
	result: WorklistOperationResult;
	revision: string;
	changed: boolean;
	changedGoalIds?: string[];
}

export interface WorklistApplicationSuccess extends WorklistApplicationResultBase {
	ok: true;
	result: WorklistOperationResult;
	error?: never;
}

export interface WorklistApplicationFailure extends WorklistApplicationResultBase {
	ok: false;
	result?: never;
	error: WorklistError;
}

export type WorklistApplicationResult = WorklistApplicationSuccess | WorklistApplicationFailure;

export interface WorklistApplicationServiceOptions {
	sessionStore?: SessionStore;
	projectPath?: string | null;
}

/**
 * How the service finds the goal file, asked once per project operation.
 *
 * The resolution order lives outside the service so every interface shares it,
 * and it is a question rather than an answer so a host that outlives a
 * `migrate_path` never writes to the path it was told about at startup.
 */
export type ProjectPathResolver = () => string | null;

type ProjectLifecycleAction = keyof typeof PROJECT_LIFECYCLE_TARGET_STATUS;

const EMPTY_RESULT_META: WorklistResultMeta = {
	changed: false,
	semanticNoOp: false,
	changedFields: [],
};

function cloneEmptyResultMeta(): WorklistResultMeta {
	return { ...EMPTY_RESULT_META, changedFields: [] };
}

function isProjectLifecycleAction(action: string): action is ProjectLifecycleAction {
	return action === "complete" || action === "reopen" || action === "archive";
}

function createApplicationError(
	code: WorklistError["code"],
	message: string,
	details?: Record<string, unknown>,
	retryable = false,
): WorklistApplicationError {
	return new WorklistApplicationError({ code, message, retryable, details });
}

function validationError(message: string, details?: Record<string, unknown>): WorklistApplicationError {
	return createApplicationError(WORKLIST_ERROR_CODES.VALIDATION_FAILED, message, details);
}

type MissingEntity =
	| "session-task"
	| "session-task-anchor"
	| "project-goal"
	| "project-goal-anchor"
	| "project-goal-dependency";

function notFoundError(entity: MissingEntity, id: string) {
	let message = `Session task anchor ${id} not found.`;
	if (entity === "session-task") message = `Session task ${id} was not found.`;
	else if (entity === "project-goal") message = `Project goal ${id} was not found.`;
	else if (entity === "project-goal-anchor") message = `Project goal anchor ${id} was not found.`;
	else if (entity === "project-goal-dependency") {
		message = `Project goal dependency ${id} was not found.`;
	}
	return createApplicationError(WORKLIST_ERROR_CODES.NOT_FOUND, message, {
		entity,
		id,
		resolution: "refresh-and-select-existing",
	});
}

/**
 * The typed failure for a selector that named no goal, or more than one.
 *
 * An ambiguous prefix is refused with the goals it matched rather than resolved
 * by picking one, because every guess a caller cannot see is a mutation applied
 * to a goal they did not mean. Interfaces share this so a prefix behaves the
 * same whether it arrived from the CLI, the model tool, or the dashboard.
 */
export function projectGoalSelectionError(
	selector: string,
	resolution: UnresolvedGoalSelector,
	field: "id" | "beforeId" | "afterId" | "dependsOn" = "id",
): WorklistApplicationError {
	if (resolution.kind === "not-found") return notFoundError("project-goal", selector);
	const reported = resolution.candidates.slice(0, MAX_REPORTED_GOAL_CANDIDATES);
	const listed = reported.map((goal) => goal.id).join(", ");
	const remainder = resolution.candidates.length - reported.length;
	return validationError(
		`Goal ID ${selector} matches ${resolution.candidates.length} goals: ${listed}${remainder > 0 ? `, and ${remainder} more` : ""}. Use a longer prefix or the full ID.`,
		{
			fields: [field],
			resolution: "provide-unambiguous-goal-id",
			candidateCount: resolution.candidates.length,
			candidates: reported.map((goal) => ({ id: goal.id, title: goal.title })),
		},
	);
}

/**
 * The typed refusal for a repository holding two worklists at once.
 *
 * Which goals survive a merge is a decision only their owner can make, so no
 * interface picks a file: the one that resolved is named as the keeper and the
 * one being passed over is named for deletion. The condition is caught both
 * before a migration starts and again under the lock, and a caller reading the
 * message or the details cannot tell which noticed.
 */
export function projectWorklistMergeRequiredError(
	currentPath: string,
	conflictingPath: string,
): WorklistApplicationError {
	return validationError(
		`Project worklist ${currentPath} already exists. Merge the goals you want to keep into it and delete ${conflictingPath}.`,
		{
			path: currentPath,
			conflictingPath,
			resolution: "merge-worklists-by-hand",
		},
	);
}

/** The explicit-intent gate every irreversible or bulk Project Goal action passes through. */
function requireConfirmation(operation: WorklistOperation): void {
	if (operation.confirm === true) return;
	throw createApplicationError(
		WORKLIST_ERROR_CODES.APPROVAL_REQUIRED,
		`Project ${operation.action} requires explicit confirmation.`,
		{
			confirmation: "confirm=true",
			resolution: "request-explicit-user-confirmation",
		},
	);
}

const MOVE_DIRECTIONS: ReadonlySet<string> = new Set(["down", "up"]);

function readPlacement(operation: WorklistOperation): ProjectGoalPlacement | undefined {
	if (operation.beforeId !== undefined) return { beforeId: operation.beforeId.trim() };
	if (operation.afterId !== undefined) return { afterId: operation.afterId.trim() };
	if (operation.direction !== undefined) return { direction: operation.direction };
	return undefined;
}

function placementField(operation: WorklistOperation): "beforeId" | "afterId" {
	return operation.beforeId !== undefined ? "beforeId" : "afterId";
}

function validatePlacementValue(operation: WorklistOperation): void {
	if (operation.beforeId !== undefined && operation.afterId !== undefined) {
		throw validationError(
			"beforeId and afterId are mutually exclusive; provide exactly one placement anchor.",
			{
				fields: ["afterId", "beforeId"],
				resolution: "provide-one-placement-anchor",
			},
		);
	}
	const anchor = operation.beforeId ?? operation.afterId;
	if (operation.direction !== undefined) {
		if (anchor !== undefined) {
			throw validationError(
				"direction and placement anchors are mutually exclusive; step by one or name an anchor.",
				{
					fields: [placementField(operation), "direction"],
					resolution: "provide-one-placement",
				},
			);
		}
		if (!MOVE_DIRECTIONS.has(operation.direction)) {
			throw validationError("direction must be up or down.", {
				fields: ["direction"],
				resolution: "provide-supported-direction",
				supportedDirections: [...MOVE_DIRECTIONS],
			});
		}
	}
	if (anchor !== undefined && !anchor.trim()) {
		throw validationError("Placement anchor must not be blank.", {
			fields: [placementField(operation)],
			resolution: "provide-non-blank-placement-anchor",
		});
	}
}

function validatePlacementSupport(
	operation: WorklistOperation,
	placement: ProjectGoalPlacement | undefined,
): void {
	if (operation.scope === "project") {
		if (placement && operation.action !== "move") {
			throw validationError("beforeId, afterId, and direction are only supported for project move.", {
				fields: [operation.direction !== undefined ? "direction" : placementField(operation)],
				resolution: "remove-placement-fields",
			});
		}
		return;
	}
	if (operation.direction !== undefined) {
		throw validationError("direction is only supported for project move.", {
			fields: ["direction"],
			resolution: "remove-placement-fields",
		});
	}
	if (placement && operation.action !== "add" && operation.action !== "move") {
		throw validationError("beforeId and afterId are only supported for session add and move.", {
			fields: [placementField(operation)],
			resolution: "remove-placement-fields",
		});
	}
}

function normalizePlacement(operation: WorklistOperation): ProjectGoalPlacement | undefined {
	validatePlacementValue(operation);
	const placement = readPlacement(operation);
	validatePlacementSupport(operation, placement);
	return placement;
}

/**
 * The same placement, narrowed to what a Session Task queue can express.
 *
 * `validatePlacementSupport` has already refused a direction outside project
 * move, so this only carries that guarantee into the type system.
 */
function asSessionPlacement(placement: ProjectGoalPlacement | undefined): SessionTaskPlacement | undefined {
	if (placement === undefined || placement.direction === undefined) return placement;
	throw validationError("direction is only supported for project move.", {
		fields: ["direction"],
		resolution: "remove-placement-fields",
	});
}

/** Fields describing a Project Goal's prose or baseline, which a Session Task has no counterpart for. */
const PROJECT_ONLY_FIELDS = [
	{ field: "description", resolution: "remove-description" },
	{ field: "appendDescription", resolution: "remove-append-description" },
	{ field: "group", resolution: "remove-group" },
	{ field: "dependsOn", resolution: "remove-depends-on" },
	{ field: "plan", resolution: "use-project-apply-plan" },
	{ field: "dryRun", resolution: "use-project-apply-plan" },
	{ field: "targetPath", resolution: "use-project-migrate-path" },
	{ field: "expectedUpdatedAt", resolution: "remove-expected-updated-at" },
] as const;

function rejectProjectOnlyFields(operation: WorklistOperation): void {
	const unsupported = PROJECT_ONLY_FIELDS.find((entry) => operation[entry.field] !== undefined);
	if (!unsupported) return;
	throw validationError(`${unsupported.field} is only supported for project goals.`, {
		fields: [unsupported.field],
		resolution: unsupported.resolution,
	});
}

/**
 * The caller's baseline for the one goal an operation targets.
 *
 * Callers echo back the `updatedAt` they read, so a mutation built on a stale
 * read is refused as a conflict instead of silently overwriting whoever wrote
 * in between. It is deliberately narrower than the whole-store revision, which
 * moves for every unrelated goal and so cannot guard a single goal usefully.
 */
function normalizeExpectedGoal(operation: WorklistOperation): ProjectGoalPrecondition | undefined {
	if (operation.expectedUpdatedAt === undefined) return undefined;
	const updatedAt = operation.expectedUpdatedAt;
	if (!updatedAt.trim()) {
		throw validationError("expectedUpdatedAt must not be blank.", {
			fields: ["expectedUpdatedAt"],
			resolution: "provide-non-blank-expected-updated-at",
		});
	}
	if (!operation.id) {
		throw validationError("expectedUpdatedAt requires the id of the goal it guards.", {
			fields: ["expectedUpdatedAt", "id"],
			resolution: "provide-project-goal-id",
		});
	}
	return { id: operation.id, updatedAt };
}

/** Exactly one kind of description change per update: replace the whole blob, or add to it. */
function normalizeDescriptionUpdate(operation: WorklistOperation): ProjectGoalUpdate {
	if (operation.appendDescription === undefined) return { description: operation.description };
	if (operation.description !== undefined) {
		throw validationError(
			"description and appendDescription are mutually exclusive; replace the description or append to it.",
			{
				fields: ["appendDescription", "description"],
				resolution: "provide-one-description-change",
			},
		);
	}
	const appendDescription = operation.appendDescription.trim();
	if (!appendDescription) {
		throw validationError("appendDescription must not be blank.", {
			fields: ["appendDescription"],
			resolution: "provide-non-blank-append-text",
		});
	}
	return { appendDescription };
}

const READ_ACTIONS = new Set(["list"]);
const EXPECTED_UPDATED_AT_ACTIONS = new Set([
	"update",
	"set_active",
	"complete",
	"reopen",
	"archive",
	"delete",
]);

/** Project actions that accept a section name, or a set of dependency edges. */
const GROUP_ACTIONS = new Set(["add", "update"]);
const DEPENDS_ON_ACTIONS = GROUP_ACTIONS;

/** Project actions whose `id` is a caller-supplied selector rather than a stored ID. */
const GOAL_SELECTOR_ACTIONS = new Set([...EXPECTED_UPDATED_AT_ACTIONS, "move", "set_status"]);

/**
 * Refuses Project Goal options an action would otherwise accept and ignore.
 *
 * Silently dropping either one is the failure they exist to prevent: an ignored
 * append still rewrites nothing, and an ignored baseline still lets a stale
 * caller overwrite a concurrent edit.
 */
function rejectUnsupportedProjectOptions(operation: WorklistOperation): void {
	if (operation.plan !== undefined && operation.action !== "apply-plan") {
		throw validationError("plan is only supported for project apply-plan.", {
			fields: ["plan"],
			resolution: "use-project-apply-plan",
		});
	}
	if (operation.dryRun !== undefined && typeof operation.dryRun !== "boolean") {
		throw validationError("dryRun must be a boolean.", {
			fields: ["dryRun"],
			resolution: "provide-boolean-dry-run",
		});
	}
	if (operation.dryRun !== undefined && operation.action !== "apply-plan") {
		throw validationError("dryRun is only supported for project apply-plan.", {
			fields: ["dryRun"],
			resolution: "use-project-apply-plan",
		});
	}
	if (operation.targetPath !== undefined && operation.action !== "migrate_path") {
		throw validationError("targetPath is only supported for project migrate_path.", {
			fields: ["targetPath"],
			resolution: "use-project-migrate-path",
		});
	}
	if (operation.appendDescription !== undefined && operation.action !== "update") {
		throw validationError("appendDescription is only supported for project update.", {
			fields: ["appendDescription"],
			resolution: "use-project-update",
		});
	}
	if (operation.expectedUpdatedAt !== undefined && !EXPECTED_UPDATED_AT_ACTIONS.has(operation.action)) {
		throw validationError("expectedUpdatedAt is only supported for target-goal mutations.", {
			fields: ["expectedUpdatedAt"],
			resolution: "remove-expected-updated-at",
		});
	}
	if (operation.group !== undefined && !GROUP_ACTIONS.has(operation.action)) {
		throw validationError("group is only supported for project add and update.", {
			fields: ["group"],
			resolution: "use-project-add-or-update",
		});
	}
	if (operation.dependsOn !== undefined && !DEPENDS_ON_ACTIONS.has(operation.action)) {
		throw validationError("dependsOn is only supported for project add and update.", {
			fields: ["dependsOn"],
			resolution: "use-project-add-or-update",
		});
	}
	if (operation.links !== undefined && !GROUP_ACTIONS.has(operation.action)) {
		throw validationError("links is only supported for project add and update.", {
			fields: ["links"],
			resolution: "use-project-add-or-update",
		});
	}
}

/**
 * The dependency selectors an operation carries, refused when one names nothing.
 *
 * A blank entry is rejected rather than skipped, because a caller who sent one
 * meant to name a goal, and silently dropping it would store a set of edges
 * they never asked for while reporting success.
 */
function normalizeDependsOn(operation: WorklistOperation): string[] | undefined {
	if (operation.dependsOn === undefined) return undefined;
	if (operation.dependsOn.some((entry) => !entry.trim())) {
		throw validationError("dependsOn entries must not be blank.", {
			fields: ["dependsOn"],
			resolution: "provide-non-blank-goal-ids",
		});
	}
	return operation.dependsOn.map((entry) => entry.trim());
}

/**
 * The links an operation carries, refused when one is not an absolute HTTP(S) URL.
 *
 * Every absolute HTTP(S) URL is accepted however it was spelled - a bare origin,
 * an uppercase scheme, a non-ASCII path - and stored in its canonical spelling,
 * so the field still never holds text a reader cannot follow, and two spellings
 * of one address deduplicate against each other.
 */
function normalizeLinks(operation: WorklistOperation): string[] | undefined {
	if (operation.links === undefined) return undefined;
	const links: string[] = [];
	for (const entry of operation.links) {
		let parsed: URL;
		try {
			parsed = new URL(entry.trim());
		} catch {
			throw validationError("links entries must be absolute HTTP or HTTPS URLs.", {
				fields: ["links"],
				resolution: "provide-absolute-http-or-https-urls",
			});
		}
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			throw validationError("links entries must be absolute HTTP or HTTPS URLs.", {
				fields: ["links"],
				resolution: "provide-absolute-http-or-https-urls",
			});
		}
		if (!links.includes(parsed.href)) links.push(parsed.href);
	}
	return links;
}

interface SuccessMetadataInput {
	operation: WorklistOperation;
	changed: boolean;
	sessionRevision?: string;
	projectRevision?: string;
	changedTaskIds?: string[];
	changedGoalIds?: string[];
}

function canonicalIds(ids: string[] | undefined): string[] {
	return [...new Set(ids ?? [])].sort();
}

function metadataForSuccess(input: SuccessMetadataInput): WorklistResultMeta {
	const { operation, changed, sessionRevision, projectRevision } = input;
	const revisions = {
		...(sessionRevision !== undefined ? { session: sessionRevision } : {}),
		...(projectRevision !== undefined ? { project: projectRevision } : {}),
	};
	if (READ_ACTIONS.has(operation.action) || operation.dryRun === true) {
		return {
			...cloneEmptyResultMeta(),
			...(Object.keys(revisions).length > 0 ? { revisions } : {}),
		};
	}

	const changedEntities: WorklistChangedEntities = {
		projectGoalIds: canonicalIds(input.changedGoalIds),
		sessionTaskIds: canonicalIds(input.changedTaskIds),
	};
	// A path migration relocates the goals without editing one, so it reports the
	// location as what changed. Naming `/goals` instead would send a reader
	// watching for edits looking for a change it will never find.
	const projectRoot = operation.action === "migrate_path" ? "/worklistPath" : "/goals";
	const changedRoot = operation.scope === "session" ? "/tasks" : projectRoot;
	return {
		changed,
		semanticNoOp: !changed,
		changedFields: changed ? canonicalChangedFields([changedRoot]) : [],
		...(changed ? { changedEntities } : {}),
		...(Object.keys(revisions).length > 0 ? { revisions } : {}),
	};
}

function isSessionTaskAnchorNotFoundError(error: unknown): error is Error & { anchorId: string } {
	return (
		error instanceof Error &&
		error.name === "SessionTaskAnchorNotFoundError" &&
		typeof (error as { anchorId?: unknown }).anchorId === "string"
	);
}

function isSessionRevisionConflictError(
	error: unknown,
): error is Error & { expectedRevision: string; actualRevision: string } {
	return (
		error instanceof Error &&
		error.name === "SessionRevisionConflictError" &&
		typeof (error as { expectedRevision?: unknown }).expectedRevision === "string" &&
		typeof (error as { actualRevision?: unknown }).actualRevision === "string"
	);
}

function persistenceError(
	operation: WorklistOperation,
	error: unknown,
	projectPath?: string | null,
): WorklistError {
	const rawMessage = error instanceof Error ? error.message : String(error);
	if (
		operation.scope === "project" &&
		(rawMessage.startsWith("Malformed project file") ||
			rawMessage.startsWith("Malformed or unsupported schema"))
	) {
		// The file is named rather than described, because which of the resolvable
		// paths answered is exactly what the person repairing it needs to know.
		const target = projectPath ?? "the project worklist";
		return {
			code: WORKLIST_ERROR_CODES.PERSISTENCE_FAILED,
			message: `Malformed project worklist or unsupported schema. Repair ${target} before retrying.`,
			retryable: false,
			details: { resolution: "repair-project-file", ...(projectPath ? { path: projectPath } : {}) },
		};
	}
	let message = "Session task persistence failed. Retry in the active Pi session.";
	let resolution = "retry-active-session";
	if (operation.scope === "project") {
		message =
			"Project worklist persistence failed. Retry after checking repository access and the worklist lock.";
		resolution = "check-repository-and-retry";
	}
	return {
		code: WORKLIST_ERROR_CODES.PERSISTENCE_FAILED,
		message,
		retryable: true,
		details: { resolution },
	};
}

/** A throwable adapter for interfaces whose host signals failures with exceptions. */
export class WorklistApplicationError extends Error {
	readonly code: WorklistError["code"];
	readonly retryable: boolean;
	readonly conflict?: WorklistError["conflict"];
	readonly details?: Record<string, unknown>;

	constructor(error: WorklistError) {
		super(error.message);
		this.name = error.code;
		this.code = error.code;
		this.retryable = error.retryable;
		this.conflict = error.conflict;
		this.details = error.details;
	}

	toResultError(): WorklistError {
		return {
			code: this.code,
			message: this.message,
			retryable: this.retryable,
			...(this.conflict !== undefined ? { conflict: this.conflict } : {}),
			...(this.details !== undefined ? { details: this.details } : {}),
		};
	}
}

export function unwrapWorklistApplicationResult(
	envelope: WorklistApplicationResult,
): WorklistOperationResult {
	if (!envelope.ok) throw new WorklistApplicationError(envelope.error);
	return envelope.result;
}

function requireOperationId(operation: WorklistOperation, entity: "session-task" | "project-goal"): string {
	if (operation.id) return operation.id;
	const resolution = entity === "session-task" ? "provide-session-task-id" : "provide-project-goal-id";
	throw validationError(`id is required for ${operation.scope} ${operation.action}.`, {
		fields: ["id"],
		resolution,
	});
}

async function addSessionTask(
	sessionStore: SessionStore,
	operation: WorklistOperation,
	placement: SessionTaskPlacement | undefined,
): Promise<SessionExecutionResult> {
	if (!operation.title) {
		throw validationError("title is required for session add.", {
			fields: ["title"],
			resolution: "provide-title",
		});
	}
	const {
		result: task,
		changed,
		revision,
	} = await sessionStore.addTask(operation.title, operation.goalId, placement, {
		expectedRevision: operation.expectedRevision,
	});
	return {
		result: { scope: "session", action: "add", task, tasks: sessionStore.getTasks() },
		changed,
		revision,
		changedTaskIds: [task.id],
	};
}

async function moveSessionTask(
	sessionStore: SessionStore,
	operation: WorklistOperation,
	placement: SessionTaskPlacement | undefined,
): Promise<SessionExecutionResult> {
	const id = requireOperationId(operation, "session-task");
	if (!placement) {
		throw validationError("Session move requires exactly one of beforeId or afterId.", {
			fields: ["afterId", "beforeId"],
			resolution: "provide-one-placement-anchor",
		});
	}
	const {
		result: task,
		changed,
		revision,
	} = await sessionStore.moveTask(id, placement, {
		expectedRevision: operation.expectedRevision,
	});
	if (!task) throw notFoundError("session-task", id);
	return {
		result: { scope: "session", action: "move", task, tasks: sessionStore.getTasks() },
		changed,
		revision,
		changedTaskIds: [id],
	};
}

async function updateSessionTask(
	sessionStore: SessionStore,
	operation: WorklistOperation,
): Promise<SessionExecutionResult> {
	const id = requireOperationId(operation, "session-task");
	const updates: Partial<Pick<SessionTask, "title" | "goalId">> = {};
	if (operation.title !== undefined) updates.title = operation.title;
	if (operation.goalId !== undefined) updates.goalId = operation.goalId;
	const {
		result: task,
		changed,
		revision,
	} = await sessionStore.updateTask(id, updates, {
		expectedRevision: operation.expectedRevision,
	});
	if (!task) throw notFoundError("session-task", id);
	return {
		result: { scope: "session", action: "update", task, tasks: sessionStore.getTasks() },
		changed,
		revision,
		changedTaskIds: [id],
	};
}

async function setSessionTaskStatus(
	sessionStore: SessionStore,
	operation: WorklistOperation,
): Promise<SessionExecutionResult> {
	const id = requireOperationId(operation, "session-task");
	if (!operation.status || !["todo", "doing", "done"].includes(operation.status)) {
		throw validationError("status must be todo, doing, or done for session tasks.", {
			fields: ["status"],
			resolution: "provide-supported-session-status",
			supportedStatuses: ["doing", "done", "todo"],
		});
	}
	const {
		result: task,
		changed,
		revision,
	} = await sessionStore.setTaskStatus(id, operation.status as SessionTaskStatus, {
		expectedRevision: operation.expectedRevision,
	});
	if (!task) throw notFoundError("session-task", id);
	return {
		result: { scope: "session", action: "set_status", task, tasks: sessionStore.getTasks() },
		changed,
		revision,
		changedTaskIds: [id],
	};
}

async function deleteSessionTask(
	sessionStore: SessionStore,
	operation: WorklistOperation,
): Promise<SessionExecutionResult> {
	const id = requireOperationId(operation, "session-task");
	const {
		result: removed,
		changed,
		revision,
	} = await sessionStore.deleteTask(id, {
		expectedRevision: operation.expectedRevision,
	});
	if (!removed) throw notFoundError("session-task", id);
	return {
		result: { scope: "session", action: "delete", tasks: sessionStore.getTasks() },
		changed,
		revision,
		changedTaskIds: [id],
	};
}

/**
 * Canonical application boundary for every worklist interface.
 *
 * Adapters are responsible only for parsing input and presenting this service's
 * deterministic result envelope. Validation, state transitions, locking, and
 * persistence are owned by this service and the stores it coordinates.
 */
export class WorklistApplicationService {
	private readonly options: WorklistApplicationServiceOptions;
	private resolveProjectPath: ProjectPathResolver;

	constructor(options: WorklistApplicationServiceOptions) {
		this.options = options;
		const configured = options.projectPath ?? null;
		this.resolveProjectPath = () => configured;
	}

	/**
	 * Hand over the resolution instead of an answer, for a host that outlives it.
	 *
	 * A CLI process resolves once and exits, so the path it was handed cannot go
	 * stale underneath it. A session or a board stays open across a `migrate_path`
	 * run in another terminal, and a goal file that moved is exactly the state
	 * where writing to the remembered path splits one roadmap into two. Every
	 * project operation asks again, so the answer is never older than the
	 * operation it decides.
	 */
	setProjectPathResolver(resolve: ProjectPathResolver): void {
		this.resolveProjectPath = resolve;
	}

	getSessionTasks(): SessionTask[] {
		return this.requireSessionStore()
			.getTasks()
			.map((task) => ({ ...task }));
	}

	async getProjectGoals(): Promise<ProjectGoal[]> {
		const projectPath = this.resolveProjectPath();
		if (!projectPath) return [];
		try {
			return await listProjectGoals(projectPath);
		} catch (error) {
			throw new WorklistApplicationError(
				persistenceError({ scope: "project", action: "list" }, error, projectPath),
			);
		}
	}

	async readProjectSnapshot(action: string): Promise<WorklistApplicationResult> {
		const operation: WorklistOperation = { scope: "project", action };
		const resolved = this.resolveProjectPath();
		try {
			const projectPath = this.requireProjectPath(resolved);
			const { goals, retiredIds, revision } = await readProjectGoals(projectPath);
			return {
				ok: true,
				scope: "project",
				action,
				result: { scope: "project", action, goals, retiredIds },
				meta: { ...cloneEmptyResultMeta(), revisions: { project: revision } },
			};
		} catch (error) {
			const typedError =
				error instanceof WorklistApplicationError
					? error.toResultError()
					: persistenceError(operation, error, resolved);
			return {
				ok: false,
				scope: "project",
				action,
				error: typedError,
				meta: cloneEmptyResultMeta(),
			};
		}
	}

	async execute(
		operation: WorklistOperation,
		_context: WorklistOperationContext,
	): Promise<WorklistApplicationResult> {
		const resolvedProjectPath = operation.scope === "project" ? this.resolveProjectPath() : null;
		try {
			const placement = normalizePlacement(operation);
			let result: WorklistOperationResult;
			let changed = false;
			let sessionRevision: string | undefined;
			let projectRevision: string | undefined;
			let changedTaskIds: string[] | undefined;
			let changedGoalIds: string[] | undefined;
			if (operation.scope === "session") {
				const sessionExecution = await this.executeSession(operation, placement);
				result = sessionExecution.result;
				changed = sessionExecution.changed;
				sessionRevision = sessionExecution.revision;
				projectRevision = sessionExecution.projectRevision;
				changedTaskIds = sessionExecution.changedTaskIds;
			} else if (operation.scope === "project") {
				const projectExecution = await this.executeProject(operation, resolvedProjectPath);
				result = projectExecution.result;
				changed = projectExecution.changed;
				projectRevision = projectExecution.revision;
				changedGoalIds = projectExecution.changedGoalIds;
			} else {
				throw createApplicationError(
					WORKLIST_ERROR_CODES.INVALID_REQUEST,
					`Unknown worklist scope: ${String(operation.scope)}.`,
					{ supportedScopes: ["project", "session"] },
				);
			}
			const meta = metadataForSuccess({
				operation,
				changed,
				sessionRevision,
				projectRevision,
				changedTaskIds,
				changedGoalIds,
			});
			return {
				ok: true,
				scope: operation.scope,
				action: operation.action,
				result,
				meta,
			};
		} catch (error) {
			let typedError: WorklistError;
			let failureMeta = cloneEmptyResultMeta();
			if (error instanceof WorklistApplicationError) typedError = error.toResultError();
			else if (error instanceof ProjectGoalNotFoundError) {
				typedError = notFoundError("project-goal", error.goalId).toResultError();
			} else if (error instanceof ProjectGoalAnchorNotFoundError) {
				typedError = notFoundError("project-goal-anchor", error.anchorId).toResultError();
			} else if (error instanceof ProjectGoalDependencyNotFoundError) {
				typedError = notFoundError("project-goal-dependency", error.dependencyId).toResultError();
			} else if (error instanceof ProjectGoalPlanValidationError) {
				typedError = validationError(error.message, error.details).toResultError();
			} else if (error instanceof ProjectGoalDependencyCycleError) {
				typedError = createApplicationError(
					WORKLIST_ERROR_CODES.DEPENDENCY_CYCLE,
					`${error.message}. An edge means must-land-before, so a cycle names goals that each have to wait for the other.`,
					{
						fields: ["dependsOn"],
						cycle: error.cycle,
						cyclePath: formatDependencyCycle(error.cycle),
						resolution: "remove-an-edge-from-the-cycle",
					},
				).toResultError();
			} else if (error instanceof ProjectRevisionConflictError) {
				typedError = {
					code: WORKLIST_ERROR_CODES.CONFLICT,
					message: error.message,
					retryable: true,
					conflict: {
						type: "revision",
						expectedRevision: error.expectedRevision,
						actualRevision: error.actualRevision,
						resolution: "refresh-and-retry",
					},
				};
				failureMeta = { ...failureMeta, revisions: { project: error.actualRevision } };
			} else if (error instanceof ProjectGoalConflictError) {
				typedError = {
					code: WORKLIST_ERROR_CODES.CONFLICT,
					message: error.message,
					retryable: true,
					conflict: {
						type: "goal-updated-at",
						id: error.goalId,
						expectedUpdatedAt: error.expectedUpdatedAt,
						actualUpdatedAt: error.actualUpdatedAt,
						resolution: "refresh-and-retry",
					},
				};
			} else if (isSessionRevisionConflictError(error)) {
				typedError = {
					code: WORKLIST_ERROR_CODES.CONFLICT,
					message: error.message,
					retryable: true,
					conflict: {
						type: "revision",
						expectedRevision: error.expectedRevision,
						actualRevision: error.actualRevision,
						resolution: "refresh-and-retry",
					},
				};
				failureMeta = { ...failureMeta, revisions: { session: error.actualRevision } };
			} else if (error instanceof ProjectWorklistMoveRefusedError) {
				// Neither reason is retryable and neither is a stale baseline: one names
				// a file that is gone, the other a second roadmap only a person can
				// reconcile, and both leave every worklist exactly as it was.
				typedError =
					error.reason === "source-missing"
						? createApplicationError(WORKLIST_ERROR_CODES.NOT_FOUND, error.message, {
								path: error.fromPath,
								resolution: "refresh-and-retry",
							}).toResultError()
						: projectWorklistMergeRequiredError(error.toPath, error.fromPath).toResultError();
			} else if (error instanceof ProjectGoalActivationBlockedError) {
				typedError = validationError(
					"A done or archived Project Goal must be reopened with confirm=true before activation.",
					{
						confirmation: "confirm=true",
						id: operation.id,
						resolution: "reopen-project-goal",
					},
				).toResultError();
			} else if (isSessionTaskAnchorNotFoundError(error)) {
				typedError = notFoundError("session-task-anchor", error.anchorId).toResultError();
			} else {
				typedError = persistenceError(operation, error, resolvedProjectPath);
			}
			return {
				ok: false,
				scope: operation.scope,
				action: operation.action,
				error: typedError,
				meta: failureMeta,
			};
		}
	}

	private async executeSession(
		operation: WorklistOperation,
		rawPlacement: ProjectGoalPlacement | undefined,
	): Promise<SessionExecutionResult> {
		const sessionStore = this.requireSessionStore();
		rejectProjectOnlyFields(operation);
		const placement = asSessionPlacement(rawPlacement);

		switch (operation.action) {
			case "list":
				return {
					result: { scope: "session", action: "list", tasks: sessionStore.getTasks() },
					changed: false,
					revision: sessionStore.getRevision(),
				};
			case "add":
				return addSessionTask(sessionStore, operation, placement);
			case "move":
				return moveSessionTask(sessionStore, operation, placement);
			case "update":
				return updateSessionTask(sessionStore, operation);
			case "set_status":
				return setSessionTaskStatus(sessionStore, operation);
			case "delete":
				return deleteSessionTask(sessionStore, operation);
			default:
				throw createApplicationError(
					WORKLIST_ERROR_CODES.INVALID_REQUEST,
					`Unknown session action: ${operation.action}.`,
					{
						supportedActions: ["add", "delete", "list", "move", "set_status", "update"],
					},
				);
		}
	}

	private async executeProject(
		rawOperation: WorklistOperation,
		resolvedProjectPath: string | null,
	): Promise<ProjectExecutionResult> {
		const projectPath = this.requireProjectPath(resolvedProjectPath);
		rejectUnsupportedProjectOptions(rawOperation);
		// Selectors resolve before the placement is read, so `move x before y`
		// anchors on the goal `y` names rather than on the caller's shorthand.
		const operation = await this.withResolvedGoalId(projectPath, rawOperation);
		const options: ProjectMutationOptions = {
			expectedRevision: operation.expectedRevision,
			expectedGoal: normalizeExpectedGoal(operation),
		};
		switch (operation.action) {
			case "list": {
				const { goals, revision } = await readProjectGoals(projectPath);
				return { result: { scope: "project", action: "list", goals }, revision, changed: false };
			}
			case "apply-plan": {
				if (operation.plan === undefined) {
					throw validationError("plan is required for project apply-plan.", {
						fields: ["plan"],
						resolution: "provide-json-goal-array",
					});
				}
				const { addedGoals, goals, warnings, revision, changed } = await applyProjectPlan(
					projectPath,
					operation.plan as ProjectGoalPlanEntry[],
					{ ...options, dryRun: operation.dryRun },
				);
				return {
					result: {
						scope: "project",
						action: "apply-plan",
						dryRun: operation.dryRun === true,
						addedGoals,
						goals,
						warnings,
					},
					revision,
					changed,
					changedGoalIds: changed ? addedGoals.map((goal) => goal.id) : [],
				};
			}
			case "add": {
				if (!operation.title) {
					throw validationError("title is required for project add.", {
						fields: ["title"],
						resolution: "provide-title",
					});
				}
				const { goal, goals, revision, changed } = await addProjectGoal(
					projectPath,
					operation.title,
					{
						description: operation.description,
						group: operation.group,
						dependsOn: operation.dependsOn,
						links: normalizeLinks(operation),
					},
					options,
				);
				return {
					result: { scope: "project", action: "add", goal, goals },
					revision,
					changed,
					changedGoalIds: [goal.id],
				};
			}
			case "move":
				return this.moveProjectGoal(projectPath, operation, readPlacement(operation), options);
			case "update": {
				if (!operation.id) {
					throw validationError("id is required for project update.", {
						fields: ["id"],
						resolution: "provide-project-goal-id",
					});
				}
				const { goal, goals, revision, changed } = await updateProjectGoal(
					projectPath,
					operation.id,
					{
						title: operation.title,
						group: operation.group,
						dependsOn: operation.dependsOn,
						links: normalizeLinks(operation),
						...normalizeDescriptionUpdate(operation),
					},
					options,
				);
				return {
					result: { scope: "project", action: "update", goal, goals },
					revision,
					changed,
					changedGoalIds: [goal.id],
				};
			}
			case "set_status":
				if (operation.status !== "active") {
					throw validationError(
						"Project set_status only accepts active. Use complete, reopen, or archive with confirm=true for lifecycle changes.",
						{
							fields: ["status"],
							resolution: "use-explicit-project-lifecycle-action",
						},
					);
				}
				return this.activateProjectGoal(projectPath, operation, options);
			case "set_active":
				return this.activateProjectGoal(projectPath, operation, options);
			case "complete":
			case "reopen":
			case "archive":
			case "delete":
				return this.transitionProjectGoal(projectPath, operation, options);
			case "migrate_ids":
				return this.runGoalIdMigration(projectPath, operation, options);
			case "migrate_path":
				return this.runWorklistPathMigration(projectPath, operation);
			default:
				throw createApplicationError(
					WORKLIST_ERROR_CODES.INVALID_REQUEST,
					`Unknown project action: ${operation.action}.`,
					{
						supportedActions: [
							"add",
							"apply-plan",
							"archive",
							"complete",
							"delete",
							"list",
							"migrate_ids",
							"migrate_path",
							"move",
							"reopen",
							"set_active",
							"set_status",
							"update",
						],
					},
				);
		}
	}

	/**
	 * The operation with its goal selector replaced by the stored ID it names.
	 *
	 * Resolution reads the worklist before the mutation takes the lock, so a goal
	 * created in between could in principle have made the prefix ambiguous. That
	 * is benign: IDs are frozen at creation, the resolved ID is exact, and it
	 * either still exists, producing the ordinary not-found, or it does not.
	 * A selector that matches nothing is passed through untouched so the mutation
	 * itself reports the miss, which keeps one not-found path instead of two.
	 */
	private async withResolvedGoalId(
		projectPath: string,
		operation: WorklistOperation,
	): Promise<WorklistOperation> {
		const dependsOn = normalizeDependsOn(operation);
		const namesGoal =
			GOAL_SELECTOR_ACTIONS.has(operation.action) &&
			(Boolean(operation.id) || operation.beforeId !== undefined || operation.afterId !== undefined);
		if (!namesGoal && dependsOn === undefined) return operation;
		const { goals, retiredIds } = await readProjectGoals(projectPath);
		const resolve = (
			selector: string | undefined,
			field: "id" | "beforeId" | "afterId" | "dependsOn",
		): string | undefined => {
			if (selector === undefined) return undefined;
			const resolution = resolveGoalSelector(goals, selector, retiredIds);
			if (resolution.kind === "ambiguous") {
				throw projectGoalSelectionError(selector, resolution, field);
			}
			return resolution.kind === "found" ? resolution.goal.id : selector;
		};
		return {
			...operation,
			...(namesGoal && operation.id ? { id: resolve(operation.id, "id") } : {}),
			...(namesGoal && operation.beforeId !== undefined
				? { beforeId: resolve(operation.beforeId, "beforeId") }
				: {}),
			...(namesGoal && operation.afterId !== undefined
				? { afterId: resolve(operation.afterId, "afterId") }
				: {}),
			// An edge is as much a reference to a goal as an anchor is, so a prefix or
			// a former ID names the same goal here as it does anywhere else.
			...(dependsOn !== undefined
				? { dependsOn: dependsOn.map((entry) => resolve(entry, "dependsOn") ?? entry) }
				: {}),
		};
	}

	/**
	 * Reorders one goal in canonical file order.
	 *
	 * A move names no new state, only a new position, so it needs no confirmation
	 * and leaves the moved goal's own fields, including its baseline, untouched.
	 */
	private async moveProjectGoal(
		projectPath: string,
		operation: WorklistOperation,
		placement: ProjectGoalPlacement | undefined,
		options: ProjectMutationOptions,
	): Promise<ProjectExecutionResult> {
		const id = requireOperationId(operation, "project-goal");
		if (!placement) {
			throw validationError("Project move requires exactly one of beforeId, afterId, or direction.", {
				fields: ["afterId", "beforeId", "direction"],
				resolution: "provide-one-placement",
			});
		}
		const { goal, goals, revision, changed } = await moveProjectGoal(projectPath, id, placement, options);
		return {
			result: { scope: "project", action: "move", goal, goals },
			revision,
			changed,
			changedGoalIds: [goal.id],
		};
	}

	private async runGoalIdMigration(
		projectPath: string,
		operation: WorklistOperation,
		options: ProjectMutationOptions,
	): Promise<ProjectExecutionResult> {
		requireConfirmation(operation);
		const { goals, migrations, revision, changed, changedGoalIds } = await migrateProjectGoalIds(
			projectPath,
			options,
		);
		return {
			result: { scope: "project", action: "migrate_ids", goals, migrations },
			revision,
			changed,
			changedGoalIds,
		};
	}

	/**
	 * Moves the whole repository's goal file to the path it should live at.
	 *
	 * A goal-free mutation, so it carries no baseline: `expectedUpdatedAt` guards
	 * one goal and the store revision guards content, while this changes neither.
	 * Already being at the target is success with nothing changed, the same
	 * answer an ID migration gives when no ID needs rewriting.
	 */
	private async runWorklistPathMigration(
		projectPath: string,
		operation: WorklistOperation,
	): Promise<ProjectExecutionResult> {
		requireConfirmation(operation);
		const targetPath = operation.targetPath?.trim();
		if (!targetPath) {
			throw validationError("targetPath is required for project migrate_path.", {
				fields: ["targetPath"],
				resolution: "provide-target-worklist-path",
			});
		}
		if (targetPath === projectPath) {
			const { goals, revision } = await readProjectGoals(projectPath);
			return {
				result: { scope: "project", action: "migrate_path", goals, worklistPath: projectPath },
				revision,
				changed: false,
				changedGoalIds: [],
			};
		}
		const { fromPath, toPath, revision } = await migrateProjectWorklistPath(projectPath, targetPath);
		const { goals } = await readProjectGoals(toPath);
		return {
			result: {
				scope: "project",
				action: "migrate_path",
				goals,
				worklistPath: toPath,
				previousWorklistPath: fromPath,
			},
			revision,
			// The move relocates every goal without editing one, so no goal ID is
			// reported as changed: a reader watching for edits should see none.
			changed: true,
			changedGoalIds: [],
		};
	}

	private async activateProjectGoal(
		projectPath: string,
		operation: WorklistOperation,
		options: ProjectMutationOptions,
	): Promise<ProjectExecutionResult> {
		if (!operation.id) {
			throw validationError("id is required for project set_active.", {
				fields: ["id"],
				resolution: "provide-project-goal-id",
			});
		}
		const { goal, goals, revision, changed, changedGoalIds } = await activateProjectGoal(
			projectPath,
			operation.id,
			options,
		);
		// Blocked is a reading of the graph, not a veto: activating anyway is a
		// legitimate call someone can make, so the edges are reported rather than
		// enforced, and the activation still happened when this list is non-empty.
		const blockedBy = unsatisfiedDependencies(goals, goal).map((entry) => entry.id);
		return {
			result: {
				scope: "project",
				action: "set_active",
				goal,
				goals,
				...(blockedBy.length > 0 ? { blockedBy } : {}),
			},
			revision,
			changed,
			changedGoalIds,
		};
	}

	private async transitionProjectGoal(
		projectPath: string,
		operation: WorklistOperation,
		options: ProjectMutationOptions,
	): Promise<ProjectExecutionResult> {
		if (!operation.id) {
			throw validationError(`id is required for project ${operation.action}.`, {
				fields: ["id"],
				resolution: "provide-project-goal-id",
			});
		}
		requireConfirmation(operation);
		if (operation.action === "delete") {
			const { goalId, goals, strippedGoalIds, revision, changed } = await deleteProjectGoal(
				projectPath,
				operation.id,
				options,
			);
			return {
				result: { scope: "project", action: "delete", goals },
				revision,
				changed,
				// The goals that lost an edge changed as surely as the one that went, so
				// a reader watching for changes is told about them rather than left to
				// notice that a dependency quietly vanished.
				changedGoalIds: [goalId, ...strippedGoalIds],
			};
		}
		if (!isProjectLifecycleAction(operation.action)) {
			throw createApplicationError(
				WORKLIST_ERROR_CODES.INVALID_REQUEST,
				`Unknown project lifecycle action: ${operation.action}.`,
			);
		}
		const action = operation.action;
		const { goal, goals, revision, changed } = await transitionProjectGoal(
			projectPath,
			operation.id,
			PROJECT_LIFECYCLE_TARGET_STATUS[action],
			options,
		);
		return {
			result: { scope: "project", action, goal, goals },
			revision,
			changed,
			changedGoalIds: [goal.id],
		};
	}

	private requireSessionStore(): SessionStore {
		if (!this.options.sessionStore) {
			throw createApplicationError(
				WORKLIST_ERROR_CODES.UNAVAILABLE,
				"Session Tasks require a live Pi session.",
				{ resolution: "run-inside-pi-session" },
			);
		}
		return this.options.sessionStore;
	}

	private requireProjectPath(projectPath: string | null = this.resolveProjectPath()): string {
		if (!projectPath) {
			throw createApplicationError(
				WORKLIST_ERROR_CODES.UNAVAILABLE,
				"Project goals require a git repository. Session tasks are still available outside git.",
				{ resolution: "run-inside-git-repository" },
			);
		}
		return projectPath;
	}
}
