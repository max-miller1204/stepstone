/**
 * Drives a stepstone checkout the way a real MCP client and a real CLI user
 * would: it spawns `node <root>/src/mcp.ts` over stdio, talks to it with the
 * MCP SDK client, and runs `node <root>/src/cli.ts ... --json` against the same
 * repository, printing both adapters' answers side by side.
 *
 *   node mcp-parity-harness.mjs <checkout-root> <label>
 */
import { execFile } from "node:child_process";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const execFileAsync = promisify(execFile);
const root = resolve(process.argv[2]);
const label = process.argv[3] ?? root;
const PREFIX = "stepstone://worklist";

function heading(text) {
	console.log(`\n${"=".repeat(78)}\n${text}\n${"=".repeat(78)}`);
}

function show(text) {
	console.log(`\n--- ${text} ---`);
}

async function cli(cwd, args) {
	try {
		const { stdout, stderr } = await execFileAsync(process.execPath, [join(root, "src", "cli.ts"), "project", ...args], {
			cwd,
		});
		return { exitCode: 0, stdout, stderr };
	} catch (error) {
		return { exitCode: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
	}
}

function printCli(args, run) {
	console.log(`$ stepstone project ${args.map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ")}`);
	console.log(`exit ${run.exitCode}`);
	// A CLI usage error reprints the whole help screen; the transcript keeps the
	// diagnostic line and drops the help body so the two adapters stay readable
	// side by side.
	const raw = `${run.stdout}${run.stderr}`.trim();
	const usageAt = raw.indexOf("\nUsage: stepstone");
	const body = usageAt === -1 ? raw : `${raw.slice(0, usageAt).trim()}\n[help screen omitted from transcript]`;
	console.log(body ? body : "(no output)");
}

function toolResult(response) {
	const text = response.content?.find((entry) => entry.type === "text")?.text;
	let envelope;
	try {
		envelope = text ? JSON.parse(text) : undefined;
	} catch {
		envelope = undefined;
	}
	return {
		isError: response.isError,
		hasStructuredContent: response.structuredContent !== undefined,
		envelope,
		text,
	};
}

function printMcpTool(name, args, result) {
	console.log(`MCP tool call: ${name} ${JSON.stringify(args)}`);
	console.log(`isError: ${result.isError} | structuredContent present: ${result.hasStructuredContent}`);
	console.log(result.envelope ? JSON.stringify(result.envelope, null, 2) : `text: ${result.text}`);
}

async function readResource(client, uri) {
	const response = await client.readResource({ uri });
	const content = response.contents[0];
	return JSON.parse(content.text);
}

const repo = await realpath(await mkdtemp(join(tmpdir(), "stepstone-parity-")));
await execFileAsync("git", ["init", "-q"], { cwd: repo });

const transport = new StdioClientTransport({
	command: process.execPath,
	args: [join(root, "src", "mcp.ts")],
	cwd: repo,
	env: { PATH: process.env.PATH, HOME: process.env.HOME, STEPSTONE_PLUGIN_PROJECT_ROOT: repo },
});
const client = new Client({ name: "parity-harness", version: "1.0.0" });
await client.connect(transport);

heading(`stepstone MCP adapter parity transcript - ${label}`);
console.log(`checkout: ${root}`);
console.log(`repository under test: ${repo}`);
console.log(`server: ${JSON.stringify(client.getServerVersion())}`);

heading("1. What an MCP client sees in the catalog (titles)");
const resources = await client.listResources();
const templates = await client.listResourceTemplates();
const tools = await client.listTools();
show("resources");
for (const entry of resources.resources) console.log(`  ${entry.uri.padEnd(34)} title: ${entry.title}`);
show("resource templates");
for (const entry of templates.resourceTemplates) console.log(`  ${entry.uriTemplate.padEnd(34)} title: ${entry.title}`);
show("tools");
for (const entry of tools.tools) console.log(`  ${entry.name.padEnd(34)} title: ${entry.title}`);

heading("2. Seed one goal through the MCP add tool");
const added = toolResult(await client.callTool({ name: "add", arguments: { title: "Alpha goal" } }));
console.log(`isError: ${added.isError} | goal id: ${added.envelope?.result?.goal?.id}`);
const goalId = added.envelope?.result?.goal?.id ?? "alpha-goal";

heading("3. update: title combined with appendDescription");
const updateArgs = { id: goalId, title: "Renamed goal", appendDescription: "New context." };
printMcpTool("update", updateArgs, toolResult(await client.callTool({ name: "update", arguments: updateArgs })));
show("same request through the CLI adapter");
const cliUpdateArgs = ["update", goalId, "Renamed goal", "--append-description", "New context.", "--json"];
printCli(cliUpdateArgs, await cli(repo, cliUpdateArgs));

heading("4. apply-plan: dependsOn reference with surrounding whitespace");
const planArgs = { plan: [{ title: "Dependent goal", dependsOn: [` ${goalId} `] }] };
printMcpTool("apply-plan", planArgs, toolResult(await client.callTool({ name: "apply-plan", arguments: planArgs })));
show("same plan through the CLI adapter");
const planPath = join(repo, "plan.json");
await writeFile(planPath, JSON.stringify(planArgs.plan, null, 2));
printCli(["apply-plan", planPath, "--json"], await cli(repo, ["apply-plan", planPath, "--json"]));

heading("5. find with a blank query");
console.log(`MCP resource read: ${PREFIX}/find/%20%20`);
console.log(JSON.stringify(await readResource(client, `${PREFIX}/find/%20%20`), null, 2));
show("same request through the CLI adapter");
printCli(["find", "  ", "--json"], await cli(repo, ["find", "  ", "--json"]));

heading("6. show for an unknown goal: failure metadata");
const missing = await readResource(client, `${PREFIX}/show/missing`);
console.log(`MCP resource read: ${PREFIX}/show/missing`);
console.log(JSON.stringify({ ok: missing.ok, code: missing.error?.code, meta: missing.meta }, null, 2));
show("same request through the CLI adapter");
const cliShow = await cli(repo, ["show", "missing", "--json"]);
console.log(`$ stepstone project show missing --json`);
console.log(`exit ${cliShow.exitCode}`);
const cliShowEnvelope = JSON.parse(`${cliShow.stdout}${cliShow.stderr}`.trim());
console.log(
	JSON.stringify({ ok: cliShowEnvelope.ok, code: cliShowEnvelope.error?.code, meta: cliShowEnvelope.meta }, null, 2),
);

heading("7. MCP input-schema failure stays outside the application-service envelope");
const schemaBad = await client.callTool({ name: "update", arguments: { id: goalId, links: ["not-a-url"] } });
console.log(`MCP tool call: update {"id":"${goalId}","links":["not-a-url"]}`);
console.log(`isError: ${schemaBad.isError} | structuredContent present: ${schemaBad.structuredContent !== undefined}`);
console.log(`content: ${JSON.stringify(schemaBad.content)}`);

heading("8. Roadmap state after every refusal above");
const list = await readResource(client, `${PREFIX}/list`);
for (const goal of list.result?.goals ?? []) {
	console.log(`  ${goal.id} | title: ${goal.title} | dependsOn: ${JSON.stringify(goal.dependsOn ?? [])}`);
	console.log(`     description: ${JSON.stringify(goal.description ?? "")}`);
}

await client.close();
