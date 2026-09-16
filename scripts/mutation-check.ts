import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

interface Mutation {
	name: string;
	file: string;
	from: string;
	to: string;
	test: string;
}

const MUTATIONS: readonly Mutation[] = [
	{
		name: "require both settled dependency states",
		file: "src/dependencies.ts",
		from: 'return goal.status === "done" || goal.status === "archived";',
		to: 'return goal.status === "done" && goal.status === "archived";',
		test: "test/dependencies.test.ts",
	},
	{
		name: "accept a dangling dependency",
		file: "src/dependencies.ts",
		from: "target !== undefined && isDependencySatisfied(target)",
		to: "target === undefined || isDependencySatisfied(target)",
		test: "test/dependencies.test.ts",
	},
	{
		name: "mark settled goals as blocked",
		file: "src/dependencies.ts",
		from: "if (isDependencySatisfied(goal)) return false;",
		to: "if (isDependencySatisfied(goal)) return true;",
		test: "test/dependencies.test.ts",
	},
	{
		name: "offer non-open goals as ready",
		file: "src/dependencies.ts",
		from: 'goal.status === "open" && !isGoalClaimed(goal)',
		to: 'goal.status !== "open" && !isGoalClaimed(goal)',
		test: "test/dependencies.test.ts",
	},
	{
		name: "trust a mismatched canonical claim",
		file: "src/claim-evidence.ts",
		from: 'evidence.canonical.state !== "matches"',
		to: 'evidence.canonical.state === "matches"',
		test: "test/claim-evidence.test.ts",
	},
	{
		name: "treat the stale threshold as recent",
		file: "src/claim-evidence.ts",
		from: "evidence.claimAgeHours < evidence.staleAfterHours",
		to: "evidence.claimAgeHours <= evidence.staleAfterHours",
		test: "test/claim-evidence.test.ts",
	},
	{
		name: "inspect entries that are not prepared",
		file: "src/claim-evidence.ts",
		from: 'entry.phase === "prepared"',
		to: 'entry.phase !== "prepared"',
		test: "test/claim-evidence.test.ts",
	},
	{
		name: "accept the wrong claimed branch",
		file: "src/claim-evidence.ts",
		from: "goal.branch === entry.branch",
		to: "goal.branch !== entry.branch",
		test: "test/claim-evidence.test.ts",
	},
];

const root = process.cwd();
const sandbox = mkdtempSync(join(tmpdir(), "stepstone-mutation-"));
const vitest = resolve(root, "node_modules/vitest/vitest.mjs");

function run(test: string): ReturnType<typeof spawnSync> {
	return spawnSync(process.execPath, [vitest, "run", test], {
		cwd: sandbox,
		encoding: "utf8",
		timeout: 60_000,
		maxBuffer: 16 * 1024 * 1024,
	});
}

try {
	for (const path of ["src", "test", "scripts", "vitest.config.ts", "package.json", "tsconfig.json"]) {
		cpSync(resolve(root, path), resolve(sandbox, path), { recursive: true });
	}
	symlinkSync(resolve(root, "node_modules"), resolve(sandbox, "node_modules"), "dir");

	for (const test of [...new Set(MUTATIONS.map((mutation) => mutation.test))]) {
		const baseline = run(test);
		if (baseline.status !== 0) {
			throw new Error(`mutation baseline failed for ${test}:\n${baseline.stdout}\n${baseline.stderr}`);
		}
	}

	for (const mutation of MUTATIONS) {
		const path = resolve(sandbox, mutation.file);
		const original = readFileSync(resolve(root, mutation.file), "utf8");
		const occurrences = original.split(mutation.from).length - 1;
		if (occurrences !== 1) {
			throw new Error(
				`${mutation.name}: expected one mutation target in ${mutation.file}, found ${occurrences}`,
			);
		}
		writeFileSync(path, original.replace(mutation.from, mutation.to));
		const result = run(mutation.test);
		writeFileSync(path, original);
		if (result.error) throw result.error;
		if (result.status === 0) throw new Error(`mutation survived: ${mutation.name}`);
		console.log(`mutation killed: ${mutation.name}`);
	}
	console.log(`test:mutation: ${MUTATIONS.length} targeted mutants were killed`);
} finally {
	rmSync(sandbox, { recursive: true, force: true });
}
