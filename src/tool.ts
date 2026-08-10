import type { ExtensionContext, ToolExecutionMode } from "@earendil-works/pi-coding-agent";
import {
	unwrapWorklistApplicationResult,
	WorklistApplicationService,
	type WorklistOperation,
	type WorklistOperationSource,
} from "./application-service.ts";
import { formatProjectGoals, formatSessionTasks } from "./format.ts";
import { resolveGitRoot, resolveWorklistLocation, type WorklistLocation } from "./git.ts";
import type { SessionStore } from "./session-store.ts";
import type { WorklistOperationResult, WorklistToolDetails } from "./types.ts";

export interface ToolDeps {
	applicationService?: WorklistApplicationService;
	sessionStore?: SessionStore;
	projectPath?: string | null;
}

/**
 * Ask again, rather than remember: the goal file a Pi session works with, on
 * demand and resolved the same way the CLI resolves it, so a session and a
 * terminal in the same repository can never disagree about which roadmap they
 * are looking at.
 *
 * The repository a session runs in cannot change under it, so the git root is
 * found once; which file inside it holds the goals can change, because
 * `migrate_path` in another terminal moves it, so that part is re-read every
 * time it is asked for.
 */
export function createProjectLocator(cwd: string): () => WorklistLocation | null {
	const result = resolveGitRoot(cwd);
	if (!result.isGit || !result.root) return () => null;
	const root = result.root;
	return () => resolveWorklistLocation(root, { env: process.env, overrideBase: cwd });
}

/** The goal file a Pi session works with, as it stands right now. */
export function getProjectLocation(cwd: string): WorklistLocation | null {
	return createProjectLocator(cwd)();
}

function getApplicationService(deps: ToolDeps): WorklistApplicationService {
	if (deps.applicationService) return deps.applicationService;
	return new WorklistApplicationService({
		sessionStore: deps.sessionStore,
		projectPath: deps.projectPath,
	});
}

function formatProjectPlan(result: WorklistOperationResult): string {
	const goals = result.addedGoals ?? [];
	const action = result.dryRun ? "Would add" : "Applied";
	const lines = [
		`${action} ${goals.length} project goal(s)${result.dryRun ? " without writing" : ""}.`,
		...goals.map((goal) => `  ${goal.id}: ${goal.title}`),
	];
	if (result.dryRun) {
		for (const warning of result.warnings ?? []) {
			lines.push(
				`Warning: ${warning.reference} resolves to new batch goal ${warning.batchGoalId}, not existing goal ${warning.existingGoalId}.`,
			);
		}
	}
	return lines.join("\n");
}

function formatProjectActivation(result: WorklistOperationResult): string {
	const activated = `Activated project goal ${result.goal?.id}`;
	const blockedBy = result.blockedBy ?? [];
	if (blockedBy.length === 0) return activated;
	return `${activated}\nWarning: ${result.goal?.id} is blocked; ${blockedBy.join(", ")} ${blockedBy.length === 1 ? "has" : "have"} not landed yet.`;
}

function formatSessionResult(operation: WorklistOperation, result: WorklistOperationResult): string {
	switch (operation.action) {
		case "list":
			return formatSessionTasks(result.tasks ?? []);
		case "add":
			return `Added session task ${result.task?.id}: ${result.task?.title}`;
		case "move":
			return `Moved session task ${result.task?.id}`;
		case "update":
			return `Updated session task ${result.task?.id}`;
		case "set_status":
			return `Set session task ${result.task?.id} to ${result.task?.status}`;
		case "delete":
			return `Deleted session task ${operation.id}`;
		default:
			throw new Error(`Unknown session action: ${operation.action}`);
	}
}

function formatProjectResult(operation: WorklistOperation, result: WorklistOperationResult): string {
	switch (operation.action) {
		case "list":
			return formatProjectGoals(result.goals ?? []);
		case "add":
			return `Added project goal ${result.goal?.id}: ${result.goal?.title}`;
		case "apply-plan":
			return formatProjectPlan(result);
		case "move":
			return `Moved project goal ${result.goal?.id}`;
		case "update":
			return `Updated project goal ${result.goal?.id}`;
		case "set_status":
		case "set_active":
			return formatProjectActivation(result);
		case "complete":
		case "reopen":
		case "archive":
			return `Project goal ${result.goal?.id} is now ${result.goal?.status}`;
		case "delete":
			return `Deleted project goal ${operation.id}`;
		default:
			throw new Error(`Unknown project action: ${operation.action}`);
	}
}

function formatResult(operation: WorklistOperation, result: WorklistOperationResult): string {
	if (operation.scope === "session") return formatSessionResult(operation, result);
	if (operation.scope === "project") return formatProjectResult(operation, result);
	throw new Error(`Unknown ${operation.scope} action: ${operation.action}`);
}

export async function executeWorklist(
	params: WorklistOperation,
	_ctx: ExtensionContext,
	deps: ToolDeps,
	source: WorklistOperationSource = "tool",
): Promise<{ content: string; details: WorklistToolDetails }> {
	const envelope = await getApplicationService(deps).execute(params, { source });
	const result = unwrapWorklistApplicationResult(envelope);
	return {
		content: formatResult(params, result),
		details: result,
	};
}

export const WORKLIST_EXECUTION_MODE = "sequential" as ToolExecutionMode;
