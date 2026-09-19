import { createHash } from "node:crypto";
import { z } from "zod";

export class ServiceError extends Error {
	readonly code: string;
	readonly status: number;
	constructor(code: string, message: string, status = 400) {
		super(message);
		this.code = code;
		this.status = status;
	}
}
export const roleSchema = z.enum(["reader", "editor", "owner"]);
export type Role = z.infer<typeof roleSchema>;
export const scopeSchema = z.enum(["read", "subscribe", "write", "delete"]);
export type Scope = z.infer<typeof scopeSchema>;
const text = z.string().max(32000);
const title = z.string().trim().min(1).max(500);
const reference = z.string().min(1).max(200);
const lifecycle = { taskId: z.uuid(), confirm: z.literal(true) };
const changes = {
	title: title.optional(),
	description: text.optional(),
	group: reference.or(z.literal("")).optional(),
	dependsOn: z.array(reference).max(1000).optional(),
	links: z.array(z.url()).max(100).optional(),
};
export const actionSchema = z.discriminatedUnion("action", [
	z.object({ action: z.literal("create_project"), title, confirm: z.literal(true) }).strict(),
	z
		.object({
			action: z.literal("configure"),
			title,
			description: text.optional(),
			repositories: z.array(z.url()).max(100).optional(),
			confirm: z.literal(true),
		})
		.strict(),
	z.object({ action: z.literal("add"), ...changes, title }).strict(),
	z
		.object({ action: z.literal("update"), taskId: z.uuid(), ...changes, appendDescription: text.optional() })
		.strict(),
	z.object({ action: z.literal("complete"), ...lifecycle }).strict(),
	z.object({ action: z.literal("reopen"), ...lifecycle }).strict(),
	z.object({ action: z.literal("archive"), ...lifecycle }).strict(),
	z.object({ action: z.literal("delete"), ...lifecycle }).strict(),
	z.object({ action: z.literal("set_active"), taskId: z.uuid() }).strict(),
	z
		.object({
			action: z.literal("start"),
			taskId: z.uuid(),
			branch: reference.optional(),
			clear: z.boolean().optional(),
		})
		.strict(),
	z
		.object({
			action: z.literal("move"),
			taskId: z.uuid(),
			beforeId: reference.optional(),
			afterId: reference.optional(),
			direction: z.enum(["up", "down"]).optional(),
		})
		.strict(),
	z.object({ action: z.literal("migrate_ids"), confirm: z.literal(true) }).strict(),
	z.object({ action: z.literal("add_milestone"), title, description: text.optional() }).strict(),
	z
		.object({
			action: z.literal("update_milestone"),
			id: reference,
			title: title.optional(),
			description: text.optional(),
		})
		.strict(),
	z
		.object({
			action: z.literal("assign_milestone"),
			taskId: z.uuid(),
			milestoneId: reference.or(z.literal("")),
		})
		.strict(),
	z
		.object({
			action: z.literal("apply-plan"),
			plan: z
				.array(
					z
						.object({
							title,
							description: text.optional(),
							group: reference.optional(),
							dependsOn: z.array(reference).optional(),
						})
						.strict(),
				)
				.min(1)
				.max(100),
		})
		.strict(),
	z
		.object({
			action: z.literal("set_member"),
			actorId: z.string().regex(/^oidc:[a-f0-9]{64}$/),
			role: roleSchema.nullable(),
			confirm: z.literal(true),
		})
		.strict(),
	z
		.object({
			action: z.literal("grant_service"),
			credentialId: z.uuid(),
			tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
			role: z.enum(["reader", "editor"]),
			scopes: z.array(scopeSchema).min(1).max(4),
			expiresAt: z.iso.datetime(),
			confirm: z.literal(true),
		})
		.strict(),
	z
		.object({ action: z.literal("revoke_service"), credentialId: z.uuid(), confirm: z.literal(true) })
		.strict(),
]);
export const commandSchema = z
	.object({
		version: z.literal(1),
		commandId: z.uuid(),
		projectId: z.uuid(),
		expectedRevision: z.number().int().nonnegative().safe(),
		operation: actionSchema,
	})
	.strict();
export type Command = z.infer<typeof commandSchema>;
export interface Principal {
	actorId: string;
	expiresAt: number;
	administrator: boolean;
	credential?: { id: string; hash: string };
}
export interface Receipt {
	version: 1;
	projectId: string;
	commandId: string;
	actorId: string;
	revision: number;
	cursor: number;
	action: Command["operation"]["action"];
	taskIds: string[];
}
export function hash(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}
export function oidcActor(issuer: string, subject: string): string {
	return `oidc:${hash(JSON.stringify([issuer, subject]))}`;
}
/** Sort object keys so equivalent JSON objects have the same command fingerprint. */
export function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object")
		return `{${Object.entries(value)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
			.join(",")}}`;
	return JSON.stringify(value);
}
export function parseCommand(input: unknown): Command {
	const result = commandSchema.safeParse(input);
	if (!result.success) throw new ServiceError("VALIDATION_FAILED", result.error.message);
	return result.data;
}
