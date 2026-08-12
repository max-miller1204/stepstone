/**
 * End-to-end evidence: what a Pi agent actually receives.
 *
 * Registers the real extension against a stub Pi ExtensionAPI, prints the
 * promptGuidelines delivered to registerTool, then checks the same canonical
 * capture workflow reaches every other agent-facing surface: the generated
 * skill, the AGENTS block written by a real `project init` run, the CLI guide,
 * and a live MCP server's apply-plan tool description.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const REPO = process.env.STEPSTONE_REPO ?? process.cwd();
const { Client } = await import(`${REPO}/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js`);
const { InMemoryTransport } = await import(`${REPO}/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js`);
const { default: worklistExtension } = await import(`${REPO}/src/extension.ts`);
const { CLI_COMMAND_CONTRACT, captureWorkflowAction, renderCliGuide, renderSkillMarkdown } = await import(
	`${REPO}/src/cli-contract.ts`
);
const { createStepstoneMcpServer } = await import(`${REPO}/src/mcp-server.ts`);

const steps = captureWorkflowAction(CLI_COMMAND_CONTRACT.actions).captureWorkflow.steps;

// 1. The prompt Pi hands the model.
let registered;
worklistExtension({
	appendEntry: () => {},
	registerTool: (config) => {
		registered = config;
	},
	registerCommand: () => {},
	on: () => {},
	events: { emit: () => {}, on: () => () => {} },
});

console.log("=== Pi registerTool({ name: %s }) promptGuidelines ===\n", registered.name);
for (const [index, guideline] of registered.promptGuidelines.entries()) {
	console.log(`${index + 1}. ${guideline}\n`);
}

// 2. AGENTS.md written by a real `project init` in a scratch repository.
const repo = mkdtempSync(join(tmpdir(), "stepstone-evidence-"));
const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
git("init", "-q");
git("config", "user.email", "evidence@example.com");
git("config", "user.name", "evidence");
const initOutput = execFileSync(process.execPath, [join(REPO, "src/cli.ts"), "project", "init"], {
	cwd: repo,
	encoding: "utf8",
});
console.log("=== stepstone project init (scratch repo) ===");
console.log(initOutput.trim());
const agentsBlock = readFileSync(join(repo, "AGENTS.md"), "utf8");
const agentsCapture = agentsBlock.split("\n").find((line) => line.startsWith("Capture workflow:"));
console.log(`\n${agentsCapture}\n`);

// 3. Live MCP apply-plan tool description.
const server = createStepstoneMcpServer({ cwd: repo, env: {} });
const client = new Client({ name: "capture-parity-evidence", version: "1.0.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
const tools = await client.listTools();
const applyPlan = tools.tools.find((tool) => tool.name.includes("apply_plan") || tool.name.includes("apply-plan"));
console.log("=== live MCP tool %s description ===\n", applyPlan.name);
console.log(`${applyPlan.description}\n`);
await client.close();

// 4. Parity + guardrail checks across every surface.
const piGuideline = registered.promptGuidelines.find((guideline) => guideline.includes(steps[0]));
const surfaces = {
	"Pi model-tool prompt": piGuideline ?? "",
	"generated skill": renderSkillMarkdown(CLI_COMMAND_CONTRACT),
	"AGENTS block (project init)": agentsBlock,
	"CLI guide": renderCliGuide(CLI_COMMAND_CONTRACT),
	"MCP apply-plan tool": applyPlan.description,
};

console.log("=== canonical capture workflow steps, per surface ===\n");
let failures = 0;
for (const [name, text] of Object.entries(surfaces)) {
	const missing = steps.filter((step) => !text.includes(step));
	failures += missing.length === 0 ? 0 : 1;
	console.log(`${missing.length === 0 ? "PASS" : "FAIL"}  ${name}: ${steps.length - missing.length}/${steps.length} canonical steps present`);
	for (const step of missing) console.log(`      missing: ${step}`);
}

const guardrail =
	"Never set worklist confirm=true for a project lifecycle action unless the user explicitly requested that exact completion, reopening, archival, or deletion.";
const guardrailKept = registered.promptGuidelines.includes(guardrail);
failures += guardrailKept ? 0 : 1;
console.log(`\n${guardrailKept ? "PASS" : "FAIL"}  Pi prompt keeps the exact project lifecycle confirmation guardrail`);

const decomposes = /per-goal `?add`? calls for|split .* into .* add calls/i.test(piGuideline ?? "");
const forbidsDecomposition = (piGuideline ?? "").includes("never turn the batch into per-goal `add` calls");
failures += forbidsDecomposition && !decomposes ? 0 : 1;
console.log(`${forbidsDecomposition ? "PASS" : "FAIL"}  Pi prompt forbids decomposing an approved batch into per-goal add calls`);

const singleSource = piGuideline?.includes(steps.join(" "));
failures += singleSource ? 0 : 1;
console.log(`${singleSource ? "PASS" : "FAIL"}  Pi prompt text is the contract's step list verbatim (single workflow source)`);

console.log(`\n${failures === 0 ? "ALL SURFACES IN PARITY" : `${failures} surface check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
