import { execFile } from "node:child_process";
import {
	access,
	chmod,
	lstat,
	mkdtemp,
	readFile,
	realpath,
	stat,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { AgentsBlockError, agentsFileNeedsRefresh } from "../src/agents.ts";
import {
	AGENTS_BLOCK_END,
	AGENTS_BLOCK_START,
	CLI_COMMAND_CONTRACT,
	renderAgentsMarkdownBlock,
	WORKLIST_PATH_ENV,
} from "../src/cli-contract.ts";

const execFileAsync = promisify(execFile);
const cliPath = resolve("src/cli.ts");

interface CliResult {
	code: number;
	stdout: string;
	stderr: string;
}

async function runCli(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<CliResult> {
	const options = { cwd, ...(env ? { env: { ...process.env, ...env } } : {}) };
	try {
		const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...args], options);
		return { code: 0, stdout, stderr };
	} catch (error) {
		const failure = error as CliResult & { code: number | null };
		return { code: failure.code ?? 1, stdout: failure.stdout, stderr: failure.stderr };
	}
}

async function tempGitRepo(): Promise<string> {
	const root = await realpath(await mkdtemp(join(tmpdir(), "stepstone-agents-init-")));
	await execFileAsync("git", ["init", "-q"], { cwd: root });
	return root;
}

async function doesNotExist(path: string): Promise<boolean> {
	return access(path).then(
		() => false,
		() => true,
	);
}

function parseEnvelope<T>(text: string): T {
	try {
		return JSON.parse(text) as T;
	} catch (error) {
		throw new Error("Expected valid JSON in init CLI test", { cause: error });
	}
}

function markerCount(contents: string, marker: string): number {
	return contents.split(marker).length - 1;
}

describe("project init AGENTS.md generation", () => {
	it("targets --cwd while ignoring --file and STEPSTONE_WORKLIST, then only offers integrations", async () => {
		const root = await tempGitRepo();
		const caller = await mkdtemp(join(tmpdir(), "stepstone-agents-caller-"));
		const explicitWorklist = join(caller, "explicit.json");
		const environmentWorklist = join(caller, "environment.json");
		const result = await runCli(
			caller,
			["project", "init", "--cwd", root, "--file", explicitWorklist, "--json"],
			{ [WORKLIST_PATH_ENV]: environmentWorklist, HOME: join(caller, "home") },
		);

		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
		expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe(`${renderAgentsMarkdownBlock()}\n`);
		expect(await doesNotExist(explicitWorklist)).toBe(true);
		expect(await doesNotExist(environmentWorklist)).toBe(true);
		expect(await doesNotExist(join(caller, "home", ".claude"))).toBe(true);
		const envelope = parseEnvelope<{
			result: {
				agentsPath: string;
				integrations: {
					skill: { command: string };
					mcp: {
						config: {
							mcpServers: Record<string, { command: string; args: string[]; cwd: string }>;
						};
					};
				};
			};
			meta: { changed: boolean; semanticNoOp: boolean };
		}>(result.stdout);
		expect(envelope.result.agentsPath).toBe(join(root, "AGENTS.md"));
		expect(envelope.result.integrations.skill.command).toBe(
			CLI_COMMAND_CONTRACT.agentSetup.skillInstallCommand,
		);
		expect(envelope.result.integrations.mcp.config).toEqual({
			mcpServers: {
				[CLI_COMMAND_CONTRACT.agentSetup.mcp.name]: {
					command: CLI_COMMAND_CONTRACT.agentSetup.mcp.command,
					args: [...CLI_COMMAND_CONTRACT.agentSetup.mcp.args],
					cwd: root,
				},
			},
		});
		expect(envelope.meta).toMatchObject({ changed: true, semanticNoOp: false });
	});

	it("appends one block without changing any existing byte", async () => {
		const root = await tempGitRepo();
		const original = "# Existing instructions\r\n\r\nKeep this final byte: x";
		await writeFile(join(root, "AGENTS.md"), original, "utf8");

		const result = await runCli(root, ["project", "init"]);

		expect(result.code).toBe(0);
		const written = await readFile(join(root, "AGENTS.md"), "utf8");
		expect(written.startsWith(original)).toBe(true);
		expect(written).toBe(`${original}\n\n${renderAgentsMarkdownBlock()}\n`);
		expect(markerCount(written, AGENTS_BLOCK_START)).toBe(1);
		expect(markerCount(written, AGENTS_BLOCK_END)).toBe(1);
		expect(result.stdout).toContain(CLI_COMMAND_CONTRACT.agentSetup.skillInstallCommand);
		expect(result.stdout).toContain("--package");
		expect(result.stdout).toContain("were not installed or registered");
	});

	it("replaces one stale block while preserving the exact prefix and suffix", async () => {
		const root = await tempGitRepo();
		const prefix = "before\r\n";
		const suffix = "\r\nafter-without-newline";
		const stale = `${prefix}${AGENTS_BLOCK_START}\nold generated text\n${AGENTS_BLOCK_END}${suffix}`;
		await writeFile(join(root, "AGENTS.md"), stale, "utf8");

		const result = await runCli(root, ["project", "init"]);
		expect(result.code).toBe(0);
		expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe(
			`${prefix}${renderAgentsMarkdownBlock()}${suffix}`,
		);
	});

	it.each([
		["missing end", `${AGENTS_BLOCK_START}\nunfinished`, "malformed-markers"],
		["missing start", `unfinished\n${AGENTS_BLOCK_END}`, "malformed-markers"],
		["out of order", `${AGENTS_BLOCK_END}\n${AGENTS_BLOCK_START}`, "malformed-markers"],
		[
			"duplicate starts",
			`${AGENTS_BLOCK_START}\n${AGENTS_BLOCK_START}\n${AGENTS_BLOCK_END}`,
			"duplicate-markers",
		],
		[
			"duplicate ends",
			`${AGENTS_BLOCK_START}\n${AGENTS_BLOCK_END}\n${AGENTS_BLOCK_END}`,
			"duplicate-markers",
		],
		["inline markers", `quoted ${AGENTS_BLOCK_START}\nold\n${AGENTS_BLOCK_END}`, "malformed-markers"],
	])("refuses %s without changing the file", async (_name, contents, markerProblem) => {
		const root = await tempGitRepo();
		const path = join(root, "AGENTS.md");
		await writeFile(path, contents, "utf8");

		const result = await runCli(root, ["project", "init", "--json"]);

		expect(result.code).toBe(1);
		expect(result.stdout).toBe("");
		expect(await readFile(path, "utf8")).toBe(contents);
		const envelope = parseEnvelope<{
			error: { code: string; details: { markerProblem: string } };
			meta: { changed: boolean };
		}>(result.stderr);
		expect(envelope.error).toMatchObject({
			code: "VALIDATION_FAILED",
			details: { markerProblem },
		});
		expect(envelope.meta.changed).toBe(false);
	});
	it("refuses symlinks and invalid UTF-8 without changing authored storage", async () => {
		const root = await tempGitRepo();
		const path = join(root, "AGENTS.md");
		const target = join(root, "shared-agents.md");
		await writeFile(target, "shared guidance", "utf8");
		await symlink("shared-agents.md", path);

		const linked = await runCli(root, ["project", "init", "--json"]);
		expect(linked.code).toBe(1);
		expect((await lstat(path)).isSymbolicLink()).toBe(true);
		expect(await readFile(target, "utf8")).toBe("shared guidance");
		await unlink(path);

		await writeFile(path, Buffer.from([0xff]));
		const invalid = await runCli(root, ["project", "init", "--json"]);
		expect(invalid.code).toBe(1);
		expect(await readFile(path)).toEqual(Buffer.from([0xff]));
	});

	it("preserves an existing regular file's permission bits", async () => {
		const root = await tempGitRepo();
		const path = join(root, "AGENTS.md");
		await writeFile(path, "authored", "utf8");
		await chmod(path, 0o664);

		expect((await runCli(root, ["project", "init"])).code).toBe(0);
		expect((await stat(path)).mode & 0o777).toBe(0o664);
	});

	it("does not rewrite a byte-identical generated block", async () => {
		const root = await tempGitRepo();
		const first = await runCli(root, ["project", "init", "--json"]);
		expect(first.code).toBe(0);
		const path = join(root, "AGENTS.md");
		const before = await stat(path);

		const second = await runCli(root, ["project", "init", "--json"]);

		expect(second.code).toBe(0);
		const after = await stat(path);
		expect(after.ino).toBe(before.ino);
		expect(after.mtimeMs).toBe(before.mtimeMs);
		const envelope = parseEnvelope<{
			meta: { changed: boolean; semanticNoOp: boolean };
		}>(second.stdout);
		expect(envelope.meta).toMatchObject({ changed: false, semanticNoOp: true });
	});

	it("refuses on inspection whatever a refresh would refuse to overwrite", async () => {
		// The documentation check inspects the file without writing it, so a lossy
		// decode there would report a repairable staleness for storage the writer
		// then declines to touch at all.
		const root = await tempGitRepo();
		const path = join(root, "AGENTS.md");
		expect(await agentsFileNeedsRefresh(root)).toBe(true);

		await writeFile(path, Buffer.from([0xff]));
		await expect(agentsFileNeedsRefresh(root)).rejects.toThrow(AgentsBlockError);
		await expect(agentsFileNeedsRefresh(root)).rejects.toMatchObject({
			problem: "invalid-encoding",
			path,
		});
		await unlink(path);

		await writeFile(join(root, "shared-agents.md"), "shared guidance", "utf8");
		await symlink("shared-agents.md", path);
		await expect(agentsFileNeedsRefresh(root)).rejects.toMatchObject({
			problem: "unsupported-file",
			path,
		});
		await unlink(path);

		await writeFile(path, "authored\n", "utf8");
		expect(await agentsFileNeedsRefresh(root)).toBe(true);
		expect((await runCli(root, ["project", "init"])).code).toBe(0);
		expect(await agentsFileNeedsRefresh(root)).toBe(false);
	});

	it("names the refused file when init targets another repository", async () => {
		// `--cwd` puts the refused file outside the directory the person is standing
		// in, so a message naming only `AGENTS.md` gives them nothing to go repair.
		const root = await tempGitRepo();
		const caller = await mkdtemp(join(tmpdir(), "stepstone-agents-caller-"));
		const path = join(root, "AGENTS.md");
		await writeFile(join(root, "CLAUDE.md"), "authored guidance", "utf8");
		await symlink("CLAUDE.md", path);

		const result = await runCli(caller, ["project", "init", "--cwd", root]);

		expect(result.code).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr.trim()).toBe(`Refusing to update ${path}: the existing path is not a regular file.`);
		expect((await lstat(path)).isSymbolicLink()).toBe(true);
	});

	it("serializes concurrent initializers into one complete block", async () => {
		const root = await tempGitRepo();
		const results = await Promise.all(
			Array.from({ length: 6 }, () => runCli(root, ["project", "init", "--json"])),
		);

		expect(results.every(({ code }) => code === 0)).toBe(true);
		const changedResults = results.filter(({ stdout }) => {
			const envelope = parseEnvelope<{ meta: { changed: boolean } }>(stdout);
			return envelope.meta.changed;
		});
		expect(changedResults).toHaveLength(1);
		const contents = await readFile(join(root, "AGENTS.md"), "utf8");
		expect(contents).toBe(`${renderAgentsMarkdownBlock()}\n`);
		expect(markerCount(contents, AGENTS_BLOCK_START)).toBe(1);
		expect(markerCount(contents, AGENTS_BLOCK_END)).toBe(1);
	});
});
