import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { FileDispatchStateStore } from "../src/dispatch-bindings.ts";
import { type DispatchRun, dispatchBaseRef, dispatchTargetRef } from "../src/dispatch-driver.ts";

const exec = promisify(execFile);

async function fixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "stepstone-custody-")));
	const git = async (...args: string[]) => (await exec("git", args, { cwd: root })).stdout.trim();
	await git("init", "-q", "-b", "main");
	await git("config", "user.name", "Stepstone Test");
	await git("config", "user.email", "stepstone@example.test");
	await git("commit", "--allow-empty", "-qm", "base");
	const base = await git("rev-parse", "HEAD");
	const directory = join(root, ".git", "stepstone-dispatch");
	const run: DispatchRun = {
		version: 2,
		id: "custody-run",
		repositoryRoot: root,
		approvedGoalIds: ["alpha"],
		maxParallel: 1,
		baseRef: "main",
		baseRevision: base,
		baseCustodyRef: dispatchBaseRef("custody-run", base),
		targetBranch: "main",
		targetRevision: base,
		workspaceConfig: {},
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		entries: {},
	};
	return { root, git, directory, run, base, store: new FileDispatchStateStore(directory, root) };
}

class InterruptedStore extends FileDispatchStateStore {
	fault = "";
	override async write(run: DispatchRun): Promise<void> {
		if (this.fault === "creation-before") throw new Error("interrupted creation");
		await super.write(run);
		if (this.fault === "creation-after" || (this.fault === "removal-intent" && run.custodyRemoval))
			throw new Error("interrupted write");
	}
	override async removeRunFile(run: DispatchRun): Promise<void> {
		if (this.fault === "removal-refs") throw new Error("interrupted removal");
		await super.removeRunFile(run);
		if (this.fault === "removal-file") throw new Error("interrupted removal");
	}
}

it.each(["creation-before", "creation-after"])(
	"recovers the Git creation journal after %s",
	async (fault) => {
		const f = await fixture();
		try {
			const interrupted = new InterruptedStore(f.directory, f.root);
			interrupted.fault = fault;
			await expect(interrupted.create(f.run)).rejects.toThrow("interrupted");
			expect(await f.store.load(f.run.id)).toEqual(f.run);
			expect(await f.store.list()).toEqual([f.run]);
			if (fault === "creation-before")
				await expect(readFile(join(f.directory, `${f.run.id}.json`))).rejects.toMatchObject({
					code: "ENOENT",
				});
			await f.store.save(f.run);
			expect(await f.git("for-each-ref", "--format=%(refname)", "refs/stepstone-dispatch/creations/")).toBe(
				"",
			);
			await expect(f.store.create(f.run)).rejects.toThrow("already exists");
			await f.store.remove(f.run.id);
			expect(await f.store.list()).toEqual([]);
		} finally {
			await rm(f.root, { recursive: true, force: true });
		}
	},
);

it.each(["removal-intent", "removal-refs", "removal-file"])(
	"recovers the removal journal after %s",
	async (fault) => {
		const f = await fixture();
		try {
			await f.store.create(f.run);
			const targetRef = dispatchTargetRef(f.run.id, f.base);
			await f.git("update-ref", targetRef, f.base, "");
			f.run.targetRef = targetRef;
			await f.store.save(f.run);
			const interrupted = new InterruptedStore(f.directory, f.root);
			interrupted.fault = fault;
			await expect(interrupted.remove(f.run.id)).rejects.toThrow("interrupted");
			const pending = await f.store.load(f.run.id);
			expect(pending.custodyRemoval?.refs).toHaveLength(2);
			expect(await f.store.list()).toEqual([pending]);
			await expect(f.store.save(pending)).rejects.toThrow("Run removal has started");
			if (fault === "removal-intent") {
				await f.git("update-ref", "-d", targetRef, f.base);
				await expect(f.store.remove(f.run.id)).rejects.toThrow("custody changed");
				await f.git("update-ref", targetRef, f.base, "");
			} else {
				await f.git("update-ref", targetRef, f.base, "");
				await expect(f.store.remove(f.run.id)).rejects.toThrow("reappeared");
				await f.git("update-ref", "-d", targetRef, f.base);
			}
			await f.store.remove(f.run.id);
			expect(await f.store.list()).toEqual([]);
			expect(await f.git("for-each-ref", "--format=%(refname)", "refs/stepstone-dispatch/")).toBe("");
		} finally {
			await rm(f.root, { recursive: true, force: true });
		}
	},
);

it("refuses missing or symbolic custody and invalid removal journals", async () => {
	const f = await fixture();
	try {
		await f.store.create(f.run);
		const ref = f.run.baseCustodyRef as string;
		await f.git("update-ref", "-d", ref, f.base);
		await expect(f.store.remove(f.run.id)).rejects.toThrow("custody changed");
		await f.git("symbolic-ref", ref, "refs/heads/main");
		await expect(f.store.remove(f.run.id)).rejects.toThrow("custody changed");
		await f.git("symbolic-ref", "--delete", ref);
		await f.git("update-ref", ref, f.base, "");
		const invalid = {
			...f.run,
			custodyRemoval: {
				ref: `refs/stepstone-dispatch/removals/${f.run.id}`,
				revision: f.base,
				refs: [{ ref: "refs/heads/main", revision: f.base }],
			},
		};
		await expect(f.store.save(invalid)).rejects.toThrow("invalid custody removal receipts");
		expect(await f.store.load(f.run.id)).toEqual(f.run);
		await f.store.remove(f.run.id);
		expect(await f.git("rev-parse", "main")).toBe(f.base);
	} finally {
		await rm(f.root, { recursive: true, force: true });
	}
});
