import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { DISPATCH_GOAL_FILE } from "../src/dispatch-driver.ts";
import { branch, compileProcessBoundaryRunner, withProcessBoundary } from "./fixtures/process-boundary.ts";

beforeAll(compileProcessBoundaryRunner);

// Deep binding/process cases. Packed executable and Pi RPC workflows live in
// their own tiers; this suite never replaces git, gh, or an application binding.
describe("real preparation process boundaries", () => {
	it("prepares and claims the exact real worktree, then releases and removes its receipts", async () => {
		await withProcessBoundary(async (f) => {
			const prepared = await f.prepare();
			const entry = prepared.entries.alpha;
			expect(entry.phase).toBe("prepared");
			expect(await f.workGit("branch", "--show-current")).toBe(branch);
			expect(await f.workGit("rev-parse", "HEAD")).toBe(f.base);
			expect(await f.workGit("status", "--porcelain")).toBe("");
			expect(await f.workGit("check-ignore", DISPATCH_GOAL_FILE)).toBe(DISPATCH_GOAL_FILE);
			expect(await readFile(join(f.workspace, DISPATCH_GOAL_FILE), "utf8")).toContain("Alpha boundary goal");
			expect((await f.read()).goals[0]).toMatchObject({
				branch,
				status: "open",
				updatedAt: entry.claimUpdatedAt,
			});
			expect((await f.run("load", prepared.id)).entries.alpha).toEqual(entry);
			await expect(f.run("cleanup", prepared.id, "alpha")).rejects.toMatchObject({
				stderr: expect.stringContaining("still has custody"),
			});
			const released = await f.run("recover", prepared.id);
			expect(released.entries.alpha.phase).toBe("cleaned");
			expect((await f.read()).goals[0]).toMatchObject({
				status: "open",
				updatedAt: released.entries.alpha.releaseUpdatedAt,
			});
			expect((await f.read()).goals[0].branch).toBeUndefined();
			await expect(readFile(join(f.workspace, "seed"))).rejects.toMatchObject({ code: "ENOENT" });
			expect(await f.git("branch", "--list", branch)).toBe("");
			await f.run("cleanup", prepared.id);
			await expect(f.run("load", prepared.id)).rejects.toMatchObject({
				stderr: expect.stringContaining("ENOENT"),
			});
			await expect(
				readFile(
					join(f.root, ".git/stepstone-dispatch/workspaces", `${entry.workspace?.metadata.marker}.json`),
				),
			).rejects.toMatchObject({ code: "ENOENT" });
		});
	});

	it.each(["branch", "path"])(
		"preserves a real Git acquisition refusal caused by an existing %s",
		async (collision) => {
			await withProcessBoundary(async (f) => {
				if (collision === "branch") await f.git("branch", branch);
				else {
					await mkdir(f.workspace);
					await writeFile(join(f.workspace, "foreign"), "preserve me");
				}
				const refused = await f.prepare();
				const failure = refused.entries.alpha.preparationFailure;
				expect(failure).toMatchObject({
					stage: "workspace-acquisition",
					classification: "ambiguous",
					message: expect.stringMatching(/git failed with exit code [1-9][0-9]*/),
				});
				expect((await f.read()).goals[0]).not.toHaveProperty("branch");
				expect((await f.run("advance", refused.id)).entries.alpha.preparationFailure).toEqual(failure);
				await expect(f.run("recover", refused.id)).rejects.toMatchObject({
					stderr: expect.stringContaining("no exact claim token"),
				});
				if (collision === "branch") expect(await f.git("rev-parse", branch)).toBe(f.base);
				else expect(await readFile(join(f.workspace, "foreign"), "utf8")).toBe("preserve me");
				expect(await f.trace()).toContain("already exists");
			});
		},
	);

	it("preserves an actual optimistic claim conflict and the competing operator claim", async () => {
		await withProcessBoundary(async (f) => {
			const refused = await f.prepare("competing-claim");
			const failure = refused.entries.alpha.preparationFailure;
			expect(failure).toMatchObject({
				stage: "roadmap-claim",
				classification: "refused",
				error: { code: "CONFLICT" },
			});
			const canonical = (await f.read()).goals[0];
			expect(canonical.branch).toBe("operator/alpha");
			const resumed = await f.run("advance", refused.id);
			expect(resumed.entries.alpha).toMatchObject({ phase: "ambiguous", preparationFailure: failure });
			await expect(f.run("recover", refused.id, canonical.updatedAt)).rejects.toMatchObject({
				stderr: expect.stringContaining("does not match"),
			});
			expect((await f.read()).goals[0]).toEqual(canonical);
			expect(await f.workGit("branch", "--show-current")).toBe(branch);
		});
	});

	it("recovers a lost claim response and interrupted Git removal without losing original failure evidence", async () => {
		await withProcessBoundary(async (f) => {
			const run = await f.run("create", f.base);
			await expect(f.run("advance", run.id, "", "lose-claim-response")).rejects.toMatchObject({ code: 86 });
			expect((await f.run("load", run.id)).entries.alpha).toMatchObject({ phase: "claiming" });
			const token = (await f.read()).goals[0].updatedAt;
			const resumed = await f.run("advance", run.id);
			const failure = resumed.entries.alpha.preparationFailure;
			expect(failure).toMatchObject({
				stage: "roadmap-claim",
				classification: "ambiguous",
				message: expect.stringContaining("exact returned token was not journaled"),
			});
			await expect(f.run("recover", run.id)).rejects.toMatchObject({
				stderr: expect.stringContaining("no exact claim token"),
			});
			await expect(f.run("recover", run.id, "2026-02-01T00:00:00.000Z")).rejects.toMatchObject({
				stderr: expect.stringContaining("does not match"),
			});
			await f.git("worktree", "lock", f.workspace);
			const pending = await f.run("recover", run.id, token);
			expect(pending.entries.alpha).toMatchObject({
				phase: "cleanup-pending",
				preparationFailure: failure,
				message: expect.stringContaining("git failed"),
			});
			expect((await f.read()).goals[0].branch).toBeUndefined();
			expect(await f.workGit("rev-parse", "HEAD")).toBe(f.base);
			await f.git("worktree", "unlock", f.workspace);
			await writeFile(join(f.workspace, "operator-work"), "preserve across retry");
			const refused = await f.run("cleanup", run.id, "alpha");
			expect(refused.entries.alpha).toMatchObject({
				phase: "cleanup-pending",
				preparationFailure: failure,
				message: expect.stringContaining("uncommitted"),
			});
			expect(await readFile(join(f.workspace, "operator-work"), "utf8")).toBe("preserve across retry");
			await rm(join(f.workspace, "operator-work"));
			const cleaned = await f.run("cleanup", run.id, "alpha");
			expect(cleaned.entries.alpha).toMatchObject({ phase: "cleaned", preparationFailure: failure });
			expect((await f.run("load", run.id)).entries.alpha.preparationFailure).toEqual(failure);
			expect(await f.git("branch", "--list", branch)).toBe("");
		});
	});
});

describe("real GitHub CLI reconciliation", () => {
	it("filters stale and mismatched PRs, then fetches, fast-forwards, completes and cleans an exact merge", async () => {
		await withProcessBoundary(async (f) => {
			const run = await f.prepare();
			const token = run.entries.alpha.claimUpdatedAt as string;
			await writeFile(join(f.workspace, "result"), "merged work\n");
			await f.workGit("add", "result");
			await f.workGit("commit", "-qm", "finish alpha");
			const tip = await f.workGit("rev-parse", "HEAD");
			await f.workGit("push", "origin", `${branch}:main`);
			const exact = f.pr(token, tip);
			f.pullRequests = [
				{ ...exact, headRefName: "other" },
				{ ...exact, baseRefName: "other" },
				{ ...exact, createdAt: "2020-01-01T00:00:00Z" },
				{ ...exact, mergedAt: "2020-01-01T00:00:00Z" },
			];
			const waiting = await f.run("advance", run.id);
			expect(waiting.entries.alpha.phase).toBe("prepared");
			expect((await f.read()).goals[0].updatedAt).toBe(token);
			expect(await f.git("rev-parse", "HEAD")).toBe(f.base);
			f.pullRequests.push(exact);
			const completed = await f.run("advance", run.id);
			expect(completed.entries.alpha).toMatchObject({
				phase: "cleaned",
				mergedPr: { mergeCommit: tip, url: exact.url },
			});
			expect((await f.read()).goals[0]).toMatchObject({
				status: "done",
				updatedAt: completed.entries.alpha.completionUpdatedAt,
			});
			expect(await f.git("rev-parse", "HEAD")).toBe(tip);
			expect(await f.git("branch", "--list", branch)).toBe("");
			expect(f.requests).toHaveLength(2);
			for (const request of f.requests) {
				expect(request).toMatchObject({ method: "POST", url: "/graphql", authenticated: false });
				expect(JSON.parse(request.body).variables).toMatchObject({
					owner: "fixture",
					repo: "stepstone",
					headBranch: branch,
					baseBranch: "main",
					state: ["MERGED"],
					limit: 20,
				});
			}
		});
	});

	it.each(["http", "graphql", "malformed", "invalid-evidence"] as const)(
		"preserves custody after %s failure from the real gh boundary and retries successfully",
		async (failure) => {
			await withProcessBoundary(async (f) => {
				const run = await f.prepare();
				const original = (await f.read()).goals[0];
				if (failure === "invalid-evidence")
					f.pullRequests = [{ ...f.pr(original.updatedAt), mergeCommit: null }];
				else f.apiFailure = failure;
				const refused = await f.run("advance", run.id);
				expect(refused.entries.alpha).toMatchObject({
					phase: "ambiguous",
					claimUpdatedAt: original.updatedAt,
					message: expect.stringContaining("Merge inspection failed; prepared claim preserved"),
				});
				expect((await f.read()).goals[0]).toEqual(original);
				expect(await f.workGit("rev-parse", "HEAD")).toBe(f.base);
				expect(f.requests).toHaveLength(1);
				f.apiFailure = undefined;
				f.pullRequests = [f.pr(original.updatedAt)];
				const retried = await f.run("advance", run.id);
				expect(retried.entries.alpha.phase).toBe("cleaned");
				expect((await f.read()).goals[0].status).toBe("done");
			});
		},
	);

	it.each(["unreachable", "diverged", "fetch"])(
		"refuses completion when real Git target synchronization is %s",
		async (failure) => {
			await withProcessBoundary(async (f) => {
				const run = await f.prepare();
				const original = (await f.read()).goals[0];
				await f.workGit("commit", "--allow-empty", "-qm", "feature");
				const tip = await f.workGit("rev-parse", "HEAD");
				f.pullRequests = [f.pr(original.updatedAt, tip)];
				if (failure === "diverged") {
					await f.workGit("push", "origin", `${branch}:main`);
					await f.git("commit", "--allow-empty", "-qm", "local divergence");
				}
				if (failure === "fetch") await f.git("remote", "set-url", "origin", join(f.directory, "missing.git"));
				const before = await f.git("rev-parse", "HEAD");
				const refused = await f.run("advance", run.id);
				expect(refused.entries.alpha).toMatchObject({
					phase: "ambiguous",
					message: expect.stringContaining("Completion failed; prepared claim preserved"),
				});
				expect(refused.entries.alpha).not.toHaveProperty("completionUpdatedAt");
				expect((await f.read()).goals[0]).toEqual(original);
				expect(await f.git("rev-parse", "HEAD")).toBe(before);
				expect(await f.workGit("rev-parse", "HEAD")).toBe(tip);
				if (failure === "unreachable") expect(refused.entries.alpha.message).toContain("not reachable");
				else expect(refused.entries.alpha.message).toContain("git failed");
			});
		},
	);
});
