import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { promisify } from "node:util";
import { WorklistApplicationService, type WorklistOperation } from "./application-service.ts";
import { WORKLIST_PATH_ENV } from "./cli-contract.ts";
import {
	dependencyWaves,
	dependentGoals,
	isDependencySatisfied,
	isGoalBlocked,
	readyGoals,
	unsatisfiedDependencies,
} from "./dependencies.ts";
import { createWorklistLocator, resolveWorktreePlacement } from "./git.ts";
import { resolveServerProject } from "./service/project-client.ts";
import { STEPSTONE_WEB_PAGE } from "./web-page.ts";

const LOOPBACK_HOST = "127.0.0.1";
const MAX_BODY_BYTES = 1_000_000;
const execFileAsync = promisify(execFile);

export interface StepstoneWebApp {
	url: string;
	close(): Promise<void>;
}

export interface StartStepstoneWebAppOptions {
	repositoryRoot?: string;
	overrideBase?: string;
	worklistOverride?: string;
	port?: number;
	openBrowser?: boolean;
}

class HttpError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

function json(response: ServerResponse, status: number, value: unknown): void {
	response.writeHead(status, {
		"cache-control": "no-store",
		"content-type": "application/json; charset=utf-8",
		"x-content-type-options": "nosniff",
	});
	response.end(`${JSON.stringify(value)}\n`);
}

function text(
	response: ServerResponse,
	status: number,
	value: string,
	type = "text/plain; charset=utf-8",
): void {
	response.writeHead(status, {
		"cache-control": "no-store",
		"content-security-policy":
			"default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
		"content-type": type,
		"referrer-policy": "no-referrer",
		"x-content-type-options": "nosniff",
		"x-frame-options": "DENY",
	});
	response.end(value);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
	if (request.headers["content-type"]?.split(";", 1)[0] !== "application/json") {
		throw new HttpError(415, "Mutation requests must use application/json.");
	}
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.length;
		if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request body is too large.");
		chunks.push(buffer);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new HttpError(400, "Request body must be valid JSON.");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new HttpError(400, "Request body must be a JSON object.");
	}
	return parsed as Record<string, unknown>;
}

function requiredString(value: unknown, name: string): string {
	if (typeof value !== "string" || !value.trim()) throw new HttpError(400, `${name} is required.`);
	return value;
}

async function openBrowser(url: string): Promise<void> {
	if (process.platform === "darwin") await execFileAsync("open", [url]);
	else if (process.platform === "linux") await execFileAsync("xdg-open", [url]);
	else throw new Error(`Opening a browser is not supported on ${process.platform}. Use ${url}.`);
}

function html(token: string): string {
	return STEPSTONE_WEB_PAGE.replace("__STEPSTONE_TOKEN__", token);
}

export async function startStepstoneWebApp(options: StartStepstoneWebAppOptions): Promise<StepstoneWebApp> {
	const configured = resolveServerProject(process.env);
	if (configured.mode === "invalid") throw new Error(configured.message);
	const remote = configured.mode === "server";
	const hasOverride = Boolean(options.worklistOverride?.trim() || process.env[WORKLIST_PATH_ENV]?.trim());
	if (!remote && !hasOverride) {
		if (!options.repositoryRoot)
			throw new Error("A project outside Git requires --file or STEPSTONE_WORKLIST.");
		const placement = resolveWorktreePlacement(options.repositoryRoot);
		if (placement.kind !== "main") {
			throw new Error("The Stepstone web app must run from the repository's main worktree.");
		}
	}
	if (
		options.port !== undefined &&
		(!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65535)
	) {
		throw new Error("Web app port must be an integer from 0 through 65535.");
	}
	const service = new WorklistApplicationService({});
	if (!remote) {
		const locator = createWorklistLocator(options.repositoryRoot ?? null, {
			override: options.worklistOverride,
			env: process.env,
			overrideBase: options.overrideBase,
		});
		service.setProjectPathResolver(() => locator().path);
	}
	const repositoryLabel = remote
		? "Server project"
		: (options.repositoryRoot?.split("/").at(-1) ?? "Standalone project");
	const token = randomBytes(32).toString("base64url");
	let expectedOrigin = "";

	const server = createServer(async (request, response) => {
		try {
			const host = request.headers.host;
			if (!host || `http://${host}` !== expectedOrigin) throw new HttpError(421, "Invalid Host header.");
			const url = new URL(request.url ?? "/", expectedOrigin);
			if (request.method === "GET" && url.pathname === "/") {
				text(response, 200, html(token), "text/html; charset=utf-8");
				return;
			}
			if (request.method === "GET" && url.pathname === "/favicon.ico") {
				response.writeHead(204, { "cache-control": "no-store" });
				response.end();
				return;
			}
			if (request.method === "GET" && url.pathname === "/api/structure") {
				const result = await service.execute(
					{ scope: "project", action: "structure" },
					{ source: "dashboard" },
				);
				json(response, result.ok ? 200 : 400, result);
				return;
			}
			if (request.method === "GET" && url.pathname === "/api/state") {
				const snapshot = await service.readProjectSnapshot("web");
				if (!snapshot.ok) {
					json(response, 400, snapshot);
					return;
				}
				const goals = snapshot.result.goals ?? [];
				const retiredIds = snapshot.result.retiredIds ?? [];
				const waves = dependencyWaves(goals, retiredIds);
				const waveById = new Map(
					waves.waves.flatMap((wave, index) => wave.map((goal) => [goal.id, index + 1])),
				);
				json(response, 200, {
					ok: true,
					result: {
						repositoryLabel,
						revision: snapshot.meta.revisions?.project ?? "0",
						readyGoalIds: readyGoals(goals, retiredIds).map((goal) => goal.id),
						goals: goals.map((goal) => ({
							...goal,
							blocked: isGoalBlocked(goals, goal, retiredIds),
							blockedBy: isDependencySatisfied(goal)
								? []
								: unsatisfiedDependencies(goals, goal, retiredIds).map((entry) => entry.goal?.id ?? entry.id),
							blocking: isDependencySatisfied(goal)
								? []
								: dependentGoals(goals, goal, retiredIds)
										.filter((dependent) => !isDependencySatisfied(dependent))
										.map((dependent) => dependent.id),
							wave: waveById.get(goal.id),
						})),
					},
				});
				return;
			}
			if (request.method !== "POST") throw new HttpError(404, "Route not found.");
			if (request.headers.origin !== expectedOrigin || request.headers["x-stepstone-token"] !== token) {
				throw new HttpError(403, "Mutation request authorization failed.");
			}
			const body = await readJson(request);
			if (url.pathname === "/api/goals") {
				const action = requiredString(body.action, "action");
				if (
					!new Set([
						"add",
						"update",
						"move",
						"complete",
						"reopen",
						"archive",
						"delete",
						"configure",
						"add_milestone",
						"update_milestone",
						"assign_milestone",
					]).has(action)
				) {
					throw new HttpError(400, `Unsupported goal action ${action}.`);
				}
				const operation: WorklistOperation = { ...body, scope: "project", action } as WorklistOperation;
				const result = await service.execute(operation, { source: "dashboard" });
				json(response, result.ok ? 200 : result.error.code === "CONFLICT" ? 409 : 400, result);
				return;
			}
			throw new HttpError(404, "Route not found.");
		} catch (error) {
			const status = error instanceof HttpError ? error.status : 500;
			json(response, status, {
				ok: false,
				error: { message: error instanceof Error ? error.message : String(error) },
			});
		}
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port ?? 0, LOOPBACK_HOST, () => resolve());
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		server.close();
		throw new Error("Web app server did not return a TCP address.");
	}
	expectedOrigin = `http://${LOOPBACK_HOST}:${address.port}`;
	if (options.openBrowser) {
		try {
			await openBrowser(expectedOrigin);
		} catch (error) {
			await new Promise<void>((resolve, reject) =>
				server.close((closeError) => (closeError ? reject(closeError) : resolve())),
			);
			throw error;
		}
	}
	return {
		url: expectedOrigin,
		close: () =>
			new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
	};
}
