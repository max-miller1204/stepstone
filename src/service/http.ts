import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { ServiceConfig } from "./auth.ts";
import { createAuthenticator } from "./auth.ts";
import { checkSchema } from "./database.ts";
import { ServiceError } from "./protocol.ts";
import type { AuthoritativeService } from "./service.ts";

function json(response: ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, {
		"content-type": "application/json",
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
	});
	response.end(JSON.stringify(body));
}
async function body(request: IncomingMessage): Promise<unknown> {
	if (request.headers["content-type"]?.split(";")[0] !== "application/json")
		throw new ServiceError("INVALID_CONTENT_TYPE", "Use application/json.", 415);
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		size += chunk.length;
		if (size > 128000) throw new ServiceError("PAYLOAD_TOO_LARGE", "Command exceeds 128000 bytes.", 413);
		chunks.push(Buffer.from(chunk));
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new ServiceError("INVALID_JSON", "Request body is not valid JSON.");
	}
}
export async function writeEventChunk(response: ServerResponse, value: string): Promise<void> {
	if (response.destroyed) throw new Error("Subscription closed.");
	if (response.write(value)) return;
	await new Promise<void>((resolve, reject) => {
		const done = (error?: Error) => {
			clearTimeout(timer);
			response.off("drain", drained);
			response.off("close", closed);
			response.off("error", failed);
			error ? reject(error) : resolve();
		};
		const drained = () => done();
		const closed = () => done(new Error("Subscription closed."));
		const failed = (error: Error) => done(error);
		const timer = setTimeout(() => done(new Error("Subscription exceeded the backpressure timeout.")), 5000);
		response.once("drain", drained);
		response.once("close", closed);
		response.once("error", failed);
	});
}
export async function startService(service: AuthoritativeService, config: ServiceConfig) {
	await checkSchema(service.pool);
	const authenticate = createAuthenticator(config.oidc);
	const server = createServer(async (request, response) => {
		try {
			const url = new URL(request.url ?? "/", config.publicOrigin);
			if (request.method === "GET" && url.pathname === "/health/live") {
				json(response, 200, { ok: true });
				return;
			}
			if (request.method === "GET" && url.pathname === "/health/ready") {
				await checkSchema(service.pool);
				json(response, 200, { ok: true });
				return;
			}
			if (request.headers.origin && request.headers.origin !== config.publicOrigin)
				throw new ServiceError("FORBIDDEN", "Request origin is not allowed.", 403);
			const match = /^Bearer ([^\s]+)$/.exec(request.headers.authorization ?? "");
			if (!match) throw new ServiceError("UNAUTHORIZED", "A bearer credential is required.", 401);
			const token = match[1];
			const principal = await authenticate(token);
			if (request.method === "GET" && url.pathname === "/v1/whoami") {
				if (principal.credential)
					throw new ServiceError("FORBIDDEN", "Service credentials require a project route.", 403);
				json(response, 200, { actorId: principal.actorId, administrator: principal.administrator });
				return;
			}
			if (request.method === "POST" && url.pathname === "/v1/commands") {
				json(response, 200, await service.execute(principal, await body(request)));
				return;
			}
			const route = /^\/v1\/projects\/([^/]+)\/(snapshot|events|access)$/.exec(url.pathname);
			if (request.method !== "GET" || !route || !z.uuid().safeParse(route[1]).success)
				throw new ServiceError("NOT_FOUND", "Route was not found.", 404);
			const [, projectId, action] = route;
			if (action === "snapshot") {
				json(response, 200, await service.snapshot(principal, projectId));
				return;
			}
			if (action === "access") {
				json(response, 200, await service.access(principal, projectId));
				return;
			}
			const rawCursor = request.headers["last-event-id"] ?? url.searchParams.get("after");
			if (typeof rawCursor !== "string" || !/^(0|[1-9][0-9]*)$/.test(rawCursor))
				throw new ServiceError(
					"SNAPSHOT_REQUIRED",
					"Supply a snapshot cursor through after or Last-Event-ID.",
					409,
				);
			let cursor = Number(rawCursor);
			let events = await service.events(principal, projectId, cursor);
			response.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-store",
				"x-accel-buffering": "no",
			});
			response.flushHeaders();
			const abort = new AbortController();
			response.once("close", () => abort.abort());
			try {
				while (!response.destroyed) {
					for (const event of events) {
						await writeEventChunk(
							response,
							`id: ${event.cursor}\nevent: change\ndata: ${JSON.stringify(event)}\n\n`,
						);
						cursor = event.cursor;
					}
					if (events.length < 100) {
						await writeEventChunk(response, ": heartbeat\n\n");
						await delay(1000, undefined, { signal: abort.signal });
					}
					// Recheck identity expiry, membership, and credential revocation on every batch.
					events = await service.events(await authenticate(token), projectId, cursor);
				}
			} finally {
				abort.abort();
			}
		} catch (error) {
			const known = error instanceof ServiceError;
			if (!known && !response.destroyed)
				console.error("Stepstone request failed:", error instanceof Error ? error.message : "Unknown error");
			const failure = {
				error: {
					code: known ? error.code : "SERVICE_FAILED",
					message: known ? error.message : "The service could not complete the request.",
				},
			};
			if (response.headersSent) {
				if (!response.destroyed) response.end(`event: error\ndata: ${JSON.stringify(failure)}\n\n`);
			} else json(response, known ? error.status : 503, failure);
		}
	});
	server.requestTimeout = 15000;
	server.headersTimeout = 10000;
	server.maxRequestsPerSocket = 1000;
	server.maxConnections = 500;
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(config.port, config.host, () => {
			server.off("error", reject);
			resolve();
		});
	});
	return server;
}
