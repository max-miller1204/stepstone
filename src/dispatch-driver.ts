import { createHash, randomUUID } from "node:crypto";
import { readyGoals } from "./dependencies.ts";
import type { ProjectGoal } from "./types.ts";

export const DISPATCH_STATE_VERSION = 2 as const;
export const DISPATCH_GOAL_FILE = "STEPSTONE_GOAL.md" as const;

export type DispatchPhase =
	| "preparing"
	| "acquiring"
	| "claiming"
	| "prepared"
	| "ambiguous"
	| "releasing"
	| "released"
	| "completed"
	| "cleanup-pending"
	| "cleaned";

export interface DispatchWorkspace {
	binding: string;
	path: string;
	metadata: Record<string, string>;
}

export interface DispatchGoalFile {
	path: typeof DISPATCH_GOAL_FILE;
	sha256: string;
	ownershipId?: string;
	backing?: DispatchGoalBacking;
	state: "pending" | "written";
}

export interface DispatchGoalBacking {
	name: string;
	device: string;
	inode: string;
}

export interface DispatchEntry {
	goal: ProjectGoal;
	branch: string;
	phase: DispatchPhase;
	workspace?: DispatchWorkspace;
	completionUpdatedAt?: string;
	completionIntentAt?: string;
	releaseUpdatedAt?: string;
	cleanupMarker?: string;
	claimUpdatedAt?: string;
	mergedPr?: MergeEvidence;
	goalFile?: DispatchGoalFile;
	message?: string;
	updatedAt: string;
}

export interface DispatchRun {
	version: typeof DISPATCH_STATE_VERSION;
	id: string;
	repositoryRoot: string;
	approvedGoalIds: string[];
	maxParallel: number;
	targetBranch: string;
	targetRevision: string;
	workspaceConfig: DispatchWorkspaceConfig;
	createdAt: string;
	updatedAt: string;
	entries: Record<string, DispatchEntry>;
}

export interface DispatchWorkspaceConfig {
	workspaceParent?: string;
}

export interface RoadmapSnapshot {
	goals: ProjectGoal[];
	retiredIds: string[];
}

export interface RoadmapBinding {
	read(): Promise<RoadmapSnapshot>;
	claim(goalId: string, branch: string, expectedUpdatedAt: string): Promise<ProjectGoal>;
	release(goalId: string, claimUpdatedAt: string): Promise<ProjectGoal>;
	complete(goalId: string, expectedUpdatedAt: string): Promise<ProjectGoal>;
}

export interface WorkspaceBinding {
	readonly name: string;
	verify(workspace: DispatchWorkspace, branch: string): Promise<void>;
	acquire(goal: ProjectGoal, branch: string, baseRevision: string): Promise<DispatchWorkspace>;
	createGoalFileBacking(
		workspace: DispatchWorkspace,
		receipt: DispatchGoalFile,
		content: string,
	): Promise<DispatchGoalBacking>;
	adoptLegacyGoalFile(
		workspace: DispatchWorkspace,
		receipt: DispatchGoalFile,
		content: string,
	): Promise<DispatchGoalBacking | undefined>;
	writeGoalFile(workspace: DispatchWorkspace, receipt: DispatchGoalFile, content: string): Promise<void>;
	cleanup(workspace: DispatchWorkspace, branch: string): Promise<void>;
}

export interface MergeEvidence {
	url: string;
	headBranch: string;
	baseBranch: string;
	createdAt: string;
	mergedAt: string;
	mergeCommit: string;
}

export interface MergeEvidenceBinding {
	findMerged(branch: string, targetBranch: string, claimedAt: string): Promise<MergeEvidence | undefined>;
	syncTarget(evidence: MergeEvidence): Promise<string>;
}

export interface DispatchStateStore {
	create(run: DispatchRun): Promise<void>;
	load(runId: string): Promise<DispatchRun>;
	save(run: DispatchRun): Promise<void>;
	list(): Promise<DispatchRun[]>;
	remove(runId: string): Promise<void>;
}

export interface DispatchDependencies {
	roadmap: RoadmapBinding;
	workspace: WorkspaceBinding;
	merges: MergeEvidenceBinding;
	store: DispatchStateStore;
	now?: () => Date;
	id?: () => string;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function hasCanonicalCustody(entry: DispatchEntry): boolean {
	return ["preparing", "acquiring", "claiming", "prepared", "ambiguous", "releasing"].includes(entry.phase);
}

function needsCleanup(entry: DispatchEntry): boolean {
	return entry.phase === "released" || entry.phase === "completed" || entry.phase === "cleanup-pending";
}

function renderGoalFile(goal: ProjectGoal, branch: string): string {
	const dependencies = goal.dependsOn?.length
		? goal.dependsOn.map((dependency) => `- \`${dependency}\``)
		: ["- None"];
	const links = goal.links?.length ? goal.links.map((link) => `- ${link}`) : ["- None"];
	return [
		"# Stepstone Project Goal",
		"",
		"This ignored, workspace-local file is the goal handoff for this prepared checkout.",
		"Stepstone created the workspace for this goal, but did not start or prompt an agent.",
		"",
		`- Goal ID: \`${goal.id}\``,
		`- Branch: \`${branch}\``,
		`- Status when prepared: \`${goal.status}\``,
		`- Goal snapshot updated at: \`${goal.updatedAt}\``,
		...(goal.group ? [`- Group: ${goal.group}`] : []),
		"",
		"## Title",
		"",
		goal.title,
		"",
		"## Description",
		"",
		goal.description?.trim() ? goal.description : "_No description was provided._",
		"",
		"## Dependencies",
		"",
		...dependencies,
		"",
		"## Links",
		"",
		...links,
		"",
		"## Workspace boundary",
		"",
		`Work on \`${branch}\` in this checkout. Do not mutate the Project Goal roadmap from this linked worktree; roadmap mutations belong in the main worktree.`,
		"",
	].join("\n");
}

function sha256(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Claims and prepares approved goals without launching or prompting any agent.
 * A caller can open each reported workspace with whichever harness it chooses.
 */
export class DispatchDriver {
	private readonly now: () => Date;
	private readonly newId: () => string;
	private readonly dependencies: DispatchDependencies;

	constructor(dependencies: DispatchDependencies) {
		this.dependencies = dependencies;
		this.now = dependencies.now ?? (() => new Date());
		this.newId = dependencies.id ?? randomUUID;
	}

	async create(options: {
		repositoryRoot: string;
		approvedGoalIds: string[];
		maxParallel: number;
		targetBranch: string;
		targetRevision: string;
		workspaceConfig: DispatchWorkspaceConfig;
	}): Promise<DispatchRun> {
		if (!Number.isSafeInteger(options.maxParallel) || options.maxParallel < 1) {
			throw new Error("maxParallel must be a positive integer");
		}
		const approvedGoalIds = [...new Set(options.approvedGoalIds.map((id) => id.trim()).filter(Boolean))];
		if (approvedGoalIds.length === 0) throw new Error("At least one approved goal ID is required");
		const snapshot = await this.dependencies.roadmap.read();
		const known = new Set(snapshot.goals.map((goal) => goal.id));
		const unknown = approvedGoalIds.filter((id) => !known.has(id));
		if (unknown.length > 0) throw new Error(`Approved goal IDs were not found: ${unknown.join(", ")}`);
		const timestamp = this.now().toISOString();
		const run: DispatchRun = {
			version: DISPATCH_STATE_VERSION,
			id: this.newId(),
			repositoryRoot: options.repositoryRoot,
			approvedGoalIds,
			maxParallel: options.maxParallel,
			targetBranch: options.targetBranch,
			targetRevision: options.targetRevision,
			workspaceConfig: structuredClone(options.workspaceConfig),
			createdAt: timestamp,
			updatedAt: timestamp,
			entries: {},
		};
		await this.dependencies.store.create(run);
		return run;
	}

	async advance(runId: string): Promise<DispatchRun> {
		const run = await this.dependencies.store.load(runId);
		await this.reconcile(run);
		const slots = run.maxParallel - Object.values(run.entries).filter(hasCanonicalCustody).length;
		if (slots <= 0) return run;
		const snapshot = await this.dependencies.roadmap.read();
		const approved = new Set(run.approvedGoalIds);
		const ready = readyGoals(snapshot.goals, snapshot.retiredIds).filter(
			(goal) => approved.has(goal.id) && !run.entries[goal.id],
		);
		for (const goal of ready.slice(0, slots)) await this.prepare(run, goal);
		return run;
	}

	async recoverRelease(runId: string, goalId: string, explicitClaimUpdatedAt?: string): Promise<DispatchRun> {
		const run = await this.dependencies.store.load(runId);
		const entry = this.requireEntry(run, goalId);
		if (!["claiming", "prepared", "ambiguous", "releasing"].includes(entry.phase)) {
			throw new Error(
				`Goal ${goalId} is in terminal or non-claim phase ${entry.phase}; recovery is not allowed`,
			);
		}
		if (entry.completionIntentAt || entry.completionUpdatedAt || entry.mergedPr) {
			throw new Error(
				`Goal ${goalId} has a journaled completion outcome; resume must reconcile it before release recovery`,
			);
		}
		if (!entry.claimUpdatedAt && explicitClaimUpdatedAt) {
			const snapshot = await this.dependencies.roadmap.read();
			const current = snapshot.goals.find((goal) => goal.id === entry.goal.id);
			if (
				!current ||
				current.branch !== entry.branch ||
				current.updatedAt !== explicitClaimUpdatedAt ||
				(current.status !== "open" && current.status !== "active")
			) {
				throw new Error("Explicit claim token does not match this goal's current claimed branch");
			}
			entry.claimUpdatedAt = explicitClaimUpdatedAt;
			entry.phase = "ambiguous";
			entry.message = "Operator supplied and verified the exact interrupted claim token.";
			await this.persist(run, entry);
		}
		if (!entry.claimUpdatedAt) {
			throw new Error(
				`Goal ${goalId} has no exact claim token; interrupted acquisition requires manual inspection`,
			);
		}
		await this.releaseKnownSafe(run, entry, "Exact prepared claim released by explicit recovery.");
		return run;
	}

	async cleanup(runId: string, goalId?: string): Promise<DispatchRun | undefined> {
		const run = await this.dependencies.store.load(runId);
		const entries = goalId ? [this.requireEntry(run, goalId)] : Object.values(run.entries);
		for (const entry of entries) {
			if (hasCanonicalCustody(entry))
				throw new Error(`Goal ${entry.goal.id} still has custody; recover its claim first`);
			if (needsCleanup(entry)) await this.cleanupEntry(run, entry);
		}
		if (!goalId && Object.values(run.entries).every((entry) => entry.phase === "cleaned")) {
			await this.dependencies.store.remove(run.id);
			return undefined;
		}
		return run;
	}

	private async reconcile(run: DispatchRun): Promise<void> {
		for (const entry of Object.values(run.entries)) {
			if (["preparing", "acquiring", "claiming", "releasing"].includes(entry.phase)) {
				await this.reconcileInterrupted(run, entry);
			}
			if (entry.workspace && (entry.phase === "prepared" || entry.phase === "ambiguous")) {
				const canRetryUnclaimedHandoff =
					entry.phase === "ambiguous" && !entry.claimUpdatedAt && entry.goalFile?.state === "pending";
				if (!(await this.verifyPersistedWorkspace(run, entry))) continue;
				if (!(await this.ensureGoalFile(run, entry))) continue;
				if (!entry.claimUpdatedAt && canRetryUnclaimedHandoff) {
					await this.claimGoal(run, entry);
					if (!entry.claimUpdatedAt) continue;
				}
			}
			if (entry.claimUpdatedAt && (entry.phase === "prepared" || entry.phase === "ambiguous")) {
				let evidence: MergeEvidence | undefined;
				try {
					evidence = await this.dependencies.merges.findMerged(
						entry.branch,
						run.targetBranch,
						entry.claimUpdatedAt,
					);
				} catch (error) {
					entry.phase = "ambiguous";
					entry.message = `Merge inspection failed; prepared claim preserved: ${errorMessage(error)}`;
					await this.persist(run, entry);
					continue;
				}
				if (evidence) await this.completeMerged(run, entry, evidence);
			}
			if (needsCleanup(entry)) await this.cleanupEntry(run, entry);
		}
	}

	private async reconcileInterrupted(run: DispatchRun, entry: DispatchEntry): Promise<void> {
		if (entry.phase === "preparing") {
			await this.acquireWorkspace(run, entry);
			return;
		}
		if (entry.phase === "acquiring") {
			if (!entry.workspace) {
				entry.phase = "ambiguous";
				entry.message =
					"Workspace acquisition was interrupted before its result was journaled; custody requires explicit inspection.";
				await this.persist(run, entry);
				return;
			}
			await this.claimGoal(run, entry);
			return;
		}
		if (!(await this.verifyPersistedWorkspace(run, entry))) return;
		if (!(await this.ensureGoalFile(run, entry))) return;
		const snapshot = await this.dependencies.roadmap.read();
		const current = snapshot.goals.find((goal) => goal.id === entry.goal.id);
		if (!current) {
			entry.phase = "ambiguous";
			entry.message = "Goal disappeared while a canonical mutation was in progress; custody preserved.";
			await this.persist(run, entry);
			return;
		}
		if (entry.phase === "claiming") {
			if (!entry.workspace) {
				entry.phase = "ambiguous";
				entry.message = "Claim intent has no persisted workspace; custody preserved.";
				await this.persist(run, entry);
			} else if (
				current.branch === entry.branch &&
				(current.status === "open" || current.status === "active") &&
				current.updatedAt !== entry.goal.updatedAt
			) {
				entry.phase = "ambiguous";
				entry.message =
					"Interrupted claim reached canonical state, but its exact returned token was not journaled; explicit token recovery is required.";
				await this.persist(run, entry);
			} else if (!current.branch && current.updatedAt === entry.goal.updatedAt) {
				await this.claimGoal(run, entry);
			} else {
				entry.phase = "ambiguous";
				entry.message =
					"Canonical state does not prove the interrupted claim belongs to this run; custody preserved.";
				await this.persist(run, entry);
			}
			return;
		}
		if (!current.branch && (current.status === "open" || current.status === "active")) {
			entry.phase = "released";
			entry.releaseUpdatedAt = current.updatedAt;
			entry.message = "Recovered the claim release committed before local state persistence.";
			await this.persist(run, entry);
			await this.cleanupEntry(run, entry);
		} else if (current.branch === entry.branch && current.updatedAt === entry.claimUpdatedAt) {
			await this.releaseKnownSafe(run, entry, "Exact claim release resumed after interruption.");
		} else {
			entry.phase = "ambiguous";
			entry.message = "Canonical state does not prove the interrupted release is safe; custody preserved.";
			await this.persist(run, entry);
		}
	}

	private async completeMerged(
		run: DispatchRun,
		entry: DispatchEntry,
		evidence: MergeEvidence,
	): Promise<void> {
		try {
			const claimTime = Date.parse(entry.claimUpdatedAt ?? "");
			if (
				evidence.headBranch !== entry.branch ||
				evidence.baseBranch !== run.targetBranch ||
				Date.parse(evidence.createdAt) < claimTime ||
				Date.parse(evidence.mergedAt) < claimTime
			) {
				throw new Error("Merge evidence does not match this claim and dispatch target");
			}
			run.targetRevision = await this.dependencies.merges.syncTarget(evidence);
			await this.persist(run);
			if (
				entry.mergedPr &&
				(entry.mergedPr.url !== evidence.url ||
					entry.mergedPr.headBranch !== evidence.headBranch ||
					entry.mergedPr.baseBranch !== evidence.baseBranch ||
					entry.mergedPr.mergeCommit !== evidence.mergeCommit ||
					entry.mergedPr.mergedAt !== evidence.mergedAt)
			) {
				throw new Error("Merge evidence changed after completion intent was journaled");
			}
			if (!entry.completionIntentAt) {
				entry.completionIntentAt = this.now().toISOString();
				entry.mergedPr = evidence;
				entry.message = `Canonical completion intent journaled for ${evidence.url}.`;
				await this.persist(run, entry);
			}
			const snapshot = await this.dependencies.roadmap.read();
			const current = snapshot.goals.find((goal) => goal.id === entry.goal.id);
			if (!current) throw new Error("Goal disappeared from the canonical roadmap");
			if (current.status === "done") {
				if (entry.completionUpdatedAt) {
					if (current.updatedAt !== entry.completionUpdatedAt || current.branch !== undefined) {
						throw new Error("Completed canonical goal cannot be tied to this run's exact claim");
					}
				} else {
					if (
						current.branch !== undefined ||
						current.completedAt !== current.updatedAt ||
						current.updatedAt === entry.claimUpdatedAt ||
						Date.parse(current.updatedAt) < Date.parse(entry.completionIntentAt)
					) {
						throw new Error("Canonical done state does not prove this run's journaled exact claim outcome");
					}
					entry.completionUpdatedAt = current.updatedAt;
					await this.persist(run, entry);
				}
			} else {
				if (
					current.branch !== entry.branch ||
					current.updatedAt !== entry.claimUpdatedAt ||
					(current.status !== "open" && current.status !== "active")
				) {
					throw new Error("Canonical goal no longer carries this run's exact claim");
				}
				const completed = await this.dependencies.roadmap.complete(current.id, entry.claimUpdatedAt);
				entry.completionUpdatedAt = completed.updatedAt;
				await this.persist(run, entry);
			}
			entry.phase = "completed";
			entry.message = `Completed from matching merged PR ${evidence.url}.`;
			await this.persist(run, entry);
		} catch (error) {
			entry.phase = "ambiguous";
			entry.message = `Completion failed; prepared claim preserved: ${errorMessage(error)}`;
			await this.persist(run, entry);
		}
	}

	private async prepare(run: DispatchRun, goal: ProjectGoal): Promise<void> {
		const entry: DispatchEntry = {
			goal: structuredClone(goal),
			branch: `stepstone/${goal.id}`,
			phase: "preparing",
			updatedAt: this.now().toISOString(),
		};
		run.entries[goal.id] = entry;
		await this.persist(run, entry);
		await this.acquireWorkspace(run, entry);
	}

	private async acquireWorkspace(run: DispatchRun, entry: DispatchEntry): Promise<void> {
		entry.phase = "acquiring";
		entry.message = "Workspace acquisition is in progress.";
		await this.persist(run, entry);
		try {
			entry.workspace = await this.dependencies.workspace.acquire(
				entry.goal,
				entry.branch,
				run.targetRevision,
			);
			await this.persist(run, entry);
		} catch (error) {
			entry.phase = "ambiguous";
			entry.message = `Workspace acquisition outcome is ambiguous; inspect before recovery: ${errorMessage(error)}`;
			await this.persist(run, entry);
			return;
		}
		await this.claimGoal(run, entry);
	}

	private async claimGoal(run: DispatchRun, entry: DispatchEntry): Promise<void> {
		if (!entry.workspace) throw new Error("Claim intent has no workspace");
		if (!(await this.verifyPersistedWorkspace(run, entry))) return;
		if (!(await this.ensureGoalFile(run, entry))) return;
		entry.phase = "claiming";
		entry.message = "Canonical claim mutation is in progress.";
		await this.persist(run, entry);
		let claimed: ProjectGoal;
		try {
			claimed = await this.dependencies.roadmap.claim(entry.goal.id, entry.branch, entry.goal.updatedAt);
		} catch (error) {
			entry.message = `Claim attempt failed before its outcome was reconciled: ${errorMessage(error)}`;
			await this.persist(run, entry);
			return;
		}
		if (
			(claimed.status !== "open" && claimed.status !== "active") ||
			claimed.branch !== entry.branch ||
			claimed.updatedAt === entry.goal.updatedAt
		) {
			entry.claimUpdatedAt = claimed.updatedAt !== entry.goal.updatedAt ? claimed.updatedAt : undefined;
			entry.phase = "ambiguous";
			entry.message =
				"Claim response did not contain the expected branch and fresh token; custody preserved.";
			await this.persist(run, entry);
			return;
		}
		entry.claimUpdatedAt = claimed.updatedAt;
		entry.phase = "prepared";
		entry.message = `Workspace prepared and claimed; goal written to ${DISPATCH_GOAL_FILE}; Stepstone did not launch or prompt an agent.`;
		await this.persist(run, entry);
	}

	private async ensureGoalFile(run: DispatchRun, entry: DispatchEntry): Promise<boolean> {
		if (!entry.workspace) return false;
		const content = renderGoalFile(entry.goal, entry.branch);
		const expected: DispatchGoalFile = {
			path: DISPATCH_GOAL_FILE,
			sha256: sha256(content),
			ownershipId: entry.goalFile?.ownershipId ?? randomUUID(),
			state: entry.goalFile?.state ?? "pending",
		};
		if (
			entry.goalFile &&
			(entry.goalFile.path !== expected.path || entry.goalFile.sha256 !== expected.sha256)
		) {
			entry.phase = "ambiguous";
			entry.message = "Persisted goal-file identity does not match this entry's immutable goal snapshot.";
			await this.persist(run, entry);
			return false;
		}
		if (!entry.goalFile) {
			entry.goalFile = expected;
			entry.message = `Goal-file intent journaled for ${DISPATCH_GOAL_FILE}.`;
			await this.persist(run, entry);
		}
		try {
			if (!entry.goalFile.backing) {
				const adopted = await this.dependencies.workspace.adoptLegacyGoalFile(
					entry.workspace,
					entry.goalFile,
					content,
				);
				if (adopted) {
					entry.goalFile.ownershipId ??= expected.ownershipId;
					entry.goalFile.backing = adopted;
					entry.message = `Legacy goal-file handoff adopted at ${DISPATCH_GOAL_FILE}.`;
					await this.persist(run, entry);
				}
			}
			if (!entry.goalFile.ownershipId) {
				entry.goalFile.ownershipId = expected.ownershipId;
				entry.message = `Goal-file ownership journaled for ${DISPATCH_GOAL_FILE}.`;
				await this.persist(run, entry);
			}
			if (!entry.goalFile.backing) {
				entry.goalFile.backing = await this.dependencies.workspace.createGoalFileBacking(
					entry.workspace,
					entry.goalFile,
					content,
				);
				entry.message = `Goal-file backing identity journaled for ${DISPATCH_GOAL_FILE}.`;
				await this.persist(run, entry);
			}
			await this.dependencies.workspace.writeGoalFile(entry.workspace, entry.goalFile, content);
		} catch (error) {
			entry.phase = "ambiguous";
			entry.message = `Goal-file handoff could not be verified; workspace preserved: ${errorMessage(error)}`;
			await this.persist(run, entry);
			return false;
		}
		if (entry.goalFile.state !== "written") {
			entry.goalFile.state = "written";
			entry.message = `Goal-file handoff verified at ${DISPATCH_GOAL_FILE}.`;
			await this.persist(run, entry);
		}
		return true;
	}

	private async releaseKnownSafe(run: DispatchRun, entry: DispatchEntry, message: string): Promise<void> {
		if (!entry.claimUpdatedAt) {
			entry.phase = "ambiguous";
			entry.message = "Claim token is unavailable; custody preserved.";
			await this.persist(run, entry);
			return;
		}
		entry.phase = "releasing";
		entry.message = message;
		await this.persist(run, entry);
		try {
			const released = await this.dependencies.roadmap.release(entry.goal.id, entry.claimUpdatedAt);
			entry.releaseUpdatedAt = released.updatedAt;
			entry.phase = "released";
			await this.persist(run, entry);
			await this.cleanupEntry(run, entry);
		} catch (error) {
			entry.message = `Exact claim release outcome requires reconciliation: ${errorMessage(error)}`;
			await this.persist(run, entry);
		}
	}

	private async cleanupEntry(run: DispatchRun, entry: DispatchEntry): Promise<void> {
		if (!needsCleanup(entry)) return;
		try {
			if (entry.workspace) {
				const workspace = entry.workspace;
				await this.dependencies.workspace.cleanup(workspace, entry.branch);
				entry.cleanupMarker = workspace.metadata.marker;
			}
		} catch (error) {
			entry.phase = "cleanup-pending";
			entry.message = `Workspace cleanup is pending: ${errorMessage(error)}`;
			await this.persist(run, entry);
			return;
		}
		entry.workspace = undefined;
		entry.phase = "cleaned";
		entry.message = entry.mergedPr
			? `Completed and cleaned after ${entry.mergedPr.url}.`
			: "Released and cleaned.";
		await this.persist(run, entry);
	}

	private async verifyPersistedWorkspace(run: DispatchRun, entry: DispatchEntry): Promise<boolean> {
		if (!entry.workspace) return true;
		try {
			await this.dependencies.workspace.verify(entry.workspace, entry.branch);
			return true;
		} catch (error) {
			entry.phase = "ambiguous";
			entry.message = `Persisted workspace custody could not be verified: ${errorMessage(error)}`;
			await this.persist(run, entry);
			return false;
		}
	}

	private requireEntry(run: DispatchRun, goalId: string): DispatchEntry {
		const entry = run.entries[goalId];
		if (!entry) throw new Error(`Run ${run.id} has no entry for goal ${goalId}`);
		return entry;
	}

	private async persist(run: DispatchRun, entry?: DispatchEntry): Promise<void> {
		const timestamp = this.now().toISOString();
		run.updatedAt = timestamp;
		if (entry) entry.updatedAt = timestamp;
		await this.dependencies.store.save(run);
	}
}
