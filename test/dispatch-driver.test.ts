import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { FileDispatchStateStore, GitWorktreeBinding } from "../src/dispatch-bindings.ts";
import {
	DISPATCH_GOAL_FILE,
	DispatchDriver,
	type DispatchGoalFile,
	type DispatchRun,
	type DispatchStateStore,
	type DispatchWorkspace,
	type MergeEvidence,
	type MergeEvidenceBinding,
	type RoadmapBinding,
	type RoadmapSnapshot,
	type WorkspaceBinding,
} from "../src/dispatch-driver.ts";
import type { ProjectGoal } from "../src/types.ts";

const execFileAsync = promisify(execFile);

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
		Object.assign(target, { branch: undefined, updatedAt: this.token() });
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
	acquisitionFailure?: Error;
	goalFileFailure?: Error;
	goalFileResponseFailure?: Error;
	readonly acquired: string[] = [];
	readonly cleaned: string[] = [];
	readonly goalFiles = new Map<string, string>();
	readonly bases: Array<{ id: string; revision: string }> = [];

	async verify(): Promise<void> {
		if (this.verificationFailure) throw this.verificationFailure;
	}
	async acquire(projectGoal: ProjectGoal, _branch: string, baseRevision: string): Promise<DispatchWorkspace> {
		if (this.acquisitionFailure) throw this.acquisitionFailure;
		this.acquired.push(projectGoal.id);
		this.bases.push({ id: projectGoal.id, revision: baseRevision });
		return { binding: this.name, path: `/work/${projectGoal.id}`, metadata: {} };
	}
	async writeGoalFile(
		workspace: DispatchWorkspace,
		receipt: DispatchGoalFile,
		content: string,
	): Promise<void> {
		if (this.goalFileFailure) throw this.goalFileFailure;
		const target = join(workspace.path, receipt.path);
		const existing = this.goalFiles.get(target);
		if (existing !== undefined && existing !== content) throw new Error("goal file content changed");
		this.goalFiles.set(target, content);
		if (this.goalFileResponseFailure) throw this.goalFileResponseFailure;
	}
	async cleanup(_workspace: DispatchWorkspace, branch: string): Promise<void> {
		this.cleaned.push(branch);
	}
}

class FakeMerges implements MergeEvidenceBinding {
	readonly evidence = new Map<string, MergeEvidence>();
	readonly synced: MergeEvidence[] = [];
	syncFailure?: Error;

	async findMerged(branch: string): Promise<MergeEvidence | undefined> {
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

function fixture(goals: ProjectGoal[], maxParallel = 2) {
	const roadmap = new FakeRoadmap({ goals, retiredIds: [] });
	const workspace = new FakeWorkspace();
	const merges = new FakeMerges();
	const store = new MemoryStore();
	let tick = 0;
	const makeDriver = () =>
		new DispatchDriver({
			roadmap,
			workspace,
			merges,
			store,
			id: () => "run-1",
			now: () => new Date(Date.parse("2026-01-01T00:00:00.100Z") + tick++),
		});
	const create = (approvedGoalIds = goals.map((entry) => entry.id)) =>
		makeDriver().create({
			repositoryRoot: "/repo",
			approvedGoalIds,
			maxParallel,
			targetBranch: "main",
			targetRevision: "0".repeat(40),
			workspaceConfig: {},
		});
	return { roadmap, workspace, merges, store, makeDriver, create };
}

describe("workspace preparation driver", () => {
	it("prepares and claims only approved ready goals up to the configured limit", async () => {
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
		expect(Object.values(advanced.entries).map((entry) => entry.phase)).toEqual(["prepared", "prepared"]);
		expect(advanced.entries.alpha.message).toContain("did not launch or prompt an agent");
		expect(advanced.entries.alpha.goalFile).toMatchObject({
			path: DISPATCH_GOAL_FILE,
			ownershipId: expect.any(String),
			state: "written",
		});
		expect(setup.workspace.goalFiles.get("/work/alpha/STEPSTONE_GOAL.md")).toContain(
			"Complete alpha thoroughly",
		);
		expect(advanced).not.toHaveProperty("sessionBinding");
		expect(advanced.workspaceConfig).toEqual({});
	});

	it("journals the exact handoff before claiming and resumes after a lost write response", async () => {
		const setup = fixture(
			[
				goal("alpha", {
					title: "Ship the café workflow",
					description: "First line.\n\nSecond line.",
					group: "Automation",
					links: ["https://example.test/goals/alpha"],
				}),
			],
			1,
		);
		setup.workspace.goalFileResponseFailure = new Error("response lost after exact write");
		const run = await setup.create();

		const interrupted = await setup.makeDriver().advance(run.id);
		expect(interrupted.entries.alpha.phase).toBe("ambiguous");
		expect(interrupted.entries.alpha.goalFile).toMatchObject({ state: "pending" });
		expect(interrupted.entries.alpha.goalFile?.ownershipId).toEqual(expect.any(String));
		expect(setup.roadmap.claims).toHaveLength(0);
		const content = setup.workspace.goalFiles.get("/work/alpha/STEPSTONE_GOAL.md");
		expect(content).toContain("Ship the café workflow");
		expect(content).toContain("First line.\n\nSecond line.");
		expect(content).toContain("https://example.test/goals/alpha");

		setup.workspace.goalFileResponseFailure = undefined;
		const resumed = await setup.makeDriver().advance(run.id);
		expect(resumed.entries.alpha.phase).toBe("prepared");
		expect(resumed.entries.alpha.goalFile).toMatchObject({ state: "written" });
		expect(setup.roadmap.claims).toHaveLength(1);
	});

	it("upgrades an existing version 2 prepared entry that predates goal handoffs", async () => {
		const setup = fixture([goal("alpha", { description: undefined })], 1);
		const run = await setup.create();
		const prepared = await setup.makeDriver().advance(run.id);
		prepared.entries.alpha.goalFile = undefined;
		setup.workspace.goalFiles.clear();
		await setup.store.save(prepared);

		const upgraded = await setup.makeDriver().advance(run.id);
		expect(upgraded.entries.alpha.phase).toBe("prepared");
		expect(upgraded.entries.alpha.goalFile).toMatchObject({ state: "written" });
		expect(setup.workspace.goalFiles.get("/work/alpha/STEPSTONE_GOAL.md")).toContain(
			"_No description was provided._",
		);
		expect(setup.roadmap.claims).toHaveLength(1);
	});

	it("preserves an unclaimed workspace when its handoff conflicts", async () => {
		const setup = fixture([goal("alpha")], 1);
		setup.workspace.goalFileFailure = new Error("goal path is a symlink");
		const run = await setup.create();
		const refused = await setup.makeDriver().advance(run.id);

		expect(refused.entries.alpha.phase).toBe("ambiguous");
		expect(refused.entries.alpha.message).toContain("goal path is a symlink");
		expect(setup.roadmap.claims).toHaveLength(0);
	});

	it("counts prepared claims, then completes exact merged work and refills the available slot", async () => {
		const setup = fixture([goal("alpha"), goal("beta", { dependsOn: ["alpha"] })], 1);
		const run = await setup.create();
		const prepared = await setup.makeDriver().advance(run.id);
		expect(prepared.entries.alpha.phase).toBe("prepared");
		expect(setup.workspace.acquired).toEqual(["alpha"]);

		await setup.makeDriver().advance(run.id);
		expect(setup.workspace.acquired).toEqual(["alpha"]);

		setup.merges.evidence.set("stepstone/alpha", merged());
		const resumed = await setup.makeDriver().advance(run.id);

		expect(setup.roadmap.completions).toHaveLength(1);
		expect(resumed.entries.alpha.phase).toBe("cleaned");
		expect(resumed.entries.alpha.mergedPr?.url).toBe("https://example.test/pull/2");
		expect(resumed.entries.beta.phase).toBe("prepared");
		expect(setup.workspace.acquired).toEqual(["alpha", "beta"]);
		expect(setup.workspace.bases.find((base) => base.id === "beta")?.revision).toBe("a".repeat(40));
	});

	it("preserves a claim when merge evidence or target synchronization is not exact", async () => {
		const setup = fixture([goal("alpha")], 1);
		const run = await setup.create();
		await setup.makeDriver().advance(run.id);
		setup.merges.evidence.set("stepstone/alpha", merged({ headBranch: "stepstone/other" }));

		const mismatched = await setup.makeDriver().advance(run.id);
		expect(mismatched.entries.alpha.phase).toBe("ambiguous");
		expect(setup.roadmap.completions).toHaveLength(0);

		setup.merges.evidence.set("stepstone/alpha", merged());
		setup.merges.syncFailure = new Error("merge commit is not on the target");
		const unsynced = await setup.makeDriver().advance(run.id);
		expect(unsynced.entries.alpha.phase).toBe("ambiguous");
		expect(unsynced.entries.alpha.message).toContain("prepared claim preserved");
		expect(setup.roadmap.completions).toHaveLength(0);
	});

	it("reconciles a completion committed before its response token was journaled", async () => {
		const setup = fixture([goal("alpha")], 1);
		const run = await setup.create();
		await setup.makeDriver().advance(run.id);
		setup.merges.evidence.set("stepstone/alpha", merged());
		setup.roadmap.completionResponseFailure = new Error("response lost after commit");

		const interrupted = await setup.makeDriver().advance(run.id);
		expect(interrupted.entries.alpha.phase).toBe("ambiguous");
		expect(interrupted.entries.alpha.completionIntentAt).toBeDefined();
		expect(interrupted.entries.alpha.completionUpdatedAt).toBeUndefined();
		await expect(setup.makeDriver().recoverRelease(run.id, "alpha")).rejects.toThrow("completion outcome");

		setup.roadmap.completionResponseFailure = undefined;
		const resumed = await setup.makeDriver().advance(run.id);
		expect(resumed.entries.alpha.phase).toBe("cleaned");
		expect(resumed.entries.alpha.completionUpdatedAt).toBe(setup.roadmap.snapshot.goals[0]?.updatedAt);
		expect(setup.roadmap.completions).toHaveLength(1);
	});

	it("fails closed around interrupted acquisition and claim persistence", async () => {
		const acquisition = fixture([goal("alpha")], 1);
		const acquisitionRun = await acquisition.create();
		acquisitionRun.entries.alpha = {
			goal: goal("alpha"),
			branch: "stepstone/alpha",
			phase: "acquiring",
			updatedAt: "2026-02-01T00:00:00.000Z",
		};
		await acquisition.store.save(acquisitionRun);
		const unknownWorkspace = await acquisition.makeDriver().advance(acquisitionRun.id);
		expect(unknownWorkspace.entries.alpha.phase).toBe("ambiguous");
		expect(acquisition.roadmap.claims).toHaveLength(0);

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

		const interruptedClaim = await claiming.makeDriver().advance(claimRun.id);
		expect(interruptedClaim.entries.alpha.phase).toBe("ambiguous");
		await expect(claiming.makeDriver().recoverRelease(claimRun.id, "alpha")).rejects.toThrow(
			"no exact claim token",
		);
		const recovered = await claiming.makeDriver().recoverRelease(claimRun.id, "alpha", claimed.updatedAt);
		expect(recovered.entries.alpha.phase).toBe("cleaned");
		expect(claiming.roadmap.releases).toEqual([{ id: "alpha", token: claimed.updatedAt }]);
	});

	it("verifies a workspace immediately before claiming and preserves failed custody", async () => {
		const setup = fixture([goal("alpha")], 1);
		setup.workspace.verificationFailure = new Error("workspace owner changed");
		const run = await setup.create();

		const advanced = await setup.makeDriver().advance(run.id);
		expect(advanced.entries.alpha.phase).toBe("ambiguous");
		expect(advanced.entries.alpha.message).toContain("workspace owner changed");
		expect(setup.roadmap.claims).toHaveLength(0);
		expect(setup.roadmap.releases).toHaveLength(0);
	});

	it("rejects release recovery after a completion outcome exists", async () => {
		const setup = fixture([goal("alpha")], 1);
		const run = await setup.create();
		const prepared = await setup.makeDriver().advance(run.id);
		const entry = prepared.entries.alpha;
		entry.phase = "completed";
		entry.completionIntentAt = "2026-02-01T00:00:00.000Z";
		entry.completionUpdatedAt = "2026-02-01T00:00:01.000Z";
		entry.mergedPr = merged();
		await setup.store.save(prepared);

		await expect(setup.makeDriver().recoverRelease(run.id, "alpha")).rejects.toThrow(
			"recovery is not allowed",
		);
		expect(setup.roadmap.releases).toHaveLength(0);
	});
});

describe("persisted preparation state", () => {
	it("accepts version 2 workspace custody and rejects hosted-session version 1 state", async () => {
		const directory = await mkdtemp(join(tmpdir(), "stepstone-dispatch-state-"));
		const path = join(directory, "persisted-run.json");
		const run: DispatchRun = {
			version: 2,
			id: "persisted-run",
			repositoryRoot: "/repo",
			approvedGoalIds: ["alpha"],
			maxParallel: 1,
			targetBranch: "main",
			targetRevision: "0".repeat(40),
			workspaceConfig: { workspaceParent: "/workspaces" },
			createdAt: "2026-02-01T00:00:00.000Z",
			updatedAt: "2026-02-01T00:00:00.000Z",
			entries: {
				alpha: {
					goal: goal("alpha"),
					branch: "stepstone/alpha",
					phase: "prepared",
					claimUpdatedAt: "2026-02-01T00:00:01.000Z",
					workspace: {
						binding: "worktree",
						path: "/workspaces/stepstone-alpha",
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

			const hosted = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
			hosted.version = 1;
			hosted.sessionBinding = "process";
			await writeFile(path, JSON.stringify(hosted));
			await expect(store.load(run.id)).rejects.toThrow("expected 2");

			const tampered = structuredClone(run);
			if (!tampered.entries.alpha.workspace) throw new Error("fixture lost workspace");
			tampered.entries.alpha.workspace.path = "/unrelated-checkout";
			await writeFile(path, JSON.stringify(tampered));
			await expect(store.load(run.id)).rejects.toThrow("invalid worktree custody");

			tampered.entries.alpha.workspace.path = "/workspaces/stepstone-alpha";
			tampered.entries.alpha.goalFile = {
				path: DISPATCH_GOAL_FILE,
				sha256: "not-a-sha256",
				state: "written",
			};
			await writeFile(path, JSON.stringify(tampered));
			await expect(store.load(run.id)).rejects.toThrow("Invalid string");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("removes durable workspace cleanup receipts with a completed run", async () => {
		const directory = await mkdtemp(join(tmpdir(), "stepstone-dispatch-receipt-"));
		const marker = "00000000-0000-4000-8000-000000000002";
		const markerPath = join(directory, "workspaces", `${marker}.json`);
		const run: DispatchRun = {
			version: 2,
			id: "receipt-run",
			repositoryRoot: "/repo",
			approvedGoalIds: ["alpha"],
			maxParallel: 1,
			targetBranch: "main",
			targetRevision: "0".repeat(40),
			workspaceConfig: {},
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
});

describe("Git workspace preparation", () => {
	it("creates, authenticates, and cleans the exact worktree it owns", { timeout: 30_000 }, async () => {
		const directory = await realpath(await mkdtemp(join(tmpdir(), "stepstone-worktree-")));
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
			const workspace = await binding.acquire(goal("alpha"), "stepstone/alpha", base);
			const goalFile = join(workspace.path, DISPATCH_GOAL_FILE);
			const content = "# Stepstone Project Goal\n\nExact handoff\n";
			const receipt: DispatchGoalFile = {
				path: DISPATCH_GOAL_FILE,
				sha256: createHash("sha256").update(content, "utf8").digest("hex"),
				ownershipId: "00000000-0000-4000-8000-000000000042",
				state: "pending",
			};
			const backing = join(workspace.path, `.stepstone-goal-${receipt.ownershipId}.owned`);
			const staleTemporary = `${goalFile}.123.00000000-0000-4000-8000-000000000000.tmp`;
			const staleBackingTemporary = `${backing}.123.00000000-0000-4000-8000-000000000000.tmp`;
			await writeFile(staleTemporary, content);
			await writeFile(staleBackingTemporary, content);
			await writeFile(goalFile, content);
			await expect(binding.writeGoalFile(workspace, receipt, content)).rejects.toThrow(
				"is not owned by this dispatch receipt",
			);
			expect(await readFile(goalFile, "utf8")).toBe(content);
			expect((await execFileAsync("git", ["status", "--porcelain"], { cwd: workspace.path })).stdout).toBe(
				"",
			);
			await rm(staleTemporary);
			await rm(staleBackingTemporary);
			await rm(goalFile);

			await binding.writeGoalFile(workspace, receipt, content);
			await binding.writeGoalFile(workspace, receipt, content);
			const [backingDetails, goalDetails] = await Promise.all([
				stat(backing, { bigint: true }),
				stat(goalFile, { bigint: true }),
			]);
			expect({ dev: goalDetails.dev, ino: goalDetails.ino }).toEqual({
				dev: backingDetails.dev,
				ino: backingDetails.ino,
			});

			await execFileAsync("git", ["add", "-f", "--", DISPATCH_GOAL_FILE], { cwd: workspace.path });
			await expect(binding.writeGoalFile(workspace, receipt, content)).rejects.toThrow(
				"final or backing path is tracked by Git",
			);
			await execFileAsync("git", ["reset", "--", DISPATCH_GOAL_FILE], { cwd: workspace.path });

			await rm(goalFile);
			const symlinkTarget = join(directory, "matching-goal.md");
			await writeFile(symlinkTarget, content);
			await symlink(symlinkTarget, goalFile);
			await expect(binding.writeGoalFile(workspace, receipt, content)).rejects.toThrow(
				"is not owned by this dispatch receipt",
			);
			expect(await readFile(symlinkTarget, "utf8")).toBe(content);
			await rm(goalFile);

			await binding.writeGoalFile(workspace, receipt, content);
			await binding.writeGoalFile(workspace, receipt, content);

			expect(await readFile(goalFile, "utf8")).toBe(content);
			expect(
				(
					await execFileAsync("git", ["check-ignore", DISPATCH_GOAL_FILE], {
						cwd: workspace.path,
					})
				).stdout,
			).toContain(DISPATCH_GOAL_FILE);
			expect((await execFileAsync("git", ["status", "--porcelain"], { cwd: workspace.path })).stdout).toBe(
				"",
			);
			await expect(binding.verify(workspace, "stepstone/alpha")).resolves.toBeUndefined();
			const tampered = structuredClone(workspace);
			tampered.metadata.marker = "00000000-0000-4000-8000-000000000099";
			await expect(binding.cleanup(tampered, "stepstone/alpha")).rejects.toThrow();
			expect(
				(await execFileAsync("git", ["branch", "--list", "stepstone/alpha"], { cwd: root })).stdout,
			).toContain("stepstone/alpha");

			await binding.cleanup(workspace, "stepstone/alpha");
			await expect(readFile(goalFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
			await expect(readFile(backing, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
			expect(
				(await execFileAsync("git", ["branch", "--list", "stepstone/alpha"], { cwd: root })).stdout,
			).toBe("");
			await expect(readFile(workspace.path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});

describe("published preparation CLI", () => {
	it("starts without a harness flag and reports prepared workspaces", { timeout: 30_000 }, async () => {
		const directory = await realpath(await mkdtemp(join(tmpdir(), "stepstone-dispatch-cli-")));
		const root = join(directory, "repo");
		const workspaceParent = join(directory, "workspaces");
		try {
			await mkdir(join(root, ".worklist"), { recursive: true });
			await mkdir(workspaceParent);
			await writeFile(
				join(root, ".worklist", "worklist.json"),
				JSON.stringify({ version: 1, revision: 0, goals: [goal("alpha")], retiredIds: [] }),
			);
			await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: root });
			await execFileAsync("git", ["config", "user.name", "Stepstone Test"], { cwd: root });
			await execFileAsync("git", ["config", "user.email", "stepstone@example.test"], { cwd: root });
			await execFileAsync("git", ["add", "."], { cwd: root });
			await execFileAsync("git", ["commit", "-q", "-m", "seed"], { cwd: root });
			const cli = join(import.meta.dirname, "..", "src", "dispatch.ts");
			const help = await execFileAsync(process.execPath, [cli, "--help"], {
				cwd: join(import.meta.dirname, ".."),
			});
			expect(help.stdout).toContain("never starts, prompts, or supervises an agent");
			expect(help.stdout).toContain(DISPATCH_GOAL_FILE);
			for (const removed of ["--session", "--agent-command", "--agent-arg", "--agent-kind"]) {
				expect(help.stdout).not.toContain(removed);
			}

			const started = await execFileAsync(
				process.execPath,
				[cli, "start", "--cwd", root, "--goal", "alpha", "--workspace-parent", workspaceParent, "--json"],
				{ cwd: join(import.meta.dirname, "..") },
			);
			const envelope = JSON.parse(started.stdout) as {
				result: {
					id: string;
					entries: Record<string, { phase: string; workspace: string; goalFile: string }>;
				};
			};
			const workspacePath = join(workspaceParent, "stepstone-alpha");
			const goalFile = join(workspacePath, DISPATCH_GOAL_FILE);
			expect(envelope.result.entries.alpha).toMatchObject({
				phase: "prepared",
				workspace: workspacePath,
				goalFile,
			});
			expect(await readFile(goalFile, "utf8")).toContain("Complete alpha thoroughly");

			const status = await execFileAsync(
				process.execPath,
				[cli, "status", envelope.result.id, "--cwd", root, "--json"],
				{ cwd: join(import.meta.dirname, "..") },
			);
			expect(JSON.parse(status.stdout)).toMatchObject({
				ok: true,
				result: [{ entries: { alpha: { phase: "prepared", goalFile } } }],
			});

			for (const removed of [
				["--agent-command", "claude"],
				["--session", "process"],
				["--workspace", "treehouse"],
			]) {
				await expect(
					execFileAsync(process.execPath, [cli, "start", "--cwd", root, "--goal", "alpha", ...removed], {
						cwd: join(import.meta.dirname, ".."),
					}),
				).rejects.toMatchObject({ stderr: expect.stringContaining(`Unknown flag ${removed[0]}`) });
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
