#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createStepstoneMcpServer } from "./mcp-server.ts";

async function main(): Promise<void> {
	const server = createStepstoneMcpServer();
	await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
	const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
	process.stderr.write(`${message}\n`);
	process.exitCode = 1;
});
