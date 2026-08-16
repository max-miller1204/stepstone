import { randomUUID } from "node:crypto";
import { readyGoals } from "./dependencies.ts";
import type { ProjectGoal } from "./types.ts";

export const DISPATCH_STATE_VERSION = 1 as const;

export type DispatchPhase =
	| "preparing"
	| "acquiring"
	| "claiming"
	| "claimed"
	| "launching"
	| "running"
	| "ambiguous"
	| "releasing"
	| "released"
	| "completed"
	| "cleanup-pending"
	| "cleaned"
	| "failed";

export interface DispatchWorkspace {
	binding: string;
	path: string;
	metadata: Record<string, string>;
}

export interface DispatchSession {
	binding: string;
	metadata: Record<string, string>;
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
	session?: DispatchSession;
	claimUpdatedAt?: string;
	launchToken?: string;
	mergedPr?: MergeEvidence;
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
	workspaceBinding: string;
	sessionBinding: string;
	bindingConfig: DispatchBindingConfig;
	createdAt: string;
	updatedAt: string;
	entries: Record<string, DispatchEntry>;
}

export interface DispatchBindingConfig {
	workspaceParent?: string;
	agentCommand?: string;
	agentCommandFingerprint?: string;
	agentArgs: string[];
	agentKind?: string;
	startupGraceMs?: number;
	promptTimeoutMs?: number;
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
	cleanup(workspace: DispatchWorkspace, branch: string): Promise<void>;
}

export interface SessionLaunchFailure extends Error {
	readonly ambiguous: boolean;
	session?: DispatchSession;
}

export interface SessionBinding {
	readonly name: string;
	verifyLaunchIdentity?(): Promise<void>;
	launch(
		workspace: DispatchWorkspace,
		goal: ProjectGoal,
		prompt: string,
		launchToken: string,
	): Promise<DispatchSession>;
	verifyInterruptedLaunchClosed(
		workspace: DispatchWorkspace,
		goal: ProjectGoal,
		launchToken: string,
	): Promise<void>;
	cleanup(session: DispatchSession): Promise<void>;
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
	session: SessionBinding;
	merges: MergeEvidenceBinding;
	store: DispatchStateStore;
	now?: () => Date;
	id?: () => string;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isAmbiguousLaunchFailure(error: unknown): error is SessionLaunchFailure {
	return error instanceof Error && "ambiguous" in error && (error as SessionLaunchFailure).ambiguous === true;
}

function hasCanonicalCustody(entry: DispatchEntry): boolean {
	return [
		"preparing",
		"acquiring",
		"claiming",
		"claimed",
		"launching",
		"running",
		"ambiguous",
		"releasing",
	].includes(entry.phase);
}

function consumesCapacity(entry: DispatchEntry): boolean {
	return (
		hasCanonicalCustody(entry) ||
		(entry.phase === "cleanup-pending" && (entry.session !== undefined || entry.launchToken !== undefined))
	);
}

function needsCleanup(entry: DispatchEntry): boolean {
	return entry.phase === "released" || entry.phase === "completed" || entry.phase === "cleanup-pending";
}

export function renderGoalPrompt(goal: ProjectGoal): string {
	return [
		"Implement this claimed Stepstone Project Goal in the provided isolated checkout.",
		"The root dispatch driver is the sole roadmap writer. Do not edit .worklist/worklist.json or run mutating Stepstone project commands.",
		"Complete the entire goal, commit the implementation branch, and open a pull request whose head is the claimed branch.",
		"Project Goal context:",
		JSON.stringify(goal, null, 2),
	].join("\n\n");
}

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
		bindingConfig: DispatchBindingConfig;
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
			workspaceBinding: this.dependencies.workspace.name,
			sessionBinding: this.dependencies.session.name,
			bindingConfig: structuredClone(options.bindingConfig),
			createdAt: timestamp,
			updatedAt: timestamp,
			entries: {},
		};
		await this.dependencies.store.create(run);
		return run;
	}

	async advance(runId: string): Promise<DispatchRun> {
		const run = await this.dependencies.store.load(runId);
		this.assertBindings(run);
		await this.dependencies.session.verifyLaunchIdentity?.();
		await this.reconcile(run);
		let slots = run.maxParallel - Object.values(run.entries).filter(consumesCapacity).length;
		if (slots <= 0) return run;
		const snapshot = await this.dependencies.roadmap.read();
		const approved = new Set(run.approvedGoalIds);
		const ready = readyGoals(snapshot.goals, snapshot.retiredIds).filter(
			(goal) => approved.has(goal.id) && !run.entries[goal.id],
		);
		for (const goal of ready.slice(0, slots)) {
			await this.launch(run, goal);
			slots = run.maxParallel - Object.values(run.entries).filter(consumesCapacity).length;
			if (slots <= 0) break;
		}
		return run;
	}

	async recoverRelease(
		runId: string,
		goalId: string,
		explicitClaimUpdatedAt?: string,
		confirmLaunchClosed = false,
	): Promise<DispatchRun> {
		const run = await this.dependencies.store.load(runId);
		this.assertBindings(run);
		const entry = this.requireEntry(run, goalId);
		if (!["claiming", "claimed", "launching", "running", "ambiguous", "releasing"].includes(entry.phase)) {
			throw new Error(
				`Goal ${goalId} is in terminal or non-claim phase ${entry.phase}; recovery is not allowed`,
			);
		}
		if (entry.completionIntentAt || entry.completionUpdatedAt || entry.mergedPr) {
			throw new Error(
				`Goal ${goalId} has a journaled completion outcome; resume must reconcile it before release recovery`,
			);
		}
		if (entry.session) {
			try {
				await this.dependencies.session.cleanup(entry.session);
				entry.launchToken = undefined;
				entry.session = undefined;
				entry.phase = "ambiguous";
				entry.message = "Worker session closed and verified before claim recovery.";
				await this.persist(run, entry);
			} catch (error) {
				entry.phase = "ambiguous";
				entry.message = `Worker session could not be proven closed; claim and workspace preserved: ${errorMessage(error)}`;
				await this.persist(run, entry);
				throw error;
			}
		}
		if (entry.launchToken && !entry.session) {
			if (!confirmLaunchClosed || !entry.workspace) {
				throw new Error(
					`Goal ${goalId} has an interrupted worker launch identity but no verified session handle; manual process inspection and --confirm-launch-closed are required`,
				);
			}
			await this.dependencies.session.verifyInterruptedLaunchClosed(
				entry.workspace,
				entry.goal,
				entry.launchToken,
			);
			entry.launchToken = undefined;
			entry.phase = "ambiguous";
			entry.message = "Explicit recovery verified that the interrupted launch has no live worker.";
			await this.persist(run, entry);
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
		await this.releaseKnownSafe(run, entry, "Exact claim released by explicit recovery.");
		return run;
	}

	async cleanup(runId: string, goalId?: string): Promise<DispatchRun | undefined> {
		const run = await this.dependencies.store.load(runId);
		this.assertBindings(run);
		const entries = goalId ? [this.requireEntry(run, goalId)] : Object.values(run.entries);
		for (const entry of entries) {
			if (hasCanonicalCustody(entry))
				throw new Error(`Goal ${entry.goal.id} still has custody; recover its claim first`);
			if (needsCleanup(entry)) await this.cleanupEntry(run, entry);
		}
		if (
			!goalId &&
			Object.values(run.entries).every((entry) => entry.phase === "cleaned" || entry.phase === "failed")
		) {
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
			if (entry.phase === "launching") {
				entry.phase = "ambiguous";
				entry.message =
					"Worker launch was interrupted before a session handle was persisted; launch identity is preserved for manual inspection.";
				await this.persist(run, entry);
			}
			if (
				entry.workspace &&
				entry.claimUpdatedAt &&
				(entry.phase === "claimed" || entry.phase === "running" || entry.phase === "ambiguous") &&
				!(await this.verifyPersistedWorkspace(run, entry))
			) {
				continue;
			}
			if (entry.phase === "claimed") {
				await this.launchWorker(run, entry);
				continue;
			}
			if (entry.claimUpdatedAt && (entry.phase === "running" || entry.phase === "ambiguous")) {
				let evidence: MergeEvidence | undefined;
				try {
					evidence = await this.dependencies.merges.findMerged(
						entry.branch,
						run.targetBranch,
						entry.claimUpdatedAt,
					);
				} catch (error) {
					entry.message = `Merge inspection failed; custody preserved: ${errorMessage(error)}`;
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
			if (await this.verifyPersistedWorkspace(run, entry)) await this.claimGoal(run, entry);
			return;
		}
		if (!(await this.verifyPersistedWorkspace(run, entry))) return;
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
					throw new Error(`Canonical goal no longer carries this run's exact claim`);
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
			entry.message = `Completion failed; custody preserved: ${errorMessage(error)}`;
			await this.persist(run, entry);
		}
	}

	private async launch(run: DispatchRun, goal: ProjectGoal): Promise<void> {
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
			await this.claimGoal(run, entry);
		} catch (error) {
			entry.phase = "ambiguous";
			entry.message = `Workspace acquisition outcome is ambiguous; inspect before recovery: ${errorMessage(error)}`;
			await this.persist(run, entry);
		}
	}

	private async claimGoal(run: DispatchRun, entry: DispatchEntry): Promise<void> {
		entry.phase = "claiming";
		entry.message = "Canonical claim mutation is in progress.";
		await this.persist(run, entry);
		if (!entry.workspace) throw new Error("Claim intent has no workspace");
		await this.dependencies.workspace.verify(entry.workspace, entry.branch);
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
		entry.phase = "claimed";
		await this.persist(run, entry);
		await this.launchWorker(run, entry);
	}

	private async launchWorker(run: DispatchRun, entry: DispatchEntry): Promise<void> {
		if (!entry.workspace) throw new Error("Claimed entry has no workspace");
		entry.launchToken = randomUUID();
		entry.phase = "launching";
		entry.message = "Worker launch intent and identity are journaled; no session handle is proven yet.";
		await this.persist(run, entry);
		try {
			await this.dependencies.workspace.verify(entry.workspace, entry.branch);
			entry.session = await this.dependencies.session.launch(
				entry.workspace,
				entry.goal,
				renderGoalPrompt(entry.goal),
				entry.launchToken,
			);
			entry.phase = "running";
			entry.message = "Worker launched; matching merged PR is the only completion evidence.";
			await this.persist(run, entry);
		} catch (error) {
			if (isAmbiguousLaunchFailure(error)) {
				entry.session = error.session ?? entry.session;
				entry.phase = "ambiguous";
				entry.message = `Launch outcome is ambiguous; custody preserved: ${errorMessage(error)}`;
				await this.persist(run, entry);
				return;
			}
			entry.launchToken = undefined;
			await this.releaseKnownSafe(
				run,
				entry,
				`Known-safe launch failure released the exact claim: ${errorMessage(error)}`,
			);
		}
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
		if (entry.session) {
			try {
				await this.dependencies.session.cleanup(entry.session);
				entry.session = undefined;
				entry.launchToken = undefined;
				entry.phase = "cleanup-pending";
				entry.message = "Worker session closed and verified; workspace cleanup is pending.";
				await this.persist(run, entry);
			} catch (error) {
				entry.phase = "cleanup-pending";
				entry.message = `Cleanup is pending because the worker session could not be verified closed: ${errorMessage(error)}`;
				await this.persist(run, entry);
				return;
			}
		}
		if (entry.launchToken && entry.workspace) {
			try {
				await this.dependencies.session.verifyInterruptedLaunchClosed(
					entry.workspace,
					entry.goal,
					entry.launchToken,
				);
				entry.launchToken = undefined;
				entry.phase = "cleanup-pending";
				entry.message = "Interrupted worker launch proven closed; workspace cleanup is pending.";
				await this.persist(run, entry);
			} catch (error) {
				entry.phase = "cleanup-pending";
				entry.message = `Cleanup is pending because the interrupted worker launch could not be proven closed: ${errorMessage(error)}`;
				await this.persist(run, entry);
				return;
			}
		}
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
		entry.launchToken = undefined;
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

	private assertBindings(run: DispatchRun): void {
		if (
			run.workspaceBinding !== this.dependencies.workspace.name ||
			run.sessionBinding !== this.dependencies.session.name
		) {
			throw new Error(
				`Run ${run.id} requires workspace=${run.workspaceBinding} session=${run.sessionBinding}; received workspace=${this.dependencies.workspace.name} session=${this.dependencies.session.name}`,
			);
		}
	}

	private async persist(run: DispatchRun, entry?: DispatchEntry): Promise<void> {
		const timestamp = this.now().toISOString();
		run.updatedAt = timestamp;
		if (entry) entry.updatedAt = timestamp;
		await this.dependencies.store.save(run);
	}
}
