import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { DispatchRun, RoadmapSnapshot } from "../../src/dispatch-driver.ts";
import { compileWorkspaceFixture } from "./compile-workspace.ts";

const exec = promisify(execFile);
const artifactRoot = resolve(import.meta.dirname, "../../artifacts/process-boundaries");
let runner: string;

// Node 20 cannot execute TypeScript. Compile the subprocess and its production
// imports separately from dist/, which the package tests rebuild concurrently.
export async function compileProcessBoundaryRunner(): Promise<void> {
	runner = join(await compileWorkspaceFixture("process-boundary"), "test/fixtures/dispatch-boundary.js");
}

export const branch = "stepstone/alpha";
const goal = {
	id: "alpha",
	title: "Alpha boundary goal",
	description: "Prepare, claim, reconcile, and clean through real tools.",
	status: "open",
	createdAt: "2026-02-01T00:00:00.000Z",
	updatedAt: "2026-02-01T00:00:00.000Z",
};

export interface PullRequest {
	headRefName: string;
	baseRefName: string;
	createdAt: string;
	mergedAt: string;
	mergeCommit: { oid: string } | null;
	url: string;
}

export async function withProcessBoundary(operation: (f: ProcessBoundary) => Promise<void>): Promise<void> {
	await mkdir(artifactRoot, { recursive: true });
	const directory = await realpath(await mkdtemp(join(artifactRoot, "case-")));
	const fixture = new ProcessBoundary(directory);
	let passed = false;
	try {
		await fixture.initialize();
		await operation(fixture);
		await fixture.close();
		passed = true;
	} catch (error) {
		try {
			await writeFile(
				join(directory, "failure.txt"),
				error instanceof Error ? (error.stack ?? error.message) : String(error),
			);
		} catch (evidenceError) {
			console.error("Could not save failure stack:", evidenceError);
		}
		console.error(`Process-boundary failure evidence retained at ${directory}`);
		throw error;
	} finally {
		if (passed) await rm(directory, { recursive: true, force: true });
		else {
			// Teardown must never replace the boundary's original failure.
			await fixture.close().catch((error) => console.error("Fixture teardown failed:", error));
		}
	}
}

class ProcessBoundary {
	readonly root: string;
	readonly remote: string;
	readonly workspace: string;
	readonly env: NodeJS.ProcessEnv;
	readonly requests: Array<{ method?: string; url?: string; body: string; authenticated: boolean }> = [];
	pullRequests: PullRequest[] = [];
	apiFailure?: "http" | "graphql" | "malformed";
	base = "";
	private server = createServer(async (request, response) => {
		let body = "";
		for await (const chunk of request) body += chunk;
		const exchange = {
			method: request.method,
			url: request.url,
			body,
			authenticated: !!request.headers.authorization,
		};
		this.requests.push(exchange);
		const status = this.apiFailure === "http" ? 503 : 200;
		const responseBody =
			this.apiFailure === "malformed"
				? "{broken-json"
				: JSON.stringify(
						this.apiFailure === "http"
							? { message: "boundary fixture unavailable" }
							: this.apiFailure === "graphql"
								? { errors: [{ message: "boundary fixture GraphQL failure" }] }
								: {
										data: {
											repository: {
												pullRequests: {
													nodes: this.pullRequests,
													totalCount: this.pullRequests.length,
													pageInfo: { hasNextPage: false, endCursor: null },
												},
											},
										},
									},
					);
		await appendFile(
			join(this.directory, "http.jsonl"),
			`${JSON.stringify({ ...exchange, status, responseBody })}\n`,
		);
		response.writeHead(status, { "Content-Type": "application/json" });
		response.end(responseBody);
	});

	constructor(readonly directory: string) {
		this.root = join(directory, "repo");
		this.remote = join(directory, "remote.git");
		this.workspace = join(directory, "stepstone-alpha");
		// Deliberately do not inherit Git/gh credentials, repository discovery,
		// hooks, signing, proxies, or global user configuration.
		this.env = {
			PATH: process.env.PATH,
			TMPDIR: join(directory, "tmp"),
			LANG: "C",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: join(directory, "gitconfig"),
			GIT_TERMINAL_PROMPT: "0",
			GIT_TRACE2_EVENT: join(directory, "git-trace.jsonl"),
			GH_CONFIG_DIR: join(directory, "gh"),
			GH_HOST: "github.localhost",
			GH_REPO: "github.localhost/fixture/stepstone",
			GH_PROMPT_DISABLED: "1",
			GH_NO_UPDATE_NOTIFIER: "1",
			GH_TELEMETRY: "0",
			XDG_CACHE_HOME: join(directory, "cache"),
		};
	}

	async initialize(): Promise<void> {
		await mkdir(this.root);
		await mkdir(this.env.TMPDIR as string);
		await mkdir(this.env.GH_CONFIG_DIR as string);
		await writeFile(this.env.GIT_CONFIG_GLOBAL as string, "");
		// gh accepts a configured host without a token. The socket fixture needs
		// no login and never contacts GitHub or forwards an Authorization header.
		await writeFile(
			join(this.directory, "gh/hosts.yml"),
			"github.localhost:\n    user: fixture\n    git_protocol: https\n",
		);
		// Declare the current schema so gh does not try to migrate credentials
		// through an OS keyring (Linux CI has no secret-service daemon).
		await writeFile(join(this.directory, "gh/config.yml"), "version: 1\nhttp_unix_socket: ../api.sock\n");
		// Relative socket paths avoid macOS's short Unix-socket path limit.
		await new Promise<void>((accept, reject) => {
			this.server.once("error", reject);
			this.server.listen(relative(process.cwd(), join(this.directory, "api.sock")), () => {
				this.server.off("error", reject);
				accept();
			});
		});
		await this.command(process.execPath, ["--version"]);
		await this.command("git", ["--version"]);
		await this.command("gh", ["--version"]);
		await this.git("init", "-q", "-b", "main");
		await this.git("config", "user.name", "Stepstone Test");
		await this.git("config", "user.email", "stepstone@example.test");
		await writeFile(join(this.root, "seed"), "seed\n");
		await writeFile(join(this.root, ".gitignore"), ".worklist/\n");
		await this.git("add", ".");
		await this.git("commit", "-qm", "seed");
		await this.git("init", "--bare", "-q", this.remote);
		await this.git("remote", "add", "origin", this.remote);
		await this.git("push", "-u", "origin", "main");
		this.base = await this.git("rev-parse", "HEAD");
		await mkdir(join(this.root, ".worklist"));
		await writeFile(
			join(this.root, ".worklist/worklist.json"),
			JSON.stringify({ version: 1, revision: 0, goals: [goal], retiredIds: [] }),
		);
	}

	async command(command: string, args: string[], cwd = this.root) {
		let result: { stdout: string; stderr: string; code?: string | number; signal?: string | null };
		try {
			result = await exec(command, args, { cwd, env: this.env, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 });
		} catch (error) {
			result = error as typeof result;
		}
		await appendFile(
			join(this.directory, "commands.jsonl"),
			`${JSON.stringify({ command, args, cwd, ...result })}\n`,
		);
		if (result.code !== undefined || result.signal) throw result;
		return result;
	}

	async git(...args: string[]): Promise<string> {
		return (await this.command("git", args)).stdout.trim();
	}

	async workGit(...args: string[]): Promise<string> {
		return (await this.command("git", args, this.workspace)).stdout.trim();
	}

	async run(action: string, value = "", token = "", fault = ""): Promise<DispatchRun> {
		return JSON.parse(
			(await this.command(process.execPath, [runner, this.root, this.directory, action, value, token, fault]))
				.stdout,
		);
	}

	async read(): Promise<RoadmapSnapshot> {
		return JSON.parse(
			(await this.command(process.execPath, [runner, this.root, this.directory, "read"])).stdout,
		);
	}

	async prepare(fault = ""): Promise<DispatchRun> {
		const run = await this.run("create", this.base);
		return this.run("advance", run.id, "", fault);
	}

	pr(claimedAt: string, mergeCommit = this.base): PullRequest {
		return {
			headRefName: branch,
			baseRefName: "main",
			createdAt: claimedAt,
			mergedAt: claimedAt,
			mergeCommit: { oid: mergeCommit },
			url: "https://github.localhost/fixture/stepstone/pull/1",
		};
	}

	async trace(): Promise<string> {
		return readFile(join(this.directory, "git-trace.jsonl"), "utf8");
	}

	async close(): Promise<void> {
		if (!this.server.listening) return;
		this.server.closeAllConnections();
		await new Promise<void>((accept, reject) =>
			this.server.close((error) => (error ? reject(error) : accept())),
		);
	}
}
