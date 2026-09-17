import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import type { BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import {
	link,
	lstat,
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
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { z } from "zod";
import { WorklistApplicationService } from "./application-service.ts";
import type { WorkspaceActivity } from "./claim-evidence.ts";
import type {
	DispatchGoalBacking,
	DispatchGoalFile,
	DispatchPhase,
	DispatchRun,
	DispatchStateStore,
	DispatchWorkspace,
	MergeEvidence,
	MergeEvidenceBinding,
	RoadmapBinding,
	RoadmapSnapshot,
	WorkspaceBinding,
	WorkspaceCleanupOptions,
} from "./dispatch-driver.ts";
import { DISPATCH_GOAL_FILE, DispatchBoundaryError } from "./dispatch-driver.ts";
import { acquireFileLock } from "./file-lock.ts";
import { createWorklistLocator } from "./git.ts";
import { WORKLIST_ERROR_CODES } from "./result-envelope.ts";
import type { ProjectGoal } from "./types.ts";

interface CommandResult {
	stdout: string;
	stderr: string;
}

class CommandFailure extends Error {
	readonly status: number | null;
	constructor(command: string, status: number | null) {
		super(
			`${command} failed${status === null ? "" : ` with exit code ${status}`}; command arguments and stderr are redacted`,
		);
		this.name = "CommandFailure";
		this.status = status;
	}
}

async function runCommand(command: string, args: string[], cwd: string): Promise<CommandResult> {
	const child = spawn(command, args, {
		cwd,
		stdio: ["ignore", "pipe", "pipe"],
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
	const [status] = (await once(child, "close")) as [number | null, NodeJS.Signals | null];
	if (status !== 0) throw new CommandFailure(command, status);
	return { stdout, stderr };
}

function requireGoal(result: Awaited<ReturnType<WorklistApplicationService["execute"]>>): ProjectGoal {
	if (!result.ok) throw new DispatchBoundaryError(result.error);
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
		if (!result.ok) throw new DispatchBoundaryError(result.error);
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
		binding: z.literal("worktree"),
		path: absoluteNormalizedPath,
		metadata: metadataSchema,
	})
	.strict();
const entrySchema = z
	.object({
		goal: goalSchema,
		branch: safeString,
		phase: z.enum([
			"preparing",
			"acquiring",
			"claiming",
			"prepared",
			"ambiguous",
			"releasing",
			"released",
			"completed",
			"cleanup-pending",
			"cleaned",
		]),
		workspace: workspaceSchema.optional(),
		preparationFailure: z
			.object({
				stage: z.enum([
					"workspace-acquisition",
					"workspace-verification",
					"goal-file-handoff",
					"goal-file-verification",
					"roadmap-claim",
				]),
				classification: z.enum(["refused", "ambiguous"]),
				message: safeString,
				recordedAt: timestampSchema,
				error: z
					.object({
						code: z.enum(WORKLIST_ERROR_CODES),
						message: safeString,
						retryable: z.boolean(),
						conflict: z
							.discriminatedUnion("type", [
								z
									.object({
										type: z.literal("revision"),
										expectedRevision: z.string().optional(),
										actualRevision: z.string().optional(),
										resolution: z.literal("refresh-and-retry"),
									})
									.strict(),
								z
									.object({
										type: z.literal("goal-updated-at"),
										id: goalIdSchema,
										expectedUpdatedAt: timestampSchema,
										actualUpdatedAt: timestampSchema,
										resolution: z.literal("refresh-and-retry"),
									})
									.strict(),
							])
							.optional(),
						details: z.record(z.string(), z.unknown()).optional(),
					})
					.strict()
					.optional(),
			})
			.strict()
			.optional(),
		claimUpdatedAt: timestampSchema.optional(),
		releaseUpdatedAt: timestampSchema.optional(),
		completionIntentAt: timestampSchema.optional(),
		completionUpdatedAt: timestampSchema.optional(),
		cleanupMarker: z.string().uuid().optional(),
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
		goalFile: z
			.object({
				path: z.literal(DISPATCH_GOAL_FILE),
				sha256: z.string().regex(/^[0-9a-f]{64}$/),
				ownershipId: z.string().uuid().optional(),
				backing: z
					.object({
						name: z.string().regex(/^\.stepstone-goal-[0-9a-f-]{36}\.owned$/),
						device: z.string().regex(/^\d+$/),
						inode: z.string().regex(/^\d+$/),
					})
					.strict()
					.optional(),
				state: z.enum(["pending", "written"]),
			})
			.strict()
			.superRefine((receipt, context) => {
				if (receipt.backing && !receipt.ownershipId) {
					context.addIssue({ code: "custom", message: "backing identity requires ownership" });
				}
			})
			.optional(),
		message: z.string().optional(),
		updatedAt: timestampSchema,
	})
	.strict();
const workspaceConfigSchema = z.object({ workspaceParent: absoluteNormalizedPath.optional() }).strict();
const runSchema = z
	.object({
		version: z.literal(2),
		id: z.string().regex(/^[A-Za-z0-9_-]+$/),
		repositoryRoot: absoluteNormalizedPath,
		approvedGoalIds: z.array(goalIdSchema).min(1),
		maxParallel: z.number().int().positive().max(1024),
		baseRef: safeString.optional(),
		baseRevision: z
			.string()
			.regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/)
			.optional(),
		targetBranch: safeString,
		targetRevision: z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/),
		workspaceConfig: workspaceConfigSchema,
		createdAt: timestampSchema,
		updatedAt: timestampSchema,
		entries: z.record(goalIdSchema, entrySchema),
		lastPass: z
			.object({
				outcome: z.enum(["no-ready-work", "capacity-full", "prepared", "refused", "mixed"]),
				attemptedGoalIds: z.array(goalIdSchema),
				preparedGoalIds: z.array(goalIdSchema),
				refusedGoalIds: z.array(goalIdSchema),
				recordedAt: timestampSchema,
			})
			.strict()
			.optional(),
	})
	.strict()
	.superRefine((run, context) => {
		if (new Set(run.approvedGoalIds).size !== run.approvedGoalIds.length) {
			context.addIssue({ code: "custom", path: ["approvedGoalIds"], message: "must be unique" });
		}

		if (Boolean(run.baseRef) !== Boolean(run.baseRevision)) {
			context.addIssue({
				code: "custom",
				path: ["baseRef"],
				message: "base ref and revision must be stored together",
			});
		}

		const approved = new Set(run.approvedGoalIds);
		if (run.lastPass) {
			const attempted = new Set(run.lastPass.attemptedGoalIds);
			const prepared = new Set(run.lastPass.preparedGoalIds);
			const refused = new Set(run.lastPass.refusedGoalIds);
			if (
				attempted.size !== run.lastPass.attemptedGoalIds.length ||
				prepared.size !== run.lastPass.preparedGoalIds.length ||
				refused.size !== run.lastPass.refusedGoalIds.length
			) {
				context.addIssue({ code: "custom", path: ["lastPass"], message: "goal IDs must be unique" });
			}
			if (
				[...prepared].some((id) => refused.has(id) || !attempted.has(id)) ||
				[...refused].some((id) => !attempted.has(id)) ||
				[...attempted].some((id) => !prepared.has(id) && !refused.has(id))
			) {
				context.addIssue({
					code: "custom",
					path: ["lastPass"],
					message: "attempted goals must partition into prepared and refused goals",
				});
			}
			const expectedOutcome =
				prepared.size > 0 && refused.size > 0
					? "mixed"
					: refused.size > 0
						? "refused"
						: prepared.size > 0
							? "prepared"
							: run.lastPass.outcome;
			if (
				expectedOutcome !== run.lastPass.outcome ||
				(attempted.size === 0 && !["no-ready-work", "capacity-full"].includes(run.lastPass.outcome))
			) {
				context.addIssue({
					code: "custom",
					path: ["lastPass", "outcome"],
					message: "does not match results",
				});
			}
			if ([...attempted].some((id) => !approved.has(id))) {
				context.addIssue({
					code: "custom",
					path: ["lastPass", "attemptedGoalIds"],
					message: "must name only approved goals",
				});
			}
		}
		for (const [id, entry] of Object.entries(run.entries)) {
			const path = ["entries", id];
			if (entry.goal.id !== id || !approved.has(id)) {
				context.addIssue({ code: "custom", path, message: "entry ID must be an approved goal ID" });
			}
			const expectedBranch = run.baseRevision ? `stepstone/${run.id}/${id}` : `stepstone/${id}`;
			if (entry.branch !== expectedBranch) {
				context.addIssue({
					code: "custom",
					path: [...path, "branch"],
					message: "does not match the goal ID",
				});
			}
			if (entry.workspace) {
				const expectedPath = join(
					run.workspaceConfig.workspaceParent ?? dirname(run.repositoryRoot),
					`stepstone-${id}`,
				);
				if (
					entry.workspace.binding !== "worktree" ||
					entry.workspace.path !== expectedPath ||
					!z.string().uuid().safeParse(entry.workspace.metadata.marker).success ||
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
			}
			const workspaceRequiredPhases: DispatchPhase[] = [
				"claiming",
				"prepared",
				"releasing",
				"released",
				"completed",
				"cleanup-pending",
			];
			const claimRequiredPhases: DispatchPhase[] = [
				"prepared",
				"releasing",
				"released",
				"completed",
				"cleanup-pending",
			];
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
			if ((entry.phase === "preparing" || entry.phase === "cleaned") && entry.workspace) {
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
				!["prepared", "ambiguous", "completed", "cleanup-pending", "cleaned"].includes(entry.phase)
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
	return result.data as DispatchRun;
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
		const release = await acquireFileLock(target, {
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
		const release = await acquireFileLock(this.directory, {
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

const workspaceMarkerSchema = z
	.object({
		marker: z.string().uuid(),
		binding: z.literal("worktree"),
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
export async function resolveDispatchSelection(
	repositoryRoot: string,
	options: { baseRef?: string; targetBranch?: string } = {},
): Promise<{ baseRef: string; baseRevision: string; targetBranch: string }> {
	const baseRef = options.baseRef ?? "HEAD";
	if (!baseRef.trim() || baseRef.includes("\0")) throw new Error("Dispatch base ref is invalid");
	const baseRevision = (
		await runCommand(
			"git",
			["rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`],
			repositoryRoot,
		)
	).stdout.trim();
	if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(baseRevision)) {
		throw new Error("Dispatch base ref did not resolve to one exact commit");
	}
	const currentBranch = (await runCommand("git", ["branch", "--show-current"], repositoryRoot)).stdout.trim();
	const targetBranch = options.targetBranch ?? currentBranch;
	if (!targetBranch) {
		throw new Error("Dispatch requires --target when the canonical checkout has detached HEAD");
	}
	await runCommand("git", ["check-ref-format", "--branch", targetBranch], repositoryRoot);
	return { baseRef, baseRevision, targetBranch };
}

const goalFileExcludePatterns = [
	`/${DISPATCH_GOAL_FILE}`,
	`/${DISPATCH_GOAL_FILE}.*.tmp`,
	"/.stepstone-goal-*.owned",
	"/.stepstone-goal-*.tmp",
];

async function ensureGoalFileIsIgnored(repositoryRoot: string): Promise<void> {
	const commonDirectory = await realpath(
		resolve(
			repositoryRoot,
			(await runCommand("git", ["rev-parse", "--git-common-dir"], repositoryRoot)).stdout.trim(),
		),
	);
	const excludePath = join(commonDirectory, "info", "exclude");
	await mkdir(dirname(excludePath), { recursive: true, mode: 0o700 });
	await writeFile(excludePath, "", { flag: "a" });
	const release = await acquireFileLock(excludePath, {
		realpath: false,
		retries: { retries: 20, factor: 1.5, minTimeout: 10, maxTimeout: 250 },
		stale: 10000,
	});
	try {
		const contents = await readFile(excludePath, "utf8");
		const existing = new Set(contents.split(/\r?\n/u));
		const missing = goalFileExcludePatterns.filter((pattern) => !existing.has(pattern));
		if (missing.length === 0) return;
		const separator = contents.length === 0 || contents.endsWith("\n") ? "" : "\n";
		await writeFile(
			excludePath,
			`${separator}# Stepstone prepared-workspace goal handoff\n${missing.join("\n")}\n`,
			{ flag: "a" },
		);
	} finally {
		await release();
	}
}

function isSameFile(left: BigIntStats, right: BigIntStats): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function backingIdentity(name: string, details: BigIntStats): DispatchGoalBacking {
	return { name, device: details.dev.toString(), inode: details.ino.toString() };
}

function matchesBacking(details: BigIntStats, backing: DispatchGoalBacking): boolean {
	return details.dev.toString() === backing.device && details.ino.toString() === backing.inode;
}

async function hashGoalFileHandle(handle: FileHandle): Promise<string> {
	const hash = createHash("sha256");
	const buffer = Buffer.allocUnsafe(64 * 1024);
	let position = 0;
	for (;;) {
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
		if (bytesRead === 0) return hash.digest("hex");
		hash.update(buffer.subarray(0, bytesRead));
		position += bytesRead;
	}
}

async function authenticateGoalBackingHandle(
	handle: FileHandle,
	path: string,
	backing: DispatchGoalBacking,
	expectedSha256: string,
): Promise<BigIntStats> {
	const details = await handle.stat({ bigint: true });
	if (!details.isFile() || !matchesBacking(details, backing)) {
		throw new Error(`Refusing goal handoff because owned backing ${path} is invalid`);
	}
	if ((await hashGoalFileHandle(handle)) !== expectedSha256) {
		throw new Error(`Refusing goal handoff because owned backing ${path} has conflicting content`);
	}
	return details;
}

async function authenticateGoalBacking(
	path: string,
	backing: DispatchGoalBacking,
	expectedSha256: string,
): Promise<BigIntStats> {
	const handle = await open(path, "r");
	try {
		return await authenticateGoalBackingHandle(handle, path, backing, expectedSha256);
	} finally {
		await handle.close();
	}
}

function validateGoalFileReceipt(receipt: DispatchGoalFile, content: string): void {
	if (
		receipt.path !== DISPATCH_GOAL_FILE ||
		createHash("sha256").update(content, "utf8").digest("hex") !== receipt.sha256
	) {
		throw new Error("Refusing a goal handoff whose receipt does not match its content");
	}
}

async function ensureGoalPathsAreLocalState(workspacePath: string, names: string[]): Promise<void> {
	if ((await runCommand("git", ["ls-files", "--stage", "--", ...names], workspacePath)).stdout.trim()) {
		throw new Error("Refusing goal handoff because its final or backing path is tracked by Git");
	}
	for (const name of names) {
		await runCommand("git", ["check-ignore", "--quiet", "--", name], workspacePath);
	}
}

async function verifyCleanupContents(
	workspace: DispatchWorkspace,
	goalFile?: DispatchGoalFile,
): Promise<void> {
	const gitdir = await workspaceGitDirectory(workspace.path);
	for (const operation of [
		"MERGE_HEAD",
		"CHERRY_PICK_HEAD",
		"REVERT_HEAD",
		"rebase-merge",
		"rebase-apply",
		"sequencer",
		"BISECT_LOG",
	]) {
		try {
			await lstat(join(gitdir, operation));
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
			throw error;
		}
		throw new Error(`Refusing cleanup because a Git operation is in progress (${operation})`);
	}
	const flags = (await runCommand("git", ["ls-files", "-v", "-z"], workspace.path)).stdout.split("\0");
	if (flags.some((file) => /^[a-zS] /u.test(file))) {
		throw new Error(
			"Refusing cleanup because assume-unchanged or skip-worktree index flags prevent verifying local changes",
		);
	}
	const status = (
		await runCommand(
			"git",
			["status", "--porcelain=v1", "-z", "--untracked-files=no", "--ignore-submodules=none"],
			workspace.path,
		)
	).stdout;
	if (status)
		throw new Error(
			"Refusing cleanup because the workspace has uncommitted tracked changes (including staged changes or submodule changes)",
		);
	const others = (await runCommand("git", ["ls-files", "--others", "-z"], workspace.path)).stdout
		.split("\0")
		.filter(Boolean);
	const owned = new Set<string>();
	if (goalFile?.backing) {
		const names = [goalFile.path, goalFile.backing.name];
		if (others.some((name) => names.includes(name))) {
			try {
				await ensureGoalPathsAreLocalState(workspace.path, names);
				await authenticateGoalBacking(
					join(workspace.path, goalFile.backing.name),
					goalFile.backing,
					goalFile.sha256,
				);
				await verifyPublishedGoalFileIdentity(join(workspace.path, goalFile.path), goalFile.backing);
			} catch (error) {
				throw new Error(
					"Refusing cleanup because the ignored goal handoff has uncommitted changes or unverifiable ownership",
					{ cause: error },
				);
			}
			for (const name of names) owned.add(name);
		}
	}
	const unowned = others.filter((name) => !owned.has(name));
	if (unowned.length) {
		throw new Error(
			`Refusing cleanup because the workspace has uncommitted untracked or ignored files: ${unowned.map((name) => JSON.stringify(name)).join(", ")}`,
		);
	}
}

async function verifyCleanupHistory(
	repositoryRoot: string,
	branchTip: string,
	targetBranch: string,
	targetRevision: string,
): Promise<void> {
	const remoteTips = new Set<string>();
	const remotes = (await runCommand("git", ["remote"], repositoryRoot)).stdout.trim();
	if (!remotes) {
		throw new Error("Refusing cleanup because pushed commits cannot be verified: no configured Git remote");
	}
	try {
		for (const remote of remotes.split("\n")) {
			await runCommand("git", ["fetch", "--prune", "--no-tags", remote], repositoryRoot);
			const advertised = (await runCommand("git", ["ls-remote", "--heads", remote], repositoryRoot)).stdout;
			for (const line of advertised.trim().split("\n").filter(Boolean)) {
				const tip = line.split("\t")[0];
				if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(tip)) throw new Error("Invalid remote commit");
				remoteTips.add(tip);
			}
		}
	} catch (error) {
		throw new Error(
			"Refusing cleanup because pushed commits could not be verified: refreshing remote refs failed",
			{ cause: error },
		);
	}
	let unpushed: string;
	try {
		// Stale refs outside a remote's fetchspec are not proof that work was pushed.
		unpushed = (
			await runCommand(
				"git",
				["rev-list", "--count", branchTip, ...[...remoteTips].map((tip) => `^${tip}`)],
				repositoryRoot,
			)
		).stdout.trim();
	} catch (error) {
		throw new Error("Refusing cleanup because pushed commit reachability could not be verified", {
			cause: error,
		});
	}
	if (unpushed !== "0") {
		throw new Error(
			`Refusing cleanup because the branch has ${unpushed} unpushed commit(s) (not reachable from refreshed remote refs)`,
		);
	}
	await runCommand("git", ["check-ref-format", `refs/heads/${targetBranch}`], repositoryRoot);
	if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(targetRevision)) {
		throw new Error("Refusing cleanup because the persisted target revision is invalid");
	}
	try {
		await runCommand("git", ["merge-base", "--is-ancestor", branchTip, targetRevision], repositoryRoot);
	} catch (error) {
		if (error instanceof CommandFailure && error.status === 1) {
			throw new Error(`Refusing cleanup because the branch has not merged into target ${targetBranch}`);
		}
		throw new Error(
			`Refusing cleanup because merge state against target ${targetBranch} could not be verified`,
			{ cause: error },
		);
	}
}

async function verifyPublishedGoalFileIdentity(target: string, backing: DispatchGoalBacking): Promise<void> {
	const finalDetails = await lstat(target, { bigint: true });
	if (!finalDetails.isFile() || !matchesBacking(finalDetails, backing)) {
		throw new Error(`Refusing goal handoff because ${target} is not owned by this dispatch receipt`);
	}
}

export class GitWorktreeBinding implements WorkspaceBinding {
	readonly name = "worktree";
	private readonly repositoryRoot: string;
	private readonly workspaceParent: string;
	private goalFilePublicationHookPending = true;
	private goalFileGitVerificationHookPending = true;

	constructor(repositoryRoot: string, workspaceParent = dirname(repositoryRoot)) {
		this.repositoryRoot = repositoryRoot;
		this.workspaceParent = workspaceParent;
	}

	protected afterGoalFilePublication(_target: string): Promise<void> {
		return Promise.resolve();
	}

	protected afterGoalFileGitVerification(_target: string): Promise<void> {
		return Promise.resolve();
	}

	private async runGoalFilePublicationHook(target: string): Promise<void> {
		if (!this.goalFilePublicationHookPending) return;
		this.goalFilePublicationHookPending = false;
		await this.afterGoalFilePublication(target);
	}

	private async runGoalFileGitVerificationHook(target: string): Promise<void> {
		if (!this.goalFileGitVerificationHookPending) return;
		this.goalFileGitVerificationHookPending = false;
		await this.afterGoalFileGitVerification(target);
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

	async observeActivity(workspace: DispatchWorkspace, branch: string): Promise<WorkspaceActivity> {
		await this.verify(workspace, branch);
		const headRevision = (await runCommand("git", ["rev-parse", "HEAD"], workspace.path)).stdout.trim();
		const status = await runCommand(
			"git",
			[
				"--no-optional-locks",
				"status",
				"--porcelain=v1",
				"-z",
				"--untracked-files=all",
				"--ignore-submodules=none",
			],
			workspace.path,
		);
		const reflog = await runCommand(
			"git",
			["reflog", "show", "-1", "--format=%gD", "--date=iso-strict", `refs/heads/${branch}`, "--"],
			workspace.path,
		);
		const timestamp = /@\{([^}]+)\}$/.exec(reflog.stdout.trim())?.[1];
		const activityTime = Date.parse(timestamp ?? "");
		await this.verify(workspace, branch);
		if ((await runCommand("git", ["rev-parse", "HEAD"], workspace.path)).stdout.trim() !== headRevision) {
			throw new Error("Workspace branch changed during observation; inspect again.");
		}
		return {
			path: workspace.path,
			baseRevision: workspace.metadata.base,
			headRevision,
			branchChangedSincePreparation: headRevision !== workspace.metadata.base,
			hasUncommittedChanges: status.stdout.length > 0,
			...(Number.isFinite(activityTime)
				? { lastBranchActivityAt: new Date(activityTime).toISOString() }
				: {}),
		};
	}

	async writeGoalFile(
		workspace: DispatchWorkspace,
		receipt: DispatchGoalFile,
		content: string,
	): Promise<void> {
		if (workspace.binding !== this.name || !receipt.ownershipId || !receipt.backing) {
			throw new Error("Refusing a goal handoff outside this binding's fixed workspace path");
		}
		validateGoalFileReceipt(receipt, content);
		await ensureGoalFileIsIgnored(this.repositoryRoot);
		const target = join(workspace.path, receipt.path);
		await ensureGoalPathsAreLocalState(workspace.path, [receipt.path, receipt.backing.name]);
		const backingPath = join(workspace.path, receipt.backing.name);
		const backingHandle = await open(backingPath, "r");
		try {
			await authenticateGoalBackingHandle(backingHandle, backingPath, receipt.backing, receipt.sha256);
			try {
				await link(backingPath, target);
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
			}
			await verifyPublishedGoalFileIdentity(target, receipt.backing);
			await this.runGoalFilePublicationHook(target);
			await verifyPublishedGoalFileIdentity(target, receipt.backing);
			await authenticateGoalBackingHandle(backingHandle, backingPath, receipt.backing, receipt.sha256);
			await ensureGoalPathsAreLocalState(workspace.path, [receipt.path, receipt.backing.name]);
		} finally {
			await backingHandle.close();
		}
	}

	async verifyGoalFile(
		workspace: DispatchWorkspace,
		receipt: DispatchGoalFile,
		content: string,
	): Promise<void> {
		if (workspace.binding !== this.name || !receipt.ownershipId || !receipt.backing) {
			throw new Error("Refusing to verify a goal handoff outside this binding's fixed workspace path");
		}
		validateGoalFileReceipt(receipt, content);
		const target = join(workspace.path, receipt.path);
		const backingPath = join(workspace.path, receipt.backing.name);
		const backingHandle = await open(backingPath, "r");
		try {
			await authenticateGoalBackingHandle(backingHandle, backingPath, receipt.backing, receipt.sha256);
			await ensureGoalPathsAreLocalState(workspace.path, [receipt.path, receipt.backing.name]);
			await this.runGoalFileGitVerificationHook(target);
			await verifyPublishedGoalFileIdentity(target, receipt.backing);
			await authenticateGoalBackingHandle(backingHandle, backingPath, receipt.backing, receipt.sha256);
		} finally {
			await backingHandle.close();
		}
	}

	async createGoalFileBacking(
		workspace: DispatchWorkspace,
		receipt: DispatchGoalFile,
		content: string,
	): Promise<DispatchGoalBacking> {
		if (workspace.binding !== this.name || !receipt.ownershipId || receipt.backing) {
			throw new Error("Refusing to create goal backing outside a pending ownership transition");
		}
		validateGoalFileReceipt(receipt, content);
		await ensureGoalFileIsIgnored(this.repositoryRoot);
		for (;;) {
			const id = randomUUID();
			const name = `.stepstone-goal-${id}.owned`;
			const temporaryName = `.stepstone-goal-${id}.tmp`;
			await ensureGoalPathsAreLocalState(workspace.path, [receipt.path, name, temporaryName]);
			const temporaryPath = join(workspace.path, temporaryName);
			const backingPath = join(workspace.path, name);
			await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
			try {
				const temporaryDetails = await lstat(temporaryPath, { bigint: true });
				try {
					await link(temporaryPath, backingPath);
				} catch (error) {
					if (error instanceof Error && "code" in error && error.code === "EEXIST") continue;
					throw error;
				}
				const backingDetails = await lstat(backingPath, { bigint: true });
				if (!backingDetails.isFile() || !isSameFile(temporaryDetails, backingDetails)) {
					throw new Error("Goal backing identity changed during exclusive creation");
				}
				return backingIdentity(name, backingDetails);
			} finally {
				await rm(temporaryPath, { force: true });
			}
		}
	}

	async adoptLegacyGoalFile(
		workspace: DispatchWorkspace,
		receipt: DispatchGoalFile,
		content: string,
	): Promise<DispatchGoalBacking | undefined> {
		if (workspace.binding !== this.name || receipt.backing) {
			throw new Error("Refusing legacy goal handoff adoption outside an unowned receipt");
		}
		validateGoalFileReceipt(receipt, content);
		await ensureGoalFileIsIgnored(this.repositoryRoot);
		const target = join(workspace.path, receipt.path);
		if (receipt.state === "pending") {
			const oldName = receipt.ownershipId ? `.stepstone-goal-${receipt.ownershipId}.owned` : undefined;
			await ensureGoalPathsAreLocalState(workspace.path, oldName ? [receipt.path, oldName] : [receipt.path]);
			if (oldName) {
				try {
					await lstat(join(workspace.path, oldName), { bigint: true });
					throw new Error("Refusing legacy pending handoff without persisted backing creation evidence");
				} catch (error) {
					if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
				}
			}
		}
		let finalDetails: BigIntStats;
		try {
			finalDetails = await lstat(target, { bigint: true });
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
			throw error;
		}
		if (!finalDetails.isFile()) {
			throw new Error(`Refusing legacy goal handoff because ${target} is not a regular file`);
		}
		const name = `.stepstone-goal-${randomUUID()}.owned`;
		await ensureGoalPathsAreLocalState(workspace.path, [receipt.path, name]);
		const backingPath = join(workspace.path, name);
		await link(target, backingPath);
		try {
			const [currentFinal, backingDetails] = await Promise.all([
				lstat(target, { bigint: true }),
				lstat(backingPath, { bigint: true }),
			]);
			if (
				!currentFinal.isFile() ||
				!backingDetails.isFile() ||
				!isSameFile(finalDetails, currentFinal) ||
				!isSameFile(currentFinal, backingDetails)
			) {
				throw new Error(`Refusing legacy goal handoff because ${target} could not be verified exactly`);
			}
			const adopted = backingIdentity(name, backingDetails);
			await authenticateGoalBacking(backingPath, adopted, receipt.sha256);
			return adopted;
		} catch (error) {
			await rm(backingPath, { force: true });
			throw error;
		}
	}

	async cleanup(
		workspace: DispatchWorkspace,
		branch: string,
		options: WorkspaceCleanupOptions,
	): Promise<void> {
		const expectedPath = join(this.workspaceParent, `stepstone-${branch.split("/").at(-1)}`);
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
			marker.record.removalBranchTip,
			marker.record.gitdir,
			marker.record.marker,
		);
		let removalRecord = marker.record;
		const branchTip = await currentBranchTip(this.repositoryRoot, branch);
		const removalTip = removalRecord.removalBranchTip ?? branchTip;
		if (!removalTip) throw new Error("Owned worktree branch disappeared before cleanup intent");
		const head = (await runCommand("git", ["rev-parse", "HEAD"], workspace.path)).stdout.trim();
		if (head !== removalTip)
			throw new Error("Refusing cleanup because the workspace HEAD changed after cleanup intent");
		if (options.targetBranch === branch) throw new Error("Refusing cleanup of the dispatch target branch");
		if (!options.force) {
			await verifyCleanupContents(workspace, options.goalFile);
			await verifyCleanupHistory(
				this.repositoryRoot,
				removalTip,
				options.targetBranch,
				options.targetRevision,
			);
			// Fetching may take time; inspect local contents again before destructive steps.
			await verifyCleanupContents(workspace, options.goalFile);
		}
		await verifyRegisteredWorkspace(
			this.repositoryRoot,
			workspace.path,
			branch,
			marker.record.removalBranchTip,
			marker.record.gitdir,
			marker.record.marker,
		);
		if (!removalRecord.removalBranchTip) {
			removalRecord = await journalWorkspaceBranchRemoval(marker.path, removalRecord, removalTip);
		}
		// Retain an inspectable HEAD if removal is interrupted after deleting the branch.
		await runCommand("git", ["update-ref", "--no-deref", "HEAD", removalTip, removalTip], workspace.path);
		removalRecord = await deleteJournaledWorkspaceBranch(
			this.repositoryRoot,
			marker.path,
			removalRecord,
			branch,
			branchTip,
		);
		await runCommand(
			"git",
			["worktree", "remove", ...(options.force ? ["--force"] : []), workspace.path],
			this.repositoryRoot,
		);
		await markWorkspaceRemoved(marker.path, removalRecord);
	}
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
		await runCommand("git", ["fetch", "--no-tags", "origin", evidence.baseBranch], this.repositoryRoot);
		const targetRevision = (
			await runCommand("git", ["rev-parse", "--verify", "FETCH_HEAD^{commit}"], this.repositoryRoot)
		).stdout.trim();
		try {
			await runCommand(
				"git",
				["merge-base", "--is-ancestor", evidence.mergeCommit, targetRevision],
				this.repositoryRoot,
			);
		} catch {
			throw new Error(
				`Merge commit ${evidence.mergeCommit} is not reachable from updated target ${evidence.baseBranch}`,
			);
		}
		return targetRevision;
	}
}
