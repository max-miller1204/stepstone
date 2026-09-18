import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { COLLABORATION_PAGE } from "./collaboration-page.ts";
import type { CollaborationActor } from "./collaboration-protocol.ts";
import { CollaborationService } from "./collaboration-protocol.ts";
import { createWorklistLocator } from "./git.ts";

export interface CollaborationServerOptions {
	store: string;
	host: string;
	port: number;
	credentials: { token: string; actor: CollaborationActor }[];
	publicOrigin?: string;
}

function respond(response: ServerResponse, status: number, value: unknown): void {
	response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
	response.end(JSON.stringify(value));
}

async function body(request: IncomingMessage): Promise<unknown> {
	if (request.headers["content-type"]?.split(";")[0] !== "application/json")
		throw new Error("Content-Type must be application/json.");
	let size = 0;
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		size += chunk.length;
		if (size > 64000) throw new Error("Command exceeds 64000 bytes.");
		chunks.push(Buffer.from(chunk));
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Wait for normal socket backpressure, or fail when the connection closes. */
function waitForDrain(response: ServerResponse): Promise<void> {
	return new Promise((resolve, reject) => {
		const cleanup = () => {
			response.off("drain", drained);
			response.off("close", closed);
			response.off("error", failed);
		};
		const drained = () => {
			cleanup();
			resolve();
		};
		const closed = () => {
			cleanup();
			reject(new Error("Event connection closed during replay."));
		};
		const failed = (error: Error) => {
			cleanup();
			reject(error);
		};
		response.once("drain", drained);
		response.once("close", closed);
		response.once("error", failed);
		if (response.destroyed) closed();
	});
}

/** The same process and command handler serve local and shared deployments. */
export async function startCollaborationServer(options: CollaborationServerOptions) {
	if (
		!options.store ||
		!options.host ||
		!Number.isInteger(options.port) ||
		options.port < 0 ||
		options.port > 65535
	)
		throw new Error("Explicit store, host, and valid port are required.");
	if (!options.credentials.length) throw new Error("At least one credential is required.");
	if (options.publicOrigin !== undefined) {
		const publicUrl = new URL(options.publicOrigin);
		if (!["http:", "https:"].includes(publicUrl.protocol) || publicUrl.origin !== options.publicOrigin)
			throw new Error("publicOrigin must be an exact HTTP(S) origin.");
	}
	const tokens = new Set<string>();
	for (const credential of options.credentials) {
		if (
			!credential.token.trim() ||
			tokens.has(credential.token) ||
			!credential.actor.id.trim() ||
			!["reader", "editor", "owner"].includes(credential.actor.role)
		)
			throw new Error("Credentials must have unique nonempty tokens and valid actors.");
		tokens.add(credential.token);
	}
	const locator = createWorklistLocator(null, {
		override: options.store,
		overrideBase: process.cwd(),
		env: {},
	});
	const service = new CollaborationService({ resolvePath: () => locator().path });
	// Refuse an absent or malformed store before accepting clients.
	await service.snapshot(options.credentials[0].actor);
	const browserClient = stripTypeScriptTypes(
		await readFile(new URL("./collaboration-client.ts", import.meta.url), "utf8"),
	);
	let origin = "";
	const streams = new Set<ServerResponse>();
	const server = createServer(async (request, response) => {
		try {
			if (
				request.headers.host !== new URL(origin).host ||
				(request.headers.origin && request.headers.origin !== origin)
			) {
				respond(response, 403, { error: "Origin or Host is not allowed." });
				return;
			}
			const url = new URL(request.url ?? "/", origin);
			if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/client.js")) {
				response.writeHead(200, {
					"content-type":
						url.pathname === "/" ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8",
					"cache-control": "no-store",
					"x-content-type-options": "nosniff",
					"content-security-policy":
						"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
					"referrer-policy": "no-referrer",
				});
				response.end(url.pathname === "/" ? COLLABORATION_PAGE : browserClient);
				return;
			}
			if (request.method === "GET" && url.pathname === "/favicon.ico") {
				response.writeHead(204);
				response.end();
				return;
			}
			const bearer = request.headers.authorization;
			const credential = options.credentials.find((entry) => {
				const expected = Buffer.from(`Bearer ${entry.token}`),
					actual = Buffer.from(bearer ?? "");
				return expected.length === actual.length && timingSafeEqual(expected, actual);
			});
			if (!credential) {
				respond(response, 401, { error: "A valid bearer credential is required." });
				return;
			}
			if (request.method === "GET" && url.pathname === "/api/snapshot") {
				respond(response, 200, await service.snapshot(credential.actor));
				return;
			}
			if (request.method === "POST" && url.pathname === "/api/commands") {
				respond(response, 200, await service.execute(credential.actor, await body(request)));
				return;
			}
			if (request.method === "GET" && url.pathname === "/api/events") {
				const value = request.headers["last-event-id"] ?? url.searchParams.get("after");
				if (
					typeof value !== "string" ||
					!/^(0|[1-9][0-9]*)$/.test(value) ||
					!Number.isSafeInteger(Number(value))
				) {
					respond(response, 400, { error: "Supply a nonnegative Last-Event-ID or after cursor." });
					return;
				}
				let after = Number(value);
				const initial = await service.events(credential.actor, after);
				response.writeHead(200, {
					"content-type": "text/event-stream",
					"cache-control": "no-store",
					"x-accel-buffering": "no",
				});
				response.write(": connected\n\n");
				streams.add(response);
				response.on("close", () => streams.delete(response));
				const writeEvents = async (events: typeof initial) => {
					for (const event of events) {
						if (!response.write(`id: ${event.cursor}\nevent: command\ndata: ${JSON.stringify(event)}\n\n`))
							await waitForDrain(response);
						after = event.cursor;
					}
				};
				await writeEvents(initial);
				if (response.destroyed) return;
				let polling = false;
				const timer = setInterval(async () => {
					if (polling || response.destroyed) return;
					polling = true;
					try {
						await writeEvents(await service.events(credential.actor, after));
					} catch {
						response.destroy();
					} finally {
						polling = false;
					}
				}, 100);
				response.on("close", () => {
					clearInterval(timer);
					streams.delete(response);
				});
				return;
			}
			respond(response, 404, { error: "Unknown collaboration endpoint." });
		} catch (error) {
			if (response.headersSent) {
				response.destroy();
				return;
			}
			const detail = error as Error & { status?: number; code?: string };
			respond(response, detail.status ?? 400, { error: detail.message, code: detail.code });
		}
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port, options.host, resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Server did not bind a TCP address.");
	origin =
		options.publicOrigin ??
		`http://${options.host.includes(":") ? `[${options.host}]` : options.host}:${address.port}`;
	if (new URL(origin).origin !== origin) {
		server.close();
		throw new Error("publicOrigin must be an exact HTTP(S) origin.");
	}
	return {
		url: origin,
		async close() {
			for (const response of streams) response.destroy();
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		},
	};
}
