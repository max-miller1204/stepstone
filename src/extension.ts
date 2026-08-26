import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	WorklistApplicationError,
	WorklistApplicationService,
	type WorklistOperationSource,
} from "./application-service.ts";
import { CLI_COMMAND_CONTRACT, captureWorkflowAction } from "./cli-contract.ts";
import { formatProjectGoals, formatSessionTasks } from "./format.ts";
import type { LocatedWorklist } from "./git.ts";
import { findGoalByStoredId } from "./goal-selection.ts";
import { WORKLIST_ERROR_CODES } from "./result-envelope.ts";
import { WorklistParamsSchema } from "./schema.ts";
import { SessionStore } from "./session-store.ts";
import { createProjectLocator, executeWorklist, WORKLIST_EXECUTION_MODE } from "./tool.ts";
import type { ProjectGoal, ProjectGoalStatus, SessionTaskStatus } from "./types.ts";
import {
	buildPromptSummary,
	buildWidgetLines,
	Dashboard,
	type DashboardAction,
	DashboardDetail,
	type DashboardDetailItem,
	type DashboardResult,
	type DashboardState,
} from "./ui.ts";

/** Widget slot this extension owns in Pi's session UI, named after the package. */
const WIDGET_ID = CLI_COMMAND_CONTRACT.binary;
const CAPTURE_WORKFLOW = captureWorkflowAction(CLI_COMMAND_CONTRACT.actions).captureWorkflow;

export interface ParsedCommand {
	scope: "session" | "project";
	action: string;
	id?: string;
	title?: string;
	description?: string;
	status?: SessionTaskStatus | ProjectGoalStatus;
	beforeId?: string;
	afterId?: string;
	confirm?: boolean;
	expectedUpdatedAt?: string;
}

export const WORKLIST_PROMPT_GUIDELINES = [
	"For non-trivial multi-step work, use worklist to create several small, concrete, independently completable Session Tasks before implementation, then update them as verified work progresses.",
	"Do not create one Session Task that merely restates the user's broad request or end goal. Broad outcomes belong in Project Goals; Session Tasks should name the next executable chunks.",
	"Keep Session Task titles concise and self-contained. Session Tasks do not have descriptions.",
	"Use worklist with scope=project only when the user asks to manage the project roadmap.",
	`When using worklist to capture Project Goals: ${CAPTURE_WORKFLOW.steps.join(" ")}`,
	"Never set worklist confirm=true for a project lifecycle action unless the user explicitly requested that exact completion, reopening, archival, or deletion.",
] as const;

function parsePlacement(
	parts: string[],
): { parts: string[]; placement?: Pick<ParsedCommand, "beforeId" | "afterId"> } | null {
	const flagIndices = parts.flatMap((part, index) =>
		part === "--before" || part === "--after" ? [index] : [],
	);
	if (flagIndices.length === 0) return { parts };
	if (flagIndices.length > 1) return null;
	const flagIndex = flagIndices[0];
	if (flagIndex !== 0 && flagIndex !== parts.length - 2) return null;
	const anchorId = parts[flagIndex + 1];
	if (!anchorId || anchorId === "--") return null;
	return {
		parts: [...parts.slice(0, flagIndex), ...parts.slice(flagIndex + 2)],
		placement: parts[flagIndex] === "--before" ? { beforeId: anchorId } : { afterId: anchorId },
	};
}

function parseProjectDetails(parts: string[]): Pick<ParsedCommand, "title" | "description"> {
	const separator = parts.indexOf("--");
	if (separator === -1) return { title: parts.join(" ") };
	return {
		title: parts.slice(0, separator).join(" "),
		description: parts.slice(separator + 1).join(" "),
	};
}

export function parseTasksCommand(args: string): ParsedCommand | null {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	if (parts.length < 2 || !["session", "project"].includes(parts[0])) return null;
	const scope = parts.shift() as "session" | "project";
	const action = parts.shift();
	if (!action) return null;
	const hasPlacementFlag = parts.some((part) => part === "--before" || part === "--after");
	if (action !== "add" && action !== "move" && hasPlacementFlag) return null;
	if (action === "list") return { scope, action };
	if (action === "add") {
		const parsed = parsePlacement(parts);
		if (!parsed) return null;
		if (scope === "session") {
			if (parsed.parts.includes("--")) return null;
			if (parsed.parts.length === 0) return null;
			return { scope, action, ...parsed.placement, title: parsed.parts.join(" ") };
		}
		return { scope, action, ...parsed.placement, ...parseProjectDetails(parsed.parts) };
	}
	if (action === "move") {
		const id = parts.shift();
		if (!id) return null;
		const parsed = parsePlacement(parts);
		if (!parsed?.placement || parsed.parts.length > 0) return null;
		return { scope, action, id, ...parsed.placement };
	}
	if (action === "update") {
		const id = parts.shift();
		if (scope === "session") {
			if (parts.includes("--")) return null;
			return { scope, action, id, ...(parts.length ? { title: parts.join(" ") } : {}) };
		}
		const details = parseProjectDetails(parts);
		return {
			scope,
			action,
			id,
			...(details.title ? { title: details.title } : {}),
			...(details.description !== undefined ? { description: details.description } : {}),
		};
	}
	if (action === "status")
		return { scope, action: "set_status", id: parts[0], status: parts[1] as ParsedCommand["status"] };
	if (["complete", "reopen", "archive", "delete", "set_active"].includes(action)) {
		return { scope, action, id: parts[0], confirm: scope === "project" && action !== "set_active" };
	}
	return null;
}

/**
 * Whether an error is "there is no goal file to read right now".
 *
 * The display degrades quietly for this one and only this one: it is a standing
 * condition of the machine or the directory rather than something the read did
 * wrong, and the operation a user asked for reports it in full.
 */
function isProjectUnavailable(error: unknown): boolean {
	return error instanceof WorklistApplicationError && error.code === WORKLIST_ERROR_CODES.UNAVAILABLE;
}

export default function worklistExtension(pi: ExtensionAPI): void {
	const sessionStore = new SessionStore(pi);
	const applicationService = new WorklistApplicationService({ sessionStore });
	let projectGoals: ProjectGoal[] = [];
	let latestContext: ExtensionContext | undefined;
	let locateProject: (() => LocatedWorklist | null) | undefined;
	let announcedNotice: string | undefined;

	/**
	 * The goals the widget draws, from the resolution that named the file.
	 *
	 * A goal file that cannot be read raises: it is a condition someone has to be
	 * told about, and it reaches them through the same handler it always did.
	 */
	async function refreshProject(located = locatedProject()): Promise<void> {
		projectGoals = await applicationService.getProjectGoals(located?.path ?? null);
	}

	/**
	 * The resolution the display reports on, which never speaks for an operation.
	 *
	 * This is the one place the display degrades: a repository whose Git cannot be
	 * reached right now leaves the widget empty, while the operation a user or model
	 * actually asked for still fails with the typed availability failure the service
	 * raises.
	 */
	function locatedProject(): LocatedWorklist | null {
		try {
			return locateProject?.() ?? null;
		} catch (error) {
			if (!isProjectUnavailable(error)) throw error;
			return null;
		}
	}

	/**
	 * Say which of two roadmaps the session is reading, whenever that answer
	 * changes.
	 *
	 * The session re-resolves the goal file on every operation, so a second
	 * worklist arriving mid-session - a branch checkout, a merge, a colleague's
	 * older release - silently switches which file every later read and write
	 * lands in. The notice is derived from the same resolution that chooses the
	 * path, so it can never describe a file the session is not using, and it is
	 * raised only when the condition newly appears, so a widget refresh on every
	 * turn does not repeat it. What counts as newly appeared is scoped to one
	 * session: pi reuses this extension across `/new`, `/resume`, `/fork` and
	 * `/clone`, and every session has to be told which of two roadmaps it reads.
	 */
	function announceLocationNotice(ctx: ExtensionContext, located: LocatedWorklist | null): void {
		const notice = located?.notice;
		if (notice === announcedNotice) return;
		announcedNotice = notice;
		if (notice) ctx.ui.notify(notice, "warning");
	}

	/**
	 * One refresh, one resolution.
	 *
	 * The widget's notice and the goals it draws come from the same answer rather
	 * than from two questions: Git runs synchronously, and asking twice per refresh
	 * doubles what a session pays while Git is slow or failing. It also closes the
	 * gap where the two answers could differ - a `migrate_path` landing between
	 * them - which is the invariant the pairing exists for.
	 */
	async function updateUi(ctx: ExtensionContext): Promise<void> {
		latestContext = ctx;
		const located = locatedProject();
		announceLocationNotice(ctx, located);
		await refreshProject(located);
		const lines = buildWidgetLines(applicationService.getSessionTasks(), projectGoals);
		if (!lines.length) ctx.ui.setWidget(WIDGET_ID, undefined);
		else if (ctx.mode === "tui") {
			ctx.ui.setWidget(
				WIDGET_ID,
				(_tui, theme) =>
					new Text(
						lines.map((line, index) => (index === 0 ? theme.fg("accent", line) : line)).join("\n"),
						0,
						0,
					),
			);
		} else ctx.ui.setWidget(WIDGET_ID, lines);
	}

	async function execute(params: ParsedCommand, ctx: ExtensionContext, source: WorklistOperationSource) {
		const result = await executeWorklist(params, ctx, { applicationService }, source);
		await updateUi(ctx);
		return result;
	}

	pi.registerTool({
		name: "worklist",
		label: "Worklist",
		description:
			"Manage branch-aware, ordered Session Tasks or repository-wide Project Goals. Session add accepts optional beforeId or afterId; session move requires exactly one. Project move requires exactly one of beforeId or afterId. Project complete, reopen, archive, and delete require confirm=true after explicit user intent.",
		promptSnippet: "Manage small Session Task chunks and repository-scoped Project Goals",
		promptGuidelines: [...WORKLIST_PROMPT_GUIDELINES],
		parameters: WorklistParamsSchema,
		executionMode: WORKLIST_EXECUTION_MODE,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const result = await execute(params, ctx, "tool");
			return { content: [{ type: "text", text: result.content }], details: result.details };
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("worklist ")) + theme.fg("muted", `${args.scope} ${args.action}`),
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const block = result.content.find((item) => item.type === "text");
			return new Text(theme.fg("muted", block?.type === "text" ? block.text : ""), 0, 0);
		},
	});

	function findDashboardDetailItem(
		action: Extract<DashboardAction, { kind: "view" }>,
	): DashboardDetailItem | undefined {
		if (action.scope === "project") {
			const goal = projectGoals.find((candidate) => candidate.id === action.id);
			return goal ? { scope: "project", goal } : undefined;
		}
		const task = applicationService.getSessionTasks().find((candidate) => candidate.id === action.id);
		if (!task) return undefined;
		// A stored association resolves through former IDs too, so an ID migration
		// never orphans a Session Task the migration itself could not reach.
		const goal = task.goalId ? findGoalByStoredId(projectGoals, task.goalId) : undefined;
		return { scope: "session", task, ...(goal ? { goal } : {}) };
	}

	async function showDashboardDetail(item: DashboardDetailItem, ctx: ExtensionContext): Promise<void> {
		await ctx.ui.custom<void>(
			(tui, theme, _keys, done) => {
				const detail = new DashboardDetail({
					item,
					goals: projectGoals,
					theme,
					terminalRows: () => tui.terminal.rows,
					done,
				});
				return {
					render: (width) => detail.render(width),
					invalidate: () => detail.invalidate(),
					handleInput: (data) => {
						detail.handleInput(data);
						tui.requestRender();
					},
				};
			},
			{
				overlay: true,
				overlayOptions: { anchor: "center", width: 96, minWidth: 50, maxHeight: "85%", margin: 1 },
			},
		);
	}

	async function handleDashboardAction(action: DashboardAction, ctx: ExtensionContext): Promise<boolean> {
		if (action.kind === "close") return false;
		if (action.kind === "view") {
			const item = findDashboardDetailItem(action);
			if (item) await showDashboardDetail(item, ctx);
			return true;
		}
		if (action.kind === "add" || action.kind === "insert") {
			let inputLabel = action.scope === "session" ? "Add session task" : "Add project goal";
			if (action.kind === "insert") inputLabel = "Insert session task";
			const title = await ctx.ui.input(inputLabel, "Title");
			if (!title?.trim()) return true;
			if (action.scope === "session") {
				await execute(
					{
						scope: "session",
						action: "add",
						title: title.trim(),
						...(action.kind === "insert" ? { beforeId: action.beforeId } : {}),
					},
					ctx,
					"dashboard",
				);
				return true;
			}
			const description = await ctx.ui.editor("Add description (optional)", "");
			await execute(
				{
					scope: "project",
					action: "add",
					title: title.trim(),
					description: description?.trim() || undefined,
				},
				ctx,
				"dashboard",
			);
			return true;
		}
		if (action.kind === "move") {
			await execute(
				{
					scope: action.scope,
					action: "move",
					id: action.id,
					...(action.beforeId !== undefined ? { beforeId: action.beforeId } : {}),
					...(action.afterId !== undefined ? { afterId: action.afterId } : {}),
				},
				ctx,
				"dashboard",
			);
			return true;
		}
		if (action.kind === "edit") {
			if (action.scope === "session") {
				const task = applicationService.getSessionTasks().find((candidate) => candidate.id === action.id);
				if (!task) return true;
				const title = await ctx.ui.input("Edit title (leave blank to keep)", task.title);
				if (title === undefined) return true;
				const nextTitle = title.trim() || undefined;
				if (nextTitle === undefined || nextTitle === task.title) return true;
				await execute(
					{ scope: "session", action: "update", id: action.id, title: nextTitle },
					ctx,
					"dashboard",
				);
				return true;
			}
			const goal = projectGoals.find((candidate) => candidate.id === action.id);
			if (!goal) return true;
			const title = await ctx.ui.input("Edit title (leave blank to keep)", goal.title);
			if (title === undefined) return true;
			const nextTitle = title.trim() || undefined;
			const description = await ctx.ui.editor("Edit description", goal.description ?? "");
			if (description === undefined) return true;
			const nextDescription = description.trim();
			if (
				(nextTitle === undefined || nextTitle === goal.title) &&
				nextDescription === (goal.description ?? "")
			) {
				return true;
			}
			await execute(
				{
					scope: "project",
					action: "update",
					id: action.id,
					title: nextTitle,
					description: nextDescription,
				},
				ctx,
				"dashboard",
			);
			return true;
		}
		if (action.kind === "delete") {
			const confirmed = await ctx.ui.confirm("Delete item?", "This cannot be undone.");
			if (confirmed)
				await execute(
					{ scope: action.scope, action: "delete", id: action.id, confirm: action.scope === "project" },
					ctx,
					"dashboard",
				);
			return true;
		}
		if (action.scope === "session") {
			const task = applicationService.getSessionTasks().find((item) => item.id === action.id);
			if (task) {
				let status: SessionTaskStatus = "todo";
				if (task.status === "todo") status = "doing";
				else if (task.status === "doing") status = "done";
				await execute({ scope: "session", action: "set_status", id: task.id, status }, ctx, "dashboard");
			}
			return true;
		}
		const goal = projectGoals.find((item) => item.id === action.id);
		if (!goal) return true;
		if (goal.status === "open") {
			const result = await execute({ scope: "project", action: "set_active", id: goal.id }, ctx, "dashboard");
			if (result.details.blockedBy?.length) ctx.ui.notify(result.content, "warning");
		} else {
			const actionName = goal.status === "active" ? "complete" : "reopen";
			const confirmed = await ctx.ui.confirm(`${actionName} project goal?`, goal.title);
			if (confirmed) {
				await execute({ scope: "project", action: actionName, id: goal.id, confirm: true }, ctx, "dashboard");
			}
		}
		return true;
	}

	pi.registerCommand("tasks", {
		description:
			"Open Worklist, or use: /tasks <session|project> <list|add|move|update|status|complete|reopen|archive|delete|set_active> ...",
		handler: async (args, ctx) => {
			if (args.trim()) {
				const parsed = parseTasksCommand(args);
				if (!parsed || (parsed.action === "add" && !parsed.title)) {
					ctx.ui.notify(
						"Usage: /tasks <session|project> <action> [id/status/title] [-- project description]\n" +
							"Session ordering: /tasks session add [--before|--after <anchor-id>] <title> (the anchor may also trail the title), /tasks session move <id> --before|--after <anchor-id>",
						"error",
					);
					return;
				}
				try {
					const result = await execute(parsed, ctx, "command");
					ctx.ui.notify(result.content, "info");
				} catch (error) {
					ctx.ui.notify(String(error), "error");
				}
				return;
			}
			if (ctx.mode !== "tui") {
				ctx.ui.notify(
					`${formatSessionTasks(applicationService.getSessionTasks())}\n\n${formatProjectGoals(projectGoals)}`,
					"info",
				);
				return;
			}
			let again = true;
			let dashboardState: DashboardState | undefined;
			while (again) {
				// Each dashboard action depends on the previous interaction and must run sequentially.
				// pi-lens-ignore: await-in-loop
				try {
					await refreshProject();
				} catch (error) {
					ctx.ui.notify(String(error), "error");
				}
				const result = await ctx.ui.custom<DashboardResult>((tui, theme, _keys, done) => {
					const dashboard = new Dashboard(
						applicationService.getSessionTasks(),
						projectGoals,
						theme,
						done,
						dashboardState,
					);
					return {
						render: (width) => dashboard.render(width),
						invalidate: () => dashboard.invalidate(),
						handleInput: (data) => {
							dashboard.handleInput(data);
							tui.requestRender();
						},
					};
				});
				dashboardState = result?.state;
				if (!result) {
					again = false;
					continue;
				}
				try {
					again = await handleDashboardAction(result.action, ctx);
				} catch (error) {
					ctx.ui.notify(String(error), "error");
					again = true;
				}
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		sessionStore.reconstruct(ctx);
		const locate = createProjectLocator(ctx.cwd);
		locateProject = locate;
		announcedNotice = undefined;
		applicationService.setProjectPathResolver(() => locate()?.path ?? null);
		try {
			await updateUi(ctx);
		} catch (error) {
			ctx.ui.notify(String(error), "error");
		}
	});
	pi.on("session_tree", async (_event, ctx) => {
		sessionStore.reconstruct(ctx);
		try {
			await updateUi(ctx);
		} catch (error) {
			ctx.ui.notify(String(error), "error");
		}
	});
	pi.on("before_agent_start", (event) => {
		const summary = buildPromptSummary(applicationService.getSessionTasks(), projectGoals);
		if (!summary) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${summary}` };
	});
	pi.on("session_shutdown", () => {
		latestContext?.ui.setWidget(WIDGET_ID, undefined);
		latestContext = undefined;
	});
}
