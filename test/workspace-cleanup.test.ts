import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { GitWorktreeBinding } from "../src/dispatch-bindings.ts";
import { DISPATCH_GOAL_FILE, type DispatchGoalFile } from "../src/dispatch-driver.ts";
import type { ProjectGoal } from "../src/types.ts";
import { compileWorkspaceFixture } from "./fixtures/compile-workspace.ts";

const exec = promisify(execFile);
const directories: string[] = [];
const goal: ProjectGoal = {
	id: "alpha",
	title: "Alpha",
	status: "open",
	createdAt: "2026-02-01T00:00:00.000Z",
	updatedAt: "2026-02-01T00:00:00.000Z",
};
const branch = "stepstone/alpha";

async function fixture(remote = false, unpushedBase = false) {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "stepstone-cleanup-")));
	directories.push(directory);
	const root = join(directory, "repo");
	await mkdir(root);
	const git = async (...args: string[]) => (await exec("git", args, { cwd: root })).stdout.trim();
	await git("init", "-q", "-b", "main");
	await git("config", "user.name", "Stepstone Test");
	await git("config", "user.email", "stepstone@example.test");
	await writeFile(join(root, "seed"), "seed\n");
	await writeFile(join(root, ".gitignore"), "ignored\n");
	await git("add", ".");
	await git("commit", "-qm", "seed");
	const remotePath = join(directory, "remote.git");
	if (remote) {
		await git("init", "--bare", "-q", remotePath);
		await git("remote", "add", "origin", remotePath);
		await git("push", "-u", "origin", "main");
	}
	if (unpushedBase) await git("commit", "--allow-empty", "-qm", "unpublished base");
	const base = await git("rev-parse", "HEAD");
	const binding = new GitWorktreeBinding(root, directory);
	const workspace = await binding.acquire(goal, branch, base);
	const workGit = async (...args: string[]) =>
		(await exec("git", args, { cwd: workspace.path })).stdout.trim();
	const commit = async () => {
		await workGit("commit", "--allow-empty", "-qm", "workspace work");
		return await workGit("rev-parse", "HEAD");
	};
	const markerPath = join(
		root,
		".git",
		"stepstone-dispatch",
		"workspaces",
		`${workspace.metadata.marker}.json`,
	);
	const marker = async () => JSON.parse(await readFile(markerPath, "utf8"));
	const cleanup = async (force = false) =>
		binding.cleanup(workspace, branch, {
			targetBranch: "main",
			targetRevision: await git("rev-parse", "main"),
			force,
		});
	return {
		directory,
		root,
		git,
		base,
		binding,
		workspace,
		workGit,
		commit,
		cleanup,
		marker,
		markerPath,
		remotePath,
	};
}

afterEach(async () => {
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("verified workspace cleanup", () => {
	it.each(["unstaged", "staged", "untracked", "ignored"])(
		"preserves %s changes and branch custody",
		async (kind) => {
			const f = await fixture();
			const name = ["unstaged", "staged"].includes(kind) ? "seed" : kind;
			await writeFile(join(f.workspace.path, name), "operator work\n");
			if (kind === "staged") await f.workGit("add", name);
			await expect(f.cleanup()).rejects.toThrow("uncommitted");
			expect(await readFile(join(f.workspace.path, name), "utf8")).toBe("operator work\n");
			expect(await f.git("rev-parse", `refs/heads/${branch}`)).toBe(f.base);
			expect(await f.marker()).not.toHaveProperty("removalBranchTip");
		},
	);

	it("refuses unpushed work even after a local merge", async () => {
		const f = await fixture(true);
		const tip = await f.commit();
		await f.git("merge", "--ff-only", branch);
		await expect(f.cleanup()).rejects.toThrow("1 unpushed commit(s)");
		expect(await f.workGit("rev-parse", "HEAD")).toBe(tip);
	});

	it("refuses cleanup without any remote evidence", async () => {
		const f = await fixture();
		await expect(f.cleanup()).rejects.toThrow("no configured Git remote");
	});

	it("refuses unpushed commits inherited from the acquisition base", async () => {
		const f = await fixture(true, true);
		await expect(f.cleanup()).rejects.toThrow("1 unpushed commit(s)");
		expect(await f.workGit("rev-parse", "HEAD")).toBe(f.base);
		expect(await f.marker()).not.toHaveProperty("removalBranchTip");
	});

	it("refuses pushed work that has not merged into the recorded target", async () => {
		const f = await fixture(true);
		await f.commit();
		await f.git("push", "origin", branch);
		await expect(f.cleanup()).rejects.toThrow("has not merged into target main");
		await f.commit();
		await expect(f.cleanup()).rejects.toThrow("1 unpushed commit(s)");
	});

	it("refreshes and prunes remote evidence before allowing deletion", async () => {
		const f = await fixture(true);
		await f.commit();
		await f.git("push", "origin", branch);
		await f.git("merge", "--ff-only", branch);
		await exec("git", ["update-ref", "-d", `refs/heads/${branch}`], { cwd: f.remotePath });
		await expect(f.cleanup()).rejects.toThrow("1 unpushed commit(s)");
	});

	it("fails closed when remote verification is unavailable", async () => {
		const f = await fixture(true);
		await f.commit();
		await f.git("push", "origin", branch);
		await f.git("merge", "--ff-only", branch);
		await f.git("remote", "set-url", "origin", join(f.directory, "missing.git"));
		await expect(f.cleanup()).rejects.toThrow("refreshing remote refs failed");
		expect(await f.marker()).not.toHaveProperty("removalBranchTip");
	});

	it("does not trust stale remote refs excluded by a changed fetchspec", async () => {
		const f = await fixture(true);
		await f.commit();
		await f.git("push", "origin", branch);
		await f.git("merge", "--ff-only", branch);
		await f.git("config", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/main");
		await f.git("config", "remote.origin.skipFetchAll", "true");
		await exec("git", ["update-ref", "-d", `refs/heads/${branch}`], { cwd: f.remotePath });
		await expect(f.cleanup()).rejects.toThrow("1 unpushed commit(s)");
	});

	it("refuses an unavailable merge target", async () => {
		const f = await fixture(true);
		await expect(
			f.binding.cleanup(f.workspace, branch, {
				targetBranch: "missing",
				targetRevision: "f".repeat(40),
			}),
		).rejects.toThrow("merge state against target missing could not be verified");
	});

	it("rechecks workspace identity after remote verification", async () => {
		const f = await fixture(true);
		await f.commit();
		await f.git("merge", "--ff-only", branch);
		await f.git("push", "origin", "main");
		const uploadPack = join(f.directory, "switch-workspace.sh");
		await writeFile(
			uploadPack,
			'#!/bin/sh\ngit -C "$STE_TEST_WORKSPACE" switch -q foreign\nexec git-upload-pack "$@"\n',
			{ mode: 0o700 },
		);
		await f.git("branch", "foreign", branch);
		await f.git(
			"config",
			"remote.origin.uploadpack",
			`STE_TEST_WORKSPACE='${f.workspace.path.replaceAll("'", "'\\''")}' '${uploadPack.replaceAll("'", "'\\''")}'`,
		);
		await expect(f.cleanup()).rejects.toThrow("on foreign, not stepstone/alpha");
		expect(await f.workGit("branch", "--show-current")).toBe("foreign");
		expect(await f.git("branch", "--list", branch)).toContain(branch);
		expect(await f.marker()).not.toHaveProperty("removalBranchTip");
	});

	it("removes pushed, merged work even after the remote feature branch is deleted", async () => {
		const f = await fixture(true);
		await f.commit();
		await f.git("merge", "--ff-only", branch);
		await f.git("push", "origin", "main");
		await f.cleanup();
		await expect(readFile(join(f.workspace.path, "seed"))).rejects.toMatchObject({ code: "ENOENT" });
		expect(await f.git("branch", "--list", branch)).toBe("");
		await expect(f.cleanup()).resolves.toBeUndefined();
	});

	it("cleans an unchanged workspace with verified pushed and merged history", async () => {
		const f = await fixture(true);
		await f.cleanup();
		expect(await f.marker()).toHaveProperty("removedAt");
	});

	it("only exempts the authenticated and unchanged ignored handoff", async () => {
		const f = await fixture(true);
		const content = "# Prepared goal\n";
		const receipt: DispatchGoalFile = {
			path: DISPATCH_GOAL_FILE,
			sha256: createHash("sha256").update(content).digest("hex"),
			ownershipId: randomUUID(),
			state: "pending",
		};
		receipt.backing = await f.binding.createGoalFileBacking(f.workspace, receipt, content);
		await f.binding.writeGoalFile(f.workspace, receipt, content);
		await writeFile(join(f.workspace.path, receipt.path), "operator edits\n");
		await expect(
			f.binding.cleanup(f.workspace, branch, {
				targetBranch: "main",
				targetRevision: f.base,
				goalFile: receipt,
			}),
		).rejects.toThrow("handoff has uncommitted changes");
		await writeFile(join(f.workspace.path, receipt.path), content);
		await f.binding.cleanup(f.workspace, branch, {
			targetBranch: "main",
			targetRevision: f.base,
			goalFile: receipt,
		});
		expect(await f.marker()).toHaveProperty("removedAt");
	});

	it.each(["MERGE_HEAD", "rebase-merge"])(
		"refuses in-progress Git operation %s even with a clean index",
		async (operation) => {
			const f = await fixture();
			const path = join(f.workspace.metadata.gitdir, operation);
			if (operation === "rebase-merge") await mkdir(path);
			else await writeFile(path, `${f.base}\n`);
			await expect(f.cleanup()).rejects.toThrow(`Git operation is in progress (${operation})`);
		},
	);

	it.each(["--assume-unchanged", "--skip-worktree"])("refuses hidden edits under %s", async (flag) => {
		const f = await fixture();
		await f.workGit("update-index", flag, "seed");
		await writeFile(join(f.workspace.path, "seed"), "hidden operator edits\n");
		await expect(f.cleanup()).rejects.toThrow("index flags prevent verifying local changes");
	});

	it("requires a fresh override after an interrupted destructive cleanup", async () => {
		const f = await fixture();
		await writeFile(join(f.workspace.path, "seed"), "operator edits\n");
		await f.git("worktree", "lock", f.workspace.path);
		await expect(f.cleanup(true)).rejects.toThrow();
		expect(await f.marker()).toHaveProperty("branchDeletedAt");
		expect(await f.workGit("rev-parse", "HEAD")).toBe(f.base);
		await f.git("worktree", "unlock", f.workspace.path);
		await expect(f.cleanup()).rejects.toThrow("uncommitted");
		await f.cleanup(true);
		expect(await f.marker()).toHaveProperty("removedAt");
	});

	it("rechecks safety and resumes a safe interrupted branch deletion", async () => {
		const f = await fixture(true);
		await f.git("worktree", "lock", f.workspace.path);
		await expect(f.cleanup()).rejects.toThrow();
		await f.git("worktree", "unlock", f.workspace.path);
		await writeFile(join(f.workspace.path, "new-work"), "preserve me");
		await expect(f.cleanup()).rejects.toThrow("uncommitted");
		await rm(join(f.workspace.path, "new-work"));
		await f.cleanup();
		expect(await f.marker()).toHaveProperty("removedAt");
	});

	it("allows explicit destructive cleanup of dirty, unpushed and unmerged work", async () => {
		const f = await fixture();
		await f.commit();
		await writeFile(join(f.workspace.path, "seed"), "discarded edits\n");
		await writeFile(join(f.workspace.path, "ignored"), "discarded ignored file\n");
		await f.cleanup(true);
		expect(await f.git("branch", "--list", branch)).toBe("");
		expect(await f.marker()).toHaveProperty("removedAt");
	});

	it.each(["owner", "branch", "path", "marker", "detached", "recreated"])(
		"preserves %s identity checks under override",
		async (kind) => {
			const f = await fixture(kind === "recreated");
			if (kind === "owner")
				await writeFile(
					join(f.workspace.metadata.gitdir, "stepstone-dispatch-owner.json"),
					JSON.stringify({ marker: randomUUID() }),
				);
			if (kind === "branch") await f.workGit("switch", "-c", "foreign");
			if (kind === "path") f.workspace.path = f.root;
			if (kind === "marker") f.workspace.metadata.marker = randomUUID();
			if (kind === "detached") await f.workGit("checkout", "--detach");
			if (kind === "recreated") {
				await f.git("worktree", "lock", f.workspace.path);
				await expect(f.cleanup()).rejects.toThrow();
				await f.git("worktree", "unlock", f.workspace.path);
				await f.git("branch", branch, f.base);
			}
			await expect(f.cleanup(true)).rejects.toThrow();
			expect(await readFile(join(f.workspace.path, "seed"), "utf8")).toBe("seed\n");
		},
	);
});

describe("cleanup operator flow", () => {
	let cli: string;
	beforeAll(async () => {
		cli = join(await compileWorkspaceFixture("cleanup-cli"), "src/cli.js");
	});

	it.each([false, true])(
		"reports refusals and requires an explicit override (force=%s)",
		{ timeout: 30_000 },
		async (force) => {
			const f = await fixture(true);
			// Start through the public CLI, which owns a separate workspace receipt.
			await f.cleanup();
			await mkdir(join(f.root, ".worklist"));
			await writeFile(
				join(f.root, ".worklist", "worklist.json"),
				JSON.stringify({ version: 1, revision: 0, goals: [goal], retiredIds: [] }),
			);
			const run = async (...args: string[]) =>
				(
					await exec(process.execPath, [cli, "project", "workspace", ...args, "--cwd", f.root], {
						cwd: f.root,
					})
				).stdout;
			const start = JSON.parse(
				await run("start", "--goal", "alpha", "--workspace-parent", f.directory, "--json"),
			).result;
			await expect(run("cleanup", start.id, "alpha", "--force")).rejects.toThrow("still has custody");
			await writeFile(join(f.workspace.path, "seed"), "operator edits\n");
			const release = JSON.parse(await run("recover", start.id, "alpha", "--release", "--json")).result;
			expect(release.entries.alpha).toMatchObject({
				phase: "cleanup-pending",
				message: expect.stringContaining("uncommitted tracked changes"),
				workspace: f.workspace.path,
			});
			expect(await run("cleanup", start.id, "alpha")).toContain(
				"cleanup-pending: Workspace cleanup is pending: Refusing cleanup",
			);
			const status = JSON.parse(await run("status", start.id, "--json")).result[0];
			expect(status.entries.alpha.message).toBe(release.entries.alpha.message);
			const inspection = JSON.parse(await run("inspect", start.id, "alpha", "--json")).result;
			expect(inspection.goal.message).toBe(release.entries.alpha.message);
			await expect(run("cleanup", start.id, "--force")).rejects.toThrow("requires an explicit goal ID");
			await expect(run("recover", start.id, "alpha", "--release", "--force")).rejects.toThrow(
				"--force is not valid for project workspace recover",
			);
			await expect(run("resume", start.id, "--force")).rejects.toThrow(
				"--force is not valid for project workspace resume",
			);
			if (!force) await writeFile(join(f.workspace.path, "seed"), "seed\n");
			const cleaned = JSON.parse(
				await run("cleanup", start.id, "alpha", ...(force ? ["--force"] : []), "--json"),
			).result;
			expect(cleaned.entries.alpha.phase).toBe("cleaned");
			expect(cleaned.entries.alpha.workspace).toBeUndefined();
			expect(cleaned.entries.alpha.message.includes("Explicit destructive cleanup override used")).toBe(
				force,
			);
			await expect(readFile(join(f.workspace.path, DISPATCH_GOAL_FILE))).rejects.toMatchObject({
				code: "ENOENT",
			});
			const removed = JSON.parse(await run("cleanup", start.id, "--json"));
			expect(removed.result).toEqual({ removedRunId: start.id });
		},
	);
});
