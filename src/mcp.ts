#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CLAUDE_PLUGIN_PROJECT_ROOT_ENV } from "./cli-contract.ts";
import { createStepstoneMcpServer } from "./mcp-server.ts";

async function main(): Promise<void> {
	const pluginProjectRoot = process.env[CLAUDE_PLUGIN_PROJECT_ROOT_ENV];
	const server = createStepstoneMcpServer({
		cwd: pluginProjectRoot && pluginProjectRoot.length > 0 ? pluginProjectRoot : undefined,
	});
	await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
	const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
	process.stderr.write(`${message}\n`);
	process.exitCode = 1;
});
