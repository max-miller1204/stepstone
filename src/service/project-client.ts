import { randomUUID } from "node:crypto";
import { SERVER_ORIGIN_ENV, SERVER_PROJECT_ENV, SERVER_TOKEN_ENV } from "../cli-contract.ts";
import type { RevisionedProjectWorklist } from "../types.ts";
import type { Receipt } from "./protocol.ts";
import { canonical } from "./protocol.ts";

/**
 * HTTP client for one configured authoritative project.
 *
 * The file CLI, loopback web app, and Pi extension use this when the server
 * environment is complete. It never reads or writes a goal file.
 */

export interface ServerProjectConfig {
	origin: string;
	token: string;
	projectId: string;
}

export type ServerProjectResolution =
	| { mode: "file" }
	| { mode: "server"; config: ServerProjectConfig }
	| { mode: "invalid"; message: string };

export interface ProjectSnapshotResponse {
	version: 1;
	projectId: string;
	revision: number;
	cursor: number;
	worklist: RevisionedProjectWorklist;
	tasks: { taskId: string; reference: string }[];
}

export class ServerProjectError extends Error {
	readonly code: string;
	readonly status?: number;

	constructor(code: string, message: string, status?: number, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "ServerProjectError";
		this.code = code;
		this.status = status;
	}
}

const PROJECT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Decide whether Project Goal operations use the goal file or one server project.
 *
 * Absent configuration keeps the file. A partial set is an error so a missing
 * token cannot silently write the file beside a server the operator selected.
 */
export function resolveServerProject(env: NodeJS.ProcessEnv): ServerProjectResolution {
	const origin = env[SERVER_ORIGIN_ENV]?.trim() ?? "";
	const token = env[SERVER_TOKEN_ENV]?.trim() ?? "";
	const projectId = env[SERVER_PROJECT_ENV]?.trim() ?? "";
	if (!origin && !token && !projectId) return { mode: "file" };
	if (!origin || !token || !projectId) {
		return {
			mode: "invalid",
			message:
				`Server project access needs ${SERVER_ORIGIN_ENV}, ${SERVER_TOKEN_ENV}, and ${SERVER_PROJECT_ENV} together. ` +
				"A partial set does not fall back to the goal file.",
		};
	}
	let parsed: URL;
	try {
		parsed = new URL(origin);
	} catch {
		return { mode: "invalid", message: `${SERVER_ORIGIN_ENV} must be an HTTP(S) origin.` };
	}
	if (
		!["http:", "https:"].includes(parsed.protocol) ||
		parsed.username ||
		parsed.password ||
		parsed.search ||
		parsed.hash ||
		(parsed.pathname !== "/" && parsed.pathname !== "")
	) {
		return {
			mode: "invalid",
			message: `${SERVER_ORIGIN_ENV} must be an HTTP(S) origin without credentials or a path.`,
		};
	}
	if (!PROJECT_UUID.test(projectId)) {
		return { mode: "invalid", message: `${SERVER_PROJECT_ENV} must be a project UUID.` };
	}
	return { mode: "server", config: { origin: parsed.origin, token, projectId } };
}

/** Compare task content without the server revision, which advances on every command. */
export function sameProjectDomain(
	before: RevisionedProjectWorklist,
	after: RevisionedProjectWorklist,
): boolean {
	return canonical({ ...before, revision: 0 }) === canonical({ ...after, revision: 0 });
}

function invalidResponse(kind: string, status?: number): ServerProjectError {
	return new ServerProjectError("UNAVAILABLE", `The configured server returned an invalid ${kind}.`, status);
}

function parseError(status: number, payload: unknown): ServerProjectError {
	const error =
		payload && typeof payload === "object" && "error" in payload
			? (payload as { error?: unknown }).error
			: undefined;
	if (
		!error ||
		typeof error !== "object" ||
		typeof (error as { code?: unknown }).code !== "string" ||
		typeof (error as { message?: unknown }).message !== "string"
	) {
		throw invalidResponse("error response", status);
	}
	const body = error as { code: string; message: string };
	return new ServerProjectError(body.code, body.message, status);
}

function parseSnapshot(payload: unknown): ProjectSnapshotResponse {
	if (!payload || typeof payload !== "object") throw invalidResponse("snapshot");
	const snapshot = payload as Partial<ProjectSnapshotResponse>;
	if (
		snapshot.version !== 1 ||
		typeof snapshot.projectId !== "string" ||
		typeof snapshot.revision !== "number" ||
		!snapshot.worklist ||
		typeof snapshot.worklist !== "object" ||
		!Array.isArray(snapshot.worklist.goals) ||
		!Array.isArray(snapshot.tasks)
	) {
		throw invalidResponse("snapshot");
	}
	return snapshot as ProjectSnapshotResponse;
}

function parseReceipt(payload: unknown): Receipt {
	if (!payload || typeof payload !== "object") throw invalidResponse("command receipt");
	const receipt = payload as Partial<Receipt>;
	if (
		receipt.version !== 1 ||
		typeof receipt.revision !== "number" ||
		typeof receipt.projectId !== "string"
	) {
		throw invalidResponse("command receipt");
	}
	return receipt as Receipt;
}

export class ServerProjectClient {
	readonly config: ServerProjectConfig;

	constructor(config: ServerProjectConfig) {
		this.config = config;
	}

	private async request(path: string, init: RequestInit = {}): Promise<unknown> {
		try {
			const response = await fetch(this.config.origin + path, {
				...init,
				headers: {
					authorization: `Bearer ${this.config.token}`,
					...(init.body ? { "content-type": "application/json" } : {}),
				},
				signal: AbortSignal.timeout(15000),
			});
			const text = await response.text();
			let payload: unknown;
			if (text) {
				try {
					payload = JSON.parse(text);
				} catch {
					throw invalidResponse(response.ok ? "response" : "error response", response.status);
				}
			}
			if (!response.ok) throw parseError(response.status, payload);
			return payload;
		} catch (cause) {
			if (cause instanceof ServerProjectError) throw cause;
			throw new ServerProjectError(
				"UNAVAILABLE",
				`Configured Stepstone server is unavailable: ${this.config.origin}`,
				undefined,
				{ cause },
			);
		}
	}

	async snapshot(): Promise<ProjectSnapshotResponse> {
		const payload = await this.request(`/v1/projects/${this.config.projectId}/snapshot`);
		const snapshot = parseSnapshot(payload);
		if (snapshot.projectId !== this.config.projectId) {
			throw new ServerProjectError("UNAVAILABLE", "The configured server returned a different project.");
		}
		return snapshot;
	}

	async command(operation: Record<string, unknown>, expectedRevision: number): Promise<Receipt> {
		const payload = await this.request("/v1/commands", {
			method: "POST",
			body: JSON.stringify({
				version: 1,
				commandId: randomUUID(),
				projectId: this.config.projectId,
				expectedRevision,
				operation,
			}),
		});
		return parseReceipt(payload);
	}
}
