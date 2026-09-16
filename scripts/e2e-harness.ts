/** Subprocess-only support for the published-surface tier. No application imports. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface CommandResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

export interface Envelope {
	ok: boolean;
	action: string;
	result: {
		goals: Goal[];
		goal: Goal;
		addedGoals: Goal[];
		[key: string]: unknown;
	};
	meta: { changed: boolean; revisions: { project: string }; cliVersion: string };
	error: { code: string; retryable: boolean; details: Record<string, unknown> };
}

export interface Goal {
	id: string;
	title: string;
	status: string;
	updatedAt: string;
	description?: string;
	dependsOn?: string[];
	branch?: string;
}

export const repoRoot = resolve(import.meta.dirname, "..");

export class Harness {
	private sequence = 0;
	readonly env: NodeJS.ProcessEnv;
	readonly root: string;

	private constructor(root: string) {
		this.root = root;
		// Do not inherit goal-file overrides, Git plumbing, provider credentials,
		// user hooks/signing settings, NODE_OPTIONS, or a user's Pi configuration.
		this.env = {
			PATH: process.env.PATH,
			SystemRoot: process.env.SystemRoot,
			HOME: join(root, "home"),
			USERPROFILE: join(root, "home"),
			XDG_CONFIG_HOME: join(root, "home", "config"),
			XDG_DATA_HOME: join(root, "home", "data"),
			TMPDIR: join(root, "tmp"),
			TMP: join(root, "tmp"),
			TEMP: join(root, "tmp"),
			PI_CODING_AGENT_DIR: join(root, "pi-agent"),
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
			GIT_TERMINAL_PROMPT: "0",
			GIT_AUTHOR_NAME: "Stepstone E2E",
			GIT_AUTHOR_EMAIL: "e2e@example.test",
			GIT_COMMITTER_NAME: "Stepstone E2E",
			GIT_COMMITTER_EMAIL: "e2e@example.test",
			GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
			GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
			npm_config_cache: join(root, "npm-cache"),
			npm_config_update_notifier: "false",
			NO_COLOR: "1",
			TZ: "UTC",
			LANG: "C",
		};
	}

	static async create(): Promise<Harness> {
		const parent = join(repoRoot, "artifacts", "e2e");
		await mkdir(parent, { recursive: true });
		const h = new Harness(await realpath(await mkdtemp(join(parent, "run-"))));
		await Promise.all(["home", "tmp", "logs", "pi-agent"].map((dir) => mkdir(join(h.root, dir))));
		await writeFile(join(h.root, "gitconfig"), "[init]\n\tdefaultBranch = main\n");
		await writeFile(
			join(h.root, "environment.json"),
			JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch }, null, 2),
		);
		return h;
	}

	log(label: string): string {
		return join(this.root, "logs", `${String(++this.sequence).padStart(3, "0")}-${label}.jsonl`);
	}

	async run(
		command: string,
		args: string[],
		cwd: string,
		options: { env?: NodeJS.ProcessEnv; timeout?: number } = {},
	): Promise<CommandResult> {
		const log = this.log("command");
		appendFileSync(log, `${JSON.stringify({ command, args, cwd })}\n`);
		const child = spawn(command, args, {
			cwd,
			env: { ...this.env, ...options.env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let spawnError: Error | undefined;
		child.on("error", (error) => {
			spawnError = error;
			appendFileSync(log, `${JSON.stringify({ error: error.message })}\n`);
		});
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
			appendFileSync(log, `${JSON.stringify({ stdout: chunk.toString() })}\n`);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
			appendFileSync(log, `${JSON.stringify({ stderr: chunk.toString() })}\n`);
		});
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, options.timeout ?? 60_000);
		const [code, signal] = await new Promise<[number | null, string | null]>((done) => {
			child.once("close", (code, signal) => done([code, signal]));
		});
		clearTimeout(timer);
		appendFileSync(log, `${JSON.stringify({ code, signal, timedOut })}\n`);
		assert.ifError(spawnError);
		assert.equal(timedOut, false, `command timed out: ${log}`);
		assert.equal(signal, null, `command killed: ${log}`);
		return { code, stdout, stderr };
	}

	async checked(command: string, args: string[], cwd: string, timeout?: number): Promise<string> {
		const result = await this.run(command, args, cwd, { timeout });
		assert.equal(result.code, 0, `${command} ${args.join(" ")}\n${result.stderr}`);
		return result.stdout;
	}

	async repository(name: string): Promise<string> {
		const cwd = join(this.root, name);
		await mkdir(cwd);
		await this.checked("git", ["init", "-q"], cwd);
		return cwd;
	}

	async finish(passed: boolean): Promise<void> {
		if (passed) await rm(this.root, { recursive: true, force: true });
		else console.error(`E2E artifacts retained at ${this.root}`);
	}
}

export function envelope(
	result: CommandResult,
	action: string,
	error?: { exit: number; code: string },
): Envelope {
	assert.equal(result.code, error?.exit ?? 0, `${action}: ${result.stderr}`);
	assert.equal(error ? result.stdout : result.stderr, "", `${action}: unexpected output stream`);
	const value = JSON.parse(error ? result.stderr : result.stdout) as Envelope;
	assert.equal(value.ok, !error);
	assert.equal(value.action, action);
	if (error) assert.equal(value.error.code, error.code);
	return value;
}

export async function readWorklist(cwd: string): Promise<{ revision: number; goals: Goal[] }> {
	return JSON.parse(await readFile(join(cwd, ".worklist", "worklist.json"), "utf8"));
}

/** One sequential RPC stream with IDs, bounded waits and complete wire logs. */
export async function withRpc(
	h: Harness,
	cwd: string,
	packagePath: string,
	exercise: (request: (body: object) => Promise<Record<string, unknown>>) => Promise<void>,
): Promise<void> {
	const log = h.log("rpc");
	const piManifest = JSON.parse(
		await readFile(join(repoRoot, "node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8"),
	) as { bin: { pi: string } };
	const args = [
		join(repoRoot, "node_modules/@earendil-works/pi-coding-agent", piManifest.bin.pi),
		"--mode",
		"rpc",
		"--offline",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"--no-context-files",
		"--session-dir",
		join(cwd, "sessions"),
		"-e",
		packagePath,
	];
	appendFileSync(log, `${JSON.stringify({ command: process.execPath, args, cwd })}\n`);
	const child = spawn(process.execPath, args, { cwd, env: h.env, stdio: ["pipe", "pipe", "pipe"] });
	const closed = new Promise<void>((resolve) =>
		child.once("close", (code, signal) => {
			appendFileSync(log, `${JSON.stringify({ code, signal })}\n`);
			resolve();
		}),
	);
	let fatal: Error | undefined;
	let buffer = "";
	let sequence = 0;
	let pending:
		| { id: string; resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }
		| undefined;
	const fail = (error: Error) => {
		fatal = error;
		pending?.reject(error);
	};
	child.on("error", (error) => {
		appendFileSync(log, `${JSON.stringify({ error: error.message })}\n`);
		fail(error);
	});
	child.stdin.on("error", fail);
	child.on("exit", (code, signal) => fail(new Error(`Pi exited: ${code}/${signal}; ${log}`)));
	child.stderr.on("data", (chunk: Buffer) =>
		appendFileSync(log, `${JSON.stringify({ stderr: chunk.toString() })}\n`),
	);
	child.stdout.on("data", (chunk: Buffer) => {
		appendFileSync(log, `${JSON.stringify({ stdout: chunk.toString() })}\n`);
		buffer += chunk.toString();
		for (;;) {
			const end = buffer.indexOf("\n");
			if (end < 0) break;
			const line = buffer.slice(0, end);
			buffer = buffer.slice(end + 1);
			if (!line.trim()) continue;
			try {
				const value = JSON.parse(line) as Record<string, unknown>;
				if (value.type === "extension_error") throw new Error(line);
				if (value.type === "response" && value.id === pending?.id) pending?.resolve(value);
			} catch (error) {
				fail(error as Error);
			}
		}
	});
	const request = async (body: object) => {
		if (fatal) throw fatal;
		const id = String(++sequence);
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
				pending = { id, resolve, reject };
				timer = setTimeout(() => reject(new Error(`RPC timed out: ${log}`)), 30_000);
				const wire = JSON.stringify({ ...body, id });
				appendFileSync(log, `${JSON.stringify({ stdin: wire })}\n`);
				child.stdin.write(`${wire}\n`);
			});
			assert.equal(response.success, true, JSON.stringify(response));
			return response;
		} finally {
			clearTimeout(timer);
			pending = undefined;
		}
	};
	try {
		await exercise(request);
		if (fatal) throw fatal;
	} finally {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGTERM");
			const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
			await closed;
			clearTimeout(timer);
		}
		await closed;
	}
}
