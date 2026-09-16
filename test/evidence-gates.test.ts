import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const ratchet = resolve("scripts/coverage-ratchet.ts");
const metrics = (percentage: number) => ({
	lines: { pct: percentage },
	branches: { pct: percentage },
	functions: { pct: percentage },
	statements: { pct: percentage },
});

async function fixture(baseline: number, current: number): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "stepstone-coverage-ratchet-"));
	roots.push(root);
	await mkdir(join(root, "coverage"));
	await mkdir(join(root, "test"));
	const canonicalRoot = await realpath(root);
	await writeFile(
		join(root, "coverage", "coverage-summary.json"),
		JSON.stringify({ total: metrics(current), [join(canonicalRoot, "src", "example.ts")]: metrics(current) }),
	);
	await writeFile(
		join(root, "test", "coverage-baseline.json"),
		JSON.stringify({ total: flat(baseline), "src/example.ts": flat(baseline) }),
	);
	return root;
}

function flat(percentage: number) {
	return { lines: percentage, branches: percentage, functions: percentage, statements: percentage };
}

function run(root: string, ...args: string[]) {
	return spawnSync(process.execPath, [ratchet, ...args], { cwd: root, encoding: "utf8" });
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("coverage ratchet", () => {
	it("accepts an equal result and rejects a lower per-file percentage", async () => {
		const equal = await fixture(80, 80);
		const equalResult = run(equal);
		expect(equalResult.status, equalResult.stderr).toBe(0);

		const lower = await fixture(80, 79.99);
		const result = run(lower);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("src/example.ts lines: 79.99 < 80");
	});

	it("refuses to update a baseline downward", async () => {
		const root = await fixture(80, 79);
		const before = await readFile(join(root, "test", "coverage-baseline.json"), "utf8");
		const result = run(root, "--update");

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("coverage baselines only move up");
		expect(await readFile(join(root, "test", "coverage-baseline.json"), "utf8")).toBe(before);
	});
});
