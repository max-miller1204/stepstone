import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WORKLIST_PATH_ENV } from "../src/cli-contract.ts";
import {
	currentGitBranch,
	isTransientGitFailure,
	resolveGitRoot,
	resolveWorklistLocation,
	shadowedWorklistWarning,
} from "../src/git.ts";

describe("git root", () => {
	it("returns a canonical root through a symlink", async () => {
		const root = await mkdtemp(join(tmpdir(), "stepstone-git-"));
		execFileSync("git", ["init", "-q"], { cwd: root });
		const link = `${root}-link`;
		await symlink(root, link);
		const result = resolveGitRoot(link);
		expect(result.root).toBe(await realpath(root));
		expect(result.isGit).toBe(true);
	});

	it("degrades cleanly outside git", async () => {
		const root = await mkdtemp(join(tmpdir(), "stepstone-no-git-"));
		expect(resolveGitRoot(root).isGit).toBe(false);
	});
});

/** A `git` on PATH that answers however the test needs it to, shadowing the real one. */
async function fakeGitOnPath(script: string): Promise<() => void> {
	const bin = await mkdtemp(join(tmpdir(), "stepstone-fake-git-"));
	await writeFile(join(bin, "git"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
	const original = process.env.PATH;
	// Prepended rather than replacing PATH, so the script can still reach the
	// ordinary commands it is written in.
	process.env.PATH = `${bin}:${original ?? ""}`;
	return () => {
		process.env.PATH = original;
	};
}

describe("current branch", () => {
	it("distinguishes a checked-out branch, detached HEAD, and Git failure", async () => {
		const root = await mkdtemp(join(tmpdir(), "stepstone-branch-"));
		const outside = currentGitBranch(root);
		expect(outside.branch).toBeNull();
		expect(outside.error).toMatchObject({ exitCode: expect.any(Number), timedOut: false });
		expect(outside.error?.message).toContain("not a git repository");

		execFileSync("git", ["init", "-q"], { cwd: root });
		execFileSync("git", ["switch", "-q", "-c", "feat/claim"], { cwd: root });
		expect(currentGitBranch(root)).toEqual({ branch: "feat/claim" });

		execFileSync(
			"git",
			[
				"-c",
				"user.email=t@example.com",
				"-c",
				"user.name=Test",
				"commit",
				"-q",
				"--allow-empty",
				"-m",
				"root",
			],
			{
				cwd: root,
			},
		);
		execFileSync("git", ["checkout", "-q", "--detach"], { cwd: root });
		expect(currentGitBranch(root)).toEqual({ branch: null });
	});

	it("keeps whether the lookup was killed or answered, because only one of those is worth retrying", async () => {
		const root = await mkdtemp(join(tmpdir(), "stepstone-branch-classify-"));
		execFileSync("git", ["init", "-q"], { cwd: root });

		// A Git that outlives its time limit never reached a verdict, so the caller
		// is entitled to ask again.
		const restoreSlow = await fakeGitOnPath("sleep 30");
		let killed: ReturnType<typeof currentGitBranch>;
		try {
			killed = currentGitBranch(root, { timeoutMs: 250 });
		} finally {
			restoreSlow();
		}
		expect(killed.branch).toBeNull();
		const killedFailure = killed.error;
		if (!killedFailure) throw new Error("a killed branch lookup reported no failure");
		expect(killedFailure).toMatchObject({ timedOut: true, signal: "SIGTERM" });
		expect(killedFailure.exitCode).toBeUndefined();
		expect(isTransientGitFailure(killedFailure)).toBe(true);

		// A Git too old for the option answers the same way forever: the status it
		// chose is the verdict, and retrying only repeats it.
		const restoreUnsupported = await fakeGitOnPath(
			"printf '%s\\n' \"error: unknown option \\`show-current'\" >&2\nexit 129",
		);
		let unsupported: ReturnType<typeof currentGitBranch>;
		try {
			unsupported = currentGitBranch(root);
		} finally {
			restoreUnsupported();
		}
		const unsupportedFailure = unsupported.error;
		if (!unsupportedFailure) throw new Error("an unsupported option reported no failure");
		expect(unsupportedFailure).toMatchObject({ exitCode: 129, timedOut: false });
		expect(unsupportedFailure.signal).toBeUndefined();
		expect(unsupportedFailure.message).toContain("unknown option");
		expect(isTransientGitFailure(unsupportedFailure)).toBe(false);
	});
});

async function tempRoot(): Promise<string> {
	return mkdtemp(join(tmpdir(), "stepstone-path-"));
}

async function seedWorklist(root: string, directory: string): Promise<string> {
	const path = join(root, directory, "worklist.json");
	await mkdir(join(root, directory), { recursive: true });
	await writeFile(path, `${JSON.stringify({ version: 1, revision: 0, goals: [] }, null, 2)}\n`);
	return path;
}

describe("worklist location", () => {
	it("writes the current path in a repository that has neither file", async () => {
		const root = await tempRoot();
		const location = resolveWorklistLocation(root, { env: {} });
		expect(location).toEqual({
			path: join(root, ".worklist", "worklist.json"),
			source: "default",
			currentPath: join(root, ".worklist", "worklist.json"),
			legacyPath: join(root, ".pi", "worklist.json"),
		});
		expect(shadowedWorklistWarning(location)).toBeUndefined();
	});

	it("keeps using the legacy file when it is the only one, so nothing needs migrating", async () => {
		const root = await tempRoot();
		const legacy = await seedWorklist(root, ".pi");
		const location = resolveWorklistLocation(root, { env: {} });
		expect(location.path).toBe(legacy);
		expect(location.source).toBe("legacy");
		expect(shadowedWorklistWarning(location)).toBeUndefined();
	});

	it("prefers the current file and warns loudly when a populated legacy file is passed over", async () => {
		const root = await tempRoot();
		const legacy = await seedWorklist(root, ".pi");
		const current = await seedWorklist(root, ".worklist");
		const location = resolveWorklistLocation(root, { env: {} });
		expect(location.path).toBe(current);
		expect(location.source).toBe("current");
		expect(location.shadowedPath).toBe(legacy);
		const warning = shadowedWorklistWarning(location);
		expect(warning).toContain(current);
		expect(warning).toContain(legacy);
	});

	it("lets an explicit path outrank both, resolving a relative one from the process directory", async () => {
		const root = await tempRoot();
		await seedWorklist(root, ".pi");
		await seedWorklist(root, ".worklist");
		const absolute = resolveWorklistLocation(root, { override: join(root, "elsewhere.json"), env: {} });
		expect(absolute).toMatchObject({ path: join(root, "elsewhere.json"), source: "override" });
		// An override names one file, so nothing else is in play and there is no
		// second roadmap to warn about.
		expect(absolute.shadowedPath).toBeUndefined();

		const relative = resolveWorklistLocation(root, {
			override: "nested/goals.json",
			env: {},
			overrideBase: root,
		});
		expect(relative.path).toBe(join(root, "nested", "goals.json"));
	});

	it("reads the environment override, which an explicit path still outranks", async () => {
		const root = await tempRoot();
		const fromEnv = join(root, "from-env.json");
		const env = { [WORKLIST_PATH_ENV]: fromEnv };
		expect(resolveWorklistLocation(root, { env })).toMatchObject({ path: fromEnv, source: "override" });
		expect(resolveWorklistLocation(root, { env, override: join(root, "from-flag.json") })).toMatchObject({
			path: join(root, "from-flag.json"),
			source: "override",
		});
	});

	it("ignores a blank override rather than resolving the repository root as a file", async () => {
		const root = await tempRoot();
		const location = resolveWorklistLocation(root, { override: "  ", env: { [WORKLIST_PATH_ENV]: "" } });
		expect(location).toMatchObject({ path: join(root, ".worklist", "worklist.json"), source: "default" });
	});
});
