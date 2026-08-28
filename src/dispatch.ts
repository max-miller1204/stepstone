#!/usr/bin/env node
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
	ApplicationRoadmapBinding,
	currentDispatchTarget,
	defaultDispatchStateDirectory,
	FileDispatchStateStore,
	GitHubMergeEvidenceBinding,
	GitWorktreeBinding,
} from "./dispatch-bindings.ts";
import { DispatchDriver, type DispatchRun, type DispatchWorkspaceConfig } from "./dispatch-driver.ts";
import { resolveGitRoot, resolveWorktreePlacement } from "./git.ts";

interface Invocation {
	action: string;
	positionals: string[];
	options: Map<string, string[]>;
	json: boolean;
}

const HELP = `Usage: stepstone-dispatch <action> [arguments] [flags]

Actions:
  start --goal <id>... [preparation flags]
  resume <run-id>
  status [run-id]
  inspect <run-id> <goal-id>
  recover <run-id> <goal-id> --release [--claim-updated-at <timestamp>]
  cleanup <run-id> [goal-id]

Preparation flags for start:
  --workspace-parent <path>            Worktree parent directory
  --max-parallel <count>               Maximum prepared claims; default: 1

Common flags:
  --cwd <repository>                   Default: current directory
  --json
  --help

Stepstone prepares and claims workspaces. It never starts, prompts, or supervises an agent.
`;

function parseArguments(argv: string[]): Invocation {
	const options = new Map<string, string[]>();
	const positionals: string[] = [];
	const valueOptions = new Set(["cwd", "goal", "workspace-parent", "max-parallel", "claim-updated-at"]);
	let json = false;
	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];
		if (token === "--json") {
			json = true;
			continue;
		}
		if (token === "--help" || token === "-h") {
			options.set("help", []);
			continue;
		}
		if (token === "--release") {
			options.set("release", []);
			continue;
		}
		if (token.startsWith("--")) {
			const name = token.slice(2);
			if (!valueOptions.has(name)) throw new Error(`Unknown flag ${token}`);
			const value = argv[index + 1];
			if (value === undefined || value.startsWith("--")) throw new Error(`${token} requires a value`);
			options.set(name, [...(options.get(name) ?? []), value]);
			index += 1;
			continue;
		}
		positionals.push(token);
	}
	return { action: positionals.shift() ?? "help", positionals, options, json };
}

function one(invocation: Invocation, name: string): string | undefined {
	const values = invocation.options.get(name);
	if (!values) return undefined;
	if (values.length !== 1) throw new Error(`--${name} may be passed only once`);
	return values[0];
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
	if (value === undefined) return fallback;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`--${name} must be a positive integer`);
	return parsed;
}

function requireMainWorktree(repositoryRoot: string): void {
	const placement = resolveWorktreePlacement(repositoryRoot);
	if (placement.kind === "linked") {
		throw new Error(
			`Dispatch must run from the repository's main worktree, not linked worktree ${repositoryRoot}`,
		);
	}
	if (placement.kind === "unavailable") throw new Error(placement.failure.message);
}

function summarize(run: DispatchRun): object {
	return {
		id: run.id,
		repositoryRoot: run.repositoryRoot,
		approvedGoalIds: run.approvedGoalIds,
		maxParallel: run.maxParallel,
		createdAt: run.createdAt,
		updatedAt: run.updatedAt,
		entries: Object.fromEntries(
			Object.entries(run.entries).map(([id, entry]) => [
				id,
				{
					phase: entry.phase,
					branch: entry.branch,
					claimUpdatedAt: entry.claimUpdatedAt,
					workspace: entry.workspace?.path,
					mergedPr: entry.mergedPr,
					message: entry.message,
					updatedAt: entry.updatedAt,
				},
			]),
		),
	};
}

function print(value: unknown, json: boolean): void {
	if (json) {
		process.stdout.write(`${JSON.stringify({ ok: true, result: value }, null, 2)}\n`);
		return;
	}
	if (Array.isArray(value)) {
		if (value.length === 0) process.stdout.write("No persisted dispatch runs.\n");
		else for (const entry of value) process.stdout.write(`${JSON.stringify(entry)}\n`);
		return;
	}
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function createDriver(run: DispatchRun, store: FileDispatchStateStore): DispatchDriver {
	return new DispatchDriver({
		roadmap: new ApplicationRoadmapBinding(run.repositoryRoot),
		workspace: new GitWorktreeBinding(run.repositoryRoot, run.workspaceConfig.workspaceParent),
		merges: new GitHubMergeEvidenceBinding(run.repositoryRoot),
		store,
	});
}

function assertRunRepository(run: DispatchRun, repositoryRoot: string): void {
	if (run.repositoryRoot !== repositoryRoot) {
		throw new Error(`Run ${run.id} belongs to ${run.repositoryRoot}, not ${repositoryRoot}`);
	}
}

async function main(): Promise<void> {
	const invocation = parseArguments(process.argv.slice(2));
	if (invocation.action === "help" || invocation.options.has("help")) {
		process.stdout.write(HELP);
		return;
	}
	const cwd = resolve(one(invocation, "cwd") ?? process.cwd());
	const rootResult = resolveGitRoot(cwd);
	if (!rootResult.root) throw new Error(rootResult.failure?.message ?? `${cwd} is not a Git repository`);
	const repositoryRoot = rootResult.root;
	requireMainWorktree(repositoryRoot);
	const store = new FileDispatchStateStore(await defaultDispatchStateDirectory(repositoryRoot));

	switch (invocation.action) {
		case "start": {
			if (invocation.positionals.length > 0)
				throw new Error("start accepts goal IDs through repeated --goal flags");
			const workspaceParent = one(invocation, "workspace-parent");
			const config: DispatchWorkspaceConfig = {
				...(workspaceParent ? { workspaceParent: await realpath(resolve(workspaceParent)) } : {}),
			};
			const target = await currentDispatchTarget(repositoryRoot);
			const placeholder: DispatchRun = {
				version: 2,
				id: "pending",
				repositoryRoot,
				approvedGoalIds: [],
				maxParallel: 1,
				targetBranch: target.branch,
				targetRevision: target.revision,
				workspaceConfig: config,
				createdAt: "",
				updatedAt: "",
				entries: {},
			};
			const driver = createDriver(placeholder, store);
			const run = await driver.create({
				repositoryRoot,
				approvedGoalIds: invocation.options.get("goal") ?? [],
				maxParallel: positiveInteger(one(invocation, "max-parallel"), 1, "max-parallel"),
				targetBranch: target.branch,
				targetRevision: target.revision,
				workspaceConfig: config,
			});
			const advanced = await store.withRunLock(run.id, () => driver.advance(run.id));
			print(summarize(advanced), invocation.json);
			return;
		}
		case "resume": {
			if (invocation.positionals.length !== 1) throw new Error("resume requires exactly one run ID");
			const runId = invocation.positionals[0];
			const advanced = await store.withRunLock(runId, async () => {
				const run = await store.load(runId);
				assertRunRepository(run, repositoryRoot);
				return createDriver(run, store).advance(run.id);
			});
			print(summarize(advanced), invocation.json);
			return;
		}
		case "status": {
			if (invocation.positionals.length > 1) throw new Error("status accepts at most one run ID");
			const runs = invocation.positionals[0]
				? [await store.load(invocation.positionals[0])]
				: await store.list();
			for (const run of runs) assertRunRepository(run, repositoryRoot);
			print(runs.map(summarize), invocation.json);
			return;
		}
		case "inspect": {
			if (invocation.positionals.length !== 2) throw new Error("inspect requires a run ID and goal ID");
			const run = await store.load(invocation.positionals[0]);
			assertRunRepository(run, repositoryRoot);
			const entry = run.entries[invocation.positionals[1]];
			if (!entry) throw new Error(`Run ${run.id} has no entry for goal ${invocation.positionals[1]}`);
			print({ run: summarize(run), goal: entry }, invocation.json);
			return;
		}
		case "recover": {
			if (invocation.positionals.length !== 2 || !invocation.options.has("release")) {
				throw new Error("recover requires a run ID, goal ID, and --release");
			}
			const runId = invocation.positionals[0];
			const recovered = await store.withRunLock(runId, async () => {
				const run = await store.load(runId);
				assertRunRepository(run, repositoryRoot);
				return createDriver(run, store).recoverRelease(
					run.id,
					invocation.positionals[1],
					one(invocation, "claim-updated-at"),
				);
			});
			print(summarize(recovered), invocation.json);
			return;
		}
		case "cleanup": {
			if (invocation.positionals.length < 1 || invocation.positionals.length > 2) {
				throw new Error("cleanup requires a run ID and optional goal ID");
			}
			const runId = invocation.positionals[0];
			const result = await store.withRunLock(runId, async () => {
				const run = await store.load(runId);
				assertRunRepository(run, repositoryRoot);
				return createDriver(run, store).cleanup(run.id, invocation.positionals[1]);
			});
			print(result ? summarize(result) : { removedRunId: runId }, invocation.json);
			return;
		}
		default:
			throw new Error(`Unknown action ${invocation.action}`);
	}
}

main().catch((error: unknown) => {
	const message = error instanceof Error ? error.message : String(error);
	if (process.argv.includes("--json")) {
		process.stdout.write(`${JSON.stringify({ ok: false, error: { message } }, null, 2)}\n`);
	} else {
		process.stderr.write(`stepstone-dispatch: ${message}\n`);
	}
	process.exitCode = 1;
});
