import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CLI_COMMAND_CONTRACT, renderWorkspaceUsage } from "./cli-contract.ts";
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
}

export interface WorkspaceInvocation {
	description?: string;
	rest: string[];
	cwd: string;
	json: boolean;
	workspaceParent?: string;
	workspaceOptions: Map<string, string[]>;
	flagsUsed: ReadonlySet<string>;
}

export class WorkspaceUsageError extends Error {}

interface WorkspaceOutput {
	json: boolean;
	action: string;
	cliVersion: string;
}

function one(invocation: Invocation, name: string): string | undefined {
	const values = invocation.options.get(name);
	if (!values) return undefined;
	if (values.length !== 1) throw new WorkspaceUsageError(`--${name} may be passed only once`);
	return values[0];
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
	if (value === undefined) return fallback;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1)
		throw new WorkspaceUsageError(`--${name} must be a positive integer`);
	return parsed;
}

function requireMainWorktree(repositoryRoot: string): void {
	const placement = resolveWorktreePlacement(repositoryRoot);
	if (placement.kind === "linked") {
		throw new Error(
			`Project workspace commands must run from the repository's main worktree, not linked worktree ${repositoryRoot}`,
		);
	}
	if (placement.kind === "unavailable") throw new Error(placement.failure.message);
}

function summarize(run: DispatchRun, reportPass = false): object {
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
					goalFile:
						entry.workspace && entry.goalFile ? join(entry.workspace.path, entry.goalFile.path) : undefined,
					mergedPr: entry.mergedPr,
					preparationFailure: entry.preparationFailure,
					message: entry.message,
					updatedAt: entry.updatedAt,
				},
			]),
		),
		...(reportPass && run.lastPass ? { pass: run.lastPass } : {}),
	};
}

function humanRun(run: DispatchRun, reportPass: boolean): string {
	const lines: string[] = [];
	if (reportPass && run.lastPass) {
		switch (run.lastPass.outcome) {
			case "no-ready-work":
				lines.push("No approved goal is ready for preparation.");
				break;
			case "capacity-full":
				lines.push("Preparation capacity is full.");
				break;
			case "prepared":
				lines.push(`Prepared: ${run.lastPass.preparedGoalIds.join(", ")}.`);
				break;
			case "refused":
				lines.push(`Preparation refused: ${run.lastPass.refusedGoalIds.join(", ")}.`);
				break;
			case "mixed":
				lines.push(`Prepared: ${run.lastPass.preparedGoalIds.join(", ")}.`);
				lines.push(`Preparation refused: ${run.lastPass.refusedGoalIds.join(", ")}.`);
				break;
		}
	}
	for (const [id, entry] of Object.entries(run.entries)) {
		lines.push(`${id}: ${entry.phase}${entry.message ? `: ${entry.message}` : ""}`);
		if (entry.preparationFailure) {
			lines.push(
				`  Original preparation failure (${entry.preparationFailure.stage}, ${entry.preparationFailure.classification}): ${entry.preparationFailure.message}`,
			);
		}
	}
	return `${lines.join("\n")}\n`;
}

function printRun(run: DispatchRun, output: WorkspaceOutput, reportPass: boolean): void {
	if (output.json) {
		print(summarize(run, reportPass), output);
		return;
	}
	process.stdout.write(humanRun(run, reportPass));
}

function print(value: unknown, output: WorkspaceOutput): void {
	if (output.json) {
		process.stdout.write(
			`${JSON.stringify({ ok: true, scope: "project", action: `workspace ${output.action}`, result: value, meta: { cliVersion: output.cliVersion } }, null, 2)}\n`,
		);
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

export async function runWorkspace(input: WorkspaceInvocation, cliVersion: string): Promise<void> {
	if (input.description !== undefined)
		throw new WorkspaceUsageError("project workspace does not accept description text");
	const [action = "help", ...positionals] = input.rest;
	const invocation: Invocation = {
		action,
		positionals,
		options: new Map(input.workspaceOptions),
	};
	invocation.options.set("cwd", [input.cwd]);
	if (input.workspaceParent !== undefined)
		invocation.options.set("workspace-parent", [input.workspaceParent]);
	const output: WorkspaceOutput = { json: input.json, action, cliVersion };
	const command = CLI_COMMAND_CONTRACT.workspaceActions.find((entry) => entry.name === action);
	if (action !== "help" && !command) throw new WorkspaceUsageError(`Unknown workspace action ${action}`);
	const allowed = new Set<string>(["--cwd", "--json", "--help", ...(command?.flags ?? [])]);
	for (const flag of input.flagsUsed) {
		if (!allowed.has(flag))
			throw new WorkspaceUsageError(`${flag} is not valid for project workspace ${action}`);
	}
	if (invocation.action === "help" || invocation.options.has("help")) {
		process.stdout.write(renderWorkspaceUsage());
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
				throw new WorkspaceUsageError("start accepts goal IDs through repeated --goal flags");
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
			printRun(advanced, output, true);
			return;
		}
		case "resume": {
			if (invocation.positionals.length !== 1)
				throw new WorkspaceUsageError("resume requires exactly one run ID");
			const runId = invocation.positionals[0];
			const advanced = await store.withRunLock(runId, async () => {
				const run = await store.load(runId);
				assertRunRepository(run, repositoryRoot);
				return createDriver(run, store).advance(run.id);
			});
			printRun(advanced, output, true);
			return;
		}
		case "status": {
			if (invocation.positionals.length > 1)
				throw new WorkspaceUsageError("status accepts at most one run ID");
			const runs = invocation.positionals[0]
				? [await store.load(invocation.positionals[0])]
				: await store.list();
			for (const run of runs) assertRunRepository(run, repositoryRoot);
			print(
				runs.map((run) => summarize(run)),
				output,
			);
			return;
		}
		case "inspect": {
			if (invocation.positionals.length !== 2)
				throw new WorkspaceUsageError("inspect requires a run ID and goal ID");
			const run = await store.load(invocation.positionals[0]);
			assertRunRepository(run, repositoryRoot);
			const entry = run.entries[invocation.positionals[1]];
			if (!entry) throw new Error(`Run ${run.id} has no entry for goal ${invocation.positionals[1]}`);
			print({ run: summarize(run), goal: entry }, output);
			return;
		}
		case "recover": {
			if (invocation.positionals.length !== 2 || !invocation.options.has("release")) {
				throw new WorkspaceUsageError("recover requires a run ID, goal ID, and --release");
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
			printRun(recovered, output, false);
			return;
		}
		case "cleanup": {
			if (invocation.positionals.length < 1 || invocation.positionals.length > 2) {
				throw new WorkspaceUsageError("cleanup requires a run ID and optional goal ID");
			}
			const runId = invocation.positionals[0];
			const result = await store.withRunLock(runId, async () => {
				const run = await store.load(runId);
				assertRunRepository(run, repositoryRoot);
				return createDriver(run, store).cleanup(
					run.id,
					invocation.positionals[1],
					invocation.options.has("force"),
				);
			});
			if (result) printRun(result, output, false);
			else print({ removedRunId: runId }, output);
			return;
		}
		default:
			throw new Error(`Unknown action ${invocation.action}`);
	}
}
