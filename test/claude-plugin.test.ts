import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	CLAUDE_PLUGIN_COMMANDS_DIRECTORY,
	CLAUDE_PLUGIN_MANIFEST_PATH,
	CLAUDE_PLUGIN_MARKETPLACE_PATH,
	CLAUDE_PLUGIN_SKILL_PATH,
	CLI_COMMAND_CONTRACT,
	type ClaudePluginPackageMetadata,
	claudePluginActions,
	renderClaudePluginArtifacts,
	renderSkillMarkdown,
	SKILL_PATH,
} from "../src/cli-contract.ts";

const packageMetadata = JSON.parse(
	await readFile(resolve("package.json"), "utf8"),
) as ClaudePluginPackageMetadata;

const kebabCase = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const semanticVersion = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
const authorSchema = z
	.object({
		name: z.string().min(1),
		email: z.string().email().optional(),
		url: z.url().optional(),
	})
	.strict();
const mcpServersSchema = z
	.record(
		kebabCase,
		z
			.object({
				command: z.literal("node"),
				args: z.tuple([z.literal(`\${CLAUDE_PLUGIN_ROOT}/dist/mcp.js`)]),
				env: z
					.object({
						STEPSTONE_PLUGIN_PROJECT_ROOT: z.literal(`\${CLAUDE_PROJECT_DIR}`),
					})
					.strict(),
			})
			.strict(),
	)
	.refine((servers) => Object.keys(servers).length === 1);
const pluginManifestSchema = z
	.object({
		name: kebabCase,
		displayName: z.string().min(1),
		version: semanticVersion,
		description: z.string().min(1),
		author: authorSchema,
		homepage: z.url(),
		repository: z.url(),
		license: z.string().min(1),
		keywords: z.array(z.string().min(1)).min(1),
		mcpServers: mcpServersSchema,
	})
	.strict();
const marketplaceSchema = z
	.object({
		name: kebabCase,
		description: z.string().min(1),
		owner: authorSchema,
		plugins: z
			.array(
				z
					.object({
						name: kebabCase,
						source: z
							.object({
								source: z.literal("npm"),
								package: kebabCase,
							})
							.strict(),
						description: z.string().min(1),
						category: z.string().min(1),
						tags: z.array(z.string().min(1)).min(1),
					})
					.strict(),
			)
			.length(1),
	})
	.strict();

function parseGeneratedJson(path: string, content: string): unknown {
	try {
		return JSON.parse(content) as unknown;
	} catch (error) {
		throw new Error(`${path} must contain valid JSON`, { cause: error });
	}
}

function commandFrontmatter(markdown: string): Record<string, unknown> {
	const lines = markdown.split("\n");
	if (lines[0] !== "---") throw new Error("command has no opening frontmatter delimiter");
	const end = lines.indexOf("---", 1);
	if (end < 0) throw new Error("command has no closing frontmatter delimiter");
	const values: Record<string, unknown> = {};
	for (const line of lines.slice(1, end)) {
		const separator = line.indexOf(":");
		if (separator < 1) throw new Error(`invalid command frontmatter line: ${line}`);
		const key = line.slice(0, separator);
		const raw = line.slice(separator + 1).trim();
		values[key] = raw === "true" ? true : raw === "false" ? false : JSON.parse(raw);
	}
	return values;
}

describe("Claude Code plugin", () => {
	it("selects exactly the five contract actions intended as namespaced commands", () => {
		const actions = claudePluginActions();
		expect(actions.map((action) => action.name)).toEqual(["list", "next", "ready", "waves", "ui"]);
		for (const action of actions.filter((entry) => entry.claudePlugin === "read-only")) {
			expect(action.mcp, `${action.name} must remain an MCP resource`).toBe("resource");
			expect(action.confirmRequired).not.toBe(true);
			expect(action.interactive).not.toBe(true);
		}
		const ui = actions.find((action) => action.name === "ui");
		expect(ui).toMatchObject({ claudePlugin: "human-interactive", interactive: true });
		expect(
			CLI_COMMAND_CONTRACT.actions
				.filter((action) => action.claudePlugin === undefined)
				.map((action) => action.name),
		).toContain("show");
		expect(
			CLI_COMMAND_CONTRACT.actions.find((action) => action.name === "find")?.claudePlugin,
		).toBeUndefined();
		for (const action of CLI_COMMAND_CONTRACT.actions.filter(
			(entry) => entry.mcp === "tool" || entry.confirmRequired,
		)) {
			expect(action.claudePlugin, `${action.name} must not become a mutation slash command`).toBeUndefined();
		}
	});

	it("keeps every committed plugin artifact byte-for-byte generated", async () => {
		const artifacts = renderClaudePluginArtifacts(packageMetadata);
		for (const artifact of artifacts) {
			expect(
				await readFile(resolve(artifact.path), "utf8"),
				`${artifact.path} is stale; run \`npm run docs\` to regenerate it`,
			).toBe(artifact.content);
		}
		expect(await readFile(resolve(CLAUDE_PLUGIN_SKILL_PATH), "utf8")).toBe(
			renderSkillMarkdown({ userInvocable: false }),
		);

		const commandFiles = (await readdir(resolve(CLAUDE_PLUGIN_COMMANDS_DIRECTORY))).sort();
		const pluginSkill = await readFile(resolve(CLAUDE_PLUGIN_SKILL_PATH), "utf8");
		expect(pluginSkill).toContain("user-invocable: false");
		expect(pluginSkill.replace("user-invocable: false\n", "")).toBe(
			await readFile(resolve(SKILL_PATH), "utf8"),
		);
		expect(commandFiles).toEqual(["list.md", "next.md", "ready.md", "ui.md", "waves.md"]);
		const metadataFiles = (await readdir(resolve(".claude-plugin"))).sort();
		expect(metadataFiles).toEqual(["marketplace.json", "plugin.json"]);
		expect(
			existsSync(resolve(".mcp.json")),
			"the plugin MCP declaration must not register as project-scoped config in this checkout",
		).toBe(false);
	});

	it("conforms semantically to the official manifest and marketplace schemas", () => {
		const artifacts = new Map(
			renderClaudePluginArtifacts(packageMetadata).map(({ path, content }) => [path, content]),
		);
		const manifest = pluginManifestSchema.parse(
			parseGeneratedJson(CLAUDE_PLUGIN_MANIFEST_PATH, artifacts.get(CLAUDE_PLUGIN_MANIFEST_PATH) ?? ""),
		);
		expect(manifest).toMatchObject({
			name: packageMetadata.name,
			version: packageMetadata.version,
			description: packageMetadata.description,
			license: packageMetadata.license,
		});

		const marketplace = marketplaceSchema.parse(
			parseGeneratedJson(CLAUDE_PLUGIN_MARKETPLACE_PATH, artifacts.get(CLAUDE_PLUGIN_MARKETPLACE_PATH) ?? ""),
		);
		expect(marketplace.plugins[0]).toMatchObject({
			name: manifest.name,
			source: { source: "npm", package: packageMetadata.name },
		});
		expect(marketplace.name).toBe(manifest.name);

		expect(manifest.mcpServers).toEqual({
			stepstone: {
				command: "node",
				args: [`\${CLAUDE_PLUGIN_ROOT}/dist/mcp.js`],
				env: { STEPSTONE_PLUGIN_PROJECT_ROOT: `\${CLAUDE_PROJECT_DIR}` },
			},
		});
	});

	it("renders read commands as deterministic resource reads and UI as human-only", () => {
		const artifacts = new Map(
			renderClaudePluginArtifacts(packageMetadata).map(({ path, content }) => [path, content]),
		);
		for (const action of claudePluginActions()) {
			const path = `${CLAUDE_PLUGIN_COMMANDS_DIRECTORY}/${action.name}.md`;
			const command = artifacts.get(path);
			if (!command) throw new Error(`missing generated command ${path}`);
			const frontmatter = commandFrontmatter(command);
			expect(frontmatter.description).toBe(action.summary);
			if (action.claudePlugin === "read-only") {
				expect(frontmatter).toEqual({ description: action.summary });
				expect(command).toContain(`stepstone://worklist/${action.name}`);
				expect(command).toContain(`stepstone project ${action.usage}`);
				expect(command).toContain("This command is read-only.");
				expect(command).toContain("Do not call an MCP tool");
				expect(command).not.toContain("dist/cli.js");
				continue;
			}
			expect(frontmatter).toEqual({ description: action.summary, "disable-model-invocation": true });
			expect(command).toContain(`node "\${CLAUDE_PLUGIN_ROOT}/dist/cli.js" project ui`);
			expect(command).toContain("only for a human at the keyboard");
			expect(command).toContain("only through its existing explicit keyboard interactions");
		}
	});
});
