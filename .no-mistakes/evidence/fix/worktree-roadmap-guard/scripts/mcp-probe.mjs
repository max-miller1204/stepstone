// Drives the published MCP server (`stepstone-mcp`) over real stdio from inside a
// linked worktree, the way a coding agent would reach the roadmap.
//
//   argv[2]  source tree the server is run from
//   argv[3]  linked worktree the server runs in
//   argv[4]  main worktree, for the "sole writer still writes" leg
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const [, , src, linked, main] = process.argv;
const require = createRequire(`${src}/`);
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

async function withServer(cwd, run) {
	const client = new Client({ name: "stepstone-evidence-probe", version: "1.0.0" });
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [join(src, "src", "mcp.ts")],
		cwd,
		stderr: "inherit",
	});
	await client.connect(transport);
	try {
		return await run(client);
	} finally {
		await client.close();
	}
}

const goals = (path) => JSON.parse(readFileSync(path, "utf8")).goals.map((goal) => goal.id);

function banner(text) {
	console.log(`\n--- ${text} ${"-".repeat(Math.max(0, 58 - text.length))}`);
}

await withServer(linked, async (client) => {
	const tools = (await client.listTools()).tools.map((tool) => tool.name);
	console.log(`MCP server: stepstone-mcp over stdio, cwd = ${linked}`);
	console.log(`tools offered: ${tools.join(", ")}`);

	banner("MCP read from the linked worktree");
	const listed = await client.readResource({ uri: "stepstone://worklist/list" });
	console.log(JSON.stringify(JSON.parse(listed.contents[0].text).result.goals.map((g) => g.id)));

	banner("MCP mutation from the linked worktree");
	const added = await client.callTool({ name: "add", arguments: { title: "Forked through MCP" } });
	console.log(`isError: ${added.isError}`);
	console.log(added.content[0].text);
});

banner("MCP mutation from the main worktree");
await withServer(main, async (client) => {
	const added = await client.callTool({ name: "add", arguments: { title: "Added through MCP on main" } });
	console.log(`isError: ${added.isError}`);
	const envelope = JSON.parse(added.content[0].text);
	console.log(`ok: ${envelope.ok}, goal: ${JSON.stringify(envelope.result?.goal?.id ?? null)}`);
});

banner("roadmaps after the MCP session");
console.log(`main worktree:   ${JSON.stringify(goals(join(main, ".worklist", "worklist.json")))}`);
console.log(`linked worktree: ${JSON.stringify(goals(join(linked, ".worklist", "worklist.json")))}`);
const status = spawnSync("git", ["-C", linked, "status", "--short"], { encoding: "utf8" }).stdout.trim();
console.log(`git status in the linked worktree: ${status === "" ? "(clean)" : status}`);
