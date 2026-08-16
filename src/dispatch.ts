#!/usr/bin/env node
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
	ApplicationRoadmapBinding,
	currentDispatchTarget,
	DetachedProcessSessionBinding,
	defaultDispatchStateDirectory,
	executableFingerprint,
	FileDispatchStateStore,
	GitHubMergeEvidenceBinding,
	GitWorktreeBinding,
	HerdrSessionBinding,
	resolveExecutablePath,
	TreehouseWorkspaceBinding,
} from "./dispatch-bindings.ts";
import {
	type DispatchBindingConfig,
	DispatchDriver,
	type DispatchRun,
	type SessionBinding,
	type WorkspaceBinding,
} from "./dispatch-driver.ts";
import { resolveGitRoot, resolveWorktreePlacement } from "./git.ts";

interface Invocation {
	action: string;
	positionals: string[];
	options: Map<string, string[]>;
	json: boolean;
}

const HELP = `Usage: stepstone-dispatch <action> [arguments] [flags]

Actions:
  start --goal <id>... --agent-command <executable> [binding flags]
  resume <run-id>
  status [run-id]
  inspect <run-id> <goal-id>
  recover <run-id> <goal-id> --release [--claim-updated-at <timestamp>] [--confirm-launch-closed]
  cleanup <run-id> [goal-id] [--confirm-launch-closed requires a goal ID]

Binding flags for start:
  --workspace worktree|treehouse       Default: worktree
  --session process|herdr              Default: process; process requires Linux
  --workspace-parent <path>            Worktree parent directory
  --agent-command <executable>         Required by process sessions
  --agent-arg <argument>               Repeatable verbatim executable argument
  --agent-kind <kind>                  Required by Herdr sessions
  --startup-grace-ms <milliseconds>    Default: 1000
  --prompt-timeout-ms <milliseconds>   Default: 300000
  --max-parallel <count>               Default: 1

Common flags:
  --cwd <repository>                   Default: current directory
  --json
  --help
`;

function parseArguments(argv: string[]): Invocation {
	const options = new Map<string, string[]>();
	const positionals: string[] = [];
	const valueOptions = new Set([
		"cwd",
		"goal",
		"workspace",
		"session",
		"workspace-parent",
		"agent-command",
		"agent-arg",
		"agent-kind",
		"startup-grace-ms",
		"prompt-timeout-ms",
		"max-parallel",
		"claim-updated-at",
	]);
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
		if (token === "--release" || token === "--confirm-launch-closed") {
			options.set(token.slice(2), []);
			continue;
		}
		if (token.startsWith("--")) {
			const name = token.slice(2);
			if (!valueOptions.has(name)) throw new Error(`Unknown flag ${token}`);
			const value = argv[index + 1];
			if (value === undefined || (name !== "agent-arg" && value.startsWith("--"))) {
				throw new Error(`${token} requires a value`);
			}
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
		workspaceBinding: run.workspaceBinding,
		sessionBinding: run.sessionBinding,
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
					session: entry.session?.metadata,
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

function createBindings(
	run: DispatchRun,
	stateDirectory: string,
): {
	workspace: WorkspaceBinding;
	session: SessionBinding;
} {
	const config = run.bindingConfig;
	const workspace =
		run.workspaceBinding === "worktree"
			? new GitWorktreeBinding(run.repositoryRoot, config.workspaceParent)
			: run.workspaceBinding === "treehouse"
				? new TreehouseWorkspaceBinding(run.repositoryRoot)
				: undefined;
	if (!workspace) throw new Error(`Unknown persisted workspace binding ${run.workspaceBinding}`);
	const session =
		run.sessionBinding === "process" && config.agentCommand && config.agentCommandFingerprint
			? new DetachedProcessSessionBinding(
					config.agentCommand,
					config.agentArgs,
					stateDirectory,
					config.startupGraceMs,
					config.agentCommandFingerprint,
				)
			: run.sessionBinding === "herdr" && config.agentKind
				? new HerdrSessionBinding(config.agentKind, stateDirectory, config.promptTimeoutMs)
				: undefined;
	if (!session) throw new Error(`Persisted ${run.sessionBinding} session configuration is incomplete`);
	return { workspace, session };
}

function createDriver(run: DispatchRun, store: FileDispatchStateStore): DispatchDriver {
	const bindings = createBindings(run, store.directory);
	return new DispatchDriver({
		roadmap: new ApplicationRoadmapBinding(run.repositoryRoot),
		workspace: bindings.workspace,
		session: bindings.session,
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
			const workspaceBinding = one(invocation, "workspace") ?? "worktree";
			const sessionBinding = one(invocation, "session") ?? "process";
			if (!new Set(["worktree", "treehouse"]).has(workspaceBinding))
				throw new Error("--workspace must be worktree or treehouse");
			if (!new Set(["process", "herdr"]).has(sessionBinding))
				throw new Error("--session must be process or herdr");
			const workspaceParent = one(invocation, "workspace-parent");
			const agentCommand = one(invocation, "agent-command");
			const agentKind = one(invocation, "agent-kind");
			const resolvedAgentCommand =
				sessionBinding === "process" && agentCommand
					? await resolveExecutablePath(agentCommand, process.cwd())
					: undefined;
			const config: DispatchBindingConfig = {
				agentArgs: sessionBinding === "process" ? (invocation.options.get("agent-arg") ?? []) : [],
				...(workspaceBinding === "worktree" && workspaceParent
					? { workspaceParent: await realpath(resolve(workspaceParent)) }
					: {}),
				...(resolvedAgentCommand
					? {
							agentCommand: resolvedAgentCommand,
							agentCommandFingerprint: await executableFingerprint(resolvedAgentCommand),
						}
					: {}),
				...(sessionBinding === "herdr" && agentKind ? { agentKind } : {}),
				...(sessionBinding === "process"
					? { startupGraceMs: positiveInteger(one(invocation, "startup-grace-ms"), 1000, "startup-grace-ms") }
					: {
							promptTimeoutMs: positiveInteger(
								one(invocation, "prompt-timeout-ms"),
								300000,
								"prompt-timeout-ms",
							),
						}),
			};
			if (sessionBinding === "process" && !config.agentCommand)
				throw new Error("--agent-command is required for process sessions");
			if (sessionBinding === "herdr" && !config.agentKind)
				throw new Error("--agent-kind is required for Herdr sessions");
			const target = await currentDispatchTarget(repositoryRoot);
			const placeholder: DispatchRun = {
				version: 1,
				id: "pending",
				repositoryRoot,
				approvedGoalIds: [],
				maxParallel: 1,
				targetBranch: target.branch,
				targetRevision: target.revision,
				workspaceBinding,
				sessionBinding,
				bindingConfig: config,
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
				bindingConfig: config,
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
					invocation.options.has("confirm-launch-closed"),
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
				return createDriver(run, store).cleanup(
					run.id,
					invocation.positionals[1],
					invocation.options.has("confirm-launch-closed"),
				);
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
