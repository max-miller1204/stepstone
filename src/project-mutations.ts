import { findDependencyCycleFromRoots, formatDependencyCycle } from "./dependencies.ts";
import {
	findGoalByStoredId,
	generateGoalId,
	planGoalIdMigration,
	slugifyGoalTitle,
	takenGoalIds,
} from "./goal-selection.ts";
import {
	moveProjectWorklist,
	mutateProjectWorklist,
	type ProjectMutationOptions,
	ProjectMutationRefusedError,
	type ProjectWorklistMove,
	readProjectWorklist,
} from "./project-store.ts";
import type {
	GoalIdMigration,
	ProjectGoal,
	ProjectGoalPlacement,
	ProjectGoalPlanEntry,
	ProjectGoalStatus,
	ProjectPlanWarning,
	ProjectWorklist,
} from "./types.ts";

/**
 * Pi-free Project Goal persistence primitives.
 *
 * Interface adapters must call WorklistApplicationService rather than these
 * functions directly so application validation and persistence stay unified.
 */

export const PROJECT_LIFECYCLE_TARGET_STATUS: Record<"complete" | "reopen" | "archive", ProjectGoalStatus> = {
	complete: "done",
	reopen: "open",
	archive: "archived",
};

export class ProjectGoalNotFoundError extends Error {
	readonly goalId: string;

	constructor(id: string) {
		super(`Project goal ${id} not found`);
		this.name = "ProjectGoalNotFoundError";
		this.goalId = id;
	}
}

/**
 * Extends the refused-mutation base because a mutate callback may raise it, and
 * `mutateProjectWorklist` only re-throws that family; anything else it catches
 * is reported as a persistence failure, which would tell a caller to retry a
 * refusal that will never succeed.
 *
 * `set_active` and a `start` branch claim both raise it, so the message names
 * both rather than activation alone. The class name predates `start` and stays
 * as it is because the type is exported and callers narrow on it.
 */
export class ProjectGoalActivationBlockedError extends ProjectMutationRefusedError {
	constructor(id: string) {
		super(
			`Project goal ${id} is done or archived and must be reopened before it can be started or activated`,
		);
		this.name = "ProjectGoalActivationBlockedError";
	}
}

export class ProjectGoalAnchorNotFoundError extends Error {
	readonly anchorId: string;

	constructor(anchorId: string) {
		super(`Project goal ${anchorId} not found`);
		this.name = "ProjectGoalAnchorNotFoundError";
		this.anchorId = anchorId;
	}
}

export class ProjectGoalDependencyNotFoundError extends ProjectMutationRefusedError {
	readonly dependencyId: string;

	constructor(dependencyId: string) {
		super(`Project goal ${dependencyId} not found`);
		this.name = "ProjectGoalDependencyNotFoundError";
		this.dependencyId = dependencyId;
	}
}

export class ProjectGoalDependencyCycleError extends ProjectMutationRefusedError {
	/** The goals on the cycle, each named once, starting where the walk closed it. */
	readonly cycle: string[];

	constructor(cycle: string[]) {
		super(`Project goal dependencies would form a cycle: ${formatDependencyCycle(cycle)}`);
		this.name = "ProjectGoalDependencyCycleError";
		this.cycle = cycle;
	}
}

/** A plan whose static shape or reference resolution is not deterministic. */
export class ProjectGoalPlanValidationError extends ProjectMutationRefusedError {
	readonly details: Record<string, unknown>;

	constructor(message: string, details: Record<string, unknown>) {
		super(message);
		this.name = "ProjectGoalPlanValidationError";
		this.details = details;
	}
}

export interface ProjectMutationOutcome {
	goal: ProjectGoal;
	goals: ProjectGoal[];
	revision: string;
	changed: boolean;
}

export interface ProjectGoalsSnapshot {
	goals: ProjectGoal[];
	retiredIds: string[];
	revision: string;
}

export interface ProjectGoalUpdate {
	title?: string;
	description?: string;
	/** Additive alternative to `description`, so a note never rewrites the whole blob. */
	appendDescription?: string;
	/** Free-form section name. The empty string clears the field. */
	group?: string;
	/** The complete set of informational HTTP(S) URLs. An empty array clears it. */
	links?: string[];
	/** The complete set of existing goals that must land first. Naming this goal is a cycle. */
	dependsOn?: string[];
}

export async function readProjectGoals(path: string): Promise<ProjectGoalsSnapshot> {
	const { data, error } = await readProjectWorklist(path);
	if (error) throw new Error(error);
	return { goals: data.goals, retiredIds: data.retiredIds ?? [], revision: String(data.revision) };
}

export async function listProjectGoals(path: string): Promise<ProjectGoal[]> {
	const snapshot = await readProjectGoals(path);
	return snapshot.goals;
}

function nextGoalUpdatedAt(previous: string): string {
	const previousTime = Date.parse(previous);
	const nextTime = Number.isNaN(previousTime) ? Date.now() : Math.max(Date.now(), previousTime + 1);
	return new Date(nextTime).toISOString();
}

/** The goal fields a mutation either writes or drops, never stores as empty. */
type OptionalGoalField = "group" | "completedAt" | "dependsOn" | "links" | "branch";

/**
 * A goal with each named optional field set, or dropped entirely when it is cleared.
 *
 * Removing the key rather than storing `undefined` keeps a cleared field out of
 * the file, so the JSON never accumulates properties that only say "nothing
 * here" and a reader cannot tell "cleared" apart from "never set". Taking the
 * fields together keeps every name beside the value it is written from, however
 * many of them one mutation resolves.
 *
 * A field is named to be written or cleared: `{ group: undefined }` clears the
 * group, while omitting `group` entirely leaves whatever the goal already had.
 * So a caller names every field its mutation resolves, and builds the value
 * conditionally rather than the key, because spreading the key away asks for the
 * stored field to survive rather than for it to be cleared.
 */
function withOptionalFields(
	goal: ProjectGoal,
	fields: { [Field in OptionalGoalField]?: ProjectGoal[Field] },
): ProjectGoal {
	let next = goal;
	for (const field of Object.keys(fields) as OptionalGoalField[]) {
		const value = fields[field];
		if (value !== undefined) {
			next = { ...next, [field]: value };
			continue;
		}
		const { [field]: _cleared, ...rest } = next;
		next = rest as ProjectGoal;
	}
	return next;
}

/** A group name as stored: trimmed, or absent once the caller clears it. */
function resolveGroup(current: string | undefined, next: string | undefined): string | undefined {
	if (next === undefined) return current;
	return next.trim() || undefined;
}

function resolveLinks(current: string[] | undefined, next: string[] | undefined): string[] | undefined {
	if (next === undefined) return current;
	return next.length > 0 ? next : undefined;
}

/**
 * The dependency edges a goal ends up with, canonicalized under the lock.
 *
 * Every entry is resolved to the target's current ID, so the file never stores a
 * name the goal it points at has already stopped using, and a blank or repeated
 * entry is dropped rather than persisted as a second way to say the same edge.
 * An empty result clears the field, which keeps "no dependencies" a single
 * representation instead of an absent field and an empty array meaning the same.
 */
function resolveDependsOn(
	worklist: ProjectWorklist,
	current: string[] | undefined,
	next: readonly string[] | undefined,
): string[] | undefined {
	if (next === undefined) return current;
	const canonical: string[] = [];
	for (const entry of next) {
		const id = entry.trim();
		if (id === "") continue;
		const target = findGoalByStoredId(worklist.goals, id, worklist.retiredIds ?? []);
		if (!target) throw new ProjectGoalDependencyNotFoundError(id);
		if (!canonical.includes(target.id)) canonical.push(target.id);
	}
	return canonical.length > 0 ? canonical : undefined;
}

/** Two lists carrying the same entries in the same order. */
function sameStringList(left: string[] | undefined, right: string[] | undefined): boolean {
	if (left === right) return true;
	if (!left || !right) return false;
	return left.length === right.length && left.every((id, index) => id === right[index]);
}

/**
 * Refuses edges that would make the graph unable to answer what may start next.
 *
 * The check runs over the goals as the mutation would leave them, under the same
 * lock that writes them, so a cycle cannot be closed by two writers who each saw
 * only their own half of it. Walking from the changed goals is enough: every
 * other goal's edges were already acyclic, so only the new ones can close a loop.
 */
function assertAcyclic(
	goals: readonly ProjectGoal[],
	goalIds: readonly string[],
	retiredIds: readonly string[],
): void {
	const cycle = findDependencyCycleFromRoots(goals, goalIds, retiredIds);
	if (cycle) throw new ProjectGoalDependencyCycleError(cycle);
}

/**
 * The completion stamp a lifecycle transition leaves behind.
 *
 * Completing stamps the very instant the transition carries, so the two can
 * never disagree. Reopening clears it, because a goal that is open again was not
 * completed. Archiving keeps whatever is there: filing a finished goal away does
 * not unfinish it, and archiving an unfinished one completed nothing.
 */
function nextCompletedAt(
	current: ProjectGoal,
	status: ProjectGoalStatus,
	updatedAt: string,
): string | undefined {
	if (status === "done") return updatedAt;
	if (status === "open") return undefined;
	return current.completedAt;
}

/**
 * The description a goal ends up with, resolved under the lock against whatever
 * is stored right now.
 *
 * Appending reads the current description here rather than in the caller, so an
 * additive note composes with a concurrent edit instead of replaying a baseline
 * the caller captured earlier. Appended text becomes its own paragraph, which
 * keeps a note distinct from the sentence it follows in every Markdown reader.
 */
function resolveDescription(current: string | undefined, updates: ProjectGoalUpdate): string | undefined {
	if (updates.appendDescription === undefined) return updates.description ?? current;
	const existing = current?.trimEnd();
	return existing ? `${existing}\n\n${updates.appendDescription}` : updates.appendDescription;
}

function mutationOutcome(result: {
	data: Omit<ProjectMutationOutcome, "revision" | "changed">;
	revision?: number;
	error?: string;
	changed?: false;
}): ProjectMutationOutcome {
	if (result.error) throw new Error(result.error);
	if (result.revision === undefined) throw new Error("Project mutation did not return a revision");
	return { ...result.data, revision: String(result.revision), changed: result.changed !== false };
}

/** Fields a new goal may carry beyond its title. */
export interface ProjectGoalDraft {
	description?: string;
	group?: string;
	links?: string[];
	/** Existing goal IDs only; the new goal's ID has not been minted when these resolve. */
	dependsOn?: string[];
}

export interface ProjectPlanOutcome {
	addedGoals: ProjectGoal[];
	goals: ProjectGoal[];
	warnings: ProjectPlanWarning[];
	revision: string;
	changed: boolean;
}

interface NormalizedProjectPlanEntry extends ProjectGoalPlanEntry {
	preCollisionSlug: string;
}

const PROJECT_PLAN_FIELDS = new Set(["title", "description", "group", "dependsOn"]);

/** Validate the plain JSON plan contract and pin every batch reference key. */
function normalizeProjectPlan(plan: readonly ProjectGoalPlanEntry[]): NormalizedProjectPlanEntry[] {
	if (!Array.isArray(plan)) {
		throw new ProjectGoalPlanValidationError("Project plan must be a JSON array of goals.", {
			fields: ["plan"],
			resolution: "provide-json-goal-array",
		});
	}
	const entries: NormalizedProjectPlanEntry[] = [];
	const indicesBySlug = new Map<string, number>();
	for (const [index, raw] of plan.entries()) {
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
			throw new ProjectGoalPlanValidationError(`Project plan entry ${index} must be an object.`, {
				fields: [`plan/${index}`],
				resolution: "provide-goal-object",
			});
		}
		const unknownFields = Object.keys(raw).filter((field) => !PROJECT_PLAN_FIELDS.has(field));
		if (unknownFields.length > 0) {
			throw new ProjectGoalPlanValidationError(
				`Project plan entry ${index} contains unsupported field(s): ${unknownFields.join(", ")}.`,
				{
					fields: unknownFields.map((field) => `plan/${index}/${field}`),
					resolution: "use-title-description-group-and-dependsOn-only",
				},
			);
		}
		if (typeof raw.title !== "string" || raw.title.trim() === "") {
			throw new ProjectGoalPlanValidationError(`Project plan entry ${index} requires a non-empty title.`, {
				fields: [`plan/${index}/title`],
				resolution: "provide-non-empty-title",
			});
		}
		if (raw.description !== undefined && typeof raw.description !== "string") {
			throw new ProjectGoalPlanValidationError(`Project plan entry ${index} description must be a string.`, {
				fields: [`plan/${index}/description`],
				resolution: "provide-string-description",
			});
		}
		if (raw.group !== undefined && typeof raw.group !== "string") {
			throw new ProjectGoalPlanValidationError(`Project plan entry ${index} group must be a string.`, {
				fields: [`plan/${index}/group`],
				resolution: "provide-string-group",
			});
		}
		if (
			raw.dependsOn !== undefined &&
			(!Array.isArray(raw.dependsOn) ||
				raw.dependsOn.some((reference: unknown) => typeof reference !== "string"))
		) {
			throw new ProjectGoalPlanValidationError(
				`Project plan entry ${index} dependsOn must be an array of strings.`,
				{
					fields: [`plan/${index}/dependsOn`],
					resolution: "provide-string-reference-array",
				},
			);
		}
		const dependsOn = raw.dependsOn as string[] | undefined;
		if (dependsOn?.some((reference) => reference.trim() === "")) {
			throw new ProjectGoalPlanValidationError(
				`Project plan entry ${index} dependsOn entries must not be blank.`,
				{
					fields: [`plan/${index}/dependsOn`],
					resolution: "provide-non-blank-goal-references",
				},
			);
		}
		if (dependsOn?.some((reference) => reference !== reference.trim())) {
			throw new ProjectGoalPlanValidationError(
				`Project plan entry ${index} dependsOn entries must match exact IDs without surrounding whitespace.`,
				{
					fields: [`plan/${index}/dependsOn`],
					resolution: "remove-surrounding-reference-whitespace",
				},
			);
		}
		const title = raw.title.trim();
		const preCollisionSlug = slugifyGoalTitle(title);
		const previousIndex = indicesBySlug.get(preCollisionSlug);
		if (previousIndex !== undefined) {
			throw new ProjectGoalPlanValidationError(
				`Project plan entries ${previousIndex} and ${index} share pre-collision slug ${preCollisionSlug}.`,
				{
					fields: [`plan/${previousIndex}/title`, `plan/${index}/title`],
					preCollisionSlug,
					resolution: "rename-one-batch-goal",
				},
			);
		}
		indicesBySlug.set(preCollisionSlug, index);
		entries.push({
			title,
			...(raw.description !== undefined ? { description: raw.description } : {}),
			...(raw.group !== undefined ? { group: raw.group } : {}),
			...(dependsOn !== undefined ? { dependsOn } : {}),
			preCollisionSlug,
		});
	}
	return entries;
}

/**
 * Adds an open goal whose ID is derived from its title.
 *
 * The ID is minted inside the mutation, against the goals the lock guarantees
 * are current, because a slug is only unique relative to what already exists:
 * choosing it beforehand would let two concurrent adds of the same title agree
 * on the same ID and leave the second one unreachable.
 *
 * The goal is appended rather than sorted in, because the array order is the
 * roadmap's canonical order and a new goal belongs at its end until someone
 * moves it.
 */
export async function addProjectGoal(
	path: string,
	title: string,
	draft: ProjectGoalDraft = {},
	options?: ProjectMutationOptions,
): Promise<ProjectMutationOutcome> {
	const now = new Date().toISOString();
	const group = resolveGroup(undefined, draft.group);
	const links = resolveLinks(undefined, draft.links);
	const result = await mutateProjectWorklist(
		path,
		(worklist) => {
			// The edges resolve against the goals under the lock, so an edge to a goal
			// another writer deleted in the meantime is refused rather than stored.
			const dependsOn = resolveDependsOn(worklist, undefined, draft.dependsOn);
			const goal: ProjectGoal = {
				id: generateGoalId(title, takenGoalIds(worklist)),
				title,
				description: draft.description,
				...(group !== undefined ? { group } : {}),
				...(links !== undefined ? { links } : {}),
				...(dependsOn !== undefined ? { dependsOn } : {}),
				status: "open",
				createdAt: now,
				updatedAt: now,
			};
			const goals = [...worklist.goals, goal];
			// A freshly minted ID cannot be its own dependency, so the only cycle a new
			// goal can reach is one a hand edit already left in the file.
			assertAcyclic(goals, [goal.id], worklist.retiredIds ?? []);
			return { worklist: { ...worklist, goals }, result: { goal, goals } };
		},
		options,
	);
	return mutationOutcome(result);
}

/**
 * Add every goal in one JSON plan through one locked mutation and revision bump.
 *
 * Batch references resolve by pre-collision slug before existing selectors. That
 * rule is intentional: when `add-focus-mode` already exists, a new batch goal
 * with that slug is minted as `add-focus-mode-2`, but another batch entry naming
 * `add-focus-mode` still points at the new goal. A preview reports that shadow
 * instead of silently wiring the edge to the existing goal.
 */
export async function applyProjectPlan(
	path: string,
	plan: readonly ProjectGoalPlanEntry[],
	options: ProjectMutationOptions & { dryRun?: boolean } = {},
): Promise<ProjectPlanOutcome> {
	if (options.dryRun !== undefined && typeof options.dryRun !== "boolean") {
		throw new ProjectGoalPlanValidationError("Project plan dryRun must be a boolean.", {
			fields: ["dryRun"],
			resolution: "provide-boolean-dry-run",
		});
	}
	const now = new Date().toISOString();
	const result = await mutateProjectWorklist(
		path,
		(worklist) => {
			const entries = normalizeProjectPlan(plan);
			const taken = takenGoalIds(worklist);
			const staged = entries.map((entry) => {
				const id = generateGoalId(entry.title, taken);
				taken.add(id);
				return { entry, id };
			});
			const batchBySlug = new Map(staged.map((item) => [item.entry.preCollisionSlug, item]));
			const warnings: ProjectPlanWarning[] = [];
			const warnedReferences = new Set<string>();

			const resolveReference = (reference: string): string => {
				const batch = batchBySlug.get(reference);
				if (batch) {
					const existing = findGoalByStoredId(worklist.goals, reference, worklist.retiredIds ?? []);
					if (existing && !warnedReferences.has(reference)) {
						warnings.push({
							code: "BATCH_REFERENCE_SHADOWS_EXISTING",
							reference,
							existingGoalId: existing.id,
							batchGoalId: batch.id,
						});
						warnedReferences.add(reference);
					}
					return batch.id;
				}

				const existing = findGoalByStoredId(worklist.goals, reference, worklist.retiredIds ?? []);
				if (existing) return existing.id;
				throw new ProjectGoalPlanValidationError(
					`Project plan dependency ${reference} was not found in the batch or existing goals.`,
					{
						fields: ["dependsOn"],
						reference,
						resolution: "add-batch-goal-or-use-existing-goal-id",
					},
				);
			};

			const addedGoals = staged.map(({ entry, id }) => {
				const canonicalDependencies = (entry.dependsOn ?? []).map(resolveReference);
				const dependsOn = [...new Set(canonicalDependencies)];
				const group = resolveGroup(undefined, entry.group);
				return {
					id,
					title: entry.title,
					...(entry.description !== undefined ? { description: entry.description } : {}),
					...(group !== undefined ? { group } : {}),
					...(dependsOn.length > 0 ? { dependsOn } : {}),
					status: "open" as const,
					createdAt: now,
					updatedAt: now,
				};
			});
			const goals = [...worklist.goals, ...addedGoals];
			assertAcyclic(
				goals,
				addedGoals.map((goal) => goal.id),
				worklist.retiredIds ?? [],
			);
			const changed = !options.dryRun && addedGoals.length > 0;
			return {
				worklist: changed ? { ...worklist, goals } : worklist,
				result: { addedGoals, goals, warnings },
				changed,
			};
		},
		options,
	);
	if (result.error) throw new Error(result.error);
	if (result.revision === undefined) throw new Error("Project plan mutation did not return a revision");
	return {
		...result.data,
		revision: String(result.revision),
		changed: result.changed !== false,
	};
}

export async function updateProjectGoal(
	path: string,
	id: string,
	updates: ProjectGoalUpdate,
	options?: ProjectMutationOptions,
): Promise<ProjectMutationOutcome> {
	const result = await mutateProjectWorklist(
		path,
		(worklist) => {
			const target = findGoalByStoredId(worklist.goals, id, worklist.retiredIds ?? []);
			const index = target ? worklist.goals.indexOf(target) : -1;
			if (index === -1) return { worklist, result: null, changed: false };
			const current = worklist.goals[index];
			const title = updates.title ?? current.title;
			const description = resolveDescription(current.description, updates);
			const group = resolveGroup(current.group, updates.group);
			const links = resolveLinks(current.links, updates.links);
			const dependsOn = resolveDependsOn(worklist, current.dependsOn, updates.dependsOn);
			if (
				title === current.title &&
				description === current.description &&
				group === current.group &&
				sameStringList(links, current.links) &&
				sameStringList(dependsOn, current.dependsOn)
			) {
				return {
					worklist,
					result: { goal: current, goals: worklist.goals },
					changed: false,
				};
			}
			const updated = withOptionalFields(
				{
					...current,
					title,
					...(description !== undefined ? { description } : {}),
					updatedAt: nextGoalUpdatedAt(current.updatedAt),
				},
				{ group, dependsOn, links },
			);
			const goals = [...worklist.goals];
			goals[index] = updated;
			assertAcyclic(goals, [updated.id], worklist.retiredIds ?? []);
			return { worklist: { ...worklist, goals }, result: { goal: updated, goals } };
		},
		options,
	);
	if (result.error) throw new Error(result.error);
	if (!result.data) throw new ProjectGoalNotFoundError(id);
	return mutationOutcome({ ...result, data: result.data });
}

export interface ProjectActivationOutcome extends ProjectMutationOutcome {
	/** Every goal whose status or timestamp changed, including demoted previously active goals. */
	changedGoalIds: string[];
}

export async function activateProjectGoal(
	path: string,
	id: string,
	options?: ProjectMutationOptions,
): Promise<ProjectActivationOutcome> {
	type ActivationResult = {
		outcome: (Omit<ProjectMutationOutcome, "revision" | "changed"> & { changedGoalIds: string[] }) | null;
		blocked: boolean;
	};
	const result = await mutateProjectWorklist(
		path,
		(
			worklist,
		): {
			worklist: typeof worklist;
			result: ActivationResult;
			changed?: boolean;
		} => {
			const target = findGoalByStoredId(worklist.goals, id, worklist.retiredIds ?? []);
			if (!target) {
				return { worklist, result: { outcome: null, blocked: false }, changed: false };
			}
			if (target.status === "done" || target.status === "archived") {
				return { worklist, result: { outcome: null, blocked: true }, changed: false };
			}
			const alreadyExclusivelyActive =
				target.status === "active" &&
				!worklist.goals.some((goal) => goal.id !== target.id && goal.status === "active");
			if (alreadyExclusivelyActive) {
				return {
					worklist,
					result: {
						outcome: { goal: target, goals: worklist.goals, changedGoalIds: [] },
						blocked: false,
					},
					changed: false,
				};
			}
			const changedGoalIds: string[] = [];
			const goals = worklist.goals.map((goal) => {
				if (goal.id === target.id) {
					changedGoalIds.push(goal.id);
					return {
						...goal,
						status: "active" as ProjectGoalStatus,
						updatedAt: nextGoalUpdatedAt(goal.updatedAt),
					};
				}
				if (goal.status === "active") {
					changedGoalIds.push(goal.id);
					return {
						...goal,
						status: "open" as ProjectGoalStatus,
						updatedAt: nextGoalUpdatedAt(goal.updatedAt),
					};
				}
				return goal;
			});
			const activated = goals.find((goal) => goal.id === target.id);
			return {
				worklist: { ...worklist, goals },
				result: {
					outcome: activated ? { goal: activated, goals, changedGoalIds } : null,
					blocked: false,
				},
			};
		},
		options,
	);
	if (result.error) throw new Error(result.error);
	if (result.data.blocked) throw new ProjectGoalActivationBlockedError(id);
	if (!result.data.outcome) throw new ProjectGoalNotFoundError(id);
	const { changedGoalIds, ...outcome } = result.data.outcome;
	return { ...mutationOutcome({ ...result, data: outcome }), changedGoalIds };
}

export async function setProjectGoalBranch(
	path: string,
	id: string,
	branch: string | undefined,
	options?: ProjectMutationOptions,
): Promise<ProjectMutationOutcome> {
	const result = await mutateProjectWorklist(
		path,
		(worklist) => {
			const target = findGoalByStoredId(worklist.goals, id, worklist.retiredIds ?? []);
			const index = target ? worklist.goals.indexOf(target) : -1;
			if (index === -1) return { worklist, result: null, changed: false };
			const current = worklist.goals[index];
			if (branch !== undefined && (current.status === "done" || current.status === "archived")) {
				throw new ProjectGoalActivationBlockedError(id);
			}
			if (current.branch === branch) {
				return { worklist, result: { goal: current, goals: worklist.goals }, changed: false };
			}
			const updated = withOptionalFields(
				{ ...current, updatedAt: nextGoalUpdatedAt(current.updatedAt) },
				{ branch },
			);
			const goals = [...worklist.goals];
			goals[index] = updated;
			return { worklist: { ...worklist, goals }, result: { goal: updated, goals } };
		},
		options,
	);
	if (result.error) throw new Error(result.error);
	if (!result.data) throw new ProjectGoalNotFoundError(id);
	return mutationOutcome({ ...result, data: result.data });
}

export async function transitionProjectGoal(
	path: string,
	id: string,
	status: ProjectGoalStatus,
	options?: ProjectMutationOptions,
): Promise<ProjectMutationOutcome> {
	const result = await mutateProjectWorklist(
		path,
		(worklist) => {
			const target = findGoalByStoredId(worklist.goals, id, worklist.retiredIds ?? []);
			const index = target ? worklist.goals.indexOf(target) : -1;
			if (index === -1) return { worklist, result: null, changed: false };
			const current = worklist.goals[index];
			if (current.status === status && !(status === "done" && current.branch !== undefined)) {
				return {
					worklist,
					result: { goal: current, goals: worklist.goals },
					changed: false,
				};
			}
			const updatedAt = nextGoalUpdatedAt(current.updatedAt);
			const updated = withOptionalFields(
				{ ...current, status, updatedAt },
				{
					completedAt: nextCompletedAt(current, status, updatedAt),
					...(status === "done" ? { branch: undefined } : {}),
				},
			);
			const goals = [...worklist.goals];
			goals[index] = updated;
			return { worklist: { ...worklist, goals }, result: { goal: updated, goals } };
		},
		options,
	);
	if (result.error) throw new Error(result.error);
	if (!result.data) throw new ProjectGoalNotFoundError(id);
	return mutationOutcome({ ...result, data: result.data });
}

/**
 * The goals in their new order, the anchor a placement could not find, or
 * neither when the move would leave the order exactly as it is.
 *
 * A direction step is resolved here, under the lock, against the goals as they
 * actually are, so a one-step move can never land beside a neighbor that
 * another writer moved between the caller's read and this mutation.
 */
function reorderGoals(
	goals: readonly ProjectGoal[],
	sourceIndex: number,
	placement: ProjectGoalPlacement,
	retiredIds: readonly string[] = [],
): { goals?: ProjectGoal[]; missingAnchorId?: string } {
	const goal = goals[sourceIndex];
	const remaining = [...goals.slice(0, sourceIndex), ...goals.slice(sourceIndex + 1)];
	let insertionIndex: number;
	if (placement.direction !== undefined) {
		insertionIndex = sourceIndex + (placement.direction === "up" ? -1 : 1);
		if (insertionIndex < 0 || insertionIndex > remaining.length) return {};
	} else {
		const anchorId = placement.beforeId ?? placement.afterId;
		const anchor = findGoalByStoredId(goals, anchorId, retiredIds);
		if (anchor?.id === goal.id) return {};
		const anchorIndex = anchor ? remaining.findIndex((candidate) => candidate.id === anchor.id) : -1;
		if (anchorIndex === -1) return { missingAnchorId: anchorId };
		insertionIndex = placement.beforeId !== undefined ? anchorIndex : anchorIndex + 1;
	}
	const next = [...remaining.slice(0, insertionIndex), goal, ...remaining.slice(insertionIndex)];
	if (next.every((candidate, index) => candidate.id === goals[index].id)) return {};
	return { goals: next };
}

/**
 * Moves one goal within canonical file order.
 *
 * Order belongs to the worklist rather than to any goal, so a move bumps the
 * worklist revision and leaves every goal's `updatedAt` untouched: rearranging
 * the roadmap is not editing the goals on it, and stamping them would both reset
 * staleness badges and invalidate baselines no one's edit actually conflicts
 * with.
 */
export async function moveProjectGoal(
	path: string,
	id: string,
	placement: ProjectGoalPlacement,
	options?: ProjectMutationOptions,
): Promise<ProjectMutationOutcome> {
	type MoveResult = {
		outcome: Omit<ProjectMutationOutcome, "revision" | "changed"> | null;
		missingAnchorId?: string;
	};
	const result = await mutateProjectWorklist(
		path,
		(worklist): { worklist: typeof worklist; result: MoveResult; changed?: boolean } => {
			const retiredIds = worklist.retiredIds ?? [];
			const source = findGoalByStoredId(worklist.goals, id, retiredIds);
			const sourceIndex = source ? worklist.goals.indexOf(source) : -1;
			if (sourceIndex === -1) return { worklist, result: { outcome: null }, changed: false };
			const goal = worklist.goals[sourceIndex];
			const reordered = reorderGoals(worklist.goals, sourceIndex, placement, retiredIds);
			if (reordered.missingAnchorId !== undefined) {
				return {
					worklist,
					result: { outcome: null, missingAnchorId: reordered.missingAnchorId },
					changed: false,
				};
			}
			if (!reordered.goals) {
				return {
					worklist,
					result: { outcome: { goal, goals: worklist.goals } },
					changed: false,
				};
			}
			const goals = reordered.goals;
			return { worklist: { ...worklist, goals }, result: { outcome: { goal, goals } } };
		},
		options,
	);
	if (result.error) throw new Error(result.error);
	if (result.data.missingAnchorId !== undefined) {
		throw new ProjectGoalAnchorNotFoundError(result.data.missingAnchorId);
	}
	if (!result.data.outcome) throw new ProjectGoalNotFoundError(id);
	return mutationOutcome({ ...result, data: result.data.outcome });
}

/**
 * The goals with every edge naming `removed` dropped, and which ones changed.
 *
 * Stripping happens inside the same mutation as the deletion, so the file is
 * never briefly readable with an edge pointing at nothing: a dangling edge is
 * read as an unsatisfied dependency, which would block its dependents on work
 * nobody can ever finish. The goals that lose an edge are stamped, because the
 * edge is stored on them and losing it genuinely changes what they say.
 */
function stripDependenciesOn(
	goals: readonly ProjectGoal[],
	removed: ProjectGoal,
): { goals: ProjectGoal[]; strippedGoalIds: string[] } {
	const retired = new Set([removed.id, ...(removed.previousIds ?? [])]);
	const strippedGoalIds: string[] = [];
	const next = goals.map((goal) => {
		if (!goal.dependsOn?.some((dependencyId) => retired.has(dependencyId))) return goal;
		const dependsOn = goal.dependsOn.filter((dependencyId) => !retired.has(dependencyId));
		strippedGoalIds.push(goal.id);
		return withOptionalFields(
			{ ...goal, updatedAt: nextGoalUpdatedAt(goal.updatedAt) },
			{ dependsOn: dependsOn.length > 0 ? dependsOn : undefined },
		);
	});
	return { goals: next, strippedGoalIds };
}

export interface ProjectDeletionOutcome {
	goalId: string;
	goals: ProjectGoal[];
	/** Goals that lost an edge to the deleted goal, so callers can report them too. */
	strippedGoalIds: string[];
	revision: string;
	changed: boolean;
}

export async function deleteProjectGoal(
	path: string,
	id: string,
	options?: ProjectMutationOptions,
): Promise<ProjectDeletionOutcome> {
	const result = await mutateProjectWorklist(
		path,
		(worklist) => {
			const removed = findGoalByStoredId(worklist.goals, id, worklist.retiredIds ?? []);
			if (!removed) return { worklist, result: null, changed: false };
			const remaining = worklist.goals.filter((goal) => goal.id !== removed.id);
			const { goals, strippedGoalIds } = stripDependenciesOn(remaining, removed);
			const retiredIds = [
				...new Set([...(worklist.retiredIds ?? []), removed.id, ...(removed.previousIds ?? [])]),
			];
			return {
				worklist: { ...worklist, goals, retiredIds },
				result: { goalId: removed.id, goals, strippedGoalIds },
			};
		},
		options,
	);
	if (result.error) throw new Error(result.error);
	if (!result.data) throw new ProjectGoalNotFoundError(id);
	if (result.revision === undefined) throw new Error("Project mutation did not return a revision");
	return { ...result.data, revision: String(result.revision), changed: true };
}

export interface GoalIdMigrationOutcome {
	goals: ProjectGoal[];
	migrations: GoalIdMigration[];
	changedGoalIds: string[];
	revision: string;
	changed: boolean;
}

/**
 * Rewrites randomly generated goal IDs into title-derived ones.
 *
 * Each rewritten goal keeps its old ID as a former ID, so the references a
 * migration cannot reach, a Session Task's `goalId`, a PR description, an
 * evidence file, all keep resolving to the same goal afterwards. That is what
 * makes migrating a done or archived goal safe rather than a decision to weigh:
 * no historical reference is invalidated by giving a goal a readable name.
 *
 * Any field that stores a goal ID inside the worklist itself, such as dependency
 * edges, is rewritten here as well: former IDs keep an outside reference
 * working, but leaving a stored edge on an old name would let the file disagree
 * with itself. A goal whose only change is a rewritten edge is stamped too,
 * because that edge is stored on it.
 */
export async function migrateProjectGoalIds(
	path: string,
	options?: ProjectMutationOptions,
): Promise<GoalIdMigrationOutcome> {
	const result = await mutateProjectWorklist(
		path,
		(worklist) => {
			const migrations = planGoalIdMigration(worklist);
			if (migrations.length === 0) {
				return {
					worklist,
					result: { goals: worklist.goals, migrations, changedGoalIds: [] },
					changed: false,
				};
			}
			const byPreviousId = new Map(migrations.map((migration) => [migration.from, migration]));
			const changedGoalIds: string[] = [];
			const goals = worklist.goals.map((goal) => {
				const migration = byPreviousId.get(goal.id);
				const dependsOn = goal.dependsOn?.map((id) => byPreviousId.get(id)?.to ?? id);
				const edgesRewritten = !sameStringList(dependsOn, goal.dependsOn);
				if (!migration && !edgesRewritten) return goal;
				const migratedGoal: ProjectGoal = {
					...goal,
					...(migration
						? {
								id: migration.to,
								previousIds: [...new Set([...(goal.previousIds ?? []), migration.from])],
							}
						: {}),
					...(dependsOn !== undefined ? { dependsOn } : {}),
					updatedAt: nextGoalUpdatedAt(goal.updatedAt),
				};
				changedGoalIds.push(migratedGoal.id);
				return migratedGoal;
			});
			return { worklist: { ...worklist, goals }, result: { goals, migrations, changedGoalIds } };
		},
		options,
	);
	if (result.error) throw new Error(result.error);
	if (result.revision === undefined) throw new Error("Project mutation did not return a revision");
	return { ...result.data, revision: String(result.revision), changed: result.changed !== false };
}

export interface ProjectWorklistPathMigration extends ProjectWorklistMove {
	revision: string;
}

/**
 * Moves the goal file to another path, leaving every goal on it untouched.
 *
 * A location change rather than a schema or content change: the bytes are
 * carried across verbatim, the revision does not move, and the worklist version
 * is the same on both sides. Validation still happens first, so a corrupt file
 * stays where its owner last saw it instead of being relocated out from under
 * the editor they have it open in.
 */
export async function migrateProjectWorklistPath(
	fromPath: string,
	toPath: string,
): Promise<ProjectWorklistPathMigration> {
	const result = await moveProjectWorklist(fromPath, toPath);
	if (result.error) throw new Error(result.error);
	if (result.revision === undefined) throw new Error("Project worklist move did not return a revision");
	return { ...result.data, revision: String(result.revision) };
}
