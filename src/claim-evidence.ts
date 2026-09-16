import type { DispatchEntry, DispatchRun, DispatchWorkspace, RoadmapBinding } from "./dispatch-driver.ts";
import { findGoalByStoredId } from "./goal-selection.ts";
import type { ProjectGoal } from "./types.ts";

export const DEFAULT_STALE_AFTER_HOURS = 24;
const HOUR_MS = 60 * 60 * 1000;

export interface WorkspaceActivity {
	path: string;
	baseRevision: string;
	headRevision: string;
	branchChangedSincePreparation: boolean;
	hasUncommittedChanges: boolean;
	lastBranchActivityAt?: string;
}

export interface ClaimActivityBinding {
	observeActivity(workspace: DispatchWorkspace, branch: string): Promise<WorkspaceActivity>;
}

export interface ClaimEvidence {
	assessment: "recent-claim" | "activity-observed" | "possibly-abandoned" | "needs-inspection";
	reason: string;
	observedAt: string;
	staleAfterHours: number;
	claimUpdatedAt?: string;
	claimAgeHours?: number;
	canonical: {
		state: "matches" | "changed" | "missing" | "unavailable";
		goalId?: string;
		status?: ProjectGoal["status"];
		branch?: string;
		updatedAt?: string;
		message?: string;
	};
	workspace: ({ state: "observed" } & WorkspaceActivity) | { state: "unavailable"; message: string };
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function assess(evidence: ClaimEvidence, now: number): Pick<ClaimEvidence, "assessment" | "reason"> {
	if (evidence.canonical.state !== "matches") {
		return {
			assessment: "needs-inspection",
			reason: "The canonical claim could not be matched to this run.",
		};
	}
	if (evidence.claimAgeHours === undefined || evidence.claimAgeHours < 0) {
		return { assessment: "needs-inspection", reason: "The claim timestamp is unavailable or in the future." };
	}
	if (evidence.workspace.state !== "observed") {
		return { assessment: "needs-inspection", reason: "Workspace activity could not be verified." };
	}
	const activityTime = Date.parse(evidence.workspace.lastBranchActivityAt ?? "");
	if (activityTime > now) {
		return { assessment: "needs-inspection", reason: "The branch activity timestamp is in the future." };
	}
	if (evidence.claimAgeHours < evidence.staleAfterHours) {
		return { assessment: "recent-claim", reason: "The claim is younger than the inspection threshold." };
	}
	if (evidence.workspace.hasUncommittedChanges || now - activityTime < evidence.staleAfterHours * HOUR_MS) {
		return {
			assessment: "activity-observed",
			reason: "Uncommitted changes or a recent local branch update are visible; inspect before deciding.",
		};
	}
	if (!Number.isFinite(activityTime)) {
		return { assessment: "needs-inspection", reason: "Local branch activity history is unavailable." };
	}
	return {
		assessment: "possibly-abandoned",
		reason:
			"The claim and latest local branch update meet the age threshold, with no visible uncommitted changes. Inspect before explicit release; this is not evidence of agent or terminal liveness.",
	};
}

/** Fresh, advisory reads only: never journal observations or change canonical claims. */
export async function inspectPreparedClaims(
	run: DispatchRun,
	roadmap: Pick<RoadmapBinding, "read">,
	workspace: ClaimActivityBinding,
	options: { now?: Date; staleAfterHours?: number; goalId?: string } = {},
): Promise<Record<string, ClaimEvidence>> {
	const now = options.now ?? new Date();
	const staleAfterHours = options.staleAfterHours ?? DEFAULT_STALE_AFTER_HOURS;
	if (
		!Number.isSafeInteger(staleAfterHours) ||
		staleAfterHours < 1 ||
		!Number.isSafeInteger(staleAfterHours * HOUR_MS)
	) {
		throw new Error("stale-after-hours must be a positive integer within the supported timestamp range");
	}
	const entries = Object.entries(run.entries).filter(
		([id, entry]) => entry.phase === "prepared" && (options.goalId === undefined || id === options.goalId),
	);
	if (entries.length === 0) return {};
	let snapshot: Awaited<ReturnType<RoadmapBinding["read"]>> | undefined;
	let roadmapError: string | undefined;
	try {
		snapshot = await roadmap.read();
	} catch (error) {
		roadmapError = message(error);
	}
	const result: Record<string, ClaimEvidence> = {};
	for (const [id, entry] of entries) {
		const current = snapshot && findGoalByStoredId(snapshot.goals, entry.goal.id, snapshot.retiredIds);
		const canonical: ClaimEvidence["canonical"] = snapshot
			? canonicalEvidence(entry, current)
			: { state: "unavailable", message: roadmapError };
		let activity: ClaimEvidence["workspace"];
		try {
			if (!entry.workspace) throw new Error("No workspace receipt is available.");
			activity = { state: "observed", ...(await workspace.observeActivity(entry.workspace, entry.branch)) };
		} catch (error) {
			activity = { state: "unavailable", message: message(error) };
		}
		const claimTime = Date.parse(entry.claimUpdatedAt ?? "");
		const evidence: ClaimEvidence = {
			assessment: "needs-inspection",
			reason: "",
			observedAt: now.toISOString(),
			staleAfterHours,
			claimUpdatedAt: entry.claimUpdatedAt,
			...(Number.isFinite(claimTime) ? { claimAgeHours: (now.getTime() - claimTime) / HOUR_MS } : {}),
			canonical,
			workspace: activity,
		};
		Object.assign(evidence, assess(evidence, now.getTime()));
		result[id] = evidence;
	}
	return result;
}

function canonicalEvidence(entry: DispatchEntry, goal: ProjectGoal | undefined): ClaimEvidence["canonical"] {
	if (!goal) return { state: "missing" };
	return {
		state:
			(goal.status === "open" || goal.status === "active") &&
			goal.branch === entry.branch &&
			goal.updatedAt === entry.claimUpdatedAt
				? "matches"
				: "changed",
		goalId: goal.id,
		status: goal.status,
		branch: goal.branch,
		updatedAt: goal.updatedAt,
	};
}
