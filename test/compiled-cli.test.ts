import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { glob, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, resolve } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { beforeAll, describe, expect, it } from "vitest";
import {
	CLI_COMMAND_CONTRACT,
	type ClaudePluginMcpServer,
	type ClaudePluginPackageMetadata,
	renderClaudePluginArtifacts,
	renderSkillMarkdown,
	resolveClaudePluginMcpServer,
	SKILL_PATH,
} from "../src/cli-contract.ts";
import { ROADMAP_PATH } from "../src/roadmap.ts";
import { DOCS_DIRECTORY, documentationPages } from "./docs-pages.ts";
import { buildPackage, packedFilePaths } from "./npm-pack.ts";

const execFileAsync = promisify(execFile);
const compiledCliPath = resolve("dist/cli.js");
const compiledMcpPath = resolve("dist/mcp.js");

/**
 * Everything this checkout writes for itself rather than for an install.
 *
 * A published tarball is downloaded by everyone who runs the CLI once through
 * `npx`, so it carries what an install reads and nothing else: the notes a
 * contributor to this repository needs are on the repository, where the person
 * who needs them already is. `AGENTS.md` is the rule list for changing this
 * source, the roadmap is this project's own goals, and the development and
 * releasing pages describe working on the package rather than using it.
 */
const DEVELOPMENT_ONLY_FILES: readonly string[] = [
	"AGENTS.md",
	ROADMAP_PATH,
	"docs/development.md",
	"docs/releasing.md",
];

interface CliResult {
	code: number;
	stdout: string;
	stderr: string;
}

async function runCompiledCli(cwd: string, args: string[]): Promise<CliResult> {
	try {
		const { stdout, stderr } = await execFileAsync(process.execPath, [compiledCliPath, ...args], { cwd });
		return { code: 0, stdout, stderr };
	} catch (error) {
		const failure = error as CliResult & { code: number | null };
		return { code: failure.code ?? 1, stdout: failure.stdout, stderr: failure.stderr };
	}
}

function parseJson<T>(text: string): T {
	try {
		return JSON.parse(text) as T;
	} catch (error) {
		throw new Error("Expected valid JSON in compiled CLI test", { cause: error });
	}
}

describe("published stepstone package", () => {
	// Every assertion that asks `npm pack` what the tarball holds lives in this
	// file, because this build rewrites `dist/` while a pack walks it: run from
	// another file, the two race in parallel workers and the pack reads a tree
	// that is being deleted. Awaiting the build here is what orders them, and
	// what `packedFilePaths` refuses to run without.
	beforeAll(async () => {
		await buildPackage();
	}, 60_000);

	it("compiles both executables to plain JavaScript entry points", async () => {
		const [compiledCli, compiledMcp] = await Promise.all([
			readFile(compiledCliPath, "utf8"),
			readFile(compiledMcpPath, "utf8"),
		]);
		for (const compiled of [compiledCli, compiledMcp]) {
			expect(compiled.startsWith("#!/usr/bin/env node")).toBe(true);
			// Node refuses TypeScript under node_modules; neither bin may need type stripping.
			expect(compiled).not.toMatch(/from "\.\/[^"]+\.ts"/);
		}
		expect(compiledCli).toContain('from "./application-service.js"');
		expect(compiledMcp).toContain('from "./mcp-server.js"');
	});

	it("starts the compiled MCP server through the Claude plugin config", async () => {
		const root = await mkdtemp(join(tmpdir(), "stepstone-plugin-mcp-"));
		await execFileAsync("git", ["init", "-q"], { cwd: root });
		const config = parseJson<{ mcpServers: Record<string, ClaudePluginMcpServer> }>(
			await readFile(resolve(".mcp.json"), "utf8"),
		);
		const configured = config.mcpServers[CLI_COMMAND_CONTRACT.binary];
		if (!configured) throw new Error("Claude plugin config has no Stepstone MCP server");
		const pluginRoot = resolve(".");
		const server = resolveClaudePluginMcpServer(configured, { pluginRoot, projectDir: root });
		const transport = new StdioClientTransport({
			command: server.command,
			args: server.args,
			cwd: pluginRoot,
			stderr: "pipe",
			env: { ...getDefaultEnvironment(), ...server.env },
		});
		const client = new Client({ name: "stepstone-claude-plugin-test", version: "1.0.0" });
		try {
			await client.connect(transport);
			const listed = await client.readResource({ uri: `${CLI_COMMAND_CONTRACT.binary}://worklist/list` });
			const content = listed.contents[0];
			expect(content && "text" in content ? parseJson(content.text) : undefined).toMatchObject({
				ok: true,
				scope: "project",
				action: "list",
				result: { goals: [] },
			});
		} finally {
			await client.close();
		}
	});

	it("imports only declared dependencies, never a Pi peer", async () => {
		// `npx -y stepstone@latest` installs the package's own dependencies and nothing
		// else, so every module the bin reaches at runtime, including the terminal
		// board, must resolve without a Pi installation present.
		const manifest = parseJson<{
			dependencies?: Record<string, string>;
			peerDependencies?: Record<string, string>;
		}>(await readFile(resolve("package.json"), "utf8"));
		const allowed = new Set(Object.keys(manifest.dependencies ?? {}));
		expect(Object.keys(manifest.peerDependencies ?? {}).length).toBeGreaterThan(0);

		const compiled: string[] = [];
		for await (const file of glob("dist/**/*.js")) compiled.push(file);
		expect(compiled.length).toBeGreaterThan(0);

		const offenders: string[] = [];
		const sources = await Promise.all(compiled.map(async (file) => [file, await readFile(file, "utf8")]));
		for (const [file, source] of sources) {
			// A module specifier never contains whitespace or a comma, so excluding
			// both keeps the scan from reading an ordinary string that happens to
			// contain the word "from" as though it were an import.
			for (const match of source.matchAll(/(?:\bfrom|\brequire\()\s*["']([^"'\s,]+)["']/g)) {
				const specifier = match[1];
				if (specifier.startsWith(".") || specifier.startsWith("node:")) continue;
				const packageName = specifier.startsWith("@")
					? specifier.split("/").slice(0, 2).join("/")
					: specifier.split("/")[0];
				if (!allowed.has(packageName)) offenders.push(`${file} imports ${specifier}`);
			}
		}
		expect(offenders, "the compiled bin must not depend on an uninstalled peer").toEqual([]);
	});

	it("declares every Pi peer optional so installing the CLI stays small", async () => {
		// npm auto-installs non-optional peers, so a peer the bin never loads is
		// still downloaded by everyone: `npx -y stepstone@latest`, the invocation
		// this package's own agent skill prescribes, pulled the entire Pi toolchain
		// (~329 MB) to run a CLI whose real dependency tree is under 1 MB. The bin
		// resolves without a Pi installation, asserted directly above, so nothing is
		// lost by letting consumers who do not embed the extension skip them.
		const manifest = parseJson<{
			peerDependencies?: Record<string, string>;
			peerDependenciesMeta?: Record<string, { optional?: boolean }>;
		}>(await readFile(resolve("package.json"), "utf8"));
		const peers = Object.keys(manifest.peerDependencies ?? {});
		expect(peers.length).toBeGreaterThan(0);
		const notOptional = peers.filter((peer) => manifest.peerDependenciesMeta?.[peer]?.optional !== true);
		expect(notOptional, "every peer must be marked optional in peerDependenciesMeta").toEqual([]);
	});

	it("runs the full goal lifecycle from the compiled bin", async () => {
		const root = await mkdtemp(join(tmpdir(), "stepstone-compiled-cli-"));
		await execFileAsync("git", ["init", "-q"], { cwd: root });

		const added = await runCompiledCli(root, ["project", "add", "Compiled goal", "--", "Full detail"]);
		expect(added.code).toBe(0);
		expect(added.stdout).toContain("Added project goal");

		const listed = await runCompiledCli(root, ["project", "list"]);
		expect(listed.code).toBe(0);
		expect(listed.stdout).toContain("Compiled goal");

		const worklist = parseJson<{ goals: Array<{ id: string }> }>(
			await readFile(join(root, ".worklist", "worklist.json"), "utf8"),
		);
		const goalId = worklist.goals[0]?.id;
		expect(goalId).toBeTruthy();

		const shown = await runCompiledCli(root, ["project", "show", `${goalId}`, "--json"]);
		expect(shown.code).toBe(0);
		const manifest = parseJson<{ version: string }>(await readFile(resolve("package.json"), "utf8"));
		expect(parseJson(shown.stdout)).toMatchObject({
			ok: true,
			action: "show",
			result: { goal: { id: goalId, description: "Full detail" } },
			meta: { cliVersion: manifest.version },
		});

		const planPath = join(root, "plan.json");
		await writeFile(
			planPath,
			`${JSON.stringify([
				{ title: "Compiled foundation" },
				{ title: "Compiled batch goal", dependsOn: ["compiled-foundation", goalId] },
			])}\n`,
			"utf8",
		);
		const beforePlan = await readFile(join(root, ".worklist", "worklist.json"), "utf8");
		const previewedPlan = await runCompiledCli(root, [
			"project",
			"apply-plan",
			planPath,
			"--dry-run",
			"--json",
		]);
		expect(previewedPlan.code).toBe(0);
		expect(parseJson(previewedPlan.stdout)).toMatchObject({
			ok: true,
			action: "apply-plan",
			result: { dryRun: true, addedGoals: [{ id: "compiled-foundation" }, { id: "compiled-batch-goal" }] },
			meta: { changed: false, semanticNoOp: false },
		});
		expect(await readFile(join(root, ".worklist", "worklist.json"), "utf8")).toBe(beforePlan);

		const appliedPlan = await runCompiledCli(root, ["project", "apply-plan", planPath, "--json"]);
		expect(appliedPlan.code).toBe(0);
		expect(parseJson(appliedPlan.stdout)).toMatchObject({
			ok: true,
			action: "apply-plan",
			result: {
				addedGoals: [
					{ id: "compiled-foundation" },
					{
						id: "compiled-batch-goal",
						dependsOn: ["compiled-foundation", goalId],
					},
				],
			},
			meta: { changed: true },
		});

		const refused = await runCompiledCli(root, ["project", "delete", `${goalId}`]);
		expect(refused.code).toBe(3);
	});

	it("packs what an install reads and leaves this repository's own material behind", async () => {
		// Asked of the real packer rather than read off the manifest's `files` array:
		// that array is a set of patterns, and whether one of them actually keeps a
		// file out of the tarball is npm's answer to give rather than something a
		// reader of the declaration can tell.
		const paths = await packedFilePaths();
		for (const path of DEVELOPMENT_ONLY_FILES) {
			// A held-back file has to still be there, or the exclusion passes by naming
			// nothing: a page renamed without updating this list and the manifest would
			// leave a dead negation behind and ship under its new name, with every
			// assertion here green.
			expect(existsSync(resolve(path)), `${path} names no file, so holding it back asserts nothing`).toBe(
				true,
			);
			expect(paths, `${path} is written for this checkout and must not be packaged`).not.toContain(path);
		}
		expect(paths, `${SKILL_PATH} must be packaged so an install carries the skill`).toContain(SKILL_PATH);
		const packageMetadata = parseJson<ClaudePluginPackageMetadata>(
			await readFile(resolve("package.json"), "utf8"),
		);
		for (const artifact of renderClaudePluginArtifacts(packageMetadata)) {
			expect(paths, `${artifact.path} must be present in the installable Claude Code plugin`).toContain(
				artifact.path,
			);
		}
		for (const dependency of ["@modelcontextprotocol/sdk", "proper-lockfile", "zod"]) {
			expect(paths, `the isolated Claude plugin cache needs bundled ${dependency}`).toContain(
				`node_modules/${dependency}/package.json`,
			);
		}
		expect(paths, "README.md must be packaged; it is the package's front page").toContain("README.md");
		// Every other documentation page ships, because it documents the package for
		// somebody using it. Classified by walking the directory rather than from a
		// second list, so a page added tomorrow is covered the day it lands: it is
		// packaged unless it was named above as one this checkout keeps to itself.
		const published = (await documentationPages()).filter((path) => !DEVELOPMENT_ONLY_FILES.includes(path));
		expect(published.length, "no docs page is published, so this assertion pins nothing").toBeGreaterThan(0);
		for (const path of published) {
			expect(paths, `${path} documents the package and must be packaged`).toContain(path);
		}
	}, 60_000);

	it("links only to pages an install carries, from every page an install carries", async () => {
		// A packaged page is read out of `node_modules`, where a relative link can only
		// land on something the tarball also carries. Excluding a page from the tarball
		// therefore breaks every relative link into it from a page that still ships,
		// which is invisible in this checkout because both files are on disk here.
		//
		// README.md is the one page held out, and deliberately: its reader is on GitHub
		// or on npmjs.com's rendered README, where every path in the repository
		// resolves, so its links to the development-only pages are answers rather than
		// dead ends.
		const paths = await packedFilePaths();
		const pages = [...paths].filter(
			(path) => path.endsWith(".md") && path !== "README.md" && !path.startsWith("node_modules/"),
		);
		expect(pages.length, "no Markdown page is packaged, so this assertion pins nothing").toBeGreaterThan(0);
		const dangling: string[] = [];
		for (const page of pages) {
			const contents = await readFile(resolve(page), "utf8");
			for (const [, target] of contents.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
				// Absolute URLs leave the package, and a bare fragment stays on the page.
				if (target === undefined || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) continue;
				const resolved = posix.normalize(posix.join(posix.dirname(page), target.split("#")[0] ?? ""));
				if (!paths.has(resolved)) dangling.push(`${page} links to ${target}`);
			}
		}
		expect(
			dangling,
			`packaged pages link to files an install does not carry: ${dangling.join("; ")}`,
		).toEqual([]);
	}, 60_000);

	it("sends the installed skill only to documentation pages an install carries", async () => {
		// The skill points its reader at pages by name rather than by Markdown link,
		// so the dangling-link pass above cannot see those references: it is read from
		// `~/.claude/skills`, where a relative link resolves against the consumer's
		// repository instead of the package. Those named paths are the same promise a
		// link makes, and they break the same way - a page renamed, or held back from
		// the tarball, leaves an agent looking for a file no install has.
		const paths = await packedFilePaths();
		// Fenced blocks are dropped before inline spans are read: their fences are
		// backticks too, and pairing across one shifts every span that follows it.
		const prose = renderSkillMarkdown().replace(/```[\s\S]*?```/g, "");
		const referenced = [...new Set([...prose.matchAll(/`([^`\n]+)`/g)].map(([, span]) => span))]
			.filter((span) => span.startsWith(`${DOCS_DIRECTORY}/`) && span.endsWith(".md"))
			.sort();
		expect(
			referenced.length,
			"the skill names no documentation page, so this assertion pins nothing",
		).toBeGreaterThan(0);
		for (const page of referenced) {
			expect(paths, `${SKILL_PATH} sends its reader to ${page}, which the tarball does not carry`).toContain(
				page,
			);
		}
	}, 60_000);

	it("ships both compiled bins in the published package", async () => {
		const paths = await packedFilePaths();
		expect(paths).toContain("dist/cli.js");
		expect(paths).toContain("dist/mcp.js");
		expect(paths).toContain("src/extension.ts");

		const packageJson = parseJson<{
			name?: string;
			bin?: Record<string, string>;
			files: string[];
		}>(await readFile(resolve("package.json"), "utf8"));
		// Both are keyed off the contract, because the generated docs lean on both:
		// `npx -y <binary>@latest` resolves the published package name, while the
		// command it then runs is the bin key. Pinning only one lets a rename ship
		// docs that name a package nobody published.
		expect(packageJson.name).toBe(CLI_COMMAND_CONTRACT.binary);
		expect(packageJson.bin).toEqual({
			[CLI_COMMAND_CONTRACT.binary]: "dist/cli.js",
			[`${CLI_COMMAND_CONTRACT.binary}-mcp`]: "dist/mcp.js",
		});
		expect(packageJson.files).toContain("dist");
	}, 60_000);
});
