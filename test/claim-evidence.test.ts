import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { inspectPreparedClaims, type WorkspaceActivity } from "../src/claim-evidence.ts";
import {
	ApplicationRoadmapBinding,
	FileDispatchStateStore,
	GitWorktreeBinding,
} from "../src/dispatch-bindings.ts";
import type { DispatchRun, RoadmapSnapshot } from "../src/dispatch-driver.ts";
import type { ProjectGoal } from "../src/types.ts";

const exec = promisify(execFile);
const claimedAt = "2026-01-01T00:00:00.000Z";
const now = new Date("2026-01-03T00:00:00.000Z");

function fixture() {
	const goal: ProjectGoal = {
		id: "alpha",
		title: "Alpha",
		status: "open",
		branch: "stepstone/alpha",
		createdAt: claimedAt,
		updatedAt: claimedAt,
	};
	const run: DispatchRun = {
		version: 2,
		id: "test-run",
		repositoryRoot: "/repo",
		approvedGoalIds: ["alpha"],
		maxParallel: 1,
		targetBranch: "main",
		targetRevision: "base",
		workspaceConfig: {},
		createdAt: claimedAt,
		updatedAt: claimedAt,
		entries: {
			alpha: {
				goal,
				branch: "stepstone/alpha",
				phase: "prepared",
				claimUpdatedAt: claimedAt,
				workspace: { binding: "worktree", path: "/workspace", metadata: { base: "base" } },
				updatedAt: claimedAt,
			},
		},
	};
	const snapshot: RoadmapSnapshot = { goals: [structuredClone(goal)], retiredIds: [] };
	const activity: WorkspaceActivity = {
		path: "/workspace",
		baseRevision: "base",
		headRevision: "base",
		branchChangedSincePreparation: false,
		hasUncommittedChanges: false,
		lastBranchActivityAt: claimedAt,
	};
	const roadmap = { read: vi.fn(async () => snapshot) };
	const workspace = { observeActivity: vi.fn(async () => activity) };
	return {
		run,
		snapshot,
		activity,
		roadmap,
		workspace,
		inspect: (options = {}) => inspectPreparedClaims(run, roadmap, workspace, { now, ...options }),
	};
}

describe("prepared claim evidence", () => {
	it("flags an old quiet claim without mutating custody or canonical data", async () => {
		const f = fixture();
		const before = JSON.stringify([f.run, f.snapshot]);
		expect((await f.inspect()).alpha).toMatchObject({
			assessment: "possibly-abandoned",
			claimAgeHours: 48,
			staleAfterHours: 24,
			observedAt: now.toISOString(),
			canonical: { state: "matches" },
			workspace: { headRevision: "base", hasUncommittedChanges: false, lastBranchActivityAt: claimedAt },
		});
		expect(JSON.stringify([f.run, f.snapshot])).toBe(before);
	});

	it("uses an inclusive configurable threshold", async () => {
		const f = fixture();
		expect((await f.inspect({ staleAfterHours: 49 })).alpha.assessment).toBe("recent-claim");
		expect((await f.inspect({ staleAfterHours: 48 })).alpha.assessment).toBe("possibly-abandoned");
		for (const staleAfterHours of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER]) {
			await expect(f.inspect({ staleAfterHours })).rejects.toThrow("stale-after-hours");
		}
	});

	it("reports changes or recent branch activity without claiming anyone is running", async () => {
		const f = fixture();
		f.activity.hasUncommittedChanges = true;
		expect((await f.inspect()).alpha.assessment).toBe("activity-observed");
		f.activity.hasUncommittedChanges = false;
		f.activity.headRevision = "new-commit";
		f.activity.branchChangedSincePreparation = true;
		f.activity.lastBranchActivityAt = "2026-01-02T23:00:00.000Z";
		expect((await f.inspect()).alpha.assessment).toBe("activity-observed");
		// A branch with older committed work can still need operator attention.
		f.activity.lastBranchActivityAt = claimedAt;
		expect((await f.inspect()).alpha.assessment).toBe("possibly-abandoned");
	});

	it("preserves uncertainty for missing history, inaccessible workspaces, and future timestamps", async () => {
		const f = fixture();
		delete f.activity.lastBranchActivityAt;
		expect((await f.inspect()).alpha.assessment).toBe("needs-inspection");
		f.activity.lastBranchActivityAt = "2026-01-04T00:00:00.000Z";
		expect((await f.inspect()).alpha.reason).toContain("future");
		f.activity.lastBranchActivityAt = claimedAt;
		expect((await f.inspect({ now: new Date("2025-12-31") })).alpha.reason).toContain("future");
		f.workspace.observeActivity.mockRejectedValue(new Error("Workspace identity changed"));
		expect((await f.inspect()).alpha).toMatchObject({
			assessment: "needs-inspection",
			workspace: { state: "unavailable", message: "Workspace identity changed" },
		});
	});

	it("requires the exact current canonical claim and resolves historical IDs", async () => {
		const f = fixture();
		f.snapshot.goals[0].id = "renamed";
		f.snapshot.goals[0].previousIds = ["alpha"];
		expect((await f.inspect()).alpha.canonical).toMatchObject({ state: "matches", goalId: "renamed" });
		f.snapshot.goals[0].updatedAt = "2026-01-02T00:00:00.000Z";
		expect((await f.inspect()).alpha).toMatchObject({
			assessment: "needs-inspection",
			canonical: { state: "changed" },
		});
		f.snapshot.retiredIds.push("alpha");
		expect((await f.inspect()).alpha.canonical.state).toBe("missing");
		f.roadmap.read.mockRejectedValue(new Error("Roadmap unavailable"));
		expect((await f.inspect()).alpha).toMatchObject({
			assessment: "needs-inspection",
			canonical: { state: "unavailable", message: "Roadmap unavailable" },
		});
	});

	it("does not inspect entries that no longer own a prepared claim", async () => {
		const f = fixture();
		f.run.entries.alpha.phase = "released";
		expect(await f.inspect()).toEqual({});
		expect(f.roadmap.read).not.toHaveBeenCalled();
		expect(f.workspace.observeActivity).not.toHaveBeenCalled();
	});
});

async function realFixture() {
	const parent = resolve("artifacts/claim-evidence");
	await mkdir(parent, { recursive: true });
	const directory = await realpath(await mkdtemp(join(parent, "case-")));
	const root = join(directory, "repo");
	await mkdir(root);
	const git = (args: string[], cwd = root) => exec("git", args, { cwd });
	await git(["init", "-q", "-b", "main"]);
	await git(["config", "user.name", "Stepstone Test"]);
	await git(["config", "user.email", "stepstone@example.test"]);
	await writeFile(join(root, "README.md"), "Seed\n");
	await git(["add", "."]);
	await git(["commit", "-qm", "seed"]);
	const cli = async (...args: string[]) =>
		JSON.parse(
			(await exec(process.execPath, [resolve("src/cli.ts"), "project", ...args, "--cwd", root, "--json"]))
				.stdout,
		);
	await cli("add", "Alpha");
	const started = await cli("workspace", "start", "--goal", "alpha", "--workspace-parent", directory);
	const runId: string = started.result.id;
	const workspacePath: string = started.result.entries.alpha.workspace;
	const store = new FileDispatchStateStore(join(root, ".git", "stepstone-dispatch"));
	const roadmap = new ApplicationRoadmapBinding(root);
	const workspace = new GitWorktreeBinding(root, directory);
	return { directory, root, git, cli, runId, workspacePath, store, roadmap, workspace };
}

describe("real workspace observation and explicit release", () => {
	it("detects age and Git activity, keeps inspection read-only, and releases only on explicit recovery", async () => {
		const f = await realFixture();
		try {
			const run = await f.store.load(f.runId);
			const future = new Date(Date.parse(run.entries.alpha.claimUpdatedAt as string) + 48 * 3600000);
			const observe = () => inspectPreparedClaims(run, f.roadmap, f.workspace, { now: future });
			expect((await observe()).alpha.assessment).toBe("possibly-abandoned");
			const files = [
				join(f.root, ".worklist", "worklist.json"),
				join(f.root, ".git", "stepstone-dispatch", `${f.runId}.json`),
				join(run.entries.alpha.workspace?.metadata.gitdir as string, "index"),
			];
			const before = await Promise.all(files.map((file) => readFile(file)));
			const status = await f.cli("workspace", "status", f.runId);
			const inspected = await f.cli("workspace", "inspect", f.runId, "alpha", "--stale-after-hours", "1");
			expect(status.result[0].entries.alpha.claimEvidence.assessment).toBe("recent-claim");
			expect(inspected.result.claimEvidence).toMatchObject({
				staleAfterHours: 1,
				canonical: { state: "matches" },
				workspace: { state: "observed", hasUncommittedChanges: false },
			});
			expect(await Promise.all(files.map((file) => readFile(file)))).toEqual(before);
			expect((await f.cli("ready")).result.goals).toEqual([]);
			await expect(f.cli("workspace", "recover", f.runId, "alpha")).rejects.toMatchObject({
				stderr: expect.stringContaining("--release"),
			});
			await writeFile(join(f.workspacePath, "work.txt"), "operator work\n");
			expect((await observe()).alpha).toMatchObject({
				assessment: "activity-observed",
				workspace: { hasUncommittedChanges: true },
			});
			await f.git(["add", "work.txt"], f.workspacePath);
			expect((await observe()).alpha.workspace).toMatchObject({ hasUncommittedChanges: true });
			await f.git(["commit", "-qm", "progress"], f.workspacePath);
			const afterCommit = await inspectPreparedClaims(run, f.roadmap, f.workspace, { now: new Date() });
			expect(afterCommit.alpha.workspace).toMatchObject({
				branchChangedSincePreparation: true,
				hasUncommittedChanges: false,
				lastBranchActivityAt: expect.any(String),
			});
			await f.git(["reflog", "expire", "--expire=all", "refs/heads/stepstone/alpha"]);
			expect((await observe()).alpha).toMatchObject({
				assessment: "needs-inspection",
				reason: "Local branch activity history is unavailable.",
			});
			await writeFile(join(f.workspacePath, "work.txt"), "more work\n");
			const released = await f.cli("workspace", "recover", f.runId, "alpha", "--release");
			expect(released.result.entries.alpha.phase).toBe("cleanup-pending");
			expect((await f.cli("ready")).result.goals).toMatchObject([{ id: "alpha" }]);
			expect(await readFile(join(f.workspacePath, "work.txt"), "utf8")).toBe("more work\n");
			expect((await f.cli("workspace", "status", f.runId)).result[0].entries.alpha).not.toHaveProperty(
				"claimEvidence",
			);
		} finally {
			await rm(f.directory, { recursive: true, force: true });
		}
	}, 20000);

	it("reports an unavailable workspace or changed claim and refuses stale-token release", async () => {
		const f = await realFixture();
		try {
			for (const flags of [
				["--stale-after-hours", "0"],
				["--stale-after-hours", "1.5"],
				["--stale-after-hours", "9007199254740991"],
				["--stale-after-hours", "1", "--stale-after-hours", "2"],
			]) {
				await expect(f.cli("workspace", "status", f.runId, ...flags)).rejects.toMatchObject({
					code: 2,
					stderr: expect.stringContaining("stale-after-hours"),
				});
			}
			await expect(
				f.cli("workspace", "recover", f.runId, "alpha", "--release", "--stale-after-hours", "1"),
			).rejects.toMatchObject({ code: 2 });
			await f.cli("update", "alpha", "Alpha changed");
			const inspected = await f.cli("workspace", "inspect", f.runId, "alpha");
			expect(inspected.result.claimEvidence).toMatchObject({
				assessment: "needs-inspection",
				canonical: { state: "changed" },
			});
			await f.cli("workspace", "recover", f.runId, "alpha", "--release");
			expect((await f.cli("ready")).result.goals).toEqual([]);
			expect((await f.roadmap.read()).goals[0].branch).toBe("stepstone/alpha");
			const run = await f.store.load(f.runId);
			run.entries.alpha.phase = "prepared";
			await rm(f.workspacePath, { recursive: true, force: true });
			expect((await inspectPreparedClaims(run, f.roadmap, f.workspace)).alpha).toMatchObject({
				assessment: "needs-inspection",
				workspace: { state: "unavailable" },
			});
		} finally {
			await rm(f.directory, { recursive: true, force: true });
		}
	}, 20000);
});
