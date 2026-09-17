import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { promisify } from "node:util";
import { WorklistApplicationService, type WorklistOperation } from "./application-service.ts";
import { inspectPreparedClaims } from "./claim-evidence.ts";
import { WORKLIST_PATH_ENV } from "./cli-contract.ts";
import { dependencyWaves, isGoalBlocked, readyGoals } from "./dependencies.ts";
import {
	ApplicationRoadmapBinding,
	currentDispatchTarget,
	defaultDispatchStateDirectory,
	FileDispatchStateStore,
	GitHubMergeEvidenceBinding,
	GitWorktreeBinding,
} from "./dispatch-bindings.ts";
import { DispatchDriver, type DispatchRun } from "./dispatch-driver.ts";
import { createWorklistLocator, resolveWorktreePlacement } from "./git.ts";
import { STEPSTONE_WEB_PAGE } from "./web-page.ts";

const LOOPBACK_HOST = "127.0.0.1";
const MAX_BODY_BYTES = 1_000_000;
const execFileAsync = promisify(execFile);

export interface StepstoneWebApp {
	url: string;
	close(): Promise<void>;
}

export interface StartStepstoneWebAppOptions {
	repositoryRoot: string;
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

function requireConfirmation(body: Record<string, unknown>): void {
	if (body.confirm !== true) throw new HttpError(403, "This action needs explicit confirmation.");
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

function summarizeRun(run: DispatchRun, evidence: Record<string, unknown> = {}): object {
	return {
		id: run.id,
		approvedGoalIds: run.approvedGoalIds,
		maxParallel: run.maxParallel,
		targetBranch: run.targetBranch,
		createdAt: run.createdAt,
		updatedAt: run.updatedAt,
		lastPass: run.lastPass,
		entries: Object.fromEntries(
			Object.entries(run.entries).map(([id, entry]) => [
				id,
				{
					phase: entry.phase,
					branch: entry.branch,
					workspace: entry.workspace?.path,
					cdCommand: entry.workspace ? `cd ${shellQuote(entry.workspace.path)}` : undefined,
					goalFile:
						entry.workspace && entry.goalFile ? `${entry.workspace.path}/${entry.goalFile.path}` : undefined,
					claimUpdatedAt: entry.claimUpdatedAt,
					preparationFailure: entry.preparationFailure,
					mergedPr: entry.mergedPr,
					message: entry.message,
					claimEvidence: evidence[id],
				},
			]),
		),
	};
}

function createDriver(run: DispatchRun, store: FileDispatchStateStore): DispatchDriver {
	return new DispatchDriver({
		roadmap: new ApplicationRoadmapBinding(run.repositoryRoot),
		workspace: new GitWorktreeBinding(run.repositoryRoot, run.workspaceConfig.workspaceParent),
		merges: new GitHubMergeEvidenceBinding(run.repositoryRoot),
		store,
	});
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
	if (options.worklistOverride !== undefined) {
		throw new Error("The Stepstone web app does not support --file. Use the canonical repository roadmap.");
	}
	if (process.env[WORKLIST_PATH_ENV]?.trim()) {
		throw new Error(`The Stepstone web app does not support ${WORKLIST_PATH_ENV}. Unset it before starting.`);
	}
	const placement = resolveWorktreePlacement(options.repositoryRoot);
	if (placement.kind !== "main") {
		throw new Error("The Stepstone web app must run from the repository's main worktree.");
	}
	if (
		options.port !== undefined &&
		(!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65535)
	) {
		throw new Error("Web app port must be an integer from 0 through 65535.");
	}
	const locator = createWorklistLocator(options.repositoryRoot);
	const service = new WorklistApplicationService({ projectPath: null });
	service.setProjectPathResolver(() => locator().path);
	const store = new FileDispatchStateStore(await defaultDispatchStateDirectory(options.repositoryRoot));
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
				const runs = [];
				for (const run of await store.list()) {
					const evidence = await inspectPreparedClaims(
						run,
						new ApplicationRoadmapBinding(run.repositoryRoot),
						new GitWorktreeBinding(run.repositoryRoot, run.workspaceConfig.workspaceParent),
					);
					runs.push(summarizeRun(run, evidence));
				}
				json(response, 200, {
					ok: true,
					result: {
						repositoryLabel: options.repositoryRoot.split("/").at(-1),
						revision: snapshot.meta.revisions?.project ?? "0",
						readyGoalIds: readyGoals(goals, retiredIds).map((goal) => goal.id),
						goals: goals.map((goal) => ({
							...goal,
							blocked: isGoalBlocked(goals, goal, retiredIds),
							blockedBy: goal.dependsOn?.filter((id) => {
								const dependency = goals.find(
									(candidate) => candidate.id === id || candidate.previousIds?.includes(id),
								);
								return !dependency || (dependency.status !== "done" && dependency.status !== "archived");
							}),
							wave: waveById.get(goal.id),
						})),
						runs,
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
				if (!new Set(["add", "update", "move", "complete", "reopen", "archive", "delete"]).has(action)) {
					throw new HttpError(400, `Unsupported goal action ${action}.`);
				}
				const operation: WorklistOperation = { ...body, scope: "project", action } as WorklistOperation;
				const result = await service.execute(operation, { source: "dashboard" });
				json(response, result.ok ? 200 : result.error.code === "CONFLICT" ? 409 : 400, result);
				return;
			}
			if (url.pathname === "/api/dispatch/start") {
				requireConfirmation(body);
				if (
					!Array.isArray(body.approvedGoalIds) ||
					!body.approvedGoalIds.every((id) => typeof id === "string")
				) {
					throw new HttpError(400, "approvedGoalIds must be an array of goal IDs.");
				}
				const maxParallel = body.maxParallel;
				if (!Number.isSafeInteger(maxParallel) || (maxParallel as number) < 1) {
					throw new HttpError(400, "maxParallel must be a positive integer.");
				}
				const target = await currentDispatchTarget(options.repositoryRoot);
				const placeholder = {
					version: 2,
					id: "pending",
					repositoryRoot: options.repositoryRoot,
					approvedGoalIds: [],
					maxParallel: maxParallel as number,
					targetBranch: target.branch,
					targetRevision: target.revision,
					workspaceConfig: {},
					createdAt: "",
					updatedAt: "",
					entries: {},
				} satisfies DispatchRun;
				const driver = createDriver(placeholder, store);
				const run = await driver.create({
					repositoryRoot: options.repositoryRoot,
					approvedGoalIds: body.approvedGoalIds as string[],
					maxParallel: maxParallel as number,
					targetBranch: target.branch,
					targetRevision: target.revision,
					workspaceConfig: {},
				});
				const advanced = await store.withRunLock(run.id, () => driver.advance(run.id));
				json(response, 200, { ok: true, result: summarizeRun(advanced) });
				return;
			}
			const dispatchMatch = url.pathname.match(/^\/api\/dispatch\/([^/]+)\/(continue|recover|cleanup)$/);
			if (!dispatchMatch) throw new HttpError(404, "Route not found.");
			requireConfirmation(body);
			const [, runId, action] = dispatchMatch;
			const result = await store.withRunLock(runId, async () => {
				const run = await store.load(runId);
				if (run.repositoryRoot !== options.repositoryRoot)
					throw new Error(`Run ${runId} belongs to another repository.`);
				const driver = createDriver(run, store);
				if (action === "continue") return driver.advance(runId);
				if (action === "recover") {
					return driver.recoverRelease(
						runId,
						requiredString(body.goalId, "goalId"),
						typeof body.claimUpdatedAt === "string" ? body.claimUpdatedAt : undefined,
					);
				}
				return driver.cleanup(runId);
			});
			json(response, 200, { ok: true, result: result ? summarizeRun(result) : { removedRunId: runId } });
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
