import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { GitHubMergeEvidenceBinding, GitWorktreeBinding } from "../src/dispatch-bindings.ts";

const exec = promisify(execFile);

it("keeps target evidence isolated when another fetch replaces FETCH_HEAD", async () => {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "stepstone-target-")));
	const root = join(directory, "repo");
	const remote = join(directory, "remote.git");
	const bin = join(directory, "bin");
	const originalPath = process.env.PATH;
	const gitPath = (await exec("which", ["git"])).stdout.trim();
	const git = async (...args: string[]) => (await exec(gitPath, args, { cwd: root })).stdout.trim();
	try {
		await mkdir(root);
		await mkdir(bin);
		await git("init", "-q", "-b", "main");
		await git("config", "user.name", "Stepstone Test");
		await git("config", "user.email", "stepstone@example.test");
		await git("commit", "--allow-empty", "-qm", "base");
		const base = await git("rev-parse", "HEAD");
		await git("init", "--bare", "-q", remote);
		await git("remote", "add", "origin", remote);
		await git("push", "origin", "main");
		await git("switch", "-qc", "release");
		await git("commit", "--allow-empty", "-qm", "release only");
		const release = await git("rev-parse", "HEAD");
		await git("push", "origin", "release");

		// Run real Git, then interleave another target fetch before the caller continues.
		const shim = join(bin, "git.mjs");
		await writeFile(
			shim,
			`import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
const result = spawnSync(${JSON.stringify(gitPath)}, args, { stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 1);
if (args[0] === "fetch") {
  const other = spawnSync(${JSON.stringify(gitPath)}, ["fetch", "--no-tags", "origin", "refs/heads/release"], { stdio: "inherit" });
  if (other.status !== 0) process.exit(other.status ?? 1);
}
`,
		);
		await writeFile(join(bin, "git"), `#!/bin/sh\nexec "${process.execPath}" "${shim}" "$@"\n`);
		await chmod(join(bin, "git"), 0o755);
		process.env.PATH = `${bin}:${originalPath}`;
		const binding = new GitHubMergeEvidenceBinding(root);
		const selectionRef = "refs/stepstone-dispatch/selections/target-test/alpha";
		const evidence = {
			url: "https://example.test/pull/1",
			headBranch: "stepstone/run/alpha",
			baseBranch: "main",
			createdAt: "2026-01-01T00:00:00.000Z",
			mergedAt: "2026-01-02T00:00:00.000Z",
			mergeCommit: base,
		};
		await expect(binding.syncTarget(evidence, "../another-run", selectionRef)).rejects.toThrow(
			"Invalid dispatch run ID",
		);
		expect(await binding.syncTarget(evidence, "target-test", selectionRef)).toBe(base);
		expect(await git("rev-parse", "FETCH_HEAD")).toBe(release);
		await expect(
			binding.syncTarget({ ...evidence, mergeCommit: release }, "target-test", selectionRef),
		).rejects.toThrow("not reachable from updated target main");
		expect(await git("for-each-ref", "--format=%(refname)", "refs/stepstone-dispatch/target/")).toBe("");
		const custodyRef = `refs/stepstone-dispatch/targets/target-test/${base}`;
		expect(await git("rev-parse", custodyRef)).toBe(base);
		expect(await binding.syncTarget(evidence, "target-test", selectionRef)).toBe(base);
		await binding.verifyTarget(evidence, { ref: custodyRef, revision: base }, "target-test");
		await expect(
			binding.verifyTarget(
				{ ...evidence, mergeCommit: release },
				{ ref: custodyRef, revision: base },
				"target-test",
			),
		).rejects.toThrow();
		await expect(
			binding.verifyTarget(evidence, { ref: custodyRef, revision: base }, "other-run"),
		).rejects.toThrow("Target ref custody changed");
		await git("update-ref", custodyRef, release, base);
		await expect(
			binding.verifyTarget(evidence, { ref: custodyRef, revision: base }, "target-test"),
		).rejects.toThrow("Target ref custody changed");
		await expect(binding.syncTarget(evidence, "target-test", selectionRef)).rejects.toThrow(
			"Target ref custody changed",
		);
		const workspaceBinding = new GitWorktreeBinding(root, directory);
		await expect(
			workspaceBinding.acquire(
				{
					id: "alpha",
					title: "Alpha",
					description: "",
					status: "open",
					createdAt: evidence.createdAt,
					updatedAt: evidence.createdAt,
				},
				"stepstone/target-test/alpha",
				base,
				custodyRef,
			),
		).rejects.toThrow("Target ref custody changed");
		expect(await git("branch", "--show-current")).toBe("release");
		expect(await git("rev-parse", "HEAD")).toBe(release);
	} finally {
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
		await rm(directory, { recursive: true, force: true });
	}
});
