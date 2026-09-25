import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { findDependencyCycleFromRoots } from "../dependencies.ts";
import { findGoalByStoredId } from "../goal-selection.ts";
import { isProjectWorklist } from "../project-store.ts";
import type { ProjectGoal, RevisionedProjectWorklist } from "../types.ts";
import { canonical, hash, ServiceError } from "./protocol.ts";

const ACTOR_ID = /^oidc:[a-f0-9]{64}$/;
const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ServerImportArgs {
	file: string;
	projectId: string;
	actorId: string;
	replace: boolean;
	dryRun: boolean;
}

export interface WorklistImportInput {
	projectId: string;
	actorId: string;
	worklist: unknown;
	replace: boolean;
	dryRun: boolean;
}

/** Canonical task content, ignoring command revision and object key order. */
export function worklistFingerprint(worklist: RevisionedProjectWorklist): string {
	const domain = { ...worklist } as Omit<RevisionedProjectWorklist, "revision"> & { revision?: number };
	delete domain.revision;
	return hash(canonical(domain));
}

export function parseImportWorklist(value: unknown): RevisionedProjectWorklist {
	if (!isProjectWorklist(value)) {
		throw new ServiceError("VALIDATION_FAILED", "Worklist is malformed or uses an unsupported schema.");
	}
	const worklist = structuredClone(value) as RevisionedProjectWorklist;
	if (worklist.revision === undefined) worklist.revision = 0;
	assertImportIdentity(worklist);
	return worklist;
}

/**
 * Read a worklist for import.
 *
 * A missing file is an error. The normal worklist reader treats a missing file
 * as an empty roadmap, which would import the wrong project and erase evidence
 * the caller still expects on disk.
 */
export async function loadImportWorklist(path: string): Promise<RevisionedProjectWorklist> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		throw new ServiceError(
			"NOT_FOUND",
			code === "ENOENT" ? `Worklist file ${path} was not found.` : `Cannot read worklist file ${path}.`,
			404,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new ServiceError("VALIDATION_FAILED", `Malformed project file ${path}: invalid JSON`);
	}
	return parseImportWorklist(parsed);
}

export function parseServerImportArgs(args: readonly string[]): ServerImportArgs {
	let file: string | undefined;
	let projectId: string | undefined;
	let actorId: string | undefined;
	let replace = false;
	let confirm = false;
	let dryRun = false;
	for (let index = 0; index < args.length; index++) {
		const part = args[index];
		if (part === "--confirm") confirm = true;
		else if (part === "--replace") replace = true;
		else if (part === "--dry-run") dryRun = true;
		else if (part === "--project" || part === "--actor") {
			const value = args[index + 1];
			if (value === undefined || value.startsWith("--")) {
				throw new Error(`${part} requires a value.`);
			}
			index += 1;
			if (part === "--project") projectId = value;
			else actorId = value;
		} else if (part.startsWith("--") || file !== undefined) {
			throw new Error(`Unknown import argument ${part}.`);
		} else file = part;
	}
	if (file === undefined || projectId === undefined || actorId === undefined) {
		throw new Error("import requires a worklist file, --project <uuid>, and --actor <actorId>.");
	}
	if (confirm === dryRun) throw new Error("import requires exactly one of --confirm or --dry-run.");
	return { file, projectId, actorId, replace, dryRun };
}

export function assertProjectId(projectId: string): void {
	if (!PROJECT_ID.test(projectId)) throw new ServiceError("VALIDATION_FAILED", "Project ID must be a UUID.");
}

export function assertImportRequest(projectId: string, actorId: string): void {
	assertProjectId(projectId);
	if (!ACTOR_ID.test(actorId)) {
		throw new ServiceError(
			"VALIDATION_FAILED",
			"Import actor must be an OIDC actor ID from stepstone-server actor.",
		);
	}
}

/**
 * Keep immutable task IDs for goals the file still names, including former IDs.
 * Identities of goals the file dropped stay in the map so those UUIDs cannot be reused.
 */
export function assignImportedIdentities(
	previousGoals: readonly ProjectGoal[],
	previousRetired: readonly string[],
	previousIdentities: Readonly<Record<string, string>>,
	incoming: RevisionedProjectWorklist,
): Record<string, string> {
	const identities: Record<string, string> = { ...previousIdentities };
	const claimed = new Set<string>();
	for (const goal of incoming.goals) {
		const existing = Object.hasOwn(identities, goal.id) ? identities[goal.id] : undefined;
		const matched = existing ? undefined : matchingGoal(previousGoals, previousRetired, goal);
		const taskId =
			existing ??
			(matched && Object.hasOwn(identities, matched.id) ? identities[matched.id] : undefined) ??
			randomUUID();
		if (claimed.has(taskId)) {
			throw new ServiceError(
				"VALIDATION_FAILED",
				`Imported goals resolve to the same task identity ${taskId}.`,
			);
		}
		claimed.add(taskId);
		identities[goal.id] = taskId;
	}
	return identities;
}

function matchingGoal(
	goals: readonly ProjectGoal[],
	retiredIds: readonly string[],
	goal: ProjectGoal,
): ProjectGoal | undefined {
	const direct = findGoalByStoredId(goals, goal.id, retiredIds);
	if (direct) return direct;
	for (const previous of goal.previousIds ?? []) {
		const match = findGoalByStoredId(goals, previous, retiredIds);
		if (match) return match;
	}
	return undefined;
}

function assertImportIdentity(worklist: RevisionedProjectWorklist): void {
	const seen = new Set<string>();
	const claim = (id: string, label: string) => {
		if (id.trim() === "") throw new ServiceError("VALIDATION_FAILED", `${label} is empty.`);
		if (seen.has(id)) {
			throw new ServiceError("VALIDATION_FAILED", `${label} ${id} collides with another stored goal ID.`);
		}
		seen.add(id);
	};
	for (const id of worklist.retiredIds ?? []) claim(id, "Retired ID");
	for (const goal of worklist.goals) {
		claim(goal.id, "Goal ID");
		for (const previous of goal.previousIds ?? []) claim(previous, "Former ID");
	}
	const cycle = findDependencyCycleFromRoots(
		worklist.goals,
		worklist.goals.map((goal) => goal.id),
		worklist.retiredIds ?? [],
	);
	if (cycle) throw new ServiceError("DEPENDENCY_CYCLE", `Dependency cycle: ${cycle.join(" -> ")}.`);
}
