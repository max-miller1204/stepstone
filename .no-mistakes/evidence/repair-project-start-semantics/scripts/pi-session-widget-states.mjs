// What a pi session shows the user: the roadmap widget the extension draws and
// the notices it raises, captured from the real extension through pi's own
// session lifecycle.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = process.argv[2];
const { createServer } = await import(join(repo, "node_modules", "vite", "dist", "node", "index.js"));
const vite = await createServer({ configFile: false, root: repo, server: { middlewareMode: true } });
const { default: worklistExtension } = await vite.ssrLoadModule("/src/extension.ts");

function startSession(cwd) {
	let tool;
	const handlers = new Map();
	const widget = { lines: undefined };
	const notifications = [];
	worklistExtension({
		appendEntry: () => {},
		registerTool: (config) => {
			tool = config;
		},
		registerCommand: () => {},
		on: (event, handler) => handlers.set(event, handler),
		events: { emit: () => {}, on: () => () => {} },
	});
	const ctx = {
		cwd,
		mode: "cli",
		sessionManager: { getBranch: () => [] },
		ui: {
			notify: (message) => notifications.push(message),
			setWidget: (_id, lines) => {
				widget.lines = lines;
			},
		},
	};
	return { tool, handlers, ctx, widget, notifications };
}

function draw(label, session) {
	console.log(`--- ${label} ---`);
	console.log("widget:");
	if (!session.widget.lines) console.log("  (no widget drawn)");
	else for (const line of session.widget.lines) console.log(`  ${line}`);
	console.log("notices:");
	if (!session.notifications.length) console.log("  (none)");
	else for (const notice of session.notifications) console.log(`  ! ${notice}`);
	console.log();
}

async function call(session, params) {
	const declared = new Set(Object.keys(session.tool.parameters.properties));
	const args = Object.fromEntries(Object.entries(params).filter(([name]) => declared.has(name)));
	console.log(`> worklist ${JSON.stringify(args)}`);
	try {
		await session.tool.execute("call", args, undefined, undefined, session.ctx);
		console.log("  ok");
	} catch (error) {
		console.log(`  failed: ${error.code}: ${error.message}`);
	}
}

function newRepository(prefix) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	execFileSync("git", ["init", "-q"], { cwd: root });
	return root;
}

console.log("=== A session on a repository with an active goal and session tasks ===");
const root = newRepository("stepstone-evidence-widget-");
const session = startSession(root);
await session.handlers.get("session_start")({ reason: "new" }, session.ctx);
await call(session, { scope: "project", action: "add", title: "Ship the 1.0 release" });
await call(session, { scope: "project", action: "add", title: "Draft the migration" });
await call(session, {
	scope: "project",
	action: "start",
	id: "ship-the-1-0-release",
	branch: "feat/ship-1-0",
});
await call(session, { scope: "project", action: "set_active", id: "ship-the-1-0-release" });
await call(session, { scope: "session", action: "add", title: "Read the release checklist" });
draw("what the user sees", session);

console.log("=== A session that starts while Git cannot be run at all ===");
const emptyBin = mkdtempSync(join(tmpdir(), "stepstone-evidence-nogit-bin-"));
const awayRoot = newRepository("stepstone-evidence-widget-away-");
const away = startSession(awayRoot);
const realPath = process.env.PATH;
process.env.PATH = emptyBin;
try {
	await away.handlers.get("session_start")({ reason: "new" }, away.ctx);
	await call(away, { scope: "project", action: "add", title: "While Git is away" });
	await call(away, { scope: "session", action: "add", title: "Session work still runs" });
} finally {
	process.env.PATH = realPath;
}
draw("the widget degrades, the operation says why", away);

console.log("=== Git comes back: the same session picks the repository up again ===");
await call(away, { scope: "project", action: "add", title: "Once Git is back" });
await call(away, { scope: "project", action: "set_active", id: "once-git-is-back" });
draw("no restart needed", away);

console.log("=== A goal file the session cannot parse is still named ===");
const malformedRoot = newRepository("stepstone-evidence-widget-malformed-");
mkdirSync(join(malformedRoot, ".worklist"), { recursive: true });
writeFileSync(join(malformedRoot, ".worklist", "worklist.json"), "{ not json\n");
const malformed = startSession(malformedRoot);
await malformed.handlers.get("session_start")({ reason: "new" }, malformed.ctx);
draw("a file someone has to repair is never silent", malformed);

await vite.close();
