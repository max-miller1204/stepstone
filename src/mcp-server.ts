import { createRequire } from "node:module";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	projectGoalSelectionError,
	type WorklistApplicationFailure,
	type WorklistApplicationResult,
	WorklistApplicationService,
	type WorklistOperation,
} from "./application-service.ts";
import {
	CLI_COMMAND_CONTRACT,
	type CliActionContract,
	type CliMcpActionContract,
	mcpActionDescription,
} from "./cli-contract.ts";
import { dependencyWaves, dependentGoals, isGoalBlocked, nextGoal, readyGoals } from "./dependencies.ts";
import { createWorklistLocator, resolveGitRoot } from "./git.ts";
import { matchesGoalQuery, resolveGoalSelector, type UnresolvedGoalSelector } from "./goal-selection.ts";
import { WORKLIST_ERROR_CODES, type WorklistResultMeta } from "./result-envelope.ts";
import type { WorklistOperationResult } from "./types.ts";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version?: unknown };
if (typeof packageJson.version !== "string") {
	throw new TypeError("package.json must contain a string version");
}

const SERVER_VERSION = packageJson.version;
const RESOURCE_URI_PREFIX = `${CLI_COMMAND_CONTRACT.binary}://worklist`;

type ToolArguments = {
	id?: string;
	title?: string;
	description?: string;
	appendDescription?: string;
	group?: string;
	dependsOn?: string[];
	links?: string[];
	branch?: string;
	clear?: boolean;
	plan?: unknown;
	dryRun?: boolean;
	direction?: "up" | "down";
	beforeId?: string;
	afterId?: string;
	confirm?: boolean;
	expectedUpdatedAt?: string;
};

export interface StepstoneMcpServerOptions {
	/** Directory whose Git repository owns the worklist. Defaults to process.cwd(). */
	cwd?: string;
	/** Environment used for STEPSTONE_WORKLIST resolution. Defaults to process.env. */
	env?: NodeJS.ProcessEnv;
}

function isMcpAction(action: CliActionContract): action is CliMcpActionContract {
	return action.mcp === "resource" || action.mcp === "tool";
}

function mcpActions(kind: CliMcpActionContract["mcp"]): CliMcpActionContract[] {
	return (CLI_COMMAND_CONTRACT.actions as readonly CliActionContract[])
		.filter(isMcpAction)
		.filter((action) => action.mcp === kind);
}

function inputSchemaFor(action: CliMcpActionContract) {
	const id = z.string().trim().min(1).describe("A complete goal ID or unique ID prefix");
	const expectedUpdatedAt = z
		.string()
		.trim()
		.min(1)
		.optional()
		.describe("The target goal's updatedAt value from the caller's last read");
	const dependsOn = z.array(z.string().trim().min(1)).optional();
	// The scheme is matched case-insensitively so the schema refuses exactly what
	// the service refuses; a prefix test would reject `HTTPS://…` here and answer
	// with a schema error the service would have accepted.
	const links = z.array(z.url({ protocol: /^https?$/i })).optional();

	switch (action.name) {
		case "add":
			return z.strictObject({
				title: z.string().trim().min(1),
				description: z.string().optional(),
				group: z.string().optional(),
				dependsOn,
				links,
			});
		case "apply-plan": {
			const workflow = action.captureWorkflow;
			if (!workflow) throw new Error("The apply-plan MCP action must own the capture workflow");
			const descriptions = workflow.schemaDescriptions;
			const planEntry = z
				.strictObject({
					title: z.string().trim().min(1).describe(descriptions.title),
					description: z.string().optional().describe(descriptions.description),
					group: z.string().optional().describe(descriptions.group),
					dependsOn: z.array(z.string().min(1)).optional().describe(descriptions.dependsOn),
				})
				.describe(descriptions.entry);
			return z.strictObject({
				plan: z.array(planEntry).describe(descriptions.plan),
				dryRun: z.boolean().optional().describe(descriptions.dryRun),
			});
		}
		case "update":
			return z.strictObject({
				id,
				title: z.string().trim().min(1).optional(),
				description: z.string().optional(),
				appendDescription: z.string().optional(),
				group: z.string().optional(),
				dependsOn,
				links,
				expectedUpdatedAt,
			});
		case "move":
			return z.strictObject({
				id,
				direction: z.enum(["up", "down"]).optional(),
				beforeId: z.string().trim().min(1).optional(),
				afterId: z.string().trim().min(1).optional(),
			});
		case "start":
			return z.strictObject({
				id,
				branch: z.string().trim().min(1).optional(),
				clear: z.boolean().optional(),
				expectedUpdatedAt,
			});
		case "set_active":
			return z.strictObject({ id, expectedUpdatedAt });
		case "complete":
		case "reopen":
		case "archive":
		case "delete":
			return z.strictObject({
				id,
				confirm: z
					.boolean()
					.optional()
					.describe("Explicit confirmation that the user requested this exact action for this exact goal"),
				expectedUpdatedAt,
			});
		default:
			throw new Error(`No MCP input schema for ${action.name}`);
	}
}

function operationFor(action: string, args: ToolArguments): WorklistOperation {
	const base = { scope: "project", action } as const;
	switch (action) {
		case "add":
			return {
				...base,
				title: args.title,
				description: args.description,
				group: args.group,
				dependsOn: args.dependsOn,
				links: args.links,
			};
		case "apply-plan":
			return { ...base, plan: args.plan, dryRun: args.dryRun };
		case "update":
			return {
				...base,
				id: args.id,
				title: args.title,
				description: args.description,
				appendDescription: args.appendDescription,
				group: args.group,
				dependsOn: args.dependsOn,
				links: args.links,
				expectedUpdatedAt: args.expectedUpdatedAt,
			};
		case "move":
			return {
				...base,
				id: args.id,
				direction: args.direction,
				beforeId: args.beforeId,
				afterId: args.afterId,
			};
		case "start":
			return {
				...base,
				id: args.id,
				branch: args.branch,
				clear: args.clear,
				expectedUpdatedAt: args.expectedUpdatedAt,
			};
		case "set_active":
			return { ...base, id: args.id, expectedUpdatedAt: args.expectedUpdatedAt };
		case "complete":
		case "reopen":
		case "archive":
		case "delete":
			return {
				...base,
				id: args.id,
				confirm: args.confirm,
				expectedUpdatedAt: args.expectedUpdatedAt,
			};
		default:
			throw new Error(`No MCP operation adapter for ${action}`);
	}
}

function successEnvelope(
	action: string,
	result: WorklistOperationResult,
	meta: WorklistResultMeta,
): WorklistApplicationResult {
	return { ok: true, scope: "project", action, result, meta };
}

function selectionFailure(
	action: string,
	selector: string,
	resolution: UnresolvedGoalSelector,
	meta: WorklistResultMeta,
): WorklistApplicationFailure {
	return {
		ok: false,
		scope: "project",
		action,
		error: projectGoalSelectionError(selector, resolution).toResultError(),
		meta,
	};
}

function validationFailure(
	action: string,
	message: string,
	details: Record<string, unknown>,
	meta: WorklistResultMeta,
): WorklistApplicationFailure {
	return {
		ok: false,
		scope: "project",
		action,
		error: {
			code: WORKLIST_ERROR_CODES.VALIDATION_FAILED,
			message,
			retryable: false,
			details,
		},
		meta,
	};
}

/**
 * The first value of a URI template variable, percent-decoded.
 *
 * `UriTemplate.match` hands back the raw path segment, so a value a client
 * encoded as docs/mcp.md asks arrives still encoded. A segment that is not
 * valid percent-encoding is read as written rather than throwing out of the
 * resource callback, which would answer a transport error instead of an
 * application-service envelope.
 */
function templateVariable(variables: Record<string, string | string[]>, name: string): string {
	const raw = variables[name];
	const value = Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

async function readEnvelope(
	service: WorklistApplicationService,
	action: string,
	variables: Record<string, string | string[]>,
): Promise<WorklistApplicationResult> {
	if (action === "list") {
		return service.execute({ scope: "project", action: "list" }, { source: "tool" });
	}

	const snapshot = await service.readProjectSnapshot(action);
	if (!snapshot.ok) return snapshot;
	const goals = snapshot.result.goals ?? [];
	const retiredIds = snapshot.result.retiredIds ?? [];

	switch (action) {
		case "show": {
			const selector = templateVariable(variables, "id");
			const resolution = resolveGoalSelector(goals, selector, retiredIds);
			if (resolution.kind !== "found") return selectionFailure(action, selector, resolution, snapshot.meta);
			const goal = resolution.goal;
			return successEnvelope(
				action,
				{
					scope: "project",
					action,
					goal,
					blocked: isGoalBlocked(goals, goal, retiredIds),
					blocks: dependentGoals(goals, goal, retiredIds).map((dependent) => dependent.id),
				},
				snapshot.meta,
			);
		}
		case "find": {
			const query = templateVariable(variables, "query").trim();
			if (!query) {
				return validationFailure(
					action,
					"Project find requires non-blank search text.",
					{ fields: ["query"], resolution: "provide-non-blank-search-text" },
					snapshot.meta,
				);
			}
			const matches = goals.filter((goal) => matchesGoalQuery(goal, query));
			return successEnvelope(action, { scope: "project", action, goals: matches }, snapshot.meta);
		}
		case "next": {
			const goal = nextGoal(goals, retiredIds);
			return successEnvelope(action, { scope: "project", action, ...(goal ? { goal } : {}) }, snapshot.meta);
		}
		case "ready":
			return successEnvelope(
				action,
				{ scope: "project", action, goals: readyGoals(goals, retiredIds) },
				snapshot.meta,
			);
		case "waves": {
			const { waves, unreachable } = dependencyWaves(goals, retiredIds);
			return successEnvelope(
				action,
				{
					scope: "project",
					action,
					waves,
					...(unreachable.length > 0 ? { unreachableGoals: unreachable } : {}),
				},
				snapshot.meta,
			);
		}
		default:
			throw new Error(`No MCP resource adapter for ${action}`);
	}
}

function toolResult(envelope: WorklistApplicationResult) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(envelope) }],
		structuredContent: envelope as unknown as Record<string, unknown>,
		isError: !envelope.ok,
	};
}

function resourceResult(uri: URL, envelope: WorklistApplicationResult) {
	return {
		contents: [
			{
				uri: uri.href,
				mimeType: "application/json",
				text: JSON.stringify(envelope),
			},
		],
	};
}

function resourceAddress(action: string): string | ResourceTemplate {
	switch (action) {
		case "show":
			return new ResourceTemplate(`${RESOURCE_URI_PREFIX}/show/{id}`, { list: undefined });
		case "find":
			return new ResourceTemplate(`${RESOURCE_URI_PREFIX}/find/{query}`, { list: undefined });
		default:
			return `${RESOURCE_URI_PREFIX}/${action}`;
	}
}

/**
 * Create the production MCP adapter for the repository containing `cwd`.
 *
 * The service receives the locator as a closure, not a startup path. Every MCP
 * resource read and tool write therefore re-runs the canonical current/legacy/
 * environment resolution before touching persistent state.
 */
export function createStepstoneMcpServer(options: StepstoneMcpServerOptions = {}): McpServer {
	const cwd = options.cwd ?? process.cwd();
	const env = options.env ?? process.env;
	const git = resolveGitRoot(cwd);
	const locate =
		git.isGit && git.root ? createWorklistLocator(git.root, { env, overrideBase: cwd }) : undefined;
	const operationService = () => {
		let shadowedWorklistPath: string | undefined;
		const service = new WorklistApplicationService({ projectPath: null });
		service.setProjectPathResolver(() => {
			const location = locate?.();
			shadowedWorklistPath = location?.shadowedPath;
			return location?.path ?? null;
		});
		return {
			service,
			withLocationMeta(envelope: WorklistApplicationResult): WorklistApplicationResult {
				if (!shadowedWorklistPath) return envelope;
				return {
					...envelope,
					meta: { ...envelope.meta, shadowedWorklistPath },
				};
			},
		};
	};

	const server = new McpServer({
		name: `${CLI_COMMAND_CONTRACT.binary}-mcp`,
		version: SERVER_VERSION,
	});

	for (const action of mcpActions("resource")) {
		const address = resourceAddress(action.name);
		const config = {
			title: action.mcpTitle,
			description: action.summary,
			mimeType: "application/json",
		};
		if (typeof address === "string") {
			server.registerResource(action.name, address, config, async (uri) => {
				const { service, withLocationMeta } = operationService();
				return resourceResult(uri, withLocationMeta(await readEnvelope(service, action.name, {})));
			});
		} else {
			server.registerResource(action.name, address, config, async (uri, variables) => {
				const { service, withLocationMeta } = operationService();
				return resourceResult(uri, withLocationMeta(await readEnvelope(service, action.name, variables)));
			});
		}
	}

	for (const action of mcpActions("tool")) {
		const inputSchema = inputSchemaFor(action);
		server.registerTool(
			action.name,
			{
				title: action.mcpTitle,
				description: mcpActionDescription(action),
				inputSchema,
				annotations: {
					readOnlyHint: false,
					openWorldHint: false,
				},
				_meta: {
					confirmRequired: action.confirmRequired === true,
					...(action.captureWorkflow ? { captureWorkflow: action.captureWorkflow } : {}),
				},
			},
			async (args: unknown) => {
				const { service, withLocationMeta } = operationService();
				const envelope = await service.execute(operationFor(action.name, args as ToolArguments), {
					source: "tool",
				});
				return toolResult(withLocationMeta(envelope));
			},
		);
	}

	return server;
}
