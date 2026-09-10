import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const demoRoot = join(repositoryRoot, "artifacts", "stepstone-ui-demo");
const sessionDir = join(demoRoot, ".pi-sessions");
const extensionPath = join(repositoryRoot, "src", "extension.ts");
const cliPath = join(repositoryRoot, "src", "cli.ts");

function daysAgo(days: number): string {
	return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

const recent = daysAgo(2);
const older = daysAgo(50);
const completed = daysAgo(12);

const goals = [
	{
		id: "build-collaboration-workspace",
		title: "Build the collaboration workspace",
		description: "Create one workspace where product teams can plan, review, and ship a release together.",
		status: "active",
		group: "Product",
		createdAt: daysAgo(80),
		updatedAt: recent,
	},
	{
		id: "validate-product-direction",
		title: "Validate the product direction",
		description: "Test the first workflow with design partners and record the decisions that shape the beta.",
		status: "done",
		group: "Product",
		createdAt: daysAgo(95),
		updatedAt: completed,
		completedAt: completed,
	},
	{
		id: "invite-design-partners",
		title: "Invite design partners",
		description: "Invite a small group of teams after the collaboration workspace is ready.",
		status: "open",
		group: "Product",
		createdAt: daysAgo(42),
		updatedAt: recent,
		dependsOn: ["build-collaboration-workspace"],
	},
	{
		id: "ship-public-beta",
		title: "Ship the public beta",
		description:
			"Open the workspace to new teams. Publish onboarding guides, release notes, and a support plan.",
		status: "open",
		group: "Product",
		createdAt: daysAgo(35),
		updatedAt: recent,
		dependsOn: ["invite-design-partners", "complete-security-review"],
		links: ["https://example.com/releases/public-beta", "https://example.com/docs/onboarding"],
	},
	{
		id: "design-pi-dashboard",
		title: "Design the Pi dashboard",
		description: "Give Pi users a focused view of Session Tasks and Project Goals.",
		status: "done",
		group: "Integrations",
		createdAt: daysAgo(90),
		updatedAt: completed,
		completedAt: completed,
	},
	{
		id: "retire-preview-bot",
		title: "Retire the preview bot",
		status: "archived",
		group: "Integrations",
		createdAt: daysAgo(75),
		updatedAt: daysAgo(30),
	},
	{
		id: "connect-github-releases",
		title: "Connect GitHub releases",
		description: "Publish release evidence from the same workflow that closes a Project Goal.",
		status: "open",
		group: "Integrations",
		createdAt: daysAgo(28),
		updatedAt: recent,
	},
	{
		id: "prepare-slack-notifications",
		title: "Prepare Slack notifications",
		status: "open",
		group: "Integrations",
		createdAt: daysAgo(21),
		updatedAt: recent,
		dependsOn: ["connect-github-releases"],
	},
	{
		id: "automate-regression-suite",
		title: "Automate the regression suite",
		description: "Run the full release path against a clean install before each beta build.",
		status: "open",
		group: "Quality",
		createdAt: daysAgo(55),
		updatedAt: older,
	},
	{
		id: "set-performance-budget",
		title: "Set the performance budget",
		description: "Set response-time and memory limits for the terminal interfaces.",
		status: "open",
		group: "Quality",
		createdAt: daysAgo(25),
		updatedAt: recent,
		branch: "feat/performance-budget",
	},
	{
		id: "complete-security-review",
		title: "Complete the security review",
		status: "open",
		group: "Quality",
		createdAt: daysAgo(24),
		updatedAt: recent,
		dependsOn: ["automate-regression-suite"],
	},
	{
		id: "measure-release-readiness",
		title: "Measure release readiness",
		status: "open",
		group: "Quality",
		createdAt: daysAgo(18),
		updatedAt: recent,
		dependsOn: ["complete-security-review"],
	},
	{
		id: "resolve-legacy-import-gap",
		title: "Resolve the legacy import gap",
		description: "Decide how to handle roadmap files created by unsupported preview builds.",
		status: "open",
		group: "Quality",
		createdAt: daysAgo(16),
		updatedAt: recent,
		dependsOn: ["retired-importer"],
	},
	{
		id: "publish-launch-retrospective",
		title: "Publish the launch retrospective",
		status: "open",
		createdAt: daysAgo(10),
		updatedAt: recent,
		dependsOn: ["ship-public-beta"],
	},
];

type RpcResponse = {
	id?: string;
	type: string;
	success?: boolean;
	data?: unknown;
};

class RpcClient {
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly pending = new Map<
		string,
		{ resolve: (response: RpcResponse) => void; reject: (error: Error) => void }
	>();
	private buffer = "";
	private stderr = "";
	private sequence = 0;

	constructor() {
		this.child = spawn(
			"pi",
			[
				"--mode",
				"rpc",
				"--offline",
				"--no-extensions",
				"--no-skills",
				"--no-prompt-templates",
				"--no-themes",
				"--no-context-files",
				"--session-dir",
				sessionDir,
				"--session-id",
				"00000000-0000-4000-8000-000000000001",
				"--name",
				"Stepstone screenshot demo",
				"-e",
				extensionPath,
			],
			{ cwd: demoRoot, stdio: ["pipe", "pipe", "pipe"] },
		);
		this.child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
		this.child.stderr.on("data", (chunk: Buffer) => {
			this.stderr += chunk.toString("utf8");
		});
		this.child.on("error", (error) => this.rejectAll(error));
		this.child.on("exit", (code, signal) => {
			if (this.pending.size === 0) return;
			this.rejectAll(
				new Error(
					`Pi RPC exited before it answered (code ${String(code)}, signal ${String(signal)}).\n${this.stderr}`,
				),
			);
		});
	}

	private onData(chunk: Buffer): void {
		this.buffer += chunk.toString("utf8");
		for (;;) {
			const newline = this.buffer.indexOf("\n");
			if (newline < 0) return;
			const line = this.buffer.slice(0, newline);
			this.buffer = this.buffer.slice(newline + 1);
			if (line.trim() === "") continue;
			const message = JSON.parse(line) as RpcResponse;
			if (message.type === "extension_error") {
				this.rejectAll(new Error(`Pi extension error: ${line}`));
				continue;
			}
			if (message.type !== "response" || message.id === undefined) continue;
			const request = this.pending.get(message.id);
			if (!request) continue;
			this.pending.delete(message.id);
			if (message.success === false) {
				request.reject(new Error(`Pi RPC request failed: ${line}\n${this.stderr}`));
			} else {
				request.resolve(message);
			}
		}
	}

	private rejectAll(error: Error): void {
		for (const request of this.pending.values()) request.reject(error);
		this.pending.clear();
	}

	request(command: Record<string, unknown>): Promise<RpcResponse> {
		const id = `demo-${this.sequence++}`;
		return new Promise((resolveRequest, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Pi RPC request timed out: ${JSON.stringify(command)}\n${this.stderr}`));
			}, 20_000);
			this.pending.set(id, {
				resolve: (response) => {
					clearTimeout(timer);
					resolveRequest(response);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
			this.child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
		});
	}

	async close(): Promise<void> {
		this.child.stdin.end();
		await new Promise<void>((resolveClose, reject) => {
			const timer = setTimeout(() => {
				this.child.kill("SIGTERM");
				reject(new Error(`Pi RPC did not exit after stdin closed.\n${this.stderr}`));
			}, 10_000);
			this.child.once("exit", (code) => {
				clearTimeout(timer);
				if (code === 0 || code === null) resolveClose();
				else reject(new Error(`Pi RPC exited with code ${code}.\n${this.stderr}`));
			});
		});
	}
}

async function seedSessionTasks(): Promise<void> {
	const rpc = new RpcClient();
	try {
		await rpc.request({ type: "get_commands" });
		for (const title of [
			"Confirm the beta acceptance criteria",
			"Update the onboarding guide",
			"Capture the terminal UI screenshots",
			"Publish the launch notes",
		]) {
			await rpc.request({ type: "prompt", message: `/tasks session add ${title}` });
		}

		const response = await rpc.request({ type: "get_entries" });
		const entries = (response.data as { entries: Array<Record<string, unknown>> }).entries;
		const snapshot = entries
			.filter((entry) => entry.type === "custom" && entry.customType === "worklist-session-snapshot")
			.at(-1) as { data: { tasks: Array<{ id: string }> } } | undefined;
		if (snapshot?.data.tasks.length !== 4) {
			throw new Error("Pi did not persist the four demo Session Tasks.");
		}
		await rpc.request({
			type: "prompt",
			message: `/tasks session status ${snapshot.data.tasks[0].id} done`,
		});
		await rpc.request({
			type: "prompt",
			message: `/tasks session status ${snapshot.data.tasks[1].id} doing`,
		});

		const finalEntriesResponse = await rpc.request({ type: "get_entries" });
		const finalEntries = (finalEntriesResponse.data as { entries: Array<Record<string, unknown>> }).entries;
		const stateResponse = await rpc.request({ type: "get_state" });
		const state = stateResponse.data as { sessionFile?: string; sessionId?: string };
		if (!state.sessionFile || !state.sessionId) {
			throw new Error("Pi did not assign a file and ID to the demo session.");
		}
		// Pi defers a session file until an assistant message exists. This demo has only
		// extension state, so persist the documented JSONL header and RPC entries here.
		const header = {
			type: "session",
			version: 3,
			id: state.sessionId,
			timestamp: new Date().toISOString(),
			cwd: demoRoot,
		};
		await writeFile(
			state.sessionFile,
			`${[header, ...finalEntries].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
		);
	} finally {
		await rpc.close();
	}
}

async function main(): Promise<void> {
	await rm(demoRoot, { recursive: true, force: true });
	await mkdir(join(demoRoot, ".worklist"), { recursive: true });
	await writeFile(
		join(demoRoot, "README.md"),
		"# Acme Workspace\n\nA fixture repository for Stepstone UI screenshots.\n",
	);
	await writeFile(
		join(demoRoot, ".worklist", "worklist.json"),
		`${JSON.stringify({ version: 1, revision: 1, goals }, null, "\t")}\n`,
	);

	const piLauncher = join(demoRoot, "open-pi.sh");
	const boardLauncher = join(demoRoot, "open-project-ui.sh");
	await writeFile(
		piLauncher,
		`#!/bin/sh\nset -eu\ncd -- "$(dirname "$0")"\nexec pi --offline --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --use-theme dark --session-dir .pi-sessions -e ${JSON.stringify(extensionPath)} --continue "/tasks"\n`,
	);
	await writeFile(
		boardLauncher,
		`#!/bin/sh\nset -eu\ncd -- "$(dirname "$0")"\nexec node ${JSON.stringify(cliPath)} project ui\n`,
	);
	await chmod(piLauncher, 0o755);
	await chmod(boardLauncher, 0o755);

	const git = (args: string[]) =>
		new Promise<void>((resolveCommand, reject) => {
			const child = spawn("git", args, { cwd: demoRoot, stdio: "inherit" });
			child.once("error", reject);
			child.once("exit", (code) => {
				if (code === 0) resolveCommand();
				else reject(new Error(`git ${args.join(" ")} exited with code ${String(code)}.`));
			});
		});
	await git(["init", "-q"]);
	await git(["add", "README.md", ".worklist/worklist.json"]);
	await git([
		"-c",
		"user.name=Stepstone Demo",
		"-c",
		"user.email=demo@example.com",
		"commit",
		"-q",
		"-m",
		"Seed screenshot demo",
	]);
	await seedSessionTasks();

	await writeFile(
		join(demoRoot, "SCREENSHOTS.md"),
		`# Screenshot demo\n\nResize the terminal to about 116 columns by 40 rows.\n\n## Pi dashboard\n\nRun:\n\n\`\`\`sh\n./open-pi.sh\n\`\`\`\n\nThe launcher opens \`/tasks\`. Use Tab to switch between Session Tasks and Project Goals.\n\n## Project Goal board\n\nRun:\n\n\`\`\`sh\n./open-project-ui.sh\n\`\`\`\n\nPress Right or Space on a section to expand it. Press \`q\` to exit either interface.\n`,
	);

	console.log(`Created the screenshot demo at:\n${demoRoot}\n\nOpen it with:\ncd ${demoRoot}`);
}

await main();
