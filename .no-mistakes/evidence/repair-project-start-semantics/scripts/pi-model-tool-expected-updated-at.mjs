// The Pi model tool as a model actually reaches it: register the stepstone
// extension the way pi does, read the tool schema pi advertises, and issue tool
// calls composed only of fields that schema declares.
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = process.argv[2];
// Loaded through the repository's own Vite toolchain, because plain node cannot
// strip every TypeScript form this source uses. The module graph is the real one.
const { createServer } = await import(join(repo, "node_modules", "vite", "dist", "node", "index.js"));
const vite = await createServer({ configFile: false, root: repo, server: { middlewareMode: true } });
const { default: worklistExtension } = await vite.ssrLoadModule("/src/extension.ts");

function registerExtension() {
	let tool;
	const handlers = new Map();
	const api = {
		appendEntry: () => {},
		registerTool: (config) => {
			tool = config;
		},
		registerCommand: () => {},
		on: (event, handler) => handlers.set(event, handler),
		events: { emit: () => {}, on: () => () => {} },
	};
	worklistExtension(api);
	if (!tool) throw new Error("worklist tool was not registered");
	return { tool, handlers };
}

/** A tool call is composed from the advertised schema, so undeclared keys cannot arrive. */
function declaredArguments(parameters, params) {
	const declared = new Set(Object.keys(parameters.properties));
	const dropped = Object.keys(params).filter((name) => !declared.has(name));
	if (dropped.length) console.log(`  (schema does not declare ${dropped.join(", ")}: dropped from the tool call)`);
	return Object.fromEntries(Object.entries(params).filter(([name]) => declared.has(name)));
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "stepstone-evidence-pi-")));
execFileSync("git", ["init", "-q"], { cwd: root });

const { tool, handlers } = registerExtension();
const ctx = {
	cwd: root,
	mode: "cli",
	sessionManager: { getBranch: () => [] },
	ui: { notify: () => {}, setWidget: () => {} },
};
await handlers.get("session_start")({ reason: "new" }, ctx);

console.log("=== The parameter schema pi advertises to the model ===");
console.log(`expectedUpdatedAt: ${JSON.stringify(tool.parameters.properties.expectedUpdatedAt, null, 2)}`);
console.log(`required: ${JSON.stringify(tool.parameters.required ?? [])}`);
console.log();

async function call(params) {
	console.log(`> worklist ${JSON.stringify(params)}`);
	try {
		const result = await tool.execute("call", declaredArguments(tool.parameters, params), undefined, undefined, ctx);
		console.log(`  ok: ${JSON.stringify(result.details?.goal ?? result.details ?? result)}`);
		console.log();
		return result;
	} catch (error) {
		console.log(
			`  failed: ${JSON.stringify({ code: error.code, retryable: error.retryable, message: error.message, conflict: error.conflict }, null, 2)}`,
		);
		console.log();
		return undefined;
	}
}

console.log("=== A model reads the goal, then claims it against the timestamp it read ===");
const added = await call({ scope: "project", action: "add", title: "Guarded dispatch" });
const baseline = added.details.goal;

await call({
	scope: "project",
	action: "start",
	id: baseline.id,
	branch: "feat/guarded",
	expectedUpdatedAt: baseline.updatedAt,
});

console.log("=== A second model still holding the stale read tries to claim it ===");
await call({
	scope: "project",
	action: "start",
	id: baseline.id,
	branch: "feat/stale",
	expectedUpdatedAt: baseline.updatedAt,
});

console.log("=== What the roadmap actually holds afterwards ===");
const list = await call({ scope: "project", action: "list" });
console.log(JSON.stringify(list.details.goals, null, 2));

await vite.close();
