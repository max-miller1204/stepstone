import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const exec = promisify(execFile);
const cli = resolve("src/cli.ts");

it("configures a standalone project and assigns existing tasks to stable milestones", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "stepstone-foundation-cli-"));
	const path = join(cwd, "project.json");
	async function run(...args: string[]) {
		const result = await exec(process.execPath, [cli, "project", ...args, "--file", path, "--json"], { cwd });
		return JSON.parse(result.stdout);
	}
	try {
		await expect(run("configure", "Launch")).rejects.toMatchObject({ code: 3 });
		const configured = await run(
			"configure",
			"Launch",
			"--confirm",
			"--repository",
			"https://github.com/org/one",
			"--repository",
			"https://github.com/org/two",
		);
		expect(configured.result.project.repositories).toHaveLength(2);
		const task = (await run("add", "Ship the interface")).result.goal;
		const milestone = (
			await run("add_milestone", "Public release", "--description", "People can use the product")
		).result.milestone;
		await run("assign_milestone", task.id, "--milestone", milestone.id);
		const updated = await run("update_milestone", milestone.id, "General release");
		expect(updated.result.milestone.id).toBe(milestone.id);
		const structure = (await run("structure")).result.projectStructure;
		expect(structure.tasks).toEqual([expect.objectContaining({ id: task.id, milestoneId: milestone.id })]);
		await run("assign_milestone", task.id, "--milestone", "");
		expect((await run("show", task.id)).result.goal.milestoneId).toBeUndefined();
		await run("configure", "Launch", "--confirm", "--repository", "");
		expect((await run("structure")).result.projectStructure.project.repositories).toEqual([]);
		const bytes = await readFile(path, "utf8");
		await expect(run("configure", "Stale", "--confirm", "--expect-revision", "0")).rejects.toMatchObject({
			code: 4,
		});
		await expect(
			run("update_milestone", milestone.id, "Stale", "--expect-revision", "0"),
		).rejects.toMatchObject({ code: 4 });
		await expect(
			run(
				"configure",
				"Launch",
				"--confirm",
				"--repository",
				"",
				"--repository",
				"https://github.com/org/one",
			),
		).rejects.toMatchObject({ code: 2 });
		await expect(run("assign_milestone", task.id)).rejects.toMatchObject({ code: 2 });
		await expect(run("structure", "ignored")).rejects.toMatchObject({ code: 2 });
		await expect(run("add_milestone", "Title", "--description", "Text", "trailing")).rejects.toMatchObject({
			code: 2,
		});
		await expect(run("configure", "--confirm")).rejects.toMatchObject({ code: 2 });
		await expect(run("update_milestone", milestone.id)).rejects.toMatchObject({ code: 2 });
		await expect(
			run("assign_milestone", task.id, "--milestone", milestone.id, "--milestone", milestone.id),
		).rejects.toMatchObject({ code: 2 });
		await expect(run("structure", "--repository", "https://example.com/repo")).rejects.toMatchObject({
			code: 2,
		});
		await expect(run("structure", "--cwd", path)).rejects.toMatchObject({ code: 1 });
		await expect(run("structure", "--cwd", join(cwd, "missing"))).rejects.toMatchObject({ code: 1 });
		expect(await readFile(path, "utf8")).toBe(bytes);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
