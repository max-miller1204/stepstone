import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveGitRoot } from "../src/git.ts";

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
