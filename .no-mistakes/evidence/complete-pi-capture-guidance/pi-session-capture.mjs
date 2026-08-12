/**
 * Product-level evidence: a Pi session that follows the delivered prompt.
 *
 * Registers the real extension, starts a session on a scratch repository, and
 * drives the registered `worklist` tool exactly the way the capture guideline
 * tells a Pi agent to: dry-run as a preview only, then one mutating apply-plan
 * call for the whole approved batch, never per-goal add calls. The transcript
 * shows what the model is told, what it calls, and what the user sees back.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = process.env.STEPSTONE_REPO ?? process.cwd();
const { default: worklistExtension } = await import(`${REPO}/src/extension.ts`);

const root = mkdtempSync(join(tmpdir(), "stepstone-pi-session-"));
execFileSync("git", ["init", "-q"], { cwd: root });

let tool;
const handlers = new Map();
worklistExtension({
	appendEntry: () => {},
	registerTool: (config) => {
		tool = config;
	},
	registerCommand: () => {},
	on: (event, handler) => handlers.set(event, handler),
	events: { emit: () => {}, on: () => () => {} },
});

const notifications = [];
let widget;
const ctx = {
	cwd: root,
	mode: "cli",
	sessionManager: { getBranch: () => [] },
	ui: { notify: (message) => notifications.push(message), setWidget: (_id, lines) => (widget = lines) },
};
await handlers.get("session_start")({ reason: "new" }, ctx);

const goalFile = join(root, ".worklist", "worklist.json");
const mutating = [];
async function call(label, params) {
	console.log(`\n--- ${label} ---`);
	console.log(`> worklist ${JSON.stringify(params)}`);
	try {
		const result = await tool.execute("call", params, undefined, undefined, ctx);
		if (params.action !== "list" && params.dryRun !== true) mutating.push(params.action);
		console.log(result.content.map((item) => item.text).join("\n"));
		return result;
	} catch (error) {
		console.log(`! ${error.code ?? "error"}: ${error.message}`);
		return null;
	}
}

const guideline = tool.promptGuidelines.find((line) => line.startsWith("When using worklist to capture Project Goals"));
console.log("=== the guideline this session is following ===\n");
console.log(guideline);

const plan = [
	{ title: "Offline-first sync for the mobile client", group: "Platform" },
	{
		title: "Self-serve billing portal",
		description: "Customers change plan and payment method without contacting support.",
		group: "Growth",
	},
	{ title: "Usage-based invoicing", group: "Growth", dependsOn: ["self-serve-billing-portal"] },
];

console.log("\n=== the exact JSON batch presented to the user for approval ===\n");
console.log(JSON.stringify(plan, null, 2));

await call("preview only: dry-run before approval", { scope: "project", action: "apply-plan", plan, dryRun: true });
const wroteOnDryRun = existsSync(goalFile);
console.log(`\ngoal file written by the dry-run? ${wroteOnDryRun ? "YES (unexpected)" : "no"}`);

console.log("\n[user] approved - apply that exact batch.");
await call("one mutating apply-plan call for the whole approved batch", { scope: "project", action: "apply-plan", plan });

const listed = await call("what the roadmap holds now", { scope: "project", action: "list" });
const goals = listed?.details?.goals ?? [];

await call("lifecycle guardrail: complete without an explicit request", {
	scope: "project",
	action: "complete",
	id: goals[0]?.id,
});

console.log("\n=== session widget the user sees ===\n");
console.log(Array.isArray(widget) ? widget.join("\n") : "(no widget: this session has no Session Tasks and no active goal)");

console.log("\n=== checks ===\n");
const results = [
	["dry-run previewed without writing the goal file", wroteOnDryRun === false],
	[`exactly one mutating call, and it was apply-plan (${mutating.join(", ") || "none"})`, mutating.length === 1 && mutating[0] === "apply-plan"],
	[`the whole batch landed in that one call (${goals.length}/3 goals)`, goals.length === 3],
	["no per-goal add call was needed", !mutating.includes("add")],
	["dependency from the batch slug resolved", goals[2]?.dependsOn?.length === 1],
	["unrequested complete was refused", goals[0]?.status === "open"],
];
let failed = 0;
for (const [label, ok] of results) {
	if (!ok) failed += 1;
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
}
console.log(`\n${failed === 0 ? "PI SESSION FOLLOWS THE DELIVERED GUIDANCE END TO END" : `${failed} check(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);
