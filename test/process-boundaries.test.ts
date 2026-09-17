import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { DISPATCH_GOAL_FILE } from "../src/dispatch-driver.ts";
import { branch, compileProcessBoundaryRunner, withProcessBoundary } from "./fixtures/process-boundary.ts";

beforeAll(compileProcessBoundaryRunner);

// Deep binding/process cases. Packed executable and Pi RPC workflows live in
// their own tiers; this suite never replaces git, gh, or an application binding.
describe("real preparation process boundaries", () => {
	it.each(["creation-before-state", "creation-after-state"])(
		"recovers base custody after %s and pruning",
		async (fault) => {
			await withProcessBoundary(async (f) => {
				const tree = await f.git("rev-parse", `${f.base}^{tree}`);
				const base = await f.git("commit-tree", tree, "-p", f.base, "-m", "unreferenced base");
				await expect(f.run("create", base, "", fault)).rejects.toMatchObject({
					code: fault === "creation-before-state" ? 90 : 91,
				});
				await f.git("reflog", "expire", "--expire=all", "--all");
				await f.git("gc", "--prune=now");
				const run = await f.run("load", "boundary-run");
				expect(run.baseRevision).toBe(base);
				expect(await f.git("rev-parse", run.baseCustodyRef as string)).toBe(base);
				expect((await f.workspaceCli("status")).result).toMatchObject([{ id: run.id }]);
				if (fault === "creation-before-state")
					await expect(
						readFile(join(f.root, ".git", "stepstone-dispatch", `${run.id}.json`)),
					).rejects.toMatchObject({ code: "ENOENT" });
				const prepared = await f.run("advance", run.id);
				expect(prepared.entries.alpha.phase).toBe("prepared");
				expect(await f.workGit("rev-parse", "HEAD")).toBe(base);
				await f.git("push", "origin", `${base}:refs/heads/base-backup`);
				await f.run("recover", run.id);
				await f.run("cleanup", run.id);
				expect(await f.git("for-each-ref", "--format=%(refname)", "refs/stepstone-dispatch/")).toBe("");
			});
		},
	);

	it.each(["removal-intent", "removal-refs", "removal-file"])(
		"recovers owned run removal after %s",
		async (fault) => {
			await withProcessBoundary(async (f) => {
				const run = await f.prepare();
				await f.run("recover", run.id);
				await expect(f.run("cleanup", run.id, "", fault)).rejects.toMatchObject({
					code: fault === "removal-intent" ? 92 : fault === "removal-refs" ? 93 : 94,
				});
				const pending = await f.run("load", run.id);
				expect(pending.custodyRemoval).toBeDefined();
				expect((await f.workspaceCli("status")).result).toMatchObject([{ id: run.id }]);
				if (fault === "removal-intent") {
					await f.git("update-ref", "-d", run.baseCustodyRef as string, f.base);
					await expect(f.run("cleanup", run.id)).rejects.toMatchObject({ code: 1 });
					await f.git("update-ref", run.baseCustodyRef as string, f.base, "");
				}
				await f.run("cleanup", run.id);
				expect((await f.workspaceCli("status")).result).toEqual([]);
				expect(await f.git("for-each-ref", "--format=%(refname)", "refs/stepstone-dispatch/")).toBe("");
			});
		},
	);

	it.each(["base", "target", "selection"])(
		"refuses externally missing %s custody before run removal",
		async (kind) => {
			await withProcessBoundary(async (f) => {
				const run = await f.prepare();
				f.pullRequests = [f.pr(run.entries.alpha.claimUpdatedAt as string)];
				const completed = await f.run("advance", run.id);
				expect(completed.entries.alpha.phase).toBe("cleaned");
				const ref = (
					kind === "base"
						? completed.baseCustodyRef
						: kind === "target"
							? completed.entries.alpha.completionTarget?.ref
							: completed.entries.alpha.targetSelection?.ref
				) as string;
				await f.git("update-ref", "-d", ref, f.base);
				await expect(f.run("cleanup", run.id)).rejects.toMatchObject({ code: 1 });
				expect((await f.run("load", run.id)).custodyRemoval).toBeUndefined();
				await f.git("update-ref", ref, f.base, "");
				await f.run("cleanup", run.id);
			});
		},
	);
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
	it("filters stale and mismatched PRs, then fetches, completes and cleans an exact merge", async () => {
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
			expect(await f.git("rev-parse", "HEAD")).toBe(f.base);
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

	it.each(["unreachable", "fetch"])(
		"refuses completion when real Git target synchronization is %s",
		async (failure) => {
			await withProcessBoundary(async (f) => {
				const run = await f.prepare();
				const original = (await f.read()).goals[0];
				await f.workGit("commit", "--allow-empty", "-qm", "feature");
				const tip = await f.workGit("rev-parse", "HEAD");
				f.pullRequests = [f.pr(original.updatedAt, tip)];
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
				await expect(f.workspaceCli("recover", run.id, "alpha", "--release")).rejects.toMatchObject({
					code: 1,
				});
				expect((await f.read()).goals[0]).toEqual(original);
				if (failure === "fetch") await f.git("remote", "set-url", "origin", f.remote);
				await f.workGit("push", "origin", `${branch}:main`);
				const requests = f.requests.length;
				f.apiFailure = "http";
				const completed = await f.run("advance", run.id);
				expect(completed.entries.alpha.phase).toBe("cleaned");
				expect((await f.read()).goals[0].status).toBe("done");
				expect(f.requests).toHaveLength(requests);
				await f.run("cleanup", run.id);
			});
		},
	);

	it.each(["lose-completion-response", "after-completion-intent", "target-before-receipt"])(
		"reuses journaled target custody after target rewrite and %s",
		async (fault) => {
			await withProcessBoundary(async (f) => {
				const run = await f.prepare();
				await f.workGit("commit", "--allow-empty", "-qm", "feature");
				const tip = await f.workGit("rev-parse", "HEAD");
				await f.git("push", "origin", `${tip}:refs/heads/main`, `${tip}:refs/heads/retained-feature`);
				f.pullRequests = [f.pr(run.entries.alpha.claimUpdatedAt as string, tip)];
				await expect(f.run("advance", run.id, "", fault)).rejects.toMatchObject({
					code: fault === "lose-completion-response" ? 88 : fault === "after-completion-intent" ? 89 : 95,
				});
				const interrupted = await f.run("load", run.id);
				if (fault === "target-before-receipt") {
					expect(interrupted.entries.alpha.completionTarget).toBeUndefined();
					expect(await f.git("rev-parse", interrupted.entries.alpha.targetSelection?.ref as string)).toBe(
						tip,
					);
				} else expect(interrupted.entries.alpha.completionTarget?.revision).toBe(tip);
				await f.command("git", ["update-ref", "refs/heads/main", f.base, tip], f.remote);
				await f.git("reflog", "expire", "--expire=all", "--all");
				await f.git("gc", "--prune=now");
				f.apiFailure = "http";
				const requests = f.requests.length;
				const resumed = await f.run("advance", run.id);
				expect(resumed.entries.alpha.phase).toBe("cleaned");
				expect((await f.read()).goals[0].status).toBe("done");
				expect(f.requests).toHaveLength(requests);
				expect(resumed.entries.alpha.completionTarget?.revision).toBe(tip);
				await f.run("cleanup", run.id);
			});
		},
	);

	it("retains exact target custody across restart and pruning until safe run removal", async () => {
		await withProcessBoundary(async (f) => {
			const run = await f.prepare();
			await f.workGit("commit", "--allow-empty", "-qm", "feature");
			const tip = await f.workGit("rev-parse", "HEAD");
			const tree = await f.git("rev-parse", `${tip}^{tree}`);
			const target = await f.git("commit-tree", tree, "-p", tip, "-m", "target tail");
			await f.git("push", "origin", `${target}:refs/heads/main`, `${f.base}:refs/heads/release`);
			await f.git("config", "remote.origin.fetch", "+refs/heads/release:refs/remotes/origin/release");
			await f.git("update-ref", "-d", "refs/remotes/origin/main");
			f.pullRequests = [f.pr(run.entries.alpha.claimUpdatedAt as string, tip)];
			await expect(f.run("advance", run.id, "", "after-completion")).rejects.toMatchObject({ code: 87 });
			const completed = await f.run("load", run.id);
			expect(completed.entries.alpha.phase).toBe("completed");
			expect(completed.targetRevision).toBe(target);
			const targetRef = completed.targetRef as string;
			expect(targetRef).toBe(`refs/stepstone-dispatch/targets/${run.id}/${target}`);
			await f.git("reflog", "expire", "--expire=all", "--all");
			await f.git("gc", "--prune=now");
			expect(await f.git("rev-parse", `${targetRef}^{commit}`)).toBe(target);

			await f.git("update-ref", targetRef, f.base, target);
			const refused = await f.run("cleanup", run.id);
			expect(refused.entries.alpha.phase).toBe("cleanup-pending");
			expect(refused.entries.alpha.message).toContain("Target ref custody changed");
			await f.git("update-ref", targetRef, target, f.base);
			const resumed = await f.run("advance", run.id);
			expect(resumed.entries.alpha.phase).toBe("cleaned");
			expect(await f.git("rev-parse", targetRef)).toBe(target);
			await f.git("update-ref", targetRef, f.base, target);
			await expect(f.run("cleanup", run.id)).rejects.toMatchObject({ code: 1 });
			expect((await f.run("load", run.id)).targetRevision).toBe(target);
			await f.git("update-ref", targetRef, target, f.base);
			await f.run("cleanup", run.id);
			expect(await f.git("for-each-ref", "--format=%(refname)", "refs/stepstone-dispatch/")).toBe("");
			await f.git("reflog", "expire", "--expire=all", "--all");
			await f.git("gc", "--prune=now");
			await expect(f.git("cat-file", "-e", target)).rejects.toMatchObject({ code: 1 });
		});
	});

	it("reconciles the persisted target without changing an unrelated canonical checkout", async () => {
		await withProcessBoundary(async (f) => {
			const run = await f.prepare();
			const original = (await f.read()).goals[0];
			await f.workGit("commit", "--allow-empty", "-qm", "feature");
			const tip = await f.workGit("rev-parse", "HEAD");
			await f.workGit("push", "origin", `${branch}:main`);
			await f.git("switch", "-qc", "integration");
			await f.git("commit", "--allow-empty", "-qm", "unrelated integration work");
			const canonicalTip = await f.git("rev-parse", "HEAD");
			f.pullRequests = [f.pr(original.updatedAt, tip)];

			const completed = await f.run("advance", run.id);

			expect(completed.entries.alpha.phase).toBe("cleaned");
			expect((await f.read()).goals[0].status).toBe("done");
			expect(await f.git("branch", "--show-current")).toBe("integration");
			expect(await f.git("rev-parse", "HEAD")).toBe(canonicalTip);
		});
	});
});

describe("project workspace CLI", () => {
	it("retains an explicit base through ref deletion and pruning for later approved goals", async () => {
		await withProcessBoundary(async (f) => {
			const path = join(f.root, ".worklist", "worklist.json");
			const document = JSON.parse(await readFile(path, "utf8"));
			document.goals.push({ ...document.goals[0], id: "beta", title: "Beta" });
			await writeFile(path, JSON.stringify(document));
			const tree = await f.git("rev-parse", `${f.base}^{tree}`);
			const base = await f.git("commit-tree", tree, "-p", f.base, "-m", "temporary base");
			await f.git("update-ref", "refs/heads/temporary", base);
			await f.git("push", "origin", "temporary:refs/heads/base-backup");
			const started = await f.workspaceCli(
				"start",
				"--goal",
				"alpha",
				"--goal",
				"beta",
				"--base",
				"temporary",
				"--target",
				"main",
				"--workspace-parent",
				f.directory,
			);
			const summary = started.result as { id: string };
			const run = await f.run("load", summary.id);
			expect(run.entries.alpha.phase).toBe("prepared");
			const custodyRef = run.baseCustodyRef as string;
			expect(custodyRef).toBe(`refs/stepstone-dispatch/bases/${run.id}/${base}`);
			await f.workspaceCli("recover", run.id, "alpha", "--release");
			await f.git("update-ref", "-d", "refs/heads/temporary");
			await f.git("update-ref", "-d", "refs/remotes/origin/base-backup");
			await f.git("reflog", "expire", "--expire=all", "--all");
			await f.git("gc", "--prune=now");
			expect(await f.git("rev-parse", `${custodyRef}^{commit}`)).toBe(base);
			const resumed = await f.workspaceCli("resume", run.id);
			expect(resumed.result).toMatchObject({ entries: { beta: { phase: "prepared" } } });
			expect(
				(await f.command("git", ["rev-parse", "HEAD"], join(f.directory, "stepstone-beta"))).stdout.trim(),
			).toBe(base);
			await f.workspaceCli("recover", run.id, "beta", "--release");
			await f.git("update-ref", custodyRef, f.base, base);
			await expect(f.workspaceCli("cleanup", run.id)).rejects.toMatchObject({ code: 1 });
			await f.git("update-ref", custodyRef, base, f.base);
			await f.workspaceCli("cleanup", run.id);
			expect(await f.git("for-each-ref", "--format=%(refname)", "refs/stepstone-dispatch/")).toBe("");
		});
	});
	it("reads existing version 2 custody without rewriting it, refuses version 1, and recovers in place", async () => {
		await withProcessBoundary(async (f) => {
			// The unchanged driver writes the version 2 schema previously owned by the companion bin.
			const prepared = await f.prepare();
			const statePath = join(f.root, ".git/stepstone-dispatch", `${prepared.id}.json`);
			const before = await readFile(statePath, "utf8");
			const status = await f.workspaceCli("status", prepared.id);
			expect(status).toMatchObject({
				ok: true,
				scope: "project",
				action: "workspace status",
				result: [
					{
						id: prepared.id,
						entries: { alpha: { phase: "prepared", claimUpdatedAt: prepared.entries.alpha.claimUpdatedAt } },
					},
				],
				meta: { cliVersion: expect.any(String) },
			});
			const inspection = await f.workspaceCli("inspect", prepared.id, "alpha");
			expect(inspection.result).toMatchObject({ goal: prepared.entries.alpha });
			expect(await readFile(statePath, "utf8")).toBe(before);
			const legacy = JSON.stringify({ ...JSON.parse(before), version: 1, sessionBinding: "process" });
			await writeFile(statePath, legacy);
			await expect(f.workspaceCli("status", prepared.id)).rejects.toMatchObject({
				code: 1,
				stdout: "",
				stderr: expect.stringContaining("expected 2"),
			});
			expect(await readFile(statePath, "utf8")).toBe(legacy);
			await writeFile(statePath, before);
			await expect(f.workspaceCli("recover", prepared.id, "alpha")).rejects.toMatchObject({
				code: 2,
				stderr: expect.stringContaining("--release"),
			});
			expect(await readFile(statePath, "utf8")).toBe(before);
			const released = await f.workspaceCli("recover", prepared.id, "alpha", "--release");
			expect(released.result).toMatchObject({ entries: { alpha: { phase: "cleaned" } } });
			expect((await f.read()).goals[0].branch).toBeUndefined();
			const removed = await f.workspaceCli("cleanup", prepared.id);
			expect(removed.result).toEqual({ removedRunId: prepared.id });
			expect((await f.workspaceCli("status")).result).toEqual([]);
		});
	});

	it("prepares through the CLI and reconciles exact merged work through real Git and gh", async () => {
		await withProcessBoundary(async (f) => {
			const started = await f.workspaceCli(
				"start",
				"--goal",
				"alpha",
				"--workspace-parent",
				f.directory,
				"--max-parallel",
				"1",
			);
			const summary = started.result as {
				id: string;
				entries: { alpha: { branch: string; claimUpdatedAt: string } };
			};
			expect(started.result).toMatchObject({
				pass: { outcome: "prepared" },
				entries: { alpha: { phase: "prepared" } },
			});
			const waiting = await f.workspaceCli("resume", summary.id);
			expect(waiting.result).toMatchObject({
				pass: { outcome: "capacity-full" },
				entries: { alpha: { phase: "prepared", claimUpdatedAt: summary.entries.alpha.claimUpdatedAt } },
			});
			await writeFile(join(f.workspace, "result"), "merged CLI work\n");
			await f.workGit("add", "result");
			await f.workGit("commit", "-qm", "finish alpha");
			const tip = await f.workGit("rev-parse", "HEAD");
			await f.workGit("push", "origin", `${summary.entries.alpha.branch}:main`);
			f.pullRequests = [f.pr(summary.entries.alpha.claimUpdatedAt, tip, summary.entries.alpha.branch)];
			const completed = await f.workspaceCli("resume", summary.id);
			expect(completed.result).toMatchObject({
				entries: { alpha: { phase: "cleaned", mergedPr: { mergeCommit: tip } } },
			});
			expect((await f.read()).goals[0].status).toBe("done");
			expect(await f.git("rev-parse", "HEAD")).toBe(f.base);
			expect(await f.git("branch", "--list", summary.entries.alpha.branch)).toBe("");
			expect((await f.workspaceCli("cleanup", summary.id)).result).toEqual({ removedRunId: summary.id });
			expect(f.requests).toHaveLength(2);
		});
	});

	it("refuses an unavailable explicit base without fetching or creating a run", async () => {
		await withProcessBoundary(async (f) => {
			await expect(
				f.workspaceCli("start", "--goal", "alpha", "--base", "origin/missing", "--target", "main"),
			).rejects.toMatchObject({ code: 1 });
			expect((await f.workspaceCli("status")).result).toEqual([]);
			expect((await f.read()).goals[0].branch).toBeUndefined();
		});
	});

	it.each([
		["status", "--goal", "alpha"],
		["resume", "run", "--max-parallel", "2"],
		["start", "--goal", "alpha", "--force"],
		["status", "--file", "elsewhere.json"],
		["start", "--goal", "alpha", "--max-parallel", "0"],
		["start", "--goal", "alpha", "--max-parallel", "1", "--max-parallel", "2"],
		["start", "--goal", "alpha", "--base", "HEAD", "--base", "main"],
		["start", "--goal", "alpha", "--target", "main", "--target", "release"],
		["start", "--goal", "alpha", "--", "ignored prose"],
		["unknown"],
	])("refuses invalid workspace arguments without creating a run: %j", async (...args) => {
		await withProcessBoundary(async (f) => {
			await expect(f.workspaceCli(...args)).rejects.toMatchObject({ code: 2 });
			expect((await f.workspaceCli("status")).result).toEqual([]);
			expect((await f.read()).goals[0].branch).toBeUndefined();
			expect(await f.git("branch", "--list", branch)).toBe("");
		});
	});
});
