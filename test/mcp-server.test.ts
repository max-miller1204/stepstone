import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { CLI_COMMAND_CONTRACT, mcpActionDescription } from "../src/cli-contract.ts";
import { createStepstoneMcpServer } from "../src/mcp-server.ts";

const execFileAsync = promisify(execFile);
const RESOURCE_PREFIX = `${CLI_COMMAND_CONTRACT.binary}://worklist`;

interface ApplicationEnvelope {
	ok: boolean;
	scope: string;
	action: string;
	result?: Record<string, unknown>;
	error?: {
		code: string;
		message: string;
		retryable: boolean;
		details?: Record<string, unknown>;
	};
	meta: Record<string, unknown>;
}

async function createGitRepository(): Promise<string> {
	// The server reports the canonical repository root, which is what Git resolves a
	// symlinked temporary directory to on macOS, so the test has to name paths the
	// same way rather than by the link it happened to create the repository through.
	const root = await realpath(await mkdtemp(join(tmpdir(), "stepstone-mcp-")));
	await execFileAsync("git", ["init", "-q"], { cwd: root });
	return root;
}

async function withMcpClient<T>(root: string, run: (client: Client) => Promise<T>): Promise<T> {
	const server = createStepstoneMcpServer({ cwd: root, env: {} });
	const client = new Client({ name: "stepstone-mcp-test", version: "1.0.0" });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	await client.connect(clientTransport);
	try {
		return await run(client);
	} finally {
		await Promise.allSettled([client.close(), server.close()]);
	}
}

async function readEnvelope(client: Client, uri: string): Promise<ApplicationEnvelope> {
	const response = await client.readResource({ uri });
	expect(response.contents).toHaveLength(1);
	const content = response.contents[0];
	if (!content || !("text" in content)) throw new Error(`${uri} did not return textual JSON content`);
	expect(content).toMatchObject({ uri, mimeType: "application/json" });
	return JSON.parse(content.text) as ApplicationEnvelope;
}

async function callTool(
	client: Client,
	name: string,
	args: Record<string, unknown>,
): Promise<{ envelope: ApplicationEnvelope; isError: boolean | undefined }> {
	const response = (await client.callTool({ name, arguments: args })) as CallToolResult;
	const text = response.content.find((entry) => entry.type === "text");
	if (text?.type !== "text") throw new Error(`${name} did not return textual JSON content`);
	const envelope = JSON.parse(text.text) as ApplicationEnvelope;
	expect(response.structuredContent).toEqual(envelope);
	return { envelope, isError: response.isError };
}

function resultGoals(envelope: ApplicationEnvelope): Array<Record<string, unknown>> {
	return (envelope.result?.goals ?? []) as Array<Record<string, unknown>>;
}

function expectedApprovalRefusal(action: string): ApplicationEnvelope {
	return {
		ok: false,
		scope: "project",
		action,
		error: {
			code: "APPROVAL_REQUIRED",
			message: `Project ${action} requires explicit confirmation.`,
			retryable: false,
			details: {
				confirmation: "confirm=true",
				resolution: "request-explicit-user-confirmation",
			},
		},
		meta: { changed: false, semanticNoOp: false, changedFields: [] },
	};
}

describe("Stepstone MCP server", () => {
	it("advertises the contract-derived resources, templates, and tools", async () => {
		const root = await createGitRepository();
		await withMcpClient(root, async (client) => {
			const resourceActions = CLI_COMMAND_CONTRACT.actions.filter((action) => action.mcp === "resource");
			const toolActions = CLI_COMMAND_CONTRACT.actions.filter((action) => action.mcp === "tool");
			const fixedResourceActions = resourceActions.filter(
				(action) => action.name !== "show" && action.name !== "find",
			);
			const templateActions = resourceActions.filter(
				(action) => action.name === "show" || action.name === "find",
			);

			const resources = await client.listResources();
			expect(resources.resources).toEqual(
				fixedResourceActions.map((action) => ({
					name: action.name,
					title: action.usage,
					description: action.summary,
					mimeType: "application/json",
					uri: `${RESOURCE_PREFIX}/${action.name}`,
				})),
			);

			const templates = await client.listResourceTemplates();
			expect(templates.resourceTemplates).toEqual(
				templateActions.map((action) => ({
					name: action.name,
					title: action.usage,
					description: action.summary,
					mimeType: "application/json",
					uriTemplate: `${RESOURCE_PREFIX}/${action.name}/{${action.name === "show" ? "id" : "query"}}`,
				})),
			);

			const tools = await client.listTools();
			expect(tools.tools.map((tool) => tool.name)).toEqual(toolActions.map((action) => action.name));
			for (const action of toolActions) {
				const tool = tools.tools.find((candidate) => candidate.name === action.name);
				expect(tool).toMatchObject({
					name: action.name,
					title: action.usage,
					description: mcpActionDescription(action),
					inputSchema: { type: "object" },
					annotations: { readOnlyHint: false, openWorldHint: false },
					_meta: { confirmRequired: action.confirmRequired === true },
				});
				if (action.captureWorkflow) {
					expect(tool).toMatchObject({ _meta: { captureWorkflow: action.captureWorkflow } });
					expect(tool?.inputSchema).toMatchObject({
						properties: {
							plan: {
								description: action.captureWorkflow.schemaDescriptions.plan,
								items: {
									description: action.captureWorkflow.schemaDescriptions.entry,
									properties: {
										title: {
											description: action.captureWorkflow.schemaDescriptions.title,
										},
										description: {
											description: action.captureWorkflow.schemaDescriptions.description,
										},
										group: {
											description: action.captureWorkflow.schemaDescriptions.group,
										},
										dependsOn: {
											description: action.captureWorkflow.schemaDescriptions.dependsOn,
										},
									},
								},
							},
							dryRun: {
								description: action.captureWorkflow.schemaDescriptions.dryRun,
							},
						},
					});
				}
				if (!action.confirmRequired) continue;
				// docs/mcp.md documents confirmation as an application-service
				// guardrail rather than a schema requirement, so the published
				// schema has to keep an omitted `confirm` valid: the call reaches
				// the service and is answered with the actionable APPROVAL_REQUIRED
				// envelope instead of a guidance-free validation error.
				const schema = tool?.inputSchema as {
					required?: unknown;
					properties?: Record<string, unknown>;
				};
				expect(schema.required).toEqual(["id"]);
				expect(schema.properties?.confirm).toMatchObject({ type: "boolean" });
			}
		});
	});

	it("reads every resource and performs every non-lifecycle mutation through MCP", async () => {
		const root = await createGitRepository();
		await withMcpClient(root, async (client) => {
			expect(await readEnvelope(client, `${RESOURCE_PREFIX}/list`)).toMatchObject({
				ok: true,
				action: "list",
				result: { goals: [] },
			});

			const added = await callTool(client, "add", {
				title: "Alpha goal",
				description: "First foundation",
				group: "Foundation",
				links: ["https://example.com/alpha"],
			});
			expect(added).toMatchObject({
				isError: false,
				envelope: {
					ok: true,
					action: "add",
					result: { goal: { id: "alpha-goal", links: ["https://example.com/alpha"] } },
				},
			});

			const plan = [
				{ title: "Beta goal", dependsOn: ["alpha-goal"] },
				{ title: "Gamma goal", dependsOn: ["beta-goal"] },
			];
			const worklistPath = join(root, ".worklist", "worklist.json");
			const beforePreview = await readFile(worklistPath, "utf8");
			const preview = await callTool(client, "apply-plan", { plan, dryRun: true });
			expect(preview).toMatchObject({
				isError: false,
				envelope: {
					ok: true,
					action: "apply-plan",
					result: { dryRun: true, addedGoals: [{ id: "beta-goal" }, { id: "gamma-goal" }] },
					meta: { changed: false, revisions: { project: "1" } },
				},
			});
			expect(await readFile(worklistPath, "utf8")).toBe(beforePreview);

			const applied = await callTool(client, "apply-plan", { plan });
			expect(applied).toMatchObject({
				isError: false,
				envelope: {
					ok: true,
					action: "apply-plan",
					result: {
						addedGoals: [{ id: "beta-goal" }, { id: "gamma-goal" }],
					},
					meta: { changed: true, revisions: { project: "2" } },
				},
			});

			const updated = await callTool(client, "update", {
				id: "beta",
				title: "Updated beta",
				description: "Second stage",
				group: "Delivery",
			});
			expect(updated).toMatchObject({
				isError: false,
				envelope: {
					ok: true,
					action: "update",
					result: {
						goal: {
							id: "beta-goal",
							title: "Updated beta",
							description: "Second stage",
							group: "Delivery",
						},
					},
				},
			});
			const appended = await callTool(client, "update", {
				id: "beta",
				appendDescription: "Owned by MCP",
			});
			expect(appended.envelope).toMatchObject({
				ok: true,
				action: "update",
				result: { goal: { description: "Second stage\n\nOwned by MCP" } },
			});

			const moved = await callTool(client, "move", { id: "gamma", direction: "up" });
			expect(resultGoals(moved.envelope).map((goal) => goal.id)).toEqual([
				"alpha-goal",
				"gamma-goal",
				"beta-goal",
			]);

			const listed = await readEnvelope(client, `${RESOURCE_PREFIX}/list`);
			expect(resultGoals(listed).map((goal) => goal.id)).toEqual(["alpha-goal", "gamma-goal", "beta-goal"]);
			const shown = await readEnvelope(client, `${RESOURCE_PREFIX}/show/alpha`);
			expect(shown).toMatchObject({
				ok: true,
				action: "show",
				result: { goal: { id: "alpha-goal" }, blocked: false, blocks: ["beta-goal"] },
			});
			const found = await readEnvelope(client, `${RESOURCE_PREFIX}/find/Updated%20beta`);
			expect(resultGoals(found).map((goal) => goal.id)).toEqual(["beta-goal"]);
			const beforeInvalidUpdate = await readFile(worklistPath, "utf8");
			const blankTitle = await client.callTool({
				name: "update",
				arguments: { id: "beta", title: "   " },
			});
			expect(blankTitle).toMatchObject({ isError: true });
			const misspelledPrecondition = await client.callTool({
				name: "update",
				arguments: { id: "beta", expected_updated_at: "stale" },
			});
			expect(misspelledPrecondition).toMatchObject({ isError: true });
			expect(await readFile(worklistPath, "utf8")).toBe(beforeInvalidUpdate);
			expect(await readEnvelope(client, `${RESOURCE_PREFIX}/next`)).toMatchObject({
				ok: true,
				action: "next",
				result: { goal: { id: "alpha-goal" } },
			});
			expect(
				resultGoals(await readEnvelope(client, `${RESOURCE_PREFIX}/ready`)).map((goal) => goal.id),
			).toEqual(["alpha-goal"]);
			const waves = await readEnvelope(client, `${RESOURCE_PREFIX}/waves`);
			expect(
				((waves.result?.waves ?? []) as Array<Array<{ id: string }>>).map((wave) =>
					wave.map((goal) => goal.id),
				),
			).toEqual([["alpha-goal"], ["beta-goal"], ["gamma-goal"]]);

			const activated = await callTool(client, "set_active", { id: "alpha" });
			expect(activated).toMatchObject({
				isError: false,
				envelope: {
					ok: true,
					action: "set_active",
					result: { goal: { id: "alpha-goal", status: "active" } },
				},
			});
		});
	});

	it("decodes an encoded template value and answers a malformed one with an envelope", async () => {
		const root = await createGitRepository();
		await withMcpClient(root, async (client) => {
			await callTool(client, "add", { title: "Alpha goal" });

			// docs/mcp.md tells clients to URI-encode both path values, and the SDK
			// hands the segment back exactly as the client wrote it.
			expect(await readEnvelope(client, `${RESOURCE_PREFIX}/show/alpha%2Dgoal`)).toMatchObject({
				ok: true,
				action: "show",
				result: { goal: { id: "alpha-goal" } },
			});

			// A client that encoded nothing still matches both templates, so a
			// segment that is not valid percent-encoding has to stay an envelope
			// rather than a transport-level error the client cannot read.
			const malformedQuery = await readEnvelope(client, `${RESOURCE_PREFIX}/find/50%%20off`);
			expect(malformedQuery).toMatchObject({ ok: true, action: "find" });
			expect(resultGoals(malformedQuery)).toEqual([]);

			const malformedSelector = await readEnvelope(client, `${RESOURCE_PREFIX}/show/50%`);
			expect(malformedSelector).toMatchObject({ ok: false, action: "show" });
			expect(malformedSelector.error?.code).toBe("NOT_FOUND");
		});
	});

	it("forwards omitted, false, and true lifecycle confirmations without mutating on refusal", async () => {
		const root = await createGitRepository();
		await withMcpClient(root, async (client) => {
			await callTool(client, "add", { title: "Guarded goal" });
			const worklistPath = join(root, ".worklist", "worklist.json");
			const lifecycle = [
				{ action: "complete", status: "done" },
				{ action: "reopen", status: "open" },
				{ action: "archive", status: "archived" },
				{ action: "delete", status: undefined },
			] as const;

			for (const { action, status } of lifecycle) {
				for (const args of [{ id: "guarded-goal" }, { id: "guarded-goal", confirm: false }]) {
					const before = await readFile(worklistPath, "utf8");
					const refused = await callTool(client, action, args);
					expect(refused.isError).toBe(true);
					expect(refused.envelope).toEqual(expectedApprovalRefusal(action));
					expect(await readFile(worklistPath, "utf8")).toBe(before);
				}

				const accepted = await callTool(client, action, { id: "guarded-goal", confirm: true });
				expect(accepted.isError).toBe(false);
				expect(accepted.envelope).toMatchObject({ ok: true, scope: "project", action });
				if (status === undefined) {
					expect(resultGoals(accepted.envelope)).toEqual([]);
				} else {
					expect(accepted.envelope.result?.goal).toMatchObject({ id: "guarded-goal", status });
				}
			}
		});
	});

	it("resolves the worklist path again after a live connection moves from legacy to current", async () => {
		const root = await createGitRepository();
		const legacyPath = join(root, ".pi", "worklist.json");
		const currentPath = join(root, ".worklist", "worklist.json");
		await mkdir(dirname(legacyPath), { recursive: true });
		await writeFile(legacyPath, `${JSON.stringify({ version: 1, revision: 0, goals: [] })}\n`, "utf8");

		await withMcpClient(root, async (client) => {
			await callTool(client, "add", { title: "Written to legacy" });
			expect(JSON.parse(await readFile(legacyPath, "utf8"))).toMatchObject({
				goals: [{ id: "written-to-legacy" }],
			});

			await mkdir(dirname(currentPath), { recursive: true });
			await rename(legacyPath, currentPath);
			await callTool(client, "add", { title: "Written after move" });

			const current = JSON.parse(await readFile(currentPath, "utf8")) as {
				goals: Array<{ id: string }>;
			};
			expect(current.goals.map((goal) => goal.id)).toEqual(["written-to-legacy", "written-after-move"]);
			await expect(readFile(legacyPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
			await mkdir(dirname(legacyPath), { recursive: true });
			await writeFile(legacyPath, `${JSON.stringify({ version: 1, revision: 0, goals: [] })}\n`, "utf8");
			const shadowed = await readEnvelope(client, `${RESOURCE_PREFIX}/list`);
			expect(shadowed.meta).toMatchObject({ shadowedWorklistPath: legacyPath });
		});
	});
});
