import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
	link,
	lstat,
	mkdir,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { z } from "zod";
import { WorklistApplicationService } from "./application-service.ts";
import type {
	DispatchPhase,
	DispatchRun,
	DispatchStateStore,
	DispatchWorkspace,
	MergeEvidence,
	MergeEvidenceBinding,
	RoadmapBinding,
	RoadmapSnapshot,
	WorkspaceBinding,
} from "./dispatch-driver.ts";
import { DISPATCH_GOAL_FILE } from "./dispatch-driver.ts";
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
				state: z.enum(["pending", "written"]),
			})
			.strict()
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
		targetBranch: safeString,
		targetRevision: z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/),
		workspaceConfig: workspaceConfigSchema,
		createdAt: timestampSchema,
		updatedAt: timestampSchema,
		entries: z.record(goalIdSchema, entrySchema),
	})
	.strict()
	.superRefine((run, context) => {
		if (new Set(run.approvedGoalIds).size !== run.approvedGoalIds.length) {
			context.addIssue({ code: "custom", path: ["approvedGoalIds"], message: "must be unique" });
		}

		const approved = new Set(run.approvedGoalIds);
		for (const [id, entry] of Object.entries(run.entries)) {
			const path = ["entries", id];
			if (entry.goal.id !== id || !approved.has(id)) {
				context.addIssue({ code: "custom", path, message: "entry ID must be an approved goal ID" });
			}
			if (entry.branch !== `stepstone/${id}`) {
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
export async function currentDispatchTarget(
	repositoryRoot: string,
): Promise<{ branch: string; revision: string }> {
	const branch = (await runCommand("git", ["branch", "--show-current"], repositoryRoot)).stdout.trim();
	if (!branch) throw new Error("Dispatch requires the canonical checkout to be on a branch");
	await runCommand("git", ["check-ref-format", "--branch", branch], repositoryRoot);
	const revision = (await runCommand("git", ["rev-parse", "HEAD"], repositoryRoot)).stdout.trim();
	return { branch, revision };
}

const goalFileExcludePattern = `/${DISPATCH_GOAL_FILE}`;

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
	const release = await lockfile.lock(excludePath, {
		realpath: false,
		retries: { retries: 20, factor: 1.5, minTimeout: 10, maxTimeout: 250 },
		stale: 10000,
	});
	try {
		const contents = await readFile(excludePath, "utf8");
		if (contents.split(/\r?\n/u).includes(goalFileExcludePattern)) return;
		const separator = contents.length === 0 || contents.endsWith("\n") ? "" : "\n";
		await writeFile(
			excludePath,
			`${separator}# Stepstone prepared-workspace goal handoff\n${goalFileExcludePattern}\n`,
			{ flag: "a" },
		);
	} finally {
		await release();
	}
}

async function verifyExactGoalFile(path: string, content: string): Promise<void> {
	const details = await lstat(path);
	if (!details.isFile()) throw new Error(`Refusing goal handoff because ${path} is not a regular file`);
	if ((await readFile(path, "utf8")) !== content) {
		throw new Error(`Refusing goal handoff because ${path} contains different content`);
	}
}

async function writeGoalFileWithoutOverwrite(path: string, content: string): Promise<void> {
	try {
		await verifyExactGoalFile(path, content);
		return;
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
	}
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
	try {
		try {
			await link(temporary, path);
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
		}
		await verifyExactGoalFile(path, content);
	} finally {
		await rm(temporary, { force: true });
	}
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

	async writeGoalFile(
		workspace: DispatchWorkspace,
		path: typeof DISPATCH_GOAL_FILE,
		content: string,
	): Promise<void> {
		if (workspace.binding !== this.name || path !== DISPATCH_GOAL_FILE) {
			throw new Error("Refusing a goal handoff outside this binding's fixed workspace path");
		}
		await ensureGoalFileIsIgnored(this.repositoryRoot);
		const target = join(workspace.path, path);
		await writeGoalFileWithoutOverwrite(target, content);
		await runCommand("git", ["check-ignore", "--quiet", "--no-index", path], workspace.path);
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
