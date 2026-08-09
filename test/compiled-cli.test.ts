import { execFile } from "node:child_process";
import { glob, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { CLI_COMMAND_CONTRACT } from "../src/cli-contract.ts";

const execFileAsync = promisify(execFile);
const compiledCliPath = resolve("dist/cli.js");

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

interface PackedPackage {
	files: Array<{ path: string }>;
}

/**
 * The packed packages reported by `npm pack --json`.
 *
 * npm has emitted two shapes for this payload: an array of results through
 * npm 11, and an object keyed by package name from npm 12. Both describe the
 * same tarball, and this test only asserts what that tarball contains, so it
 * reads either rather than failing on whichever npm happens to be installed.
 */
function packedPackages(stdout: string): PackedPackage[] {
	const parsed = parseJson<PackedPackage[] | Record<string, PackedPackage>>(stdout);
	return Array.isArray(parsed) ? parsed : Object.values(parsed);
}

describe("compiled stepstone CLI bin", () => {
	beforeAll(async () => {
		await execFileAsync("npm", ["run", "build"], { cwd: resolve(".") });
	}, 60_000);

	it("compiles to plain JavaScript with an executable entry point", async () => {
		const compiled = await readFile(compiledCliPath, "utf8");
		expect(compiled.startsWith("#!/usr/bin/env node")).toBe(true);
		// Node refuses TypeScript under node_modules; the bin must not need type stripping.
		expect(compiled).not.toContain('from "./application-service.ts"');
		expect(compiled).toContain('from "./application-service.js"');
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
			await readFile(join(root, ".pi", "worklist.json"), "utf8"),
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
		const beforePlan = await readFile(join(root, ".pi", "worklist.json"), "utf8");
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
		expect(await readFile(join(root, ".pi", "worklist.json"), "utf8")).toBe(beforePlan);

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

	it("ships the compiled bin in the published package", async () => {
		const { stdout } = await execFileAsync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
			cwd: resolve("."),
			maxBuffer: 10 * 1024 * 1024,
		});
		const packs = packedPackages(stdout);
		// One package is packed, so an empty list means the payload was read wrong
		// rather than that the tarball is missing files.
		expect(packs).toHaveLength(1);
		const paths = packs[0].files.map((file) => file.path);
		expect(paths).toContain("dist/cli.js");
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
		expect(packageJson.bin).toEqual({ [CLI_COMMAND_CONTRACT.binary]: "dist/cli.js" });
		expect(packageJson.files).toContain("dist");
	}, 60_000);
});
