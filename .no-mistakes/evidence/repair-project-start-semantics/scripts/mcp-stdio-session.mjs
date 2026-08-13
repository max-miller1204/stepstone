// The MCP server as an agent host actually reaches it: the real `stepstone-mcp`
// entrypoint spawned over stdio, driven by the Model Context Protocol client SDK.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = process.argv[2];
const { Client } = await import(join(repo, "node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js"));
const { StdioClientTransport } = await import(
	join(repo, "node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js")
);

const root = realpathSync(mkdtempSync(join(tmpdir(), "stepstone-evidence-mcp-")));
execFileSync("git", ["init", "-q"], { cwd: root });
const config = join(root, ".git", "config");
const originalConfig = readFileSync(config, "utf8");

// The routine instance is a repository Git will not work in until something is
// repaired: a config it cannot parse, an owner it does not trust.
console.log("=== The repository Git refuses when the agent host connects ===");
writeFileSync(config, "this is not a config file\n");

const transport = new StdioClientTransport({
	command: process.execPath,
	args: [join(repo, "src", "mcp.ts")],
	cwd: root,
});
const client = new Client({ name: "stepstone-evidence-host", version: "1.0.0" });
await client.connect(transport);

function envelopeOf(response) {
	const text = response.content.find((entry) => entry.type === "text");
	return JSON.parse(text.text);
}

async function callTool(name, args) {
	console.log(`> tools/call ${name} ${JSON.stringify(args)}`);
	const envelope = envelopeOf(await client.callTool({ name, arguments: args }));
	console.log(JSON.stringify(envelope.ok ? { ok: true, result: envelope.result } : envelope, null, 2));
	console.log();
	return envelope;
}

async function readResource(uri) {
	console.log(`> resources/read ${uri}`);
	const response = await client.readResource({ uri });
	const envelope = JSON.parse(response.contents[0].text);
	console.log(JSON.stringify(envelope, null, 2));
	console.log();
	return envelope;
}

await callTool("add", { title: "While Git objects" });

console.log("=== The user runs the repair Git named, without reconnecting the host ===");
writeFileSync(config, originalConfig);
const added = await callTool("add", { title: "Ship the 1.0 release" });
const baseline = added.result.goal;

console.log("=== A branch claim guarded by the goal timestamp the host last read ===");
await callTool("start", {
	id: baseline.id,
	branch: "feat/ship-1-0",
	expectedUpdatedAt: baseline.updatedAt,
});

console.log("=== A second host still holding the stale read tries to claim the same goal ===");
await callTool("start", {
	id: baseline.id,
	branch: "feat/stale",
	expectedUpdatedAt: baseline.updatedAt,
});

console.log("=== The claim that actually holds, and the frontier that hides it ===");
await readResource("stepstone://worklist/list");
await readResource("stepstone://worklist/ready");

await client.close();
console.log(`Scratch repository: ${root}`);
