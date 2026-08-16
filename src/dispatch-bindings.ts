import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { constants } from "node:fs";
import {
	access,
	mkdir,
	open,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { delimiter, dirname, extname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { finished } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import lockfile from "proper-lockfile";
import { z } from "zod";
import { WorklistApplicationService } from "./application-service.ts";
import type {
	DispatchPhase,
	DispatchRun,
	DispatchSession,
	DispatchStateStore,
	DispatchWorkspace,
	LaunchClosureOutcome,
	MergeEvidence,
	MergeEvidenceBinding,
	RoadmapBinding,
	RoadmapSnapshot,
	SessionBinding,
	SessionLaunchFailure,
	WorkspaceBinding,
} from "./dispatch-driver.ts";
import { createWorklistLocator } from "./git.ts";
import type { ProjectGoal } from "./types.ts";

interface CommandResult {
	stdout: string;
	stderr: string;
}

class CommandFailure extends Error {
	constructor(command: string, status: number | null) {
		super(
			`${command} failed${status === null ? "" : ` with exit code ${status}`}; command arguments and stderr are redacted`,
		);
		this.name = "CommandFailure";
	}
}

interface CommandOptions {
	stdin?: string;
}

async function runCommand(
	command: string,
	args: string[],
	cwd: string,
	options: CommandOptions = {},
): Promise<CommandResult> {
	const child = spawn(command, args, {
		cwd,
		stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
	});
	const stdoutPipe = child.stdout;
	const stderrPipe = child.stderr;
	if (!stdoutPipe || !stderrPipe) {
		child.kill();
		throw new Error(`Failed to open output pipes for ${command}`);
	}
	let stdout = "";
	let stderr = "";
	stdoutPipe.setEncoding("utf8");
	stderrPipe.setEncoding("utf8");
	stdoutPipe.on("data", (chunk: string) => (stdout += chunk));
	stderrPipe.on("data", (chunk: string) => (stderr += chunk));
	if (options.stdin !== undefined) {
		const stdinPipe = child.stdin;
		if (!stdinPipe) {
			child.kill();
			throw new Error(`Failed to open the input pipe for ${command}`);
		}
		stdinPipe.on("error", () => undefined);
		stdinPipe.end(options.stdin);
	}
	const [status] = (await once(child, "close")) as [number | null, NodeJS.Signals | null];
	if (status !== 0) throw new CommandFailure(command, status);
	return { stdout, stderr };
}

function isUnexecutableCommand(error: unknown): boolean {
	if (!(error instanceof Error) || !("code" in error)) return false;
	return error.code === "ENOENT" || error.code === "EACCES" || error.code === "EPERM";
}

function requireGoal(result: Awaited<ReturnType<WorklistApplicationService["execute"]>>): ProjectGoal {
	if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
	if (!result.result.goal) throw new Error(`Project ${result.action} did not return its goal`);
	return result.result.goal;
}

export class ApplicationRoadmapBinding implements RoadmapBinding {
	private readonly service: WorklistApplicationService;

	constructor(repositoryRoot: string) {
		const locate = createWorklistLocator(repositoryRoot);
		this.service = new WorklistApplicationService({ projectPath: null });
		this.service.setProjectPathResolver(() => locate().path);
	}

	async read(): Promise<RoadmapSnapshot> {
		const result = await this.service.readProjectSnapshot("dispatch");
		if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
		return { goals: result.result.goals ?? [], retiredIds: result.result.retiredIds ?? [] };
	}

	async claim(goalId: string, branch: string, expectedUpdatedAt: string): Promise<ProjectGoal> {
		return requireGoal(
			await this.service.execute(
				{ scope: "project", action: "start", id: goalId, branch, expectedUpdatedAt },
				{ source: "cli" },
			),
		);
	}

	async release(goalId: string, claimUpdatedAt: string): Promise<ProjectGoal> {
		return requireGoal(
			await this.service.execute(
				{ scope: "project", action: "start", id: goalId, clear: true, expectedUpdatedAt: claimUpdatedAt },
				{ source: "cli" },
			),
		);
	}

	async complete(goalId: string, expectedUpdatedAt: string): Promise<ProjectGoal> {
		return requireGoal(
			await this.service.execute(
				{ scope: "project", action: "complete", id: goalId, confirm: true, expectedUpdatedAt },
				{ source: "cli" },
			),
		);
	}
}

const safeString = z
	.string()
	.min(1)
	.refine((value) => !value.includes("\0"), "must not contain NUL");
const goalIdSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
const timestampSchema = z.string().datetime();
const absoluteNormalizedPath = safeString.refine(
	(value) => isAbsolute(value) && normalize(value) === value,
	"must be an absolute normalized path",
);
const metadataSchema = z.record(
	z.string(),
	z.string().refine((value) => !value.includes("\0")),
);
const goalSchema = z
	.object({
		id: goalIdSchema,
		title: safeString,
		description: z.string().optional(),
		status: z.enum(["open", "active", "done", "archived"]),
		createdAt: timestampSchema,
		updatedAt: timestampSchema,
		group: z.string().optional(),
		completedAt: timestampSchema.optional(),
		links: z.array(z.string().url()).optional(),
		branch: safeString.optional(),
		dependsOn: z.array(goalIdSchema).optional(),
	})
	.strict();
const workspaceSchema = z
	.object({
		binding: z.enum(["worktree", "treehouse"]),
		path: absoluteNormalizedPath,
		metadata: metadataSchema,
	})
	.strict();
const sessionSchema = z.object({ binding: z.enum(["process", "herdr"]), metadata: metadataSchema }).strict();
const entrySchema = z
	.object({
		goal: goalSchema,
		branch: safeString,
		phase: z.enum([
			"preparing",
			"acquiring",
			"claiming",
			"claimed",
			"launching",
			"running",
			"ambiguous",
			"releasing",
			"released",
			"completed",
			"cleanup-pending",
			"cleaned",
		]),
		workspace: workspaceSchema.optional(),
		session: sessionSchema.optional(),
		claimUpdatedAt: timestampSchema.optional(),
		releaseUpdatedAt: timestampSchema.optional(),
		completionIntentAt: timestampSchema.optional(),
		completionUpdatedAt: timestampSchema.optional(),
		cleanupMarker: z.string().uuid().optional(),
		launchToken: z.string().uuid().optional(),
		mergedPr: z
			.object({
				url: z.string().url(),
				headBranch: safeString,
				baseBranch: safeString,
				createdAt: timestampSchema,
				mergedAt: timestampSchema,
				mergeCommit: z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/),
			})
			.strict()
			.optional(),
		message: z.string().optional(),
		updatedAt: timestampSchema,
	})
	.strict();
const bindingConfigSchema = z
	.object({
		workspaceParent: absoluteNormalizedPath.optional(),
		agentCommand: absoluteNormalizedPath.optional(),
		agentCommandFingerprint: z
			.string()
			.regex(/^[0-9]+:[0-9]+:[0-9]+:[0-9]+:[0-9]+:[0-9.]+$/)
			.optional(),
		agentArgs: z.array(z.string().refine((value) => !value.includes("\0"))),
		agentKind: z
			.string()
			.regex(/^[A-Za-z0-9._-]+$/)
			.optional(),
		startupGraceMs: z.number().int().positive().max(300_000).optional(),
		promptTimeoutMs: z.number().int().positive().max(86_400_000).optional(),
	})
	.strict();
const runSchema = z
	.object({
		version: z.literal(1),
		id: z.string().regex(/^[A-Za-z0-9_-]+$/),
		repositoryRoot: absoluteNormalizedPath,
		approvedGoalIds: z.array(goalIdSchema).min(1),
		maxParallel: z.number().int().positive().max(1024),
		targetBranch: safeString,
		targetRevision: z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/),
		workspaceBinding: z.enum(["worktree", "treehouse"]),
		sessionBinding: z.enum(["process", "herdr"]),
		bindingConfig: bindingConfigSchema,
		createdAt: timestampSchema,
		updatedAt: timestampSchema,
		entries: z.record(goalIdSchema, entrySchema),
	})
	.strict()
	.superRefine((run, context) => {
		if (new Set(run.approvedGoalIds).size !== run.approvedGoalIds.length) {
			context.addIssue({ code: "custom", path: ["approvedGoalIds"], message: "must be unique" });
		}
		if (run.workspaceBinding === "treehouse" && run.bindingConfig.workspaceParent !== undefined) {
			context.addIssue({
				code: "custom",
				path: ["bindingConfig", "workspaceParent"],
				message: "is worktree-only",
			});
		}
		if (run.sessionBinding === "process") {
			if (!run.bindingConfig.agentCommand || !run.bindingConfig.agentCommandFingerprint) {
				context.addIssue({
					code: "custom",
					path: ["bindingConfig"],
					message: "resolved agent executable and fingerprint are required",
				});
			}
			if (run.bindingConfig.agentKind !== undefined) {
				context.addIssue({ code: "custom", path: ["bindingConfig", "agentKind"], message: "is Herdr-only" });
			}
		} else {
			if (!run.bindingConfig.agentKind) {
				context.addIssue({ code: "custom", path: ["bindingConfig", "agentKind"], message: "is required" });
			}
			if (
				run.bindingConfig.agentCommand !== undefined ||
				run.bindingConfig.agentCommandFingerprint !== undefined ||
				run.bindingConfig.agentArgs.length > 0
			) {
				context.addIssue({
					code: "custom",
					path: ["bindingConfig"],
					message: "process command fields are forbidden",
				});
			}
		}
		const approved = new Set(run.approvedGoalIds);
		for (const [id, entry] of Object.entries(run.entries)) {
			const path = ["entries", id];
			if (entry.goal.id !== id || !approved.has(id)) {
				context.addIssue({ code: "custom", path, message: "entry ID must be an approved goal ID" });
			}
			const expectedBranch = `stepstone/${id}`;
			if (entry.branch !== expectedBranch) {
				context.addIssue({
					code: "custom",
					path: [...path, "branch"],
					message: "does not match the goal ID",
				});
			}
			if (entry.workspace) {
				if (entry.workspace.binding !== run.workspaceBinding) {
					context.addIssue({
						code: "custom",
						path: [...path, "workspace", "binding"],
						message: "binding mismatch",
					});
				}
				const markerValid = z.string().uuid().safeParse(entry.workspace.metadata.marker).success;
				if (run.workspaceBinding === "worktree") {
					const expectedPath = join(
						run.bindingConfig.workspaceParent ?? dirname(run.repositoryRoot),
						`stepstone-${id}`,
					);
					if (
						entry.workspace.path !== expectedPath ||
						!markerValid ||
						!absoluteNormalizedPath.safeParse(entry.workspace.metadata.gitdir).success ||
						!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(entry.workspace.metadata.base ?? "") ||
						Object.keys(entry.workspace.metadata).some(
							(key) => key !== "marker" && key !== "base" && key !== "gitdir",
						)
					) {
						context.addIssue({
							code: "custom",
							path: [...path, "workspace"],
							message: "invalid worktree custody",
						});
					}
				} else if (
					entry.workspace.metadata.holder !== `stepstone:${id}` ||
					!/^[0-9a-f]{32}$/.test(entry.workspace.metadata.leaseId ?? "") ||
					!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(entry.workspace.metadata.base ?? "") ||
					!absoluteNormalizedPath.safeParse(entry.workspace.metadata.gitdir).success ||
					!markerValid ||
					Object.keys(entry.workspace.metadata).some(
						(key) =>
							key !== "holder" && key !== "leaseId" && key !== "base" && key !== "marker" && key !== "gitdir",
					)
				) {
					context.addIssue({
						code: "custom",
						path: [...path, "workspace"],
						message: "invalid Treehouse custody",
					});
				}
			}
			if (entry.session) {
				if (entry.session.binding !== run.sessionBinding) {
					context.addIssue({
						code: "custom",
						path: [...path, "session", "binding"],
						message: "binding mismatch",
					});
				}
				const keys = Object.keys(entry.session.metadata);
				if (run.sessionBinding === "process") {
					const metadata = entry.session.metadata;
					if (
						!/^[1-9][0-9]*$/.test(metadata.pid ?? "") ||
						!z.string().uuid().safeParse(metadata.token).success ||
						!metadata.logPath ||
						!isAbsolute(metadata.logPath) ||
						normalize(metadata.logPath) !== metadata.logPath ||
						!metadata.receiptPath ||
						!isAbsolute(metadata.receiptPath) ||
						normalize(metadata.receiptPath) !== metadata.receiptPath ||
						keys.some((key) => !["pid", "token", "logPath", "receiptPath"].includes(key)) ||
						(entry.launchToken !== undefined && metadata.token !== entry.launchToken)
					) {
						context.addIssue({
							code: "custom",
							path: [...path, "session"],
							message: "invalid process custody",
						});
					}
				} else {
					const metadata = entry.session.metadata;
					if (
						metadata.workspace !== entry.workspace?.path ||
						metadata.promptPath === undefined ||
						!isAbsolute(metadata.promptPath) ||
						normalize(metadata.promptPath) !== metadata.promptPath ||
						!metadata.receiptPath ||
						!isAbsolute(metadata.receiptPath) ||
						normalize(metadata.receiptPath) !== metadata.receiptPath ||
						!metadata.agentName ||
						!goalIdSchema.safeParse(metadata.agentName).success ||
						metadata.agentName !== herdrAgentName(entry.goal.id) ||
						(metadata.paneId === undefined && metadata.pane !== "unknown") ||
						(metadata.pane === "unknown" && !metadata.beforePaneIds) ||
						keys.some(
							(key) =>
								![
									"paneId",
									"pane",
									"workspace",
									"promptPath",
									"receiptPath",
									"beforePaneIds",
									"agentName",
								].includes(key),
						)
					) {
						context.addIssue({
							code: "custom",
							path: [...path, "session"],
							message: "invalid Herdr custody",
						});
					}
				}
			}
			const sessionPhases: DispatchPhase[] = ["running", "ambiguous", "completed", "cleanup-pending"];
			const launchPhases: DispatchPhase[] = [
				"launching",
				"running",
				"ambiguous",
				"completed",
				"cleanup-pending",
			];
			const workspaceRequiredPhases: DispatchPhase[] = [
				"claiming",
				"claimed",
				"launching",
				"running",
				"releasing",
				"released",
				"completed",
				"cleanup-pending",
			];
			const claimRequiredPhases: DispatchPhase[] = [
				"claimed",
				"launching",
				"running",
				"releasing",
				"released",
				"completed",
				"cleanup-pending",
			];
			if (entry.session && !sessionPhases.includes(entry.phase)) {
				context.addIssue({ code: "custom", path, message: "phase cannot retain a worker session" });
			}
			if (entry.session && !entry.launchToken) {
				context.addIssue({ code: "custom", path, message: "worker session lacks its launch token" });
			}
			if ((entry.session || entry.launchToken) && !entry.workspace) {
				context.addIssue({
					code: "custom",
					path,
					message: "live launch or session custody requires its persisted workspace",
				});
			}
			if (entry.launchToken && !launchPhases.includes(entry.phase)) {
				context.addIssue({ code: "custom", path, message: "phase cannot retain live launch custody" });
			}
			if (entry.phase === "launching" && !entry.launchToken) {
				context.addIssue({ code: "custom", path, message: "launching phase lacks its launch token" });
			}
			if (entry.phase === "launching" && entry.session) {
				context.addIssue({ code: "custom", path, message: "launching phase cannot claim a session handle" });
			}
			if (entry.phase === "running" && !entry.session) {
				context.addIssue({ code: "custom", path, message: "phase requires a worker session" });
			}
			if (
				workspaceRequiredPhases.includes(entry.phase) &&
				(!entry.workspace || (entry.phase !== "claiming" && !entry.claimUpdatedAt))
			) {
				context.addIssue({
					code: "custom",
					path,
					message: "canonical mutation phase lacks required custody metadata",
				});
			}
			if (claimRequiredPhases.includes(entry.phase) && !entry.claimUpdatedAt) {
				context.addIssue({ code: "custom", path, message: "phase lacks its exact claim token" });
			}
			if (
				(entry.phase === "preparing" || entry.phase === "cleaned") &&
				(entry.workspace || entry.session || entry.launchToken)
			) {
				context.addIssue({
					code: "custom",
					path,
					message: "terminal or pre-acquisition phase retains custody",
				});
			}
			if (entry.cleanupMarker && entry.phase !== "cleaned") {
				context.addIssue({
					code: "custom",
					path,
					message: "cleanup receipt belongs only to a cleaned phase",
				});
			}
			const hasAnyCompletionState = Boolean(
				entry.mergedPr || entry.completionIntentAt || entry.completionUpdatedAt,
			);
			if (
				hasAnyCompletionState &&
				(!entry.mergedPr || !entry.completionIntentAt || (entry.completionUpdatedAt && !entry.mergedPr))
			) {
				context.addIssue({ code: "custom", path, message: "completion journal is incomplete" });
			}
			if (entry.releaseUpdatedAt && hasAnyCompletionState) {
				context.addIssue({
					code: "custom",
					path,
					message: "entry has conflicting release and completion receipts",
				});
			}
			if (entry.releaseUpdatedAt && !["released", "cleanup-pending", "cleaned"].includes(entry.phase)) {
				context.addIssue({ code: "custom", path, message: "release receipt is invalid for this phase" });
			}
			if (
				hasAnyCompletionState &&
				!["running", "ambiguous", "completed", "cleanup-pending", "cleaned"].includes(entry.phase)
			) {
				context.addIssue({ code: "custom", path, message: "completion journal is invalid for this phase" });
			}
			const hasCompletionReceipt = Boolean(
				entry.mergedPr && entry.completionIntentAt && entry.completionUpdatedAt,
			);
			if (entry.phase === "completed" && !hasCompletionReceipt) {
				context.addIssue({
					code: "custom",
					path,
					message: "completed phase lacks merged PR and canonical completion receipt",
				});
			}
			if (entry.phase === "released" && !entry.releaseUpdatedAt) {
				context.addIssue({ code: "custom", path, message: "released phase lacks canonical release receipt" });
			}
			if (entry.phase === "cleanup-pending" && !entry.releaseUpdatedAt && !hasCompletionReceipt) {
				context.addIssue({
					code: "custom",
					path,
					message: "cleanup-pending phase lacks canonical release or completion receipt",
				});
			}
		}
	});

function validateRun(value: unknown, path: string): DispatchRun {
	const result = runSchema.safeParse(value);
	if (!result.success) {
		throw new Error(`Dispatch state ${path} is invalid: ${z.prettifyError(result.error)}`);
	}
	const run = result.data;
	const stateDirectory = dirname(path);
	for (const [id, entry] of Object.entries(run.entries)) {
		if (entry.session?.binding === "process") {
			const expected = join(stateDirectory, "sessions", id, "agent.log");
			if (entry.session.metadata.logPath !== expected) {
				throw new Error(`Dispatch state ${path} is invalid: process log path does not match run ${id}`);
			}
			const expectedReceipt = join(
				stateDirectory,
				"sessions",
				id,
				`launch-${entry.session.metadata.token}.json`,
			);
			if (entry.session.metadata.receiptPath !== expectedReceipt) {
				throw new Error(`Dispatch state ${path} is invalid: process receipt path does not match run ${id}`);
			}
		}
		if (entry.session?.binding === "herdr") {
			const expectedReceipt = join(stateDirectory, "sessions", id, `herdr-launch-${entry.launchToken}.json`);
			if (entry.session.metadata.receiptPath !== expectedReceipt) {
				throw new Error(`Dispatch state ${path} is invalid: Herdr receipt path does not match run ${id}`);
			}
			const expected = join(stateDirectory, "sessions", id, "prompt.txt");
			if (entry.session.metadata.promptPath !== expected) {
				throw new Error(`Dispatch state ${path} is invalid: Herdr prompt path does not match run ${id}`);
			}
		}
	}
	return run as DispatchRun;
}

export class FileDispatchStateStore implements DispatchStateStore {
	readonly directory: string;
	constructor(directory: string) {
		this.directory = directory;
	}

	async create(run: DispatchRun): Promise<void> {
		await this.withLock(async () => {
			const path = this.path(run.id);
			try {
				await readFile(path, "utf8");
				throw new Error(`Dispatch run ${run.id} already exists`);
			} catch (error) {
				if (error instanceof Error && "code" in error && error.code === "ENOENT") await this.write(run);
				else throw error;
			}
		});
	}

	async load(runId: string): Promise<DispatchRun> {
		return this.withLock(async () => this.read(runId));
	}

	async save(run: DispatchRun): Promise<void> {
		await this.withLock(async () => {
			const current = await this.read(run.id);
			if (current.repositoryRoot !== run.repositoryRoot)
				throw new Error(`Dispatch run ${run.id} changed repository roots`);
			await this.write(run);
		});
	}

	async list(): Promise<DispatchRun[]> {
		return this.withLock(async () => {
			const names = (await readdir(this.directory)).filter((name) => name.endsWith(".json"));
			return Promise.all(names.map((name) => this.read(name.slice(0, -5))));
		});
	}

	async remove(runId: string): Promise<void> {
		await this.withLock(async () => {
			const run = await this.read(runId);
			for (const entry of Object.values(run.entries)) {
				if (entry.cleanupMarker) {
					await rm(join(this.directory, "workspaces", `${entry.cleanupMarker}.json`), { force: true });
				}
			}
			await rm(this.path(runId), { force: true });
		});
	}
	async withRunLock<T>(runId: string, operation: () => Promise<T>): Promise<T> {
		this.path(runId);
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		const target = join(this.directory, `.run-${runId}`);
		await writeFile(target, "", { flag: "a", mode: 0o600 });
		const release = await lockfile.lock(target, {
			retries: { retries: 20, factor: 1.5, minTimeout: 10, maxTimeout: 250 },
			stale: 10000,
		});
		try {
			return await operation();
		} finally {
			await release();
		}
	}

	private path(runId: string): string {
		if (!/^[A-Za-z0-9_-]+$/.test(runId)) throw new Error(`Invalid dispatch run ID ${runId}`);
		return join(this.directory, `${runId}.json`);
	}

	private async read(runId: string): Promise<DispatchRun> {
		const path = this.path(runId);
		return validateRun(JSON.parse(await readFile(path, "utf8")) as unknown, path);
	}

	private async write(run: DispatchRun): Promise<void> {
		const target = this.path(run.id);
		validateRun(run, target);
		const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
		await writeFile(temporary, `${JSON.stringify(run, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		await rename(temporary, target);
	}

	private async withLock<T>(operation: () => Promise<T>): Promise<T> {
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		const release = await lockfile.lock(this.directory, {
			lockfilePath: join(this.directory, ".lock"),
			retries: { retries: 20, factor: 1.5, minTimeout: 10, maxTimeout: 250 },
			stale: 10000,
		});
		try {
			return await operation();
		} finally {
			await release();
		}
	}
}

export async function executableFingerprint(path: string): Promise<string> {
	const info = await stat(path);
	if (!info.isFile()) throw new Error(`Agent executable ${path} is not a regular file`);
	await access(path, constants.X_OK);
	return [info.dev, info.ino, info.mode, info.uid, info.size, info.mtimeMs].join(":");
}

export async function resolveExecutablePath(command: string, cwd: string): Promise<string> {
	const requested = command.trim();
	if (!requested || requested.includes("\0")) throw new Error("Agent executable is empty or invalid");
	const extensions =
		process.platform === "win32" && extname(requested) === ""
			? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
			: [""];
	const candidates =
		isAbsolute(requested) || requested.includes("/") || requested.includes("\\")
			? extensions.map((extension) => resolve(cwd, `${requested}${extension}`))
			: (process.env.PATH ?? "")
					.split(delimiter)
					.filter(Boolean)
					.flatMap((directory) =>
						extensions.map((extension) => resolve(directory, `${requested}${extension}`)),
					);
	for (const candidate of candidates) {
		try {
			await access(candidate, constants.X_OK);
			return await realpath(candidate);
		} catch {
			// Try the next PATH entry.
		}
	}
	throw new Error(`Agent executable ${JSON.stringify(requested)} was not found or is not executable`);
}

const workspaceMarkerSchema = z
	.object({
		marker: z.string().uuid(),
		binding: z.enum(["worktree", "treehouse"]),
		path: absoluteNormalizedPath,
		branch: safeString,
		base: z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/),
		removalBranchTip: z
			.string()
			.regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/)
			.optional(),
		branchDeletedAt: timestampSchema.optional(),
		gitdir: absoluteNormalizedPath,
		removedAt: timestampSchema.optional(),
	})
	.strict();

async function workspaceMarkerPath(repositoryRoot: string, marker: string): Promise<string> {
	if (!z.string().uuid().safeParse(marker).success) throw new Error("Workspace ownership marker is invalid");
	return join(await defaultDispatchStateDirectory(repositoryRoot), "workspaces", `${marker}.json`);
}

async function createWorkspaceMarker(
	repositoryRoot: string,
	record: z.infer<typeof workspaceMarkerSchema>,
): Promise<void> {
	const validated = workspaceMarkerSchema.parse(record);
	const path = await workspaceMarkerPath(repositoryRoot, validated.marker);
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	await writeFile(path, `${JSON.stringify(validated, null, 2)}\n`, {
		encoding: "utf8",
		mode: 0o600,
		flag: "wx",
	});
}

async function readOptionalFile(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

async function writePrivateJsonAtomically(path: string, value: unknown): Promise<void> {
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
	await rename(temporary, path);
}

async function verifyWorkspaceMarker(
	repositoryRoot: string,
	workspace: DispatchWorkspace,
	branch: string,
	base: string,
): Promise<{ path: string; record: z.infer<typeof workspaceMarkerSchema> }> {
	const marker = workspace.metadata.marker;
	if (!marker) throw new Error("Workspace custody has no ownership marker");
	const path = await workspaceMarkerPath(repositoryRoot, marker);
	const record = workspaceMarkerSchema.parse(JSON.parse(await readFile(path, "utf8")));
	if (
		record.marker !== marker ||
		record.binding !== workspace.binding ||
		record.path !== workspace.path ||
		record.branch !== branch ||
		record.base !== base ||
		record.gitdir !== workspace.metadata.gitdir
	) {
		throw new Error("Workspace ownership marker does not match persisted custody");
	}
	return { path, record };
}

async function markWorkspaceRemoved(
	path: string,
	record: z.infer<typeof workspaceMarkerSchema>,
): Promise<void> {
	await writePrivateJsonAtomically(path, { ...record, removedAt: new Date().toISOString() });
}

async function journalWorkspaceBranchRemoval(
	path: string,
	record: z.infer<typeof workspaceMarkerSchema>,
	branchTip: string,
): Promise<z.infer<typeof workspaceMarkerSchema>> {
	if (record.removalBranchTip && record.removalBranchTip !== branchTip) {
		throw new Error("Workspace branch changed after removal identity was journaled");
	}
	const updated = { ...record, removalBranchTip: branchTip };
	await writePrivateJsonAtomically(path, updated);
	return updated;
}

async function journalWorkspaceBranchDeleted(
	path: string,
	record: z.infer<typeof workspaceMarkerSchema>,
): Promise<z.infer<typeof workspaceMarkerSchema>> {
	if (!record.removalBranchTip) {
		throw new Error("Cannot journal branch deletion without its exact removal identity");
	}
	const updated = { ...record, branchDeletedAt: record.branchDeletedAt ?? new Date().toISOString() };
	await writePrivateJsonAtomically(path, updated);
	return updated;
}

async function isRegisteredWorkspace(repositoryRoot: string, workspacePath: string): Promise<boolean> {
	const listing = (await runCommand("git", ["worktree", "list", "--porcelain", "-z"], repositoryRoot)).stdout;
	return listing
		.split("\0")
		.filter((field) => field.startsWith("worktree "))
		.map((field) => field.slice("worktree ".length))
		.includes(workspacePath);
}

async function currentBranchTip(repositoryRoot: string, branch: string): Promise<string | undefined> {
	const tip = (
		await runCommand(
			"git",
			["for-each-ref", "--format=%(objectname)", `refs/heads/${branch}`],
			repositoryRoot,
		)
	).stdout.trim();
	return tip || undefined;
}

async function deleteBranchIfUnchanged(
	repositoryRoot: string,
	branch: string,
	expectedBranchTip: string,
): Promise<void> {
	const before = await currentBranchTip(repositoryRoot, branch);
	if (!before) return;
	if (before !== expectedBranchTip) {
		throw new Error("Refusing branch cleanup because the branch identity changed");
	}
	try {
		await runCommand("git", ["update-ref", "-d", `refs/heads/${branch}`, expectedBranchTip], repositoryRoot);
	} catch (error) {
		if (!(await currentBranchTip(repositoryRoot, branch))) return;
		throw new Error("Refusing branch cleanup because its exact ref could not be atomically deleted", {
			cause: error,
		});
	}
}

async function deleteJournaledWorkspaceBranch(
	repositoryRoot: string,
	markerPath: string,
	record: z.infer<typeof workspaceMarkerSchema>,
	branch: string,
	branchTip: string | undefined,
	beforeDelete?: () => Promise<void>,
): Promise<z.infer<typeof workspaceMarkerSchema>> {
	const expectedBranchTip = record.removalBranchTip;
	if (!expectedBranchTip) throw new Error("Workspace cleanup lacks its exact branch identity");
	if (record.branchDeletedAt) {
		if (branchTip) throw new Error("Refusing cleanup because the deleted branch name was recreated");
		return record;
	}
	if (branchTip && branchTip !== expectedBranchTip) {
		throw new Error("Refusing branch cleanup because the branch identity changed");
	}
	if (branchTip) {
		await beforeDelete?.();
		await deleteBranchIfUnchanged(repositoryRoot, branch, expectedBranchTip);
	}
	return await journalWorkspaceBranchDeleted(markerPath, record);
}

async function finishAlreadyRemovedWorkspace(
	repositoryRoot: string,
	workspacePath: string,
	branchDeletedAt?: string,
): Promise<boolean> {
	if (await isRegisteredWorkspace(repositoryRoot, workspacePath)) return false;
	try {
		await stat(workspacePath);
		throw new Error(`Refusing cleanup because unregistered path ${workspacePath} still exists`);
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
	}
	if (!branchDeletedAt) {
		throw new Error(
			"Workspace disappeared before branch deletion was journaled; manual branch cleanup is required",
		);
	}
	return true;
}

async function workspaceGitDirectory(workspacePath: string): Promise<string> {
	const gitdir = (await runCommand("git", ["rev-parse", "--absolute-git-dir"], workspacePath)).stdout.trim();
	return await realpath(gitdir);
}

async function verifyRegisteredWorkspace(
	repositoryRoot: string,
	workspacePath: string,
	branch: string,
	detachedBase?: string,
	expectedGitdir?: string,
	expectedMarker?: string,
): Promise<void> {
	if (!branch.startsWith("stepstone/")) throw new Error("Refusing cleanup for a non-Stepstone branch");
	if (!(await isRegisteredWorkspace(repositoryRoot, workspacePath))) {
		throw new Error(`Refusing cleanup because ${workspacePath} is not this repository's registered worktree`);
	}
	const top = (await runCommand("git", ["rev-parse", "--show-toplevel"], workspacePath)).stdout.trim();
	if (top !== workspacePath)
		throw new Error(`Refusing cleanup because ${workspacePath} is not its worktree root`);
	const currentBranch = (await runCommand("git", ["branch", "--show-current"], workspacePath)).stdout.trim();
	if (currentBranch !== branch) {
		const head = (await runCommand("git", ["rev-parse", "HEAD"], workspacePath)).stdout.trim();
		if (currentBranch || !detachedBase || head !== detachedBase) {
			throw new Error(
				`Refusing cleanup because ${workspacePath} is on ${currentBranch || `detached ${head}`}, not ${branch}`,
			);
		}
	}
	const rootCommon = await realpath(
		resolve(
			repositoryRoot,
			(await runCommand("git", ["rev-parse", "--git-common-dir"], repositoryRoot)).stdout.trim(),
		),
	);
	const workspaceCommon = await realpath(
		resolve(
			workspacePath,
			(await runCommand("git", ["rev-parse", "--git-common-dir"], workspacePath)).stdout.trim(),
		),
	);
	if (rootCommon !== workspaceCommon) {
		throw new Error(`Refusing cleanup because ${workspacePath} belongs to another repository`);
	}
	if (expectedGitdir) {
		const actualGitdir = await workspaceGitDirectory(workspacePath);
		if (actualGitdir !== expectedGitdir) {
			throw new Error(`Refusing cleanup because ${workspacePath} is not the originally acquired worktree`);
		}
		const owner = z
			.object({ marker: z.string().uuid() })
			.strict()
			.parse(JSON.parse(await readFile(join(actualGitdir, "stepstone-dispatch-owner.json"), "utf8")));
		if (!expectedMarker || owner.marker !== expectedMarker) {
			throw new Error(`Refusing cleanup because ${workspacePath} has newer dispatch ownership`);
		}
	}
}

export async function defaultDispatchStateDirectory(repositoryRoot: string): Promise<string> {
	const { stdout } = await runCommand("git", ["rev-parse", "--git-common-dir"], repositoryRoot);
	return resolve(repositoryRoot, stdout.trim(), "stepstone-dispatch");
}
export async function currentDispatchTarget(
	repositoryRoot: string,
): Promise<{ branch: string; revision: string }> {
	const branch = (await runCommand("git", ["branch", "--show-current"], repositoryRoot)).stdout.trim();
	if (!branch) throw new Error("Dispatch requires the canonical checkout to be on a branch");
	await runCommand("git", ["check-ref-format", "--branch", branch], repositoryRoot);
	const revision = (await runCommand("git", ["rev-parse", "HEAD"], repositoryRoot)).stdout.trim();
	return { branch, revision };
}

export class GitWorktreeBinding implements WorkspaceBinding {
	readonly name = "worktree";
	private readonly repositoryRoot: string;
	private readonly workspaceParent: string;

	constructor(repositoryRoot: string, workspaceParent = dirname(repositoryRoot)) {
		this.repositoryRoot = repositoryRoot;
		this.workspaceParent = workspaceParent;
	}

	async acquire(goal: ProjectGoal, branch: string, baseRevision: string): Promise<DispatchWorkspace> {
		if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(baseRevision)) {
			throw new Error("Dispatch base revision is invalid");
		}
		const path = join(this.workspaceParent, `stepstone-${goal.id}`);
		await runCommand("git", ["worktree", "add", "-b", branch, path, baseRevision], this.repositoryRoot);
		const gitdir = await workspaceGitDirectory(path);
		const marker = randomUUID();
		await writePrivateJsonAtomically(join(gitdir, "stepstone-dispatch-owner.json"), { marker });
		await createWorkspaceMarker(this.repositoryRoot, {
			marker,
			binding: this.name,
			path,
			branch,
			base: baseRevision,
			gitdir,
		});
		return { binding: this.name, path, metadata: { marker, base: baseRevision, gitdir } };
	}

	async verify(workspace: DispatchWorkspace, branch: string): Promise<void> {
		const base = workspace.metadata.base;
		if (!base) throw new Error("Worktree workspace base is missing");
		const { record } = await verifyWorkspaceMarker(this.repositoryRoot, workspace, branch, base);
		if (record.removedAt) throw new Error("Worktree workspace was already recorded as removed");
		if (record.removalBranchTip || record.branchDeletedAt) {
			throw new Error("Worktree workspace cleanup is already in progress");
		}
		await verifyRegisteredWorkspace(
			this.repositoryRoot,
			workspace.path,
			branch,
			undefined,
			record.gitdir,
			record.marker,
		);
	}

	async cleanup(workspace: DispatchWorkspace, branch: string): Promise<void> {
		const expectedPath = join(this.workspaceParent, `stepstone-${branch.slice("stepstone/".length)}`);
		if (
			!branch.startsWith("stepstone/") ||
			workspace.binding !== this.name ||
			workspace.path !== expectedPath
		) {
			throw new Error("Refusing cleanup for worktree custody that does not match this binding");
		}
		const base = workspace.metadata.base;
		if (!base) throw new Error("Worktree workspace base is missing");
		const marker = await verifyWorkspaceMarker(this.repositoryRoot, workspace, branch, base);
		if (marker.record.removedAt) return;
		if (
			await finishAlreadyRemovedWorkspace(this.repositoryRoot, workspace.path, marker.record.branchDeletedAt)
		) {
			await markWorkspaceRemoved(marker.path, marker.record);
			return;
		}
		await verifyRegisteredWorkspace(
			this.repositoryRoot,
			workspace.path,
			branch,
			undefined,
			marker.record.gitdir,
			marker.record.marker,
		);
		let removalRecord = marker.record;
		let branchTip = await currentBranchTip(this.repositoryRoot, branch);
		if (!removalRecord.removalBranchTip) {
			await runCommand("git", ["reset", "--hard", "HEAD"], workspace.path);
			await runCommand("git", ["clean", "-fdx"], workspace.path);
			const { stdout } = await runCommand("git", ["status", "--porcelain"], workspace.path);
			if (stdout.trim()) throw new Error(`Workspace ${workspace.path} is not clean after scrubbing`);
			branchTip = await currentBranchTip(this.repositoryRoot, branch);
			if (!branchTip) throw new Error("Owned worktree branch disappeared before cleanup intent");
			removalRecord = await journalWorkspaceBranchRemoval(marker.path, removalRecord, branchTip);
		}
		removalRecord = await deleteJournaledWorkspaceBranch(
			this.repositoryRoot,
			marker.path,
			removalRecord,
			branch,
			branchTip,
		);
		await runCommand("git", ["worktree", "remove", "--force", workspace.path], this.repositoryRoot);
		await markWorkspaceRemoved(marker.path, removalRecord);
	}
}

const treehouseLeaseSchema = z
	.object({
		path: absoluteNormalizedPath,
		lease_id: z.string().regex(/^[0-9a-f]{32}$/),
		lease_holder: safeString,
		leased_at: timestampSchema,
	})
	.strict();

const treehouseStatusSchema = z.array(
	z
		.object({
			name: z.string(),
			path: absoluteNormalizedPath,
			status: z.string(),
			lease_id: z.string(),
			lease_holder: z.string(),
			leased_at: timestampSchema.nullable(),
			processes: z.array(z.object({ pid: z.number().int(), name: z.string() }).strict()),
		})
		.strict(),
);
export class TreehouseWorkspaceBinding implements WorkspaceBinding {
	readonly name = "treehouse";
	private readonly repositoryRoot: string;

	constructor(repositoryRoot: string) {
		this.repositoryRoot = repositoryRoot;
	}

	async acquire(goal: ProjectGoal, branch: string, baseRevision: string): Promise<DispatchWorkspace> {
		if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(baseRevision)) {
			throw new Error("Dispatch base revision is invalid");
		}
		const holder = `stepstone:${goal.id}`;
		const base = baseRevision;
		const lease = treehouseLeaseSchema.parse(
			JSON.parse(
				(
					await runCommand(
						"treehouse",
						["get", "--lease", "--lease-holder", holder, "--json"],
						this.repositoryRoot,
					)
				).stdout,
			),
		);
		if (lease.lease_holder !== holder) throw new Error("Treehouse returned the wrong lease holder");
		const path = lease.path;
		try {
			await runCommand("git", ["checkout", "-b", branch, base], path);
		} catch (error) {
			await runCommand(
				"treehouse",
				["return", path, "--force", "--if-lease-id", lease.lease_id, "--if-lease-holder", holder],
				this.repositoryRoot,
			);
			throw error;
		}
		const gitdir = await workspaceGitDirectory(path);
		const marker = randomUUID();
		await writePrivateJsonAtomically(join(gitdir, "stepstone-dispatch-owner.json"), { marker });
		await createWorkspaceMarker(this.repositoryRoot, {
			marker,
			binding: this.name,
			path,
			branch,
			base,
			gitdir,
		});
		return {
			binding: this.name,
			path,
			metadata: { holder, leaseId: lease.lease_id, base, marker, gitdir },
		};
	}

	async verify(workspace: DispatchWorkspace, branch: string): Promise<void> {
		const base = workspace.metadata.base;
		if (!base) throw new Error("Treehouse workspace base is missing");
		const { record } = await verifyWorkspaceMarker(this.repositoryRoot, workspace, branch, base);
		if (record.removedAt) throw new Error("Treehouse workspace was already recorded as removed");
		if (record.removalBranchTip || record.branchDeletedAt) {
			throw new Error("Treehouse workspace cleanup is already in progress");
		}
		await verifyRegisteredWorkspace(
			this.repositoryRoot,
			workspace.path,
			branch,
			undefined,
			record.gitdir,
			record.marker,
		);
		if ((await this.leaseState(workspace)) !== "owned") {
			throw new Error("Treehouse workspace lease was already returned");
		}
	}

	async cleanup(workspace: DispatchWorkspace, branch: string): Promise<void> {
		const holder = workspace.metadata.holder;
		const leaseId = workspace.metadata.leaseId;
		const base = workspace.metadata.base;
		if (!holder || !leaseId || !base) throw new Error("Treehouse workspace metadata is incomplete");
		if (
			!branch.startsWith("stepstone/") ||
			workspace.binding !== this.name ||
			holder !== `stepstone:${branch.slice("stepstone/".length)}` ||
			!/^[0-9a-f]{32}$/.test(leaseId) ||
			!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(base)
		) {
			throw new Error("Refusing cleanup for Treehouse custody that does not match this binding");
		}
		const marker = await verifyWorkspaceMarker(this.repositoryRoot, workspace, branch, base);
		if (marker.record.removedAt) return;
		const leaseState = await this.leaseState(workspace);
		if (leaseState === "available") {
			await markWorkspaceRemoved(marker.path, marker.record);
			return;
		}
		await verifyRegisteredWorkspace(
			this.repositoryRoot,
			workspace.path,
			branch,
			base,
			marker.record.gitdir,
			marker.record.marker,
		);
		let removalRecord = marker.record;
		const branchTip = await currentBranchTip(this.repositoryRoot, branch);
		if (!removalRecord.removalBranchTip) {
			if (!branchTip) throw new Error("Leased Treehouse branch disappeared before cleanup intent");
			removalRecord = await journalWorkspaceBranchRemoval(marker.path, removalRecord, branchTip);
		}
		removalRecord = await deleteJournaledWorkspaceBranch(
			this.repositoryRoot,
			marker.path,
			removalRecord,
			branch,
			branchTip,
			async () => {
				await runCommand("git", ["checkout", "--force", "--detach", base], workspace.path);
			},
		);
		await runCommand(
			"treehouse",
			["return", workspace.path, "--force", "--if-lease-id", leaseId, "--if-lease-holder", holder],
			this.repositoryRoot,
		);
		await markWorkspaceRemoved(marker.path, removalRecord);
	}

	private async leaseState(workspace: DispatchWorkspace): Promise<"owned" | "available"> {
		const status = treehouseStatusSchema.parse(
			JSON.parse((await runCommand("treehouse", ["status", "--json"], this.repositoryRoot)).stdout),
		);
		const matches = status.filter((entry) => entry.path === workspace.path);
		if (matches.length !== 1) {
			throw new Error(`Treehouse status did not identify exactly one workspace at ${workspace.path}`);
		}
		const current = matches[0];
		if (!current) throw new Error("Treehouse status lost its selected workspace");
		if (current.status === "available" && !current.lease_id && !current.lease_holder) return "available";
		if (
			current.status !== "leased" ||
			current.lease_id !== workspace.metadata.leaseId ||
			current.lease_holder !== workspace.metadata.holder
		) {
			throw new Error(`Treehouse workspace ${workspace.path} is held by a different lease`);
		}
		return "owned";
	}
}

class ProcessLaunchFailure extends Error implements SessionLaunchFailure {
	readonly ambiguous = false;
}

class ProcessPromptFailure extends Error implements SessionLaunchFailure {
	readonly ambiguous = true;
	readonly session?: DispatchSession;
	constructor(message: string, session?: DispatchSession) {
		super(message);
		this.session = session;
	}
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
		if (error instanceof Error && "code" in error && error.code === "EPERM") return true;
		throw error;
	}
}

async function carriesSessionToken(pid: number, launchToken: string): Promise<boolean> {
	try {
		const environment = await readFile(`/proc/${pid}/environ`);
		return environment.includes(Buffer.from(`STEPSTONE_DISPATCH_SESSION_TOKEN=${launchToken}\0`));
	} catch (error) {
		if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "EACCES")) {
			return false;
		}
		throw error;
	}
}

async function acceptInterruptedLaunchVerdict(
	operatorConfirmed: boolean,
	unprovable: string,
	accept: () => Promise<void>,
): Promise<LaunchClosureOutcome> {
	if (!operatorConfirmed) {
		throw new Error(`${unprovable}; inspect that custody and rerun with --confirm-launch-closed`);
	}
	await accept();
	return "operator-asserted";
}

export class DetachedProcessSessionBinding implements SessionBinding {
	readonly name = "process";
	private readonly command: string;
	private readonly args: string[];
	private readonly stateDirectory: string;
	private readonly startupGraceMs: number;
	private readonly expectedFingerprint: string | undefined;

	constructor(
		command: string,
		args: string[],
		stateDirectory: string,
		startupGraceMs = 1000,
		expectedFingerprint?: string,
	) {
		this.command = command;
		this.args = args;
		this.stateDirectory = stateDirectory;
		this.startupGraceMs = startupGraceMs;
		this.expectedFingerprint = expectedFingerprint;
		if (process.platform !== "linux") {
			throw new Error(`Detached process sessions are supported only on Linux, not ${process.platform}`);
		}
	}

	async verifyLaunchIdentity(): Promise<void> {
		if (!this.expectedFingerprint) return;
		const actual = await executableFingerprint(this.command).catch(() => undefined);
		if (!actual || actual !== this.expectedFingerprint) {
			throw new Error("Dispatch cannot launch because the agent executable identity changed");
		}
	}

	async launch(
		workspace: DispatchWorkspace,
		goal: ProjectGoal,
		prompt: string,
		launchToken: string = randomUUID(),
	): Promise<DispatchSession> {
		await this.verifyLaunchIdentity();
		const sessionDirectory = join(this.stateDirectory, "sessions", goal.id);
		await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
		const logPath = join(sessionDirectory, "agent.log");
		const token = launchToken;
		const receiptPath = join(sessionDirectory, `launch-${token}.json`);
		try {
			await writeFile(receiptPath, `${JSON.stringify({ token })}\n`, {
				encoding: "utf8",
				mode: 0o600,
				flag: "wx",
			});
		} catch (error) {
			throw new ProcessLaunchFailure(
				`Worker launch identity could not be reserved before spawn: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		const log = await open(logPath, "a", 0o600);
		try {
			const child = spawn(this.command, this.args, {
				cwd: workspace.path,
				detached: true,
				stdio: ["pipe", log.fd, log.fd],
				env: { ...process.env, STEPSTONE_DISPATCH_SESSION_TOKEN: token },
			});
			const exited = once(child, "exit").then(
				() => "exit" as const,
				() => "exit" as const,
			);
			try {
				await once(child, "spawn");
			} catch (error) {
				await rm(receiptPath, { force: true });
				throw new ProcessLaunchFailure(
					`Worker executable failed before launch: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			const pid = child.pid;
			if (!pid) throw new ProcessPromptFailure("Worker spawned without a process ID");
			const session = {
				binding: this.name,
				metadata: { pid: String(pid), token, logPath, receiptPath },
			};
			try {
				await writePrivateJsonAtomically(receiptPath, { pid, token });
			} catch (error) {
				child.stdin?.destroy();
				child.unref();
				throw new ProcessPromptFailure(
					`Worker launch receipt could not be persisted: ${error instanceof Error ? error.message : String(error)}`,
					session,
				);
			}
			const promptInput = child.stdin;
			if (!promptInput) throw new ProcessPromptFailure("Worker spawned without an input pipe", session);
			const promptSubmission = finished(promptInput).then(
				() => ({ kind: "submitted" as const }),
				(error: unknown) => ({ kind: "error" as const, error }),
			);
			promptInput.end(prompt);
			const startup = await Promise.race([
				exited,
				delay(this.startupGraceMs, "running" as const, { ref: false }),
			]);
			if (startup === "exit") {
				promptInput.destroy();
				child.unref();
				throw new ProcessPromptFailure(
					`Worker exited during the ${this.startupGraceMs}ms startup grace`,
					session,
				);
			}
			const promptOutcome = await Promise.race([
				promptSubmission,
				delay(this.startupGraceMs, { kind: "pending" as const }, { ref: false }),
			]);
			if (promptOutcome.kind !== "submitted") {
				const detail =
					promptOutcome.kind === "error" && promptOutcome.error instanceof Error
						? promptOutcome.error.message
						: "stdin did not finish within the startup grace";
				promptInput.destroy();
				child.unref();
				throw new ProcessPromptFailure(`Worker prompt submission was ambiguous: ${detail}`, session);
			}
			child.unref();
			return session;
		} finally {
			await log.close();
		}
	}
	async verifyInterruptedLaunchClosed(
		_workspace: DispatchWorkspace,
		goal: ProjectGoal,
		launchToken: string,
		operatorConfirmed = false,
	): Promise<LaunchClosureOutcome> {
		if (!z.string().uuid().safeParse(launchToken).success) {
			throw new Error("Interrupted process launch token is invalid");
		}
		const receiptPath = join(this.stateDirectory, "sessions", goal.id, `launch-${launchToken}.json`);
		const journaled = await readOptionalFile(receiptPath);
		if (journaled === undefined) return "proven";
		const receipt = z
			.object({ pid: z.number().int().positive().optional(), token: z.literal(launchToken) })
			.strict()
			.parse(JSON.parse(journaled));
		const release = async () => {
			await rm(receiptPath, { force: true });
		};
		const pid = receipt.pid;
		if (pid === undefined) {
			return await acceptInterruptedLaunchVerdict(
				operatorConfirmed,
				`Interrupted launch ${launchToken} reserved its identity but never journaled a process ID`,
				release,
			);
		}
		if (await carriesSessionToken(pid, launchToken)) {
			throw new Error(`Interrupted dispatch worker PID ${pid} is still live`);
		}
		if (!processExists(-pid)) {
			await release();
			return "proven";
		}
		return await acceptInterruptedLaunchVerdict(
			operatorConfirmed,
			`Process-group ${pid} remains after the interrupted session leader for ${launchToken} exited`,
			release,
		);
	}

	async cleanup(session: DispatchSession, operatorConfirmed = false): Promise<LaunchClosureOutcome> {
		const pid = Number(session.metadata.pid);
		const token = session.metadata.token;
		const receiptPath = session.metadata.receiptPath;
		const receiptRoot = join(this.stateDirectory, "sessions");
		if (
			!Number.isSafeInteger(pid) ||
			pid < 1 ||
			!token ||
			!receiptPath ||
			!receiptPath.startsWith(`${receiptRoot}${sep}`)
		) {
			throw new Error("Process session metadata is incomplete");
		}
		const release = async () => {
			await rm(receiptPath, { force: true });
		};
		if (!(await carriesSessionToken(pid, token))) {
			if (!processExists(-pid)) {
				await release();
				return "proven";
			}
			return await acceptInterruptedLaunchVerdict(
				operatorConfirmed,
				`Process-group ${pid} remains after its verifiable session leader exited`,
				release,
			);
		}
		process.kill(-pid, "SIGTERM");
		for (let attempt = 0; attempt < 40; attempt += 1) {
			if (!processExists(-pid)) {
				await rm(receiptPath, { force: true });
				return "proven";
			}
			await delay(50);
		}
		throw new Error(`Process-group ${pid} remained live after SIGTERM`);
	}
}

class HerdrAmbiguousFailure extends Error implements SessionLaunchFailure {
	readonly ambiguous = true;
	readonly session: DispatchSession;
	constructor(message: string, session: DispatchSession) {
		super(message);
		this.session = session;
	}
}

export class HerdrSessionBinding implements SessionBinding {
	readonly name = "herdr";
	private readonly agentKind: string;
	private readonly promptTimeoutMs: number;
	private readonly stateDirectory: string;

	constructor(agentKind: string, stateDirectory: string, promptTimeoutMs = 300000) {
		this.agentKind = agentKind;
		this.stateDirectory = stateDirectory;
		this.promptTimeoutMs = promptTimeoutMs;
	}

	async launch(
		workspace: DispatchWorkspace,
		goal: ProjectGoal,
		prompt: string,
		launchToken: string = randomUUID(),
	): Promise<DispatchSession> {
		const sessionDirectory = join(this.stateDirectory, "sessions", goal.id);
		await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
		const promptPath = join(sessionDirectory, "prompt.txt");
		const receiptPath = join(sessionDirectory, `herdr-launch-${launchToken}.json`);
		await writeFile(promptPath, prompt, { encoding: "utf8", mode: 0o600 });
		const agentName = herdrAgentName(goal.id);
		const beforePaneIds = (await this.listPanes(workspace.path))
			.map((pane) => pane.pane_id)
			.filter((id): id is string => typeof id === "string");
		await writePrivateJsonAtomically(receiptPath, {
			launchToken,
			workspace: workspace.path,
			agentName,
			beforePaneIds,
		});
		let paneId: string | undefined;
		try {
			const split = await runCommand(
				"herdr",
				["pane", "split", "--current", "--direction", "right", "--cwd", workspace.path, "--no-focus"],
				workspace.path,
			);
			const parsed = JSON.parse(split.stdout) as { result?: { pane?: { pane_id?: unknown } } };
			if (typeof parsed.result?.pane?.pane_id !== "string") {
				throw new Error("Herdr split response did not contain result.pane.pane_id");
			}
			paneId = parsed.result.pane.pane_id;
			await writePrivateJsonAtomically(receiptPath, {
				launchToken,
				workspace: workspace.path,
				agentName,
				beforePaneIds,
				paneId,
			});
			await runCommand(
				"herdr",
				["agent", "start", agentName, "--kind", this.agentKind, "--pane", paneId],
				workspace.path,
			);
		} catch (error) {
			if (!paneId) {
				if (!isUnexecutableCommand(error)) {
					throw new HerdrAmbiguousFailure(
						`Herdr pane creation outcome is ambiguous: ${error instanceof Error ? error.message : String(error)}`,
						{
							binding: this.name,
							metadata: {
								workspace: workspace.path,
								pane: "unknown",
								promptPath,
								receiptPath,
								beforePaneIds: JSON.stringify(beforePaneIds),
								agentName,
							},
						},
					);
				}
				await rm(promptPath, { force: true });
				await rm(receiptPath, { force: true });
				throw error;
			}
			try {
				await this.closePane(paneId, workspace.path);
				await rm(promptPath, { force: true });
				await rm(receiptPath, { force: true });
			} catch (cleanupError) {
				throw new HerdrAmbiguousFailure(
					`Herdr pre-prompt cleanup could not prove pane ${paneId} closed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
					{
						binding: this.name,
						metadata: { paneId, workspace: workspace.path, promptPath, receiptPath, agentName },
					},
				);
			}
			throw error;
		}
		if (!paneId) throw new Error("Herdr launch reached an impossible state without a pane ID");
		const session = {
			binding: this.name,
			metadata: { paneId, workspace: workspace.path, promptPath, receiptPath, agentName },
		};
		const promptInstruction = `Read the complete Stepstone goal context from ${promptPath} and follow it exactly.`;
		try {
			await runCommand(
				"herdr",
				["agent", "prompt", paneId, promptInstruction, "--wait", "--timeout", String(this.promptTimeoutMs)],
				workspace.path,
			);
			return session;
		} catch (error) {
			throw new HerdrAmbiguousFailure(
				`Herdr prompt outcome is ambiguous: ${error instanceof Error ? error.message : String(error)}`,
				session,
			);
		}
	}

	async verifyInterruptedLaunchClosed(
		workspace: DispatchWorkspace,
		goal: ProjectGoal,
		launchToken: string,
		operatorConfirmed = false,
	): Promise<LaunchClosureOutcome> {
		const receiptPath = join(this.stateDirectory, "sessions", goal.id, `herdr-launch-${launchToken}.json`);
		const promptPath = join(this.stateDirectory, "sessions", goal.id, "prompt.txt");
		const journaled = await readOptionalFile(receiptPath);
		if (journaled === undefined) {
			await rm(promptPath, { force: true });
			return "proven";
		}
		const receipt = z
			.object({
				launchToken: z.literal(launchToken),
				workspace: z.literal(workspace.path),
				agentName: z.literal(herdrAgentName(goal.id)),
				beforePaneIds: z.array(z.string()),
				paneId: z.string().optional(),
			})
			.strict()
			.parse(JSON.parse(journaled));
		const release = async () => {
			await rm(receiptPath, { force: true });
			await rm(promptPath, { force: true });
		};
		let panes: Array<{ pane_id?: string }>;
		let owned: string | undefined;
		try {
			panes = await this.listPanes(workspace.path);
			owned = await this.findOwnedAgentPane(receipt.agentName, workspace.path);
		} catch (error) {
			return await acceptInterruptedLaunchVerdict(
				operatorConfirmed,
				`Herdr could not be asked whether pane custody for ${launchToken} survives: ${error instanceof Error ? error.message : String(error)}`,
				release,
			);
		}
		if (owned) throw new Error(`Interrupted Herdr worker pane ${owned} is still live`);
		if (receipt.paneId) {
			if (panes.some((pane) => pane.pane_id === receipt.paneId)) {
				throw new Error(`Interrupted Herdr pane ${receipt.paneId} is still live`);
			}
		} else {
			const previous = new Set(receipt.beforePaneIds);
			if (panes.some((pane) => pane.pane_id && !previous.has(pane.pane_id))) {
				return await acceptInterruptedLaunchVerdict(
					operatorConfirmed,
					"An unidentified post-launch Herdr pane is still live",
					release,
				);
			}
		}
		await release();
		return "proven";
	}

	async cleanup(session: DispatchSession, operatorConfirmed = false): Promise<LaunchClosureOutcome> {
		const cwd = session.metadata.workspace;
		const promptPath = session.metadata.promptPath;
		const receiptPath = session.metadata.receiptPath;
		const agentName = session.metadata.agentName;
		if (!cwd || !promptPath || !receiptPath || !agentName) {
			throw new Error("Herdr session ownership metadata is incomplete");
		}
		const finish = async () => {
			await rm(promptPath, { force: true });
			await rm(receiptPath, { force: true });
		};
		const paneId = session.metadata.paneId;
		let panes: Array<{ pane_id?: string }>;
		let inventoried: string | undefined;
		try {
			panes = await this.listPanes(cwd);
			inventoried = paneId ? await this.findOwnedAgentPane(agentName, cwd) : undefined;
		} catch (error) {
			return await acceptInterruptedLaunchVerdict(
				operatorConfirmed,
				`Herdr could not be asked whether pane custody for ${agentName} survives: ${error instanceof Error ? error.message : String(error)}`,
				finish,
			);
		}
		if (paneId) {
			const owned = inventoried;
			if (owned !== undefined && owned !== paneId) {
				throw new Error(`Herdr agent ${agentName} does not authenticate pane ${paneId}`);
			}
			if (!panes.some((pane) => pane.pane_id === paneId)) {
				if (owned !== undefined) {
					throw new Error(`Herdr agent ${agentName} reports a pane absent from the pane inventory`);
				}
				await finish();
				return "proven";
			}
			if (!owned) {
				return await acceptInterruptedLaunchVerdict(
					operatorConfirmed,
					`Herdr could not authenticate live pane ${paneId} against agent ${agentName}`,
					finish,
				);
			}
			await this.closePane(paneId, cwd);
		} else {
			const before = z.array(z.string()).safeParse(JSON.parse(session.metadata.beforePaneIds ?? "null"));
			if (!before.success) throw new Error("Herdr session has no valid pre-launch pane snapshot");
			const previous = new Set(before.data);
			const candidates = panes.filter(
				(pane): pane is { pane_id: string } =>
					typeof pane.pane_id === "string" && !previous.has(pane.pane_id),
			);
			if (candidates.length === 0) {
				await finish();
				return "proven";
			}
			let owned: string | undefined;
			try {
				owned = await this.ownedAgentPane(agentName, cwd);
			} catch (error) {
				return await acceptInterruptedLaunchVerdict(
					operatorConfirmed,
					`Herdr could not be asked which post-launch pane belongs to agent ${agentName}: ${error instanceof Error ? error.message : String(error)}`,
					finish,
				);
			}
			if (!candidates.some((pane) => pane.pane_id === owned)) {
				return await acceptInterruptedLaunchVerdict(
					operatorConfirmed,
					"Herdr did not authenticate any post-launch pane to this persisted agent; custody remains ambiguous",
					finish,
				);
			}
			await this.closePane(owned, cwd);
		}
		await finish();
		return "proven";
	}

	private async findOwnedAgentPane(agentName: string, cwd: string): Promise<string | undefined> {
		try {
			return await this.ownedAgentPane(agentName, cwd);
		} catch (error) {
			if (error instanceof CommandFailure) return undefined;
			throw error;
		}
	}

	private async ownedAgentPane(agentName: string, cwd: string): Promise<string> {
		const response = z
			.object({
				result: z.object({
					agent: z.object({ pane_id: z.string(), cwd: z.string() }),
				}),
			})
			.parse(JSON.parse((await runCommand("herdr", ["agent", "get", agentName], cwd)).stdout));
		if (response.result.agent.cwd !== cwd) {
			throw new Error(`Herdr agent ${agentName} belongs to another workspace`);
		}
		return response.result.agent.pane_id;
	}

	private async closePane(paneId: string, cwd: string): Promise<void> {
		if (!(await this.listPanes(cwd)).some((pane) => pane.pane_id === paneId)) return;
		await runCommand("herdr", ["pane", "close", paneId], cwd);
		if ((await this.listPanes(cwd)).some((pane) => pane.pane_id === paneId)) {
			throw new Error(`Herdr pane ${paneId} remains after close`);
		}
	}

	private async listPanes(cwd: string): Promise<Array<{ pane_id?: string }>> {
		const listed = z
			.object({ result: z.object({ panes: z.array(z.object({ pane_id: z.string().optional() })) }) })
			.parse(JSON.parse((await runCommand("herdr", ["pane", "list"], cwd)).stdout));
		return listed.result.panes;
	}
}
function herdrAgentName(goalId: string): string {
	return `ss-${goalId.slice(0, 18)}-${checksum(goalId)}`.slice(0, 32);
}

function checksum(value: string): string {
	let hash = 2166136261;
	for (const byte of Buffer.from(value)) {
		hash ^= byte;
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(36);
}

export class GitHubMergeEvidenceBinding implements MergeEvidenceBinding {
	private readonly repositoryRoot: string;
	constructor(repositoryRoot: string) {
		this.repositoryRoot = repositoryRoot;
	}

	async findMerged(
		branch: string,
		targetBranch: string,
		claimedAt: string,
	): Promise<MergeEvidence | undefined> {
		const { stdout } = await runCommand(
			"gh",
			[
				"pr",
				"list",
				"--state",
				"merged",
				"--head",
				branch,
				"--base",
				targetBranch,
				"--limit",
				"20",
				"--json",
				"headRefName,baseRefName,createdAt,mergedAt,mergeCommit,url",
			],
			this.repositoryRoot,
		);
		const entries = z
			.array(
				z.object({
					headRefName: z.string(),
					baseRefName: z.string(),
					createdAt: timestampSchema,
					mergedAt: timestampSchema,
					mergeCommit: z.object({ oid: z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/) }),
					url: z.string().url(),
				}),
			)
			.parse(JSON.parse(stdout));
		const exact = entries.find(
			(entry) =>
				entry.headRefName === branch &&
				entry.baseRefName === targetBranch &&
				Date.parse(entry.createdAt) >= Date.parse(claimedAt) &&
				Date.parse(entry.mergedAt) >= Date.parse(claimedAt),
		);
		if (!exact) return undefined;
		return {
			url: exact.url,
			headBranch: branch,
			baseBranch: targetBranch,
			createdAt: exact.createdAt,
			mergedAt: exact.mergedAt,
			mergeCommit: exact.mergeCommit.oid,
		};
	}

	async syncTarget(evidence: MergeEvidence): Promise<string> {
		await runCommand("git", ["check-ref-format", "--branch", evidence.baseBranch], this.repositoryRoot);
		const currentBranch = (
			await runCommand("git", ["branch", "--show-current"], this.repositoryRoot)
		).stdout.trim();
		if (currentBranch !== evidence.baseBranch) {
			throw new Error(
				`Dispatch target is ${evidence.baseBranch}, but the canonical checkout is on ${currentBranch || "detached HEAD"}`,
			);
		}
		await runCommand("git", ["fetch", "--no-tags", "origin", evidence.baseBranch], this.repositoryRoot);
		const remote = `refs/remotes/origin/${evidence.baseBranch}`;
		try {
			await runCommand(
				"git",
				["merge-base", "--is-ancestor", evidence.mergeCommit, remote],
				this.repositoryRoot,
			);
		} catch {
			throw new Error(
				`Merge commit ${evidence.mergeCommit} is not reachable from updated target ${evidence.baseBranch}`,
			);
		}
		await runCommand("git", ["merge", "--ff-only", remote], this.repositoryRoot);
		const revision = (await runCommand("git", ["rev-parse", "HEAD"], this.repositoryRoot)).stdout.trim();
		const targetRevision = (
			await runCommand("git", ["rev-parse", remote], this.repositoryRoot)
		).stdout.trim();
		if (revision !== targetRevision)
			throw new Error("Canonical target checkout did not reach the fetched revision");
		return revision;
	}
}
