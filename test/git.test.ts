import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WORKLIST_PATH_ENV } from "../src/cli-contract.ts";
import {
	currentGitBranch,
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

describe("current branch", () => {
	it("names the checked-out branch and answers null when there is none", async () => {
		const root = await mkdtemp(join(tmpdir(), "stepstone-branch-"));
		// Every "no branch to default to" case reads the same to a caller, so the
		// directory outside any repository has to answer null rather than throw.
		expect(currentGitBranch(root)).toBeNull();

		execFileSync("git", ["init", "-q"], { cwd: root });
		execFileSync("git", ["switch", "-q", "-c", "feat/claim"], { cwd: root });
		expect(currentGitBranch(root)).toBe("feat/claim");

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
		expect(currentGitBranch(root)).toBeNull();
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
