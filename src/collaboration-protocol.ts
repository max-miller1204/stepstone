import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { WorklistApplicationResult } from "./application-service.ts";
import { WorklistApplicationService } from "./application-service.ts";
import {
	ProjectMutationRefusedError,
	readProjectWorklist,
	transactProjectWorklist,
} from "./project-store.ts";
import type { Project, ProjectGoal, RevisionedProjectWorklist } from "./types.ts";

const uuid = z.uuid();
const commandSchema = z
	.object({
		version: z.literal(1),
		commandId: uuid,
		projectId: uuid,
		expectedRevision: z.number().int().nonnegative().safe(),
		action: z.enum(["add", "update", "complete", "reopen", "archive", "delete"]),
		taskId: uuid.optional(),
		title: z.string().trim().min(1).optional(),
		description: z.string().optional(),
		confirm: z.boolean().optional(),
	})
	.strict()
	.superRefine((command, context) => {
		const invalid = (message: string) => context.addIssue({ code: "custom", message });
		if (command.action === "add") {
			if (!command.title || command.taskId) invalid("Add requires a title and no taskId.");
		} else if (!command.taskId) invalid("A taskId is required.");
		if (
			command.action !== "add" &&
			command.action !== "update" &&
			(command.title !== undefined || command.description !== undefined)
		)
			invalid("Lifecycle commands cannot change text.");
		if (command.action === "update" && command.title === undefined && command.description === undefined)
			invalid("Update requires title or description.");
	});
export type CollaborationCommand = z.infer<typeof commandSchema>;
export interface CollaborationActor {
	id: string;
	role: "reader" | "editor" | "owner";
}
export interface CollaborationReceipt {
	version: 1;
	commandId: string;
	projectId: string;
	revision: number;
	cursor: number;
	taskId?: string;
	result: WorklistApplicationResult;
}
export interface CollaborationEvent {
	version: 1;
	projectId: string;
	cursor: number;
	revision: number;
	commandId: string;
	actorId: string;
	action: CollaborationCommand["action"];
	taskId: string;
}
export interface CollaborationSnapshot {
	project: Project;
	version: 1;
	projectId: string;
	revision: number;
	cursor: number;
	tasks: { taskId: string; goal: ProjectGoal }[];
	retiredIds: string[];
}
interface CollaborationMetadata {
	version: 1;
	projectId: string;
	identities: Record<string, string>;
	events: CollaborationEvent[];
	receipts: Record<string, { fingerprint: string; receipt: CollaborationReceipt }>;
}
type CollaborationWorklist = RevisionedProjectWorklist & { collaboration?: CollaborationMetadata };
export class CollaborationError extends ProjectMutationRefusedError {
	readonly code: string;
	readonly status: number;
	constructor(code: string, message: string, status = 400) {
		super(message);
		this.name = "CollaborationError";
		this.code = code;
		this.status = status;
	}
}
function actorValid(actor: CollaborationActor): void {
	if (
		!actor ||
		typeof actor.id !== "string" ||
		!actor.id.trim() ||
		!["reader", "editor", "owner"].includes(actor.role)
	)
		throw new CollaborationError("UNAUTHORIZED", "A configured actor is required.", 401);
}
const receiptSchema = z
	.object({
		version: z.literal(1),
		commandId: uuid,
		projectId: uuid,
		revision: z.number().int().nonnegative().safe(),
		cursor: z.number().int().positive().safe(),
		taskId: uuid,
		result: z.object({ ok: z.literal(true) }).passthrough(),
	})
	.strict();
const metadataSchema = z
	.object({
		version: z.literal(1),
		projectId: uuid,
		identities: z.record(z.string(), uuid),
		events: z.array(
			z
				.object({
					version: z.literal(1),
					projectId: uuid,
					cursor: z.number().int().positive().safe(),
					revision: z.number().int().positive().safe(),
					commandId: uuid,
					actorId: z.string().trim().min(1),
					action: commandSchema.shape.action,
					taskId: uuid,
				})
				.strict(),
		),
		receipts: z.record(uuid, z.object({ fingerprint: z.string().min(1), receipt: receiptSchema }).strict()),
	})
	.strict();
function metadata(worklist: CollaborationWorklist): CollaborationMetadata {
	const data = worklist.collaboration;
	if (!metadataSchema.safeParse(data).success) {
		throw new CollaborationError(
			"INVALID_STORE",
			"The collaboration store is missing or invalid. Initialize it explicitly.",
			500,
		);
	}
	if (!data) throw new CollaborationError("INVALID_STORE", "Collaboration metadata is missing.", 500);
	const ids = Object.values(data.identities);
	if (
		new Set(ids).size !== ids.length ||
		ids.some((id) => !uuid.safeParse(id).success) ||
		worklist.goals.some((goal) => !data.identities[goal.id])
	)
		throw new CollaborationError("INVALID_STORE", "Task identity metadata is invalid.", 500);
	if (data.events.some((event, index) => event.cursor !== index + 1 || event.projectId !== data.projectId))
		throw new CollaborationError("INVALID_STORE", "Event order is invalid.", 500);
	if (
		data.events.some((event) => {
			const stored = data.receipts[event.commandId];
			return (
				!stored ||
				stored.receipt.commandId !== event.commandId ||
				stored.receipt.projectId !== data.projectId ||
				stored.receipt.cursor !== event.cursor ||
				stored.receipt.revision !== event.revision ||
				stored.receipt.taskId !== event.taskId
			);
		}) ||
		Object.keys(data.receipts).length !== data.events.length ||
		(data.events.length > 0 && data.events[data.events.length - 1].revision !== worklist.revision)
	)
		throw new CollaborationError("INVALID_STORE", "Command receipts and event history disagree.", 500);
	return data;
}
function snapshotOf(worklist: CollaborationWorklist): CollaborationSnapshot {
	const data = metadata(worklist);
	if (!worklist.project) throw new CollaborationError("INVALID_STORE", "Project metadata is missing.", 500);
	return {
		project: worklist.project,
		version: 1,
		projectId: data.projectId,
		revision: worklist.revision,
		cursor: data.events.length,
		tasks: worklist.goals.map((goal) => ({ taskId: data.identities[goal.id], goal })),
		retiredIds: worklist.retiredIds ?? [],
	};
}

/** File-backed protocol proof. The resolver names server storage, not repository identity. */
export class CollaborationService {
	private readonly options: { resolvePath: () => string };
	constructor(options: { resolvePath: () => string }) {
		this.options = options;
	}
	async initialize(
		actor: CollaborationActor,
		options: { title: string; confirm: boolean; projectId?: string },
	): Promise<CollaborationSnapshot> {
		actorValid(actor);
		if (actor.role !== "owner")
			throw new CollaborationError("FORBIDDEN", "Initialization requires the owner role.", 403);
		if (options.confirm !== true)
			throw new CollaborationError(
				"APPROVAL_REQUIRED",
				"Initialization requires explicit confirmation.",
				403,
			);
		const projectId = options.projectId ?? randomUUID();
		if (!uuid.safeParse(projectId).success)
			throw new CollaborationError("VALIDATION_FAILED", "projectId must be a UUID.");
		const path = this.options.resolvePath();
		const outcome = await transactProjectWorklist(path, async (state) => {
			const current = state.worklist as CollaborationWorklist;
			if ("collaboration" in current)
				throw new CollaborationError("ALREADY_INITIALIZED", "This store is already initialized.", 409);
			const app = new WorklistApplicationService({ projectPath: path });
			const result = await app.execute(
				{ scope: "project", action: "configure", title: options.title, confirm: true },
				{ source: "cli" },
			);
			if (!result.ok) throw new CollaborationError(result.error.code, result.error.message);
			const worklist = state.worklist as CollaborationWorklist;
			worklist.collaboration = {
				version: 1,
				projectId,
				identities: Object.fromEntries(worklist.goals.map((goal) => [goal.id, randomUUID()])),
				events: [],
				receipts: {},
			};
			// Initialization changes the aggregate once, including when configuration was unchanged.
			worklist.revision = current.revision + 1;
			return { result: snapshotOf(worklist), changed: true };
		});
		if (outcome.error) throw new CollaborationError("PERSISTENCE_FAILED", outcome.error, 500);
		return outcome.data;
	}
	async snapshot(actor: CollaborationActor): Promise<CollaborationSnapshot> {
		actorValid(actor);
		const result = await readProjectWorklist(this.options.resolvePath());
		if (result.error) throw new CollaborationError("PERSISTENCE_FAILED", result.error, 500);
		return snapshotOf(result.data);
	}
	async events(actor: CollaborationActor, after: number): Promise<CollaborationEvent[]> {
		actorValid(actor);
		const result = await readProjectWorklist(this.options.resolvePath());
		if (result.error) throw new CollaborationError("PERSISTENCE_FAILED", result.error, 500);
		const data = metadata(result.data);
		if (!Number.isSafeInteger(after) || after < 0 || after > data.events.length)
			throw new CollaborationError(
				"SNAPSHOT_REQUIRED",
				"The event cursor is invalid. Fetch a new snapshot.",
				409,
			);
		return data.events.slice(after);
	}
	async execute(actor: CollaborationActor, input: unknown): Promise<CollaborationReceipt> {
		actorValid(actor);
		if (actor.role === "reader")
			throw new CollaborationError("FORBIDDEN", "The reader role cannot change tasks.", 403);
		const parsed = commandSchema.safeParse(input);
		if (!parsed.success) throw new CollaborationError("VALIDATION_FAILED", parsed.error.message);
		const command = parsed.data;
		if (command.action === "delete" && actor.role !== "owner")
			throw new CollaborationError("FORBIDDEN", "Delete requires the owner role.", 403);
		const fingerprint = JSON.stringify([actor.id, command]);
		const path = this.options.resolvePath();
		const outcome = await transactProjectWorklist(path, async (state) => {
			const current = state.worklist as CollaborationWorklist;
			const data = metadata(current);
			if (command.projectId !== data.projectId)
				throw new CollaborationError("NOT_FOUND", "Project identity does not match this server.", 404);
			const previous = data.receipts[command.commandId];
			if (previous) {
				if (previous.fingerprint !== fingerprint)
					throw new CollaborationError(
						"IDEMPOTENCY_CONFLICT",
						"The command ID was already used with different content or actor.",
						409,
					);
				return { result: previous.receipt, changed: false };
			}
			if (command.expectedRevision !== current.revision)
				throw new CollaborationError(
					"REVISION_CONFLICT",
					`Expected revision ${command.expectedRevision}; current revision is ${current.revision}.`,
					409,
				);
			const goal =
				command.taskId === undefined
					? undefined
					: current.goals.find((goal) => data.identities[goal.id] === command.taskId);
			if (command.action !== "add" && !goal)
				throw new CollaborationError("NOT_FOUND", "Task identity was not found.", 404);
			const result = await new WorklistApplicationService({ projectPath: path }).execute(
				{
					scope: "project",
					action: command.action,
					...(goal ? { id: goal.id } : {}),
					...(command.title === undefined ? {} : { title: command.title }),
					...(command.description === undefined ? {} : { description: command.description }),
					...(command.confirm === undefined ? {} : { confirm: command.confirm }),
				},
				{ source: "cli" },
			);
			if (!result.ok)
				throw new CollaborationError(
					result.error.code,
					result.error.message,
					result.error.code === "APPROVAL_REQUIRED" ? 403 : 400,
				);
			const worklist = state.worklist as CollaborationWorklist;
			const next = worklist.collaboration;
			if (!next) throw new CollaborationError("INVALID_STORE", "Collaboration metadata was removed.", 500);
			const taskId = goal ? next.identities[goal.id] : randomUUID();
			if (command.action === "add") {
				const added = worklist.goals.find((entry) => !current.goals.some((old) => old.id === entry.id));
				if (!added) throw new CollaborationError("INVALID_STORE", "Add did not create a task.", 500);
				next.identities[added.id] = taskId;
			}
			const revision = current.revision + 1;
			const cursor = next.events.length + 1;
			result.meta.revisions = { ...result.meta.revisions, project: String(revision) };
			const receipt: CollaborationReceipt = {
				version: 1,
				commandId: command.commandId,
				projectId: next.projectId,
				revision,
				cursor,
				taskId,
				result,
			};
			next.events.push({
				version: 1,
				projectId: next.projectId,
				revision,
				cursor,
				commandId: command.commandId,
				actorId: actor.id,
				action: command.action,
				taskId,
			});
			next.receipts[command.commandId] = { fingerprint, receipt };
			return { result: receipt, changed: true };
		});
		if (outcome.error) throw new CollaborationError("PERSISTENCE_FAILED", outcome.error, 500);
		return outcome.data;
	}
}
