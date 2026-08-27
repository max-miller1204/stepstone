import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
	DetachedProcessSessionBinding,
	executableFingerprint,
	FileDispatchStateStore,
	GitWorktreeBinding,
	HerdrSessionBinding,
	TreehouseWorkspaceBinding,
} from "../src/dispatch-bindings.ts";
import {
	DispatchDriver,
	type DispatchEntry,
	type DispatchRun,
	type DispatchSession,
	type DispatchStateStore,
	type DispatchWorkspace,
	type LaunchClosureOutcome,
	type MergeEvidence,
	type MergeEvidenceBinding,
	type RoadmapBinding,
	type RoadmapSnapshot,
	type SessionBinding,
	type SessionLaunchFailure,
	type WorkspaceBinding,
} from "../src/dispatch-driver.ts";
import type { ProjectGoal } from "../src/types.ts";

const execFileAsync = promisify(execFile);

// Detached process sessions prove session-token ownership through /proc, so the
// binding refuses to construct anywhere but Linux (docs/dispatch.md). Tests whose
// subject is that binding only have a subject on Linux.
const itOnLinux = it.skipIf(process.platform !== "linux");

function goal(id: string, options: Partial<ProjectGoal> = {}): ProjectGoal {
	return {
		id,
		title: `Goal ${id}`,
		description: `Complete ${id} thoroughly`,
		status: "open",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...options,
	};
}

async function readEventually(path: string): Promise<string> {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		try {
			const contents = await readFile(path, "utf8");
			if (contents) return contents;
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		}
		await delay(10);
	}
	throw new Error(`Timed out waiting for ${path}`);
}

class MemoryStore implements DispatchStateStore {
	readonly runs = new Map<string, DispatchRun>();

	async create(run: DispatchRun): Promise<void> {
		if (this.runs.has(run.id)) throw new Error("duplicate run");
		this.runs.set(run.id, structuredClone(run));
	}
	async load(runId: string): Promise<DispatchRun> {
		const run = this.runs.get(runId);
		if (!run) throw new Error("missing run");
		return structuredClone(run);
	}
	async save(run: DispatchRun): Promise<void> {
		this.runs.set(run.id, structuredClone(run));
	}
	async list(): Promise<DispatchRun[]> {
		return [...this.runs.values()].map((run) => structuredClone(run));
	}
	async remove(runId: string): Promise<void> {
		this.runs.delete(runId);
	}
}

class FakeRoadmap implements RoadmapBinding {
	readonly claims: Array<{ id: string; branch: string; token: string }> = [];
	readonly releases: Array<{ id: string; token: string }> = [];
	readonly completions: Array<{ id: string; token: string }> = [];
	completionResponseFailure?: Error;
	private counter = 0;

	constructor(readonly snapshot: RoadmapSnapshot) {}

	async read(): Promise<RoadmapSnapshot> {
		return structuredClone(this.snapshot);
	}
	async claim(id: string, branch: string, expectedUpdatedAt: string): Promise<ProjectGoal> {
		const target = this.require(id);
		if (target.updatedAt !== expectedUpdatedAt) throw new Error("claim conflict");
		this.claims.push({ id, branch, token: expectedUpdatedAt });
		Object.assign(target, { branch, updatedAt: this.token() });
		return structuredClone(target);
	}
	async release(id: string, claimUpdatedAt: string): Promise<ProjectGoal> {
		const target = this.require(id);
		if (target.updatedAt !== claimUpdatedAt) throw new Error("release conflict");
		this.releases.push({ id, token: claimUpdatedAt });
		Object.assign(target, { status: "open", branch: undefined, updatedAt: this.token() });
		return structuredClone(target);
	}
	async complete(id: string, expectedUpdatedAt: string): Promise<ProjectGoal> {
		const target = this.require(id);
		if (target.updatedAt !== expectedUpdatedAt) throw new Error("complete conflict");
		this.completions.push({ id, token: expectedUpdatedAt });
		const completedAt = this.token();
		Object.assign(target, { status: "done", branch: undefined, updatedAt: completedAt, completedAt });
		if (this.completionResponseFailure) throw this.completionResponseFailure;
		return structuredClone(target);
	}
	private require(id: string): ProjectGoal {
		const target = this.snapshot.goals.find((entry) => entry.id === id);
		if (!target) throw new Error("missing goal");
		return target;
	}
	private token(): string {
		this.counter += 1;
		return `2026-01-01T00:00:0${this.counter}.000Z`;
	}
}

class FakeWorkspace implements WorkspaceBinding {
	readonly name = "fake-workspace";
	verificationFailure?: Error;
	verifyCalls = 0;
	async verify(_workspace: DispatchWorkspace, _branch: string): Promise<void> {
		this.verifyCalls += 1;
		if (this.verificationFailure) throw this.verificationFailure;
	}
	readonly acquired: string[] = [];
	readonly cleaned: string[] = [];
	readonly bases: Array<{ id: string; revision: string }> = [];
	async acquire(projectGoal: ProjectGoal, _branch: string, baseRevision: string): Promise<DispatchWorkspace> {
		this.acquired.push(projectGoal.id);
		this.bases.push({ id: projectGoal.id, revision: baseRevision });
		return { binding: this.name, path: `/work/${projectGoal.id}`, metadata: {} };
	}
	async cleanup(_workspace: DispatchWorkspace, branch: string): Promise<void> {
		this.cleaned.push(branch);
	}
}

class FakeSession implements SessionBinding {
	readonly name = "fake-session";
	readonly prompts: string[] = [];
	readonly cleaned: string[] = [];
	cleanupFailure?: Error;
	readonly interruptedLaunchChecks: string[] = [];
	interruptedLaunchFailure?: Error;
	failure?: Error;
	launchIdentityFailure?: Error;
	launchClosureOutcome: LaunchClosureOutcome = "proven";
	async verifyLaunchIdentity(): Promise<void> {
		if (this.launchIdentityFailure) throw this.launchIdentityFailure;
	}
	async launch(
		_workspace: DispatchWorkspace,
		projectGoal: ProjectGoal,
		prompt: string,
	): Promise<DispatchSession> {
		await this.verifyLaunchIdentity();
		this.prompts.push(prompt);
		if (this.failure) throw this.failure;
		return { binding: this.name, metadata: { goalId: projectGoal.id } };
	}
	async verifyInterruptedLaunchClosed(
		_workspace: DispatchWorkspace,
		_projectGoal: ProjectGoal,
		launchToken: string,
	): Promise<LaunchClosureOutcome> {
		this.interruptedLaunchChecks.push(launchToken);
		if (this.interruptedLaunchFailure) throw this.interruptedLaunchFailure;
		return this.launchClosureOutcome;
	}
	async cleanup(session: DispatchSession): Promise<LaunchClosureOutcome> {
		if (this.cleanupFailure) throw this.cleanupFailure;
		this.cleaned.push(session.metadata.goalId ?? "unknown");
		return this.launchClosureOutcome;
	}
}

class PersistedWorktreeWorkspace implements WorkspaceBinding {
	readonly name = "worktree";
	readonly acquired: string[] = [];
	readonly cleaned: string[] = [];
	async verify(): Promise<void> {}
	async acquire(projectGoal: ProjectGoal, _branch: string, baseRevision: string): Promise<DispatchWorkspace> {
		this.acquired.push(projectGoal.id);
		return {
			binding: this.name,
			path: `/stepstone-${projectGoal.id}`,
			metadata: {
				marker: `00000000-0000-4000-8000-00000000001${this.acquired.length}`,
				base: baseRevision,
				gitdir: `/repo/.git/worktrees/${projectGoal.id}`,
			},
		};
	}
	async cleanup(_workspace: DispatchWorkspace, branch: string): Promise<void> {
		this.cleaned.push(branch);
	}
}

class PersistedHerdrSession implements SessionBinding {
	readonly name = "herdr";
	readonly interruptedLaunchChecks: string[] = [];
	interruptedLaunchFailure?: Error;
	async launch(): Promise<DispatchSession> {
		throw new Error("worker host is unavailable");
	}
	async verifyInterruptedLaunchClosed(
		_workspace: DispatchWorkspace,
		_projectGoal: ProjectGoal,
		launchToken: string,
	): Promise<LaunchClosureOutcome> {
		this.interruptedLaunchChecks.push(launchToken);
		if (this.interruptedLaunchFailure) throw this.interruptedLaunchFailure;
		return "proven";
	}
	async cleanup(): Promise<LaunchClosureOutcome> {
		return "proven";
	}
}

class FakeMerges implements MergeEvidenceBinding {
	readonly evidence = new Map<string, MergeEvidence>();
	readonly synced: MergeEvidence[] = [];
	syncFailure?: Error;
	async findMerged(branch: string) {
		return this.evidence.get(branch);
	}
	async syncTarget(evidence: MergeEvidence): Promise<string> {
		if (this.syncFailure) throw this.syncFailure;
		this.synced.push(evidence);
		return evidence.mergeCommit;
	}
}

function merged(overrides: Partial<MergeEvidence> = {}): MergeEvidence {
	return {
		url: "https://example.test/pull/2",
		headBranch: "stepstone/alpha",
		baseBranch: "main",
		createdAt: "2026-02-02T00:00:00.000Z",
		mergedAt: "2026-02-03T00:00:00.000Z",
		mergeCommit: "a".repeat(40),
		...overrides,
	};
}

class AmbiguousLaunchError extends Error implements SessionLaunchFailure {
	readonly ambiguous = true;
	readonly session = { binding: "fake-session", metadata: { goalId: "ambiguous" } };
}

function fixture(goals: ProjectGoal[], maxParallel = 2) {
	const roadmap = new FakeRoadmap({ goals, retiredIds: [] });
	const workspace = new FakeWorkspace();
	const session = new FakeSession();
	const merges = new FakeMerges();
	const store = new MemoryStore();
	let id = 0;
	const makeDriver = () =>
		new DispatchDriver({
			roadmap,
			workspace,
			session,
			merges,
			store,
			id: () => "run-1",
			now: () => new Date(Date.parse("2026-01-01T00:00:00.100Z") + id++),
		});
	const create = (approvedGoalIds = goals.map((entry) => entry.id)) =>
		makeDriver().create({
			repositoryRoot: "/repo",
			approvedGoalIds,
			maxParallel,
			targetBranch: "main",
			targetRevision: "0".repeat(40),
			bindingConfig: { agentArgs: [] },
		});
	return { roadmap, workspace, session, merges, store, makeDriver, create };
}

describe("resumable dispatch driver", () => {
	it("selects only approved ready goals, claims exact baselines, limits parallelism, and sends full context", async () => {
		const blocked = goal("blocked", { dependsOn: ["dependency"] });
		const setup = fixture(
			[goal("alpha"), goal("beta"), goal("unapproved"), goal("dependency", { status: "active" }), blocked],
			2,
		);
		const run = await setup.create(["alpha", "beta", "blocked"]);
		const advanced = await setup.makeDriver().advance(run.id);

		expect(setup.workspace.acquired).toEqual(["alpha", "beta"]);
		expect(setup.roadmap.claims).toEqual([
			{ id: "alpha", branch: "stepstone/alpha", token: "2026-01-01T00:00:00.000Z" },
			{ id: "beta", branch: "stepstone/beta", token: "2026-01-01T00:00:00.000Z" },
		]);
		expect(Object.values(advanced.entries).map((entry) => entry.phase)).toEqual(["running", "running"]);
		expect(setup.session.prompts[0]).toContain('"description": "Complete alpha thoroughly"');
		expect(setup.session.prompts[0]).toContain("Do not edit .worklist/worklist.json");
	});

	it("resumes persisted custody without relaunching and completes only exact matching merged PR evidence", async () => {
		const setup = fixture([goal("alpha")], 1);
		const run = await setup.create();
		await setup.makeDriver().advance(run.id);
		setup.merges.evidence.set(
			"stepstone/alpha",
			merged({ url: "https://example.test/pull/1", headBranch: "stepstone/other" }),
		);
		const restarted = setup.makeDriver();
		const preserved = await restarted.advance(run.id);
		expect(preserved.entries.alpha.phase).toBe("ambiguous");
		expect(setup.roadmap.completions).toHaveLength(0);
		expect(setup.session.prompts).toHaveLength(1);

		setup.merges.evidence.set("stepstone/alpha", merged());
		const completed = await restarted.advance(run.id);
		expect(setup.roadmap.completions).toHaveLength(1);
		expect(completed.entries.alpha.phase).toBe("cleaned");
		expect(completed.entries.alpha.mergedPr?.url).toBe("https://example.test/pull/2");
	});

	it("never accepts a completed goal from a later claim on the same deterministic branch", async () => {
		const setup = fixture([goal("alpha")], 1);
		const run = await setup.create();
		await setup.makeDriver().advance(run.id);
		const canonical = setup.roadmap.snapshot.goals[0];
		if (!canonical) throw new Error("fixture lost alpha");
		Object.assign(canonical, {
			status: "done",
			branch: "stepstone/alpha",
			updatedAt: "2026-01-01T00:00:09.000Z",
		});
		setup.merges.evidence.set("stepstone/alpha", merged());

		const resumed = await setup.makeDriver().advance(run.id);

		expect(resumed.entries.alpha.phase).toBe("ambiguous");
		expect(resumed.entries.alpha.message).toContain("exact claim");
		expect(setup.roadmap.completions).toHaveLength(0);
	});

	it("resumes an exact completion result persisted before the local phase advanced", async () => {
		const setup = fixture([goal("alpha")], 1);
		const run = await setup.create();
		const running = await setup.makeDriver().advance(run.id);
		const entry = running.entries.alpha;
		if (!entry.claimUpdatedAt) throw new Error("fixture did not claim alpha");
		const completedGoal = await setup.roadmap.complete("alpha", entry.claimUpdatedAt);
		entry.phase = "ambiguous";
		entry.completionUpdatedAt = completedGoal.updatedAt;
		entry.completionIntentAt = "2026-01-01T00:00:00.500Z";
		entry.mergedPr = merged();
		await setup.store.save(running);
		setup.merges.evidence.set("stepstone/alpha", merged());

		const resumed = await setup.makeDriver().advance(run.id);

		expect(resumed.entries.alpha.phase).toBe("cleaned");
		expect(setup.roadmap.completions).toHaveLength(1);
	});

	it("reconciles a canonical completion committed before its result token was journaled", async () => {
		const setup = fixture([goal("alpha")], 1);
		const run = await setup.create();
		await setup.makeDriver().advance(run.id);
		setup.merges.evidence.set("stepstone/alpha", merged());
		setup.roadmap.completionResponseFailure = new Error("response lost after commit");

		const interrupted = await setup.makeDriver().advance(run.id);
		expect(interrupted.entries.alpha.phase).toBe("ambiguous");
		expect(interrupted.entries.alpha.completionIntentAt).toBeDefined();
		expect(interrupted.entries.alpha.completionUpdatedAt).toBeUndefined();
		expect(setup.roadmap.snapshot.goals[0]?.status).toBe("done");
		await expect(setup.makeDriver().recoverRelease(run.id, "alpha")).rejects.toThrow("completion outcome");
		expect(setup.session.cleaned).toHaveLength(0);
		expect(setup.roadmap.releases).toHaveLength(0);

		setup.roadmap.completionResponseFailure = undefined;
		const resumed = await setup.makeDriver().advance(run.id);
		expect(resumed.entries.alpha.phase).toBe("cleaned");
		expect(resumed.entries.alpha.completionUpdatedAt).toBe(setup.roadmap.snapshot.goals[0]?.updatedAt);
		expect(setup.roadmap.completions).toHaveLength(1);
	});

	it("resumes journaled prepare and fails closed on an unjournaled exact claim response", async () => {
		const preparing = fixture([goal("alpha")], 1);
		const prepareRun = await preparing.create();
		prepareRun.entries.alpha = {
			goal: goal("alpha"),
			branch: "stepstone/alpha",
			phase: "preparing",
			updatedAt: "2026-02-01T00:00:00.000Z",
		};
		await preparing.store.save(prepareRun);
		const prepared = await preparing.makeDriver().advance(prepareRun.id);
		expect(prepared.entries.alpha.phase).toBe("running");
		expect(preparing.workspace.acquired).toEqual(["alpha"]);

		const claiming = fixture([goal("alpha")], 1);
		const claimRun = await claiming.create();
		const baseline = goal("alpha");
		const claimed = await claiming.roadmap.claim("alpha", "stepstone/alpha", baseline.updatedAt);
		claimRun.entries.alpha = {
			goal: baseline,
			branch: "stepstone/alpha",
			phase: "claiming",
			workspace: { binding: claiming.workspace.name, path: "/work/alpha", metadata: {} },
			updatedAt: "2026-02-01T00:00:00.000Z",
		};
		await claiming.store.save(claimRun);
		const resumed = await claiming.makeDriver().advance(claimRun.id);
		expect(resumed.entries.alpha.phase).toBe("ambiguous");
		expect(claiming.roadmap.claims).toHaveLength(1);
		expect(claiming.session.prompts).toHaveLength(0);

		const recovered = await claiming.makeDriver().recoverRelease(claimRun.id, "alpha", claimed.updatedAt);
		expect(recovered.entries.alpha.phase).toBe("cleaned");
		expect(claiming.roadmap.releases).toEqual([{ id: "alpha", token: claimed.updatedAt }]);
	});

	it("reconciles a release committed before its local journal update", async () => {
		const setup = fixture([goal("alpha")], 1);
		const run = await setup.create();
		const running = await setup.makeDriver().advance(run.id);
		const entry = running.entries.alpha;
		if (!entry.claimUpdatedAt) throw new Error("fixture did not claim alpha");
		await setup.roadmap.release("alpha", entry.claimUpdatedAt);
		entry.phase = "releasing";
		entry.session = undefined;
		await setup.store.save(running);
		const resumed = await setup.makeDriver().advance(run.id);
		expect(resumed.entries.alpha.phase).toBe("cleaned");
		expect(setup.roadmap.releases).toHaveLength(1);
		expect(setup.workspace.cleaned).toEqual(["stepstone/alpha"]);
	});

	it("keeps an unverified cleanup session inside the parallel capacity bound", async () => {
		const setup = fixture([goal("alpha", { status: "done" }), goal("beta")], 1);
		const run = await setup.create();
		run.entries.alpha = {
			goal: goal("alpha", { status: "done" }),
			branch: "stepstone/alpha",
			phase: "cleanup-pending",
			claimUpdatedAt: "2026-01-01T00:00:01.000Z",
			completionIntentAt: "2026-01-01T00:00:01.500Z",
			completionUpdatedAt: "2026-01-01T00:00:02.000Z",
			launchToken: "00000000-0000-4000-8000-000000000003",
			mergedPr: merged(),
			workspace: { binding: setup.workspace.name, path: "/work/alpha", metadata: {} },
			session: { binding: setup.session.name, metadata: { goalId: "alpha" } },
			updatedAt: "2026-02-01T00:00:00.000Z",
		};
		setup.session.cleanupFailure = new Error("cannot verify stop");
		await setup.store.save(run);
		const resumed = await setup.makeDriver().advance(run.id);
		expect(resumed.entries.alpha.phase).toBe("cleanup-pending");
		expect(setup.workspace.acquired).not.toContain("beta");
	});

	it("rejects stale or wrong-base PRs and updates the target before dispatching an unblocked goal", async () => {
		const setup = fixture([goal("alpha"), goal("beta", { dependsOn: ["alpha"] })], 1);
		const run = await setup.create();
		await setup.makeDriver().advance(run.id);
		setup.merges.evidence.set(
			"stepstone/alpha",
			merged({ baseBranch: "release", createdAt: "2025-01-01T00:00:00.000Z" }),
		);
		const rejected = await setup.makeDriver().advance(run.id);
		expect(rejected.entries.alpha.phase).toBe("ambiguous");
		expect(setup.roadmap.completions).toHaveLength(0);
		expect(setup.workspace.acquired).not.toContain("beta");

		setup.merges.evidence.set("stepstone/alpha", merged());
		setup.merges.syncFailure = new Error("merge commit is not reachable from target");
		const unreachable = await setup.makeDriver().advance(run.id);
		expect(unreachable.entries.alpha.phase).toBe("ambiguous");
		expect(setup.roadmap.completions).toHaveLength(0);
		setup.merges.syncFailure = undefined;
		const resumed = await setup.makeDriver().advance(run.id);
		expect(setup.merges.synced).toHaveLength(1);
		expect(resumed.targetRevision).toBe("a".repeat(40));
		expect(setup.workspace.acquired).toContain("beta");
		expect(setup.workspace.bases.find((base) => base.id === "beta")?.revision).toBe("a".repeat(40));
	});

	it("deeply validates persisted binding configuration and custody before use", async () => {
		const directory = await mkdtemp(join(tmpdir(), "stepstone-dispatch-state-"));
		const path = join(directory, "persisted-run.json");
		const fingerprint = await executableFingerprint(process.execPath);
		const run: DispatchRun = {
			version: 1,
			id: "persisted-run",
			repositoryRoot: "/repo",
			approvedGoalIds: ["alpha"],
			maxParallel: 1,
			targetBranch: "main",
			targetRevision: "0".repeat(40),
			workspaceBinding: "worktree",
			sessionBinding: "process",
			bindingConfig: {
				agentArgs: ["run"],
				agentCommand: process.execPath,
				agentCommandFingerprint: fingerprint,
				startupGraceMs: 1000,
			},
			createdAt: "2026-02-01T00:00:00.000Z",
			updatedAt: "2026-02-01T00:00:00.000Z",
			entries: {
				alpha: {
					goal: goal("alpha"),
					branch: "stepstone/alpha",
					phase: "ambiguous",
					custodyOperatorAsserted: true,
					workspace: {
						binding: "worktree",
						path: "/stepstone-alpha",
						metadata: {
							marker: "00000000-0000-4000-8000-000000000001",
							base: "0".repeat(40),
							gitdir: "/repo/.git/worktrees/alpha",
						},
					},
					updatedAt: "2026-02-01T00:00:00.000Z",
				},
			},
		};
		try {
			const store = new FileDispatchStateStore(directory);
			await store.create(run);
			expect(await store.load(run.id)).toEqual(run);

			const tampered = JSON.parse(await readFile(path, "utf8")) as DispatchRun;
			if (!tampered.entries.alpha.workspace) throw new Error("fixture lost workspace");
			const sentinel = join(directory, "unrelated-sentinel");
			await writeFile(sentinel, "untouched");
			tampered.entries.alpha.workspace.path = "/unrelated-checkout";
			await writeFile(path, JSON.stringify(tampered));
			await expect(store.load(run.id)).rejects.toThrow("invalid worktree custody");
			expect(await readFile(sentinel, "utf8")).toBe("untouched");

			tampered.entries.alpha.workspace.path = "/stepstone-alpha";
			tampered.bindingConfig.agentCommand = "/bin/rm";

			const malformed = structuredClone(run);
			const malformedEntry = malformed.entries.alpha;
			malformedEntry.phase = "cleanup-pending";
			malformedEntry.claimUpdatedAt = "2026-02-01T00:00:01.000Z";
			malformedEntry.launchToken = "00000000-0000-4000-8000-000000000009";
			malformedEntry.session = {
				binding: "process",
				metadata: {
					pid: String(process.pid),
					token: malformedEntry.launchToken,
					logPath: join(directory, "sessions", "alpha", "agent.log"),
					receiptPath: join(directory, "sessions", "alpha", `launch-${malformedEntry.launchToken}.json`),
				},
			};
			await writeFile(path, JSON.stringify(malformed));
			await expect(store.load(run.id)).rejects.toThrow("lacks canonical release or completion receipt");
			expect(await readFile(sentinel, "utf8")).toBe("untouched");

			const premature = structuredClone(malformed);
			premature.entries.alpha.phase = "preparing";
			premature.entries.alpha.workspace = undefined;
			premature.entries.alpha.claimUpdatedAt = undefined;
			await writeFile(path, JSON.stringify(premature));
			await expect(store.load(run.id)).rejects.toThrow("phase cannot retain a worker session");
			expect(await readFile(sentinel, "utf8")).toBe("untouched");
			await writeFile(path, JSON.stringify(tampered));
			await expect(store.load(run.id)).resolves.toMatchObject({ id: run.id });
			expect(await readFile(sentinel, "utf8")).toBe("untouched");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("completes, proves closure, and cleans an interrupted launch whose PR later merges", async () => {
		const directory = await mkdtemp(join(tmpdir(), "stepstone-dispatch-interrupted-"));
		const claimToken = "2026-01-01T00:00:00.000Z";
		const launchToken = "00000000-0000-4000-8000-000000000007";
		const run: DispatchRun = {
			version: 1,
			id: "interrupted-run",
			repositoryRoot: "/repo",
			approvedGoalIds: ["alpha", "beta"],
			maxParallel: 1,
			targetBranch: "main",
			targetRevision: "0".repeat(40),
			workspaceBinding: "worktree",
			sessionBinding: "herdr",
			bindingConfig: { agentArgs: [], agentKind: "task", promptTimeoutMs: 300000 },
			createdAt: "2026-02-01T00:00:00.000Z",
			updatedAt: "2026-02-01T00:00:00.000Z",
			entries: {
				alpha: {
					goal: goal("alpha", { status: "active", branch: "stepstone/alpha", updatedAt: claimToken }),
					branch: "stepstone/alpha",
					phase: "ambiguous",
					claimUpdatedAt: claimToken,
					launchToken,
					message: "Worker launch was interrupted before a session handle was persisted.",
					workspace: {
						binding: "worktree",
						path: "/stepstone-alpha",
						metadata: {
							marker: "00000000-0000-4000-8000-000000000006",
							base: "0".repeat(40),
							gitdir: "/repo/.git/worktrees/alpha",
						},
					},
					updatedAt: "2026-02-01T00:00:00.000Z",
				},
			},
		};
		try {
			const store = new FileDispatchStateStore(directory);
			await store.create(run);
			const roadmap = new FakeRoadmap({
				goals: [
					goal("alpha", { status: "active", branch: "stepstone/alpha", updatedAt: claimToken }),
					goal("beta"),
				],
				retiredIds: [],
			});
			const workspace = new PersistedWorktreeWorkspace();
			const session = new PersistedHerdrSession();
			const merges = new FakeMerges();
			merges.evidence.set("stepstone/alpha", merged());
			let tick = 0;
			const makeDriver = () =>
				new DispatchDriver({
					roadmap,
					workspace,
					session,
					merges,
					store,
					now: () => new Date(Date.parse("2026-03-01T00:00:00.000Z") + tick++),
				});

			session.interruptedLaunchFailure = new Error("worker still carries the launch identity");
			const held = await makeDriver().advance(run.id);

			expect(held.entries.alpha.phase).toBe("cleanup-pending");
			expect(held.entries.alpha.launchToken).toBe(launchToken);
			expect(held.entries.alpha.completionUpdatedAt).toBeDefined();
			expect(roadmap.completions).toHaveLength(1);
			expect(workspace.cleaned).toEqual([]);
			expect(workspace.acquired).toEqual([]);
			expect((await store.load(run.id)).entries.alpha.phase).toBe("cleanup-pending");

			session.interruptedLaunchFailure = undefined;
			const cleaned = await makeDriver().advance(run.id);

			expect(cleaned.entries.alpha.phase).toBe("cleaned");
			expect(cleaned.entries.alpha.launchToken).toBeUndefined();
			expect(cleaned.entries.alpha.mergedPr?.url).toBe("https://example.test/pull/2");
			expect(session.interruptedLaunchChecks).toEqual([launchToken, launchToken]);
			expect(roadmap.completions).toHaveLength(1);
			expect(workspace.acquired).toEqual(["beta"]);
			expect(workspace.cleaned).toEqual(["stepstone/alpha", "stepstone/beta"]);
			expect((await store.load(run.id)).entries.alpha.phase).toBe("cleaned");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("reconciles merged evidence but keeps approved goals undispatched when the agent identity changed", async () => {
		const setup = fixture([goal("alpha"), goal("beta", { dependsOn: ["alpha"] })], 1);
		const run = await setup.create();
		await setup.makeDriver().advance(run.id);
		setup.session.launchIdentityFailure = new Error("agent executable identity changed");
		setup.merges.evidence.set("stepstone/alpha", merged());

		await expect(setup.makeDriver().advance(run.id)).rejects.toThrow("agent executable identity changed");

		const reconciled = await setup.store.load(run.id);
		expect(reconciled.entries.alpha.phase).toBe("cleaned");
		expect(setup.roadmap.completions).toHaveLength(1);
		expect(reconciled.entries.beta).toBeUndefined();
		expect(setup.workspace.acquired).toEqual(["alpha"]);
		expect(setup.roadmap.releases).toEqual([]);

		setup.session.launchIdentityFailure = undefined;
		const dispatched = await setup.makeDriver().advance(run.id);
		expect(dispatched.entries.beta.phase).toBe("running");
	});

	it("defers a resumed claimed launch with its custody held when the agent identity changed", async () => {
		const setup = fixture([goal("alpha")], 1);
		const run = await setup.create();
		const baseline = goal("alpha");
		const claimed = await setup.roadmap.claim("alpha", "stepstone/alpha", baseline.updatedAt);
		run.entries.alpha = {
			goal: baseline,
			branch: "stepstone/alpha",
			phase: "claimed",
			workspace: { binding: setup.workspace.name, path: "/work/alpha", metadata: {} },
			claimUpdatedAt: claimed.updatedAt,
			updatedAt: "2026-01-01T00:00:00.500Z",
		};
		await setup.store.save(run);
		setup.session.launchIdentityFailure = new Error("agent executable identity changed");

		const deferred = await setup.makeDriver().advance(run.id);

		expect(deferred.entries.alpha.phase).toBe("claimed");
		expect(deferred.entries.alpha.launchToken).toBeUndefined();
		expect(deferred.entries.alpha.message).toContain("agent executable identity changed");
		expect(setup.roadmap.releases).toEqual([]);
		expect(setup.session.prompts).toEqual([]);
		expect(setup.workspace.cleaned).toEqual([]);

		setup.session.launchIdentityFailure = undefined;
		const launched = await setup.makeDriver().advance(run.id);

		expect(launched.entries.alpha.phase).toBe("running");
		expect(setup.roadmap.claims).toHaveLength(1);
	});

	it("refuses to apply one goal's inspected launch verdict to every entry in a run", async () => {
		const setup = fixture([goal("alpha", { status: "done" }), goal("beta", { status: "done" })], 2);
		const run = await setup.create();
		for (const [index, id] of ["alpha", "beta"].entries()) {
			run.entries[id] = {
				goal: goal(id, { status: "done" }),
				branch: `stepstone/${id}`,
				phase: "cleanup-pending",
				claimUpdatedAt: "2026-01-01T00:00:01.000Z",
				completionIntentAt: "2026-01-01T00:00:01.500Z",
				completionUpdatedAt: "2026-01-01T00:00:02.000Z",
				launchToken: `00000000-0000-4000-8000-00000000004${index}`,
				mergedPr: merged({ headBranch: `stepstone/${id}` }),
				workspace: { binding: setup.workspace.name, path: `/work/${id}`, metadata: {} },
				updatedAt: "2026-02-01T00:00:00.000Z",
			};
		}
		await setup.store.save(run);

		await expect(setup.makeDriver().cleanup(run.id, undefined, true)).rejects.toThrow("name that goal");
		expect(setup.session.interruptedLaunchChecks).toEqual([]);
		expect(setup.workspace.cleaned).toEqual([]);

		const cleaned = await setup.makeDriver().cleanup(run.id, "alpha", true);

		expect(cleaned?.entries.alpha.phase).toBe("cleaned");
		expect(cleaned?.entries.beta.phase).toBe("cleanup-pending");
		expect(cleaned?.entries.beta.launchToken).toBe("00000000-0000-4000-8000-000000000041");
		expect(setup.workspace.cleaned).toEqual(["stepstone/alpha"]);
	});

	itOnLinux("refuses to spawn a worker whose agent executable identity changed", async () => {
		const directory = await mkdtemp(join(tmpdir(), "stepstone-dispatch-identity-"));
		try {
			const changed = new DetachedProcessSessionBinding(
				process.execPath,
				[],
				directory,
				100,
				"1:2:3:4:5:6.7",
			);
			await expect(changed.verifyLaunchIdentity()).rejects.toThrow("agent executable identity changed");
			await expect(
				changed.launch({ binding: "worktree", path: directory, metadata: {} }, goal("alpha"), "prompt"),
			).rejects.toThrow("agent executable identity changed");

			const current = new DetachedProcessSessionBinding(
				process.execPath,
				[],
				directory,
				100,
				await executableFingerprint(process.execPath),
			);
			await expect(current.verifyLaunchIdentity()).resolves.toBeUndefined();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	itOnLinux("proves an interrupted launch closed when it never reserved a spawn receipt", async () => {
		const directory = await mkdtemp(join(tmpdir(), "stepstone-dispatch-receipt-proof-"));
		const workspace: DispatchWorkspace = { binding: "worktree", path: directory, metadata: {} };
		const launchToken = "00000000-0000-4000-8000-000000000022";
		try {
			const processBinding = new DetachedProcessSessionBinding(process.execPath, [], directory, 100);
			await expect(
				processBinding.verifyInterruptedLaunchClosed(workspace, goal("alpha"), launchToken),
			).resolves.toBe("proven");

			const herdrBinding = new HerdrSessionBinding("task", directory, 100);
			await expect(
				herdrBinding.verifyInterruptedLaunchClosed(workspace, goal("alpha"), launchToken),
			).resolves.toBe("proven");

			const sessionDirectory = join(directory, "sessions", "alpha");
			const receiptPath = join(sessionDirectory, `launch-${launchToken}.json`);
			await mkdir(sessionDirectory, { recursive: true });
			await writeFile(receiptPath, JSON.stringify({ token: launchToken }));
			await expect(
				processBinding.verifyInterruptedLaunchClosed(workspace, goal("alpha"), launchToken),
			).rejects.toThrow("--confirm-launch-closed");
			expect(await readFile(receiptPath, "utf8")).toContain(launchToken);

			await expect(
				processBinding.verifyInterruptedLaunchClosed(workspace, goal("alpha"), launchToken, true),
			).resolves.toBe("operator-asserted");
			await expect(readFile(receiptPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	itOnLinux("carries an operator verdict for a recycled PID whose process group survives", async () => {
		const directory = await mkdtemp(join(tmpdir(), "stepstone-dispatch-verdict-"));
		const workspace: DispatchWorkspace = { binding: "worktree", path: directory, metadata: {} };
		const launchToken = "00000000-0000-4000-8000-000000000023";
		const sessionDirectory = join(directory, "sessions", "alpha");
		const receiptPath = join(sessionDirectory, `launch-${launchToken}.json`);
		const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
			detached: true,
			stdio: "ignore",
		});
		try {
			await once(unrelated, "spawn");
			const recycled = unrelated.pid;
			if (!recycled) throw new Error("fixture could not spawn an unrelated process group");
			await mkdir(sessionDirectory, { recursive: true });
			await writeFile(receiptPath, JSON.stringify({ pid: recycled, token: launchToken }));
			const processBinding = new DetachedProcessSessionBinding(process.execPath, [], directory, 100);

			await expect(
				processBinding.verifyInterruptedLaunchClosed(workspace, goal("alpha"), launchToken),
			).rejects.toThrow("--confirm-launch-closed");
			expect(await readFile(receiptPath, "utf8")).toContain(launchToken);

			await expect(
				processBinding.verifyInterruptedLaunchClosed(workspace, goal("alpha"), launchToken, true),
			).resolves.toBe("operator-asserted");
			await expect(readFile(receiptPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			if (unrelated.pid) process.kill(-unrelated.pid, "SIGKILL");
			unrelated.unref();
			await rm(directory, { recursive: true, force: true });
		}
	});

	itOnLinux("carries an operator verdict for a session handle no binding can prove closed", async () => {
		const directory = await mkdtemp(join(tmpdir(), "stepstone-dispatch-session-verdict-"));
		const sessionDirectory = join(directory, "sessions", "alpha");
		const token = "00000000-0000-4000-8000-000000000025";
		const receiptPath = join(sessionDirectory, `launch-${token}.json`);
		const survivor = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
			detached: true,
			stdio: "ignore",
		});
		const oldPath = process.env.PATH;
		try {
			await once(survivor, "spawn");
			const orphaned = survivor.pid;
			if (!orphaned) throw new Error("fixture could not spawn a surviving process group");
			await mkdir(sessionDirectory, { recursive: true });
			await writeFile(receiptPath, JSON.stringify({ pid: orphaned, token }));
			const processBinding = new DetachedProcessSessionBinding(process.execPath, [], directory, 100);
			const processSession: DispatchSession = {
				binding: "process",
				metadata: {
					pid: String(orphaned),
					token,
					logPath: join(sessionDirectory, "agent.log"),
					receiptPath,
				},
			};

			await expect(processBinding.cleanup(processSession)).rejects.toThrow("--confirm-launch-closed");
			expect(await readFile(receiptPath, "utf8")).toContain(token);
			await expect(processBinding.cleanup(processSession, true)).resolves.toBe("operator-asserted");
			await expect(readFile(receiptPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
			expect(process.kill(-orphaned, 0)).toBe(true);

			const herdrReceiptPath = join(sessionDirectory, `herdr-launch-${token}.json`);
			const promptPath = join(sessionDirectory, "prompt.txt");
			await writeFile(herdrReceiptPath, JSON.stringify({ launchToken: token }));
			await writeFile(promptPath, "prompt");
			const herdrBinding = new HerdrSessionBinding("task", directory, 100);
			const herdrSession: DispatchSession = {
				binding: "herdr",
				metadata: {
					paneId: "worker-pane",
					workspace: directory,
					promptPath,
					receiptPath: herdrReceiptPath,
					agentName: "ss-alpha-1",
				},
			};
			process.env.PATH = join(directory, "absent-bin");

			await expect(herdrBinding.cleanup(herdrSession)).rejects.toThrow("--confirm-launch-closed");
			expect(await readFile(herdrReceiptPath, "utf8")).toContain(token);
			await expect(herdrBinding.cleanup(herdrSession, true)).resolves.toBe("operator-asserted");
			await expect(readFile(herdrReceiptPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
			await expect(readFile(promptPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			process.env.PATH = oldPath;
			if (survivor.pid) process.kill(-survivor.pid, "SIGKILL");
			survivor.unref();
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("removes durable workspace cleanup receipts with a completed run", async () => {
		const directory = await mkdtemp(join(tmpdir(), "stepstone-dispatch-receipt-"));
		const marker = "00000000-0000-4000-8000-000000000002";
		const markerPath = join(directory, "workspaces", `${marker}.json`);
		const run: DispatchRun = {
			version: 1,
			id: "receipt-run",
			repositoryRoot: "/repo",
			approvedGoalIds: ["alpha"],
			maxParallel: 1,
			targetBranch: "main",
			targetRevision: "0".repeat(40),
			workspaceBinding: "worktree",
			sessionBinding: "herdr",
			bindingConfig: { agentArgs: [], agentKind: "task", promptTimeoutMs: 300000 },
			createdAt: "2026-02-01T00:00:00.000Z",
			updatedAt: "2026-02-01T00:00:00.000Z",
			entries: {
				alpha: {
					goal: goal("alpha"),
					branch: "stepstone/alpha",
					phase: "cleaned",
					cleanupMarker: marker,
					updatedAt: "2026-02-01T00:00:00.000Z",
				},
			},
		};
		try {
			await mkdir(join(directory, "workspaces"));
			await writeFile(markerPath, "verified removal");
			const store = new FileDispatchStateStore(directory);
			await store.create(run);

			await store.remove(run.id);

			await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
			await expect(store.load(run.id)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	itOnLinux("delivers process prompts over stdin and redacts them from launch errors", async () => {
		const directory = await mkdtemp(join(tmpdir(), "stepstone-dispatch-prompt-"));
		const argvPath = join(directory, "argv.json");
		const stdinPath = join(directory, "stdin.txt");
		const scriptPath = join(directory, "capture.mjs");
		const secret = "goal secret that must not appear in argv or errors";
		try {
			await writeFile(
				scriptPath,
				[
					'import { writeFile } from "node:fs/promises";',
					'import { once } from "node:events";',
					'import { createServer } from "node:net";',
					"const [, , argvPath, stdinPath] = process.argv;",
					"await writeFile(argvPath, JSON.stringify(process.argv.slice(2)));",
					'let prompt = "";',
					'process.stdin.setEncoding("utf8");',
					"for await (const chunk of process.stdin) prompt += chunk;",
					"await writeFile(stdinPath, prompt);",
					"const server = createServer().listen(0);",
					'await once(process, "SIGTERM");',
					"server.close();",
				].join("\n"),
			);
			const binding = new DetachedProcessSessionBinding(
				process.execPath,
				[scriptPath, argvPath, stdinPath],
				directory,
				100,
			);
			const session = await binding.launch(
				{ binding: "worktree", path: directory, metadata: {} },
				goal("alpha"),
				secret,
			);
			expect(await readEventually(argvPath)).not.toContain(secret);
			expect(await readEventually(stdinPath)).toBe(secret);
			const launchToken = session.metadata.token;
			if (!launchToken) throw new Error("process session lost its launch token");
			await expect(
				binding.verifyInterruptedLaunchClosed(
					{ binding: "worktree", path: directory, metadata: {} },
					goal("alpha"),
					launchToken,
				),
			).rejects.toThrow("still live");
			await binding.cleanup(session);

			await writeFile(scriptPath, `process.stderr.write(${JSON.stringify(secret)}); process.exit(9);`);
			const failingBinding = new DetachedProcessSessionBinding(
				process.execPath,
				[scriptPath, argvPath, stdinPath],
				directory,
				5000,
			);
			const failure = await failingBinding
				.launch({ binding: "worktree", path: directory, metadata: {} }, goal("alpha"), secret)
				.catch((error: unknown) => error);
			expect(failure).toMatchObject({ ambiguous: true, session: { binding: "process" } });
			expect(String(failure)).not.toContain(secret);
			expect(String(failure)).toContain("Worker exited during");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("releases the exact claim and cleans up after a known-safe launch failure", async () => {
		const setup = fixture([goal("alpha")], 1);
		setup.session.failure = new Error("executable not found");
		const run = await setup.create();
		const advanced = await setup.makeDriver().advance(run.id);

		expect(setup.roadmap.releases).toEqual([{ id: "alpha", token: "2026-01-01T00:00:01.000Z" }]);
		expect(advanced.entries.alpha.phase).toBe("cleaned");
		expect(setup.workspace.cleaned).toEqual(["stepstone/alpha"]);
	});

	it("preserves ambiguous custody across restart until explicit exact-token recovery", async () => {
		const setup = fixture([goal("alpha")], 1);
		setup.session.failure = new AmbiguousLaunchError("prompt timed out");
		const run = await setup.create();
		const ambiguous = await setup.makeDriver().advance(run.id);
		expect(ambiguous.entries.alpha.phase).toBe("ambiguous");
		expect(setup.roadmap.releases).toHaveLength(0);

		await expect(setup.makeDriver().cleanup(run.id)).rejects.toThrow("still has custody");
		const recovered = await setup.makeDriver().recoverRelease(run.id, "alpha");
		expect(setup.roadmap.releases).toEqual([
			{ id: "alpha", token: ambiguous.entries.alpha.claimUpdatedAt as string },
		]);
		expect(recovered.entries.alpha.phase).toBe("cleaned");
	});

	it("requires explicit proof before releasing a launch with no persisted session handle", async () => {
		const setup = fixture([goal("alpha")], 1);
		const run = await setup.create();
		const running = await setup.makeDriver().advance(run.id);
		const launchToken = running.entries.alpha.launchToken;
		if (!launchToken) throw new Error("fixture lost launch identity");
		running.entries.alpha.phase = "launching";
		running.entries.alpha.session = undefined;
		await setup.store.save(running);

		await expect(setup.makeDriver().recoverRelease(run.id, "alpha")).rejects.toThrow(
			"--confirm-launch-closed",
		);
		expect(setup.roadmap.releases).toHaveLength(0);
		expect(setup.workspace.cleaned).toHaveLength(0);
		setup.session.interruptedLaunchFailure = new Error("worker still live");
		await expect(setup.makeDriver().recoverRelease(run.id, "alpha", undefined, true)).rejects.toThrow(
			"worker still live",
		);
		expect(setup.roadmap.releases).toHaveLength(0);
		setup.session.interruptedLaunchFailure = undefined;

		const recovered = await setup.makeDriver().recoverRelease(run.id, "alpha", undefined, true);
		expect(setup.session.interruptedLaunchChecks).toEqual([launchToken, launchToken]);
		expect(setup.roadmap.releases).toHaveLength(1);
		expect(recovered.entries.alpha.phase).toBe("cleaned");
	});

	it("rejects explicit release recovery from terminal completion custody before cleanup", async () => {
		const setup = fixture([goal("alpha")], 1);
		const run = await setup.create();
		const running = await setup.makeDriver().advance(run.id);
		const entry = running.entries.alpha;
		entry.phase = "completed";
		entry.completionIntentAt = "2026-02-01T00:00:00.000Z";
		entry.completionUpdatedAt = "2026-02-01T00:00:01.000Z";
		entry.mergedPr = merged();
		await setup.store.save(running);

		await expect(setup.makeDriver().recoverRelease(run.id, "alpha")).rejects.toThrow(
			"recovery is not allowed",
		);
		expect(setup.session.cleaned).toHaveLength(0);
		expect(setup.roadmap.releases).toHaveLength(0);
		expect((await setup.store.load(run.id)).entries.alpha.phase).toBe("completed");
	});

	it("authenticates worktree identity and never deletes a branch from an absent path alone", {
		timeout: 60_000,
	}, async () => {
		const directory = await realpath(await mkdtemp(join(tmpdir(), "stepstone-worktree-marker-")));
		const root = join(directory, "repo");
		try {
			await mkdir(root);
			await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: root });
			await execFileAsync("git", ["config", "user.name", "Stepstone Test"], { cwd: root });
			await execFileAsync("git", ["config", "user.email", "stepstone@example.test"], { cwd: root });
			await writeFile(join(root, "seed"), "seed");
			await execFileAsync("git", ["add", "seed"], { cwd: root });
			await execFileAsync("git", ["commit", "-q", "-m", "seed"], { cwd: root });
			const base = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
			const binding = new GitWorktreeBinding(root, directory);
			const alpha = await binding.acquire(goal("alpha"), "stepstone/alpha", base);
			const beta = await binding.acquire(goal("beta"), "stepstone/beta", base);
			const tampered = structuredClone(alpha);
			tampered.metadata.marker = beta.metadata.marker;

			await expect(binding.cleanup(tampered, "stepstone/alpha")).rejects.toThrow(
				"does not match persisted custody",
			);
			expect(
				(await execFileAsync("git", ["branch", "--list", "stepstone/alpha"], { cwd: root })).stdout,
			).toContain("stepstone/alpha");

			await execFileAsync("git", ["worktree", "remove", "--force", alpha.path], { cwd: root });
			await execFileAsync("git", ["branch", "-D", "stepstone/alpha"], { cwd: root });
			const replacement = await binding.acquire(goal("alpha"), "stepstone/alpha", base);
			await expect(binding.cleanup(alpha, "stepstone/alpha")).rejects.toThrow("newer dispatch ownership");
			expect(await readFile(join(replacement.path, "seed"), "utf8")).toBe("seed");

			const gamma = await binding.acquire(goal("gamma"), "stepstone/gamma", base);
			const gammaTip = (
				await execFileAsync("git", ["rev-parse", "refs/heads/stepstone/gamma"], { cwd: root })
			).stdout.trim();
			const gammaMarkerPath = join(
				root,
				".git",
				"stepstone-dispatch",
				"workspaces",
				`${gamma.metadata.marker}.json`,
			);
			const gammaMarker = JSON.parse(await readFile(gammaMarkerPath, "utf8")) as Record<string, unknown>;
			await writeFile(
				gammaMarkerPath,
				`${JSON.stringify({ ...gammaMarker, removalBranchTip: gammaTip }, null, 2)}\n`,
			);
			await execFileAsync("git", ["worktree", "remove", "--force", gamma.path], { cwd: root });
			const sameTipCheckout = join(directory, "same-tip-checkout");
			await execFileAsync("git", ["worktree", "add", sameTipCheckout, "stepstone/gamma"], { cwd: root });
			await expect(binding.cleanup(gamma, "stepstone/gamma")).rejects.toThrow(
				"manual branch cleanup is required",
			);
			expect(await readFile(join(sameTipCheckout, "seed"), "utf8")).toBe("seed");
			expect(
				(await execFileAsync("git", ["branch", "--list", "stepstone/gamma"], { cwd: root })).stdout,
			).toContain("stepstone/gamma");
			await execFileAsync("git", ["worktree", "remove", "--force", sameTipCheckout], { cwd: root });
			await execFileAsync("git", ["branch", "-D", "stepstone/gamma"], { cwd: root });

			const delta = await binding.acquire(goal("delta"), "stepstone/delta", base);
			const deltaTip = (
				await execFileAsync("git", ["rev-parse", "refs/heads/stepstone/delta"], { cwd: root })
			).stdout.trim();
			const deltaMarkerPath = join(
				root,
				".git",
				"stepstone-dispatch",
				"workspaces",
				`${delta.metadata.marker}.json`,
			);
			const deltaMarker = JSON.parse(await readFile(deltaMarkerPath, "utf8")) as Record<string, unknown>;
			await writeFile(
				deltaMarkerPath,
				`${JSON.stringify({ ...deltaMarker, removalBranchTip: deltaTip }, null, 2)}\n`,
			);
			await execFileAsync("git", ["worktree", "remove", "--force", delta.path], { cwd: root });
			await writeFile(join(root, "new-owner"), "new branch identity");
			await execFileAsync("git", ["add", "new-owner"], { cwd: root });
			await execFileAsync("git", ["commit", "-q", "-m", "new owner"], { cwd: root });
			const repurposedTip = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
			await execFileAsync("git", ["branch", "-f", "stepstone/delta", repurposedTip], { cwd: root });
			await expect(binding.cleanup(delta, "stepstone/delta")).rejects.toThrow(
				"manual branch cleanup is required",
			);
			expect(
				(
					await execFileAsync("git", ["rev-parse", "refs/heads/stepstone/delta"], { cwd: root })
				).stdout.trim(),
			).toBe(repurposedTip);
			await execFileAsync("git", ["branch", "-D", "stepstone/delta"], { cwd: root });

			const epsilon = await binding.acquire(goal("epsilon"), "stepstone/epsilon", base);
			const epsilonTip = (
				await execFileAsync("git", ["rev-parse", "refs/heads/stepstone/epsilon"], { cwd: root })
			).stdout.trim();
			const epsilonMarkerPath = join(
				root,
				".git",
				"stepstone-dispatch",
				"workspaces",
				`${epsilon.metadata.marker}.json`,
			);
			const epsilonMarker = JSON.parse(await readFile(epsilonMarkerPath, "utf8")) as Record<string, unknown>;
			await writeFile(
				epsilonMarkerPath,
				`${JSON.stringify(
					{
						...epsilonMarker,
						removalBranchTip: epsilonTip,
						branchDeletedAt: "2026-01-01T00:00:00.000Z",
					},
					null,
					2,
				)}\n`,
			);
			await execFileAsync("git", ["update-ref", "-d", "refs/heads/stepstone/epsilon", epsilonTip], {
				cwd: root,
			});
			await binding.cleanup(epsilon, "stepstone/epsilon");
			expect(
				(await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd: root })).stdout,
			).not.toContain(epsilon.path);

			await binding.cleanup(replacement, "stepstone/alpha");
			await binding.cleanup(beta, "stepstone/beta");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("verifies a newly acquired workspace immediately before claiming it", async () => {
		const setup = fixture([goal("alpha")], 1);
		setup.workspace.verificationFailure = new Error("lease holder changed before claim");
		const run = await setup.create();

		const advanced = await setup.makeDriver().advance(run.id);
		expect(advanced.entries.alpha.phase).toBe("ambiguous");
		expect(setup.roadmap.claims).toHaveLength(0);
		expect(setup.session.prompts).toHaveLength(0);
	});

	it("fails closed when a resumed claimed workspace no longer verifies before launch", async () => {
		const setup = fixture([goal("alpha")], 1);
		const run = await setup.create();
		const baseline = goal("alpha");
		const claimed = await setup.roadmap.claim("alpha", "stepstone/alpha", baseline.updatedAt);
		run.entries.alpha = {
			goal: baseline,
			branch: "stepstone/alpha",
			phase: "claimed",
			workspace: { binding: setup.workspace.name, path: "/work/alpha", metadata: {} },
			claimUpdatedAt: claimed.updatedAt,
			updatedAt: "2026-01-01T00:00:00.500Z",
		};
		await setup.store.save(run);
		setup.workspace.verificationFailure = new Error("lease holder changed");

		const resumed = await setup.makeDriver().advance(run.id);
		expect(resumed.entries.alpha.phase).toBe("ambiguous");
		expect(resumed.entries.alpha.message).toContain("lease holder changed");
		expect(setup.session.prompts).toHaveLength(0);
		expect(setup.roadmap.releases).toHaveLength(0);
	});

	it("guards Treehouse resume and cleanup with the exact current lease", async () => {
		const directory = await realpath(await mkdtemp(join(tmpdir(), "stepstone-treehouse-retry-")));
		const root = join(directory, "repo");
		const leased = join(directory, "leased");
		const bin = join(directory, "bin");
		const counter = join(directory, "returns");
		const oldPath = process.env.PATH;
		try {
			await mkdir(root);
			await mkdir(bin);
			await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: root });
			await execFileAsync("git", ["config", "user.name", "Stepstone Test"], { cwd: root });
			await execFileAsync("git", ["config", "user.email", "stepstone@example.test"], { cwd: root });
			await writeFile(join(root, "seed"), "seed");
			await execFileAsync("git", ["add", "seed"], { cwd: root });
			await execFileAsync("git", ["commit", "-q", "-m", "seed"], { cwd: root });
			const base = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
			await execFileAsync("git", ["worktree", "add", "-q", "--detach", leased, "HEAD"], { cwd: root });
			const command = join(bin, "treehouse");
			await writeFile(
				command,
				[
					"#!/usr/bin/env node",
					'import { readFileSync, writeFileSync } from "node:fs";',
					"const args = process.argv.slice(2);",
					"const leaseId = 'a'.repeat(32);",
					"const holder = 'stepstone:alpha';",
					"const path = process.env.STEPSTONE_TEST_LEASED;",
					"const countPath = process.env.STEPSTONE_TEST_RETURNS;",
					"const count = Number(readFileSync(countPath, 'utf8') || '0');",
					"if (args[0] === 'get') { console.log(JSON.stringify({ path, lease_id: leaseId, lease_holder: holder, leased_at: '2026-01-01T00:00:00.000Z' })); process.exit(0); }",
					"if (args[0] === 'status') {",
					"  const changed = process.env.STEPSTONE_TEST_CHANGED === '1';",
					"  const available = count >= 2;",
					"  console.log(JSON.stringify([{ name: '1', path, status: available ? 'available' : 'leased', lease_id: available ? '' : changed ? 'b'.repeat(32) : leaseId, lease_holder: available ? '' : changed ? 'other' : holder, leased_at: available ? null : '2026-01-01T00:00:00.000Z', processes: [] }]));",
					"  process.exit(0);",
					"}",
					"writeFileSync(countPath, String(count + 1));",
					"if (count === 0) process.exit(9);",
				].join("\n"),
			);
			await chmod(command, 0o755);
			await writeFile(counter, "0");
			process.env.PATH = `${bin}:${oldPath ?? ""}`;
			process.env.STEPSTONE_TEST_RETURNS = counter;
			process.env.STEPSTONE_TEST_LEASED = leased;
			const binding = new TreehouseWorkspaceBinding(root);
			const workspace = await binding.acquire(goal("alpha"), "stepstone/alpha", base);
			const sentinel = join(leased, "untracked-custody");
			await writeFile(sentinel, "must survive");
			await writeFile(join(leased, "seed"), "worker committed this");
			await execFileAsync("git", ["commit", "-q", "-am", "worker work"], { cwd: leased });
			await writeFile(join(leased, "seed"), "worker was interrupted mid-edit");
			process.env.STEPSTONE_TEST_CHANGED = "1";
			await expect(binding.verify(workspace, "stepstone/alpha")).rejects.toThrow("different lease");
			await expect(binding.cleanup(workspace, "stepstone/alpha")).rejects.toThrow("different lease");
			expect(await readFile(sentinel, "utf8")).toBe("must survive");
			expect(await readFile(counter, "utf8")).toBe("0");

			process.env.STEPSTONE_TEST_CHANGED = "0";
			await expect(binding.cleanup(workspace, "stepstone/alpha")).rejects.toThrow();
			expect(await readFile(sentinel, "utf8")).toBe("must survive");
			await expect(binding.cleanup(workspace, "stepstone/alpha")).resolves.toBeUndefined();
			await expect(binding.cleanup(workspace, "stepstone/alpha")).resolves.toBeUndefined();
			expect(await readFile(counter, "utf8")).toBe("2");
			expect(
				(await execFileAsync("git", ["branch", "--list", "stepstone/alpha"], { cwd: root })).stdout,
			).toBe("");
			await expect(binding.acquire(goal("alpha"), "stepstone/alpha", base)).resolves.toMatchObject({
				binding: "treehouse",
			});
		} finally {
			process.env.PATH = oldPath;
			delete process.env.STEPSTONE_TEST_RETURNS;
			delete process.env.STEPSTONE_TEST_LEASED;
			delete process.env.STEPSTONE_TEST_CHANGED;
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("carries an operator verdict for an unidentified Herdr pane whose agent was never started", async () => {
		const directory = await mkdtemp(join(tmpdir(), "stepstone-herdr-unknown-pane-"));
		const bin = join(directory, "bin");
		const panesPath = join(directory, "panes.json");
		const sessionDirectory = join(directory, "sessions", "alpha");
		const promptPath = join(sessionDirectory, "prompt.txt");
		const receiptPath = join(sessionDirectory, "herdr-launch-token.json");
		const oldPath = process.env.PATH;
		try {
			await mkdir(bin);
			await mkdir(sessionDirectory, { recursive: true });
			await writeFile(panesPath, JSON.stringify(["root-pane", "orphan-pane"]));
			await writeFile(promptPath, "prompt");
			await writeFile(receiptPath, JSON.stringify({ launchToken: "token" }));
			const command = join(bin, "herdr");
			await writeFile(
				command,
				[
					"#!/usr/bin/env node",
					'import { readFileSync } from "node:fs";',
					"const panes = JSON.parse(readFileSync(process.env.STEPSTONE_TEST_PANES, 'utf8'));",
					"const args = process.argv.slice(2);",
					"if (args[0] === 'pane' && args[1] === 'list') console.log(JSON.stringify({ result: { panes: panes.map((pane_id) => ({ pane_id })) } }));",
					"else if (args[0] === 'agent' && args[1] === 'get' && process.env.STEPSTONE_TEST_OWNED) console.log(JSON.stringify({ result: { agent: { pane_id: process.env.STEPSTONE_TEST_OWNED, cwd: process.env.STEPSTONE_TEST_CWD } } }));",
					"else process.exit(1);",
				].join("\n"),
			);
			await chmod(command, 0o755);
			process.env.PATH = `${bin}:${oldPath ?? ""}`;
			process.env.STEPSTONE_TEST_PANES = panesPath;
			const binding = new HerdrSessionBinding("task", directory, 100);
			const session: DispatchSession = {
				binding: "herdr",
				metadata: {
					pane: "unknown",
					workspace: directory,
					promptPath,
					receiptPath,
					beforePaneIds: JSON.stringify(["root-pane"]),
					agentName: "ss-alpha-1",
				},
			};

			await expect(binding.cleanup(session)).rejects.toThrow("--confirm-launch-closed");
			expect(await readFile(receiptPath, "utf8")).toContain("token");

			process.env.STEPSTONE_TEST_OWNED = "root-pane";
			process.env.STEPSTONE_TEST_CWD = directory;
			await expect(binding.cleanup(session, true)).rejects.toThrow("is still live");
			expect(await readFile(receiptPath, "utf8")).toContain("token");
			delete process.env.STEPSTONE_TEST_OWNED;

			await expect(binding.cleanup(session, true)).resolves.toBe("operator-asserted");
			await expect(readFile(receiptPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
			await expect(readFile(promptPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
			expect(JSON.parse(await readFile(panesPath, "utf8"))).toEqual(["root-pane", "orphan-pane"]);
		} finally {
			process.env.PATH = oldPath;
			delete process.env.STEPSTONE_TEST_PANES;
			delete process.env.STEPSTONE_TEST_OWNED;
			delete process.env.STEPSTONE_TEST_CWD;
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("journals a session released on the operator's verdict as asserted rather than proven", async () => {
		const stranded = (): DispatchEntry => ({
			goal: goal("alpha"),
			branch: "stepstone/alpha",
			phase: "ambiguous",
			workspace: { binding: "fake-workspace", path: "/work/alpha", metadata: {} },
			session: { binding: "fake-session", metadata: { goalId: "alpha" } },
			launchToken: "00000000-0000-4000-8000-000000000051",
			updatedAt: "2026-02-01T00:00:00.000Z",
		});

		const asserted = fixture([goal("alpha")], 1);
		const assertedRun = await asserted.create();
		assertedRun.entries.alpha = stranded();
		await asserted.store.save(assertedRun);
		asserted.session.launchClosureOutcome = "operator-asserted";

		await expect(asserted.makeDriver().recoverRelease(assertedRun.id, "alpha")).rejects.toThrow(
			"no exact claim token",
		);

		const assertedEntry = (await asserted.store.load(assertedRun.id)).entries.alpha;
		expect(asserted.session.cleaned).toEqual(["alpha"]);
		expect(assertedEntry.message).toContain("operator's inspected verdict");
		expect(assertedEntry.message).not.toContain("closed and verified");

		const proven = fixture([goal("alpha")], 1);
		const provenRun = await proven.create();
		provenRun.entries.alpha = stranded();
		await proven.store.save(provenRun);

		await expect(proven.makeDriver().recoverRelease(provenRun.id, "alpha")).rejects.toThrow(
			"no exact claim token",
		);

		const provenEntry = (await proven.store.load(provenRun.id)).entries.alpha;
		expect(provenEntry.message).toContain("closed and verified");
		expect(provenEntry.message).not.toContain("operator's inspected verdict");
	});

	it("keeps an operator-asserted release readable after the entry reaches its terminal phase", async () => {
		const asserted = fixture([goal("alpha")], 1);
		const assertedRun = await asserted.create();
		await asserted.makeDriver().advance(assertedRun.id);
		asserted.session.launchClosureOutcome = "operator-asserted";

		const recovered = await asserted.makeDriver().recoverRelease(assertedRun.id, "alpha", undefined, true);

		expect(recovered.entries.alpha.phase).toBe("cleaned");
		expect(recovered.entries.alpha.message).toBe("Released and cleaned.");
		expect(recovered.entries.alpha.custodyOperatorAsserted).toBe(true);
		expect((await asserted.store.load(assertedRun.id)).entries.alpha.custodyOperatorAsserted).toBe(true);

		const proven = fixture([goal("alpha")], 1);
		const provenRun = await proven.create();
		await proven.makeDriver().advance(provenRun.id);

		const released = await proven.makeDriver().recoverRelease(provenRun.id, "alpha", undefined, true);

		expect(released.entries.alpha.phase).toBe("cleaned");
		expect(released.entries.alpha.custodyOperatorAsserted).toBeUndefined();
	});

	it("recovers only the Herdr pane that appeared during an unidentified launch", async () => {
		const directory = await mkdtemp(join(tmpdir(), "stepstone-herdr-recovery-"));
		const bin = join(directory, "bin");
		const panesPath = join(directory, "panes.json");
		const oldPath = process.env.PATH;
		try {
			await mkdir(bin);
			await writeFile(panesPath, JSON.stringify(["root-pane"]));
			const command = join(bin, "herdr");
			await writeFile(
				command,
				[
					"#!/usr/bin/env node",
					'import { readFileSync, writeFileSync } from "node:fs";',
					"const path = process.env.STEPSTONE_TEST_PANES;",
					"let panes = JSON.parse(readFileSync(path, 'utf8'));",
					"const args = process.argv.slice(2);",
					"if (args[0] === 'pane' && args[1] === 'list') console.log(JSON.stringify({ result: { panes: panes.map((pane_id) => ({ pane_id })) } }));",
					"else if (args[0] === 'pane' && args[1] === 'split') { panes.push('worker-pane', 'concurrent-pane'); writeFileSync(path, JSON.stringify(panes)); console.log(JSON.stringify({ result: {} })); }",
					"else if (args[0] === 'pane' && args[1] === 'close') { panes = panes.filter((id) => id !== args[2]); writeFileSync(path, JSON.stringify(panes)); console.log('{}'); }",
					"else if (args[0] === 'agent' && args[1] === 'get') console.log(JSON.stringify({ result: { agent: { pane_id: 'worker-pane', cwd: process.env.STEPSTONE_TEST_CWD } } }));",
					"else process.exit(8);",
				].join("\n"),
			);
			await chmod(command, 0o755);
			process.env.PATH = `${bin}:${oldPath ?? ""}`;
			process.env.STEPSTONE_TEST_PANES = panesPath;
			process.env.STEPSTONE_TEST_CWD = directory;
			const binding = new HerdrSessionBinding("task", directory, 100);
			const workspace: DispatchWorkspace = { binding: "worktree", path: directory, metadata: {} };
			const launchToken = "00000000-0000-4000-8000-000000000024";
			let session: DispatchSession | undefined;
			try {
				await binding.launch(workspace, goal("alpha"), "prompt", launchToken);
			} catch (error) {
				session =
					error instanceof Error && "session" in error ? (error as SessionLaunchFailure).session : undefined;
			}
			if (!session) throw new Error("Herdr fixture did not preserve ambiguous session custody");

			await expect(
				binding.verifyInterruptedLaunchClosed(workspace, goal("alpha"), launchToken, true),
			).rejects.toThrow("still live");

			const herdrReceiptPath = join(directory, "sessions", "alpha", `herdr-launch-${launchToken}.json`);
			process.env.PATH = join(directory, "absent-bin");
			await expect(
				binding.verifyInterruptedLaunchClosed(workspace, goal("alpha"), launchToken),
			).rejects.toThrow("--confirm-launch-closed");
			expect(await readFile(herdrReceiptPath, "utf8")).toContain(launchToken);
			await expect(
				binding.verifyInterruptedLaunchClosed(workspace, goal("alpha"), launchToken, true),
			).resolves.toBe("operator-asserted");
			await expect(readFile(herdrReceiptPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
			process.env.PATH = `${bin}:${oldPath ?? ""}`;

			await binding.cleanup(session);
			expect(JSON.parse(await readFile(panesPath, "utf8"))).toEqual(["root-pane", "concurrent-pane"]);
		} finally {
			process.env.PATH = oldPath;
			delete process.env.STEPSTONE_TEST_PANES;
			delete process.env.STEPSTONE_TEST_CWD;
			await rm(directory, { recursive: true, force: true });
		}
	});

	itOnLinux("accepts option-shaped agent arguments through the published CLI contract", async () => {
		const directory = await mkdtemp(join(tmpdir(), "stepstone-dispatch-cli-"));
		const root = join(directory, "repo");
		const workspaceParent = join(directory, "workspaces");
		const argvPath = join(directory, "agent-argv.json");
		const agent = join(directory, "agent.mjs");
		try {
			await mkdir(join(root, ".worklist"), { recursive: true });
			await mkdir(workspaceParent);
			await writeFile(
				join(root, ".worklist", "worklist.json"),
				JSON.stringify({ version: 1, revision: 0, goals: [goal("alpha")], retiredIds: [] }),
			);
			await writeFile(
				agent,
				[
					'import { writeFile } from "node:fs/promises";',
					'import { createServer } from "node:net";',
					"await writeFile(process.argv[3], JSON.stringify(process.argv.slice(2)));",
					"createServer().listen(0);",
				].join("\n"),
			);
			await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: root });
			await execFileAsync("git", ["config", "user.name", "Stepstone Test"], { cwd: root });
			await execFileAsync("git", ["config", "user.email", "stepstone@example.test"], { cwd: root });
			await execFileAsync("git", ["add", "."], { cwd: root });
			await execFileAsync("git", ["commit", "-q", "-m", "seed"], { cwd: root });
			const cli = join(import.meta.dirname, "..", "src", "dispatch.ts");
			const started = await execFileAsync(
				process.execPath,
				[
					cli,
					"start",
					"--cwd",
					root,
					"--goal",
					"alpha",
					"--agent-command",
					process.execPath,
					"--agent-arg",
					agent,
					"--agent-arg",
					"--model",
					"--agent-arg",
					argvPath,
					"--workspace-parent",
					workspaceParent,
					"--startup-grace-ms",
					"20",
					"--json",
				],
				{ cwd: join(import.meta.dirname, "..") },
			);
			const envelope: unknown = JSON.parse(started.stdout);
			if (
				!envelope ||
				typeof envelope !== "object" ||
				!("result" in envelope) ||
				!envelope.result ||
				typeof envelope.result !== "object" ||
				!("id" in envelope.result) ||
				typeof envelope.result.id !== "string"
			) {
				throw new Error("Dispatch CLI returned an invalid start envelope");
			}
			const runId = envelope.result.id;
			expect(JSON.parse(await readEventually(argvPath))).toEqual(["--model", argvPath]);
			await execFileAsync(
				process.execPath,
				[cli, "recover", runId, "alpha", "--release", "--cwd", root, "--json"],
				{ cwd: join(import.meta.dirname, "..") },
			);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
