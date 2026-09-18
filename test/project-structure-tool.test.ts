import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { WorklistApplicationService } from "../src/application-service.ts";
import { WorklistParamsSchema } from "../src/schema.ts";
import { executeWorklist } from "../src/tool.ts";

it("exposes organization actions to agents and returns project task identity", async () => {
	const directory = await mkdtemp(join(tmpdir(), "stepstone-foundation-tool-"));
	const deps = { projectPath: join(directory, "project.json") };
	const ctx = {} as ExtensionContext;
	try {
		expect((WorklistParamsSchema.properties.action as unknown as { enum: string[] }).enum).toEqual(
			expect.arrayContaining([
				"structure",
				"configure",
				"add_milestone",
				"update_milestone",
				"assign_milestone",
			]),
		);
		await expect(
			executeWorklist({ scope: "project", action: "configure", title: "Launch" }, ctx, deps),
		).rejects.toThrow();
		const configured = await executeWorklist(
			{ scope: "project", action: "configure", title: "Launch", confirm: true, repositories: [] },
			ctx,
			deps,
		);
		expect(JSON.parse(configured.content).title).toBe("Launch");
		const added = await executeWorklist(
			{ scope: "project", action: "add_milestone", title: "Release" },
			ctx,
			deps,
		);
		const milestoneId = added.details.milestone?.id;
		expect(milestoneId).toBeDefined();
		const task = await executeWorklist({ scope: "project", action: "add", title: "Ship" }, ctx, deps);
		const assigned = await executeWorklist(
			{ scope: "project", action: "assign_milestone", id: task.details.goal?.id, milestoneId },
			ctx,
			deps,
		);
		expect(JSON.parse(assigned.content).milestoneId).toBe(milestoneId);
		await executeWorklist(
			{ scope: "project", action: "update_milestone", id: milestoneId, title: "Public release" },
			ctx,
			deps,
		);
		const structure = await executeWorklist({ scope: "project", action: "structure" }, ctx, deps);
		expect(JSON.parse(structure.content).milestones[0]).toMatchObject({
			id: milestoneId,
			title: "Public release",
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

it.each(["structure", "configure", "add_milestone", "update_milestone", "assign_milestone"])(
	"rejects an incomplete successful %s receipt instead of reporting success",
	async (action) => {
		const applicationService = new WorklistApplicationService({});
		vi.spyOn(applicationService, "execute").mockResolvedValue({
			ok: true,
			scope: "project",
			action,
			result: { scope: "project", action },
			meta: { changed: true, semanticNoOp: false, changedFields: [] },
		});
		await expect(
			executeWorklist({ scope: "project", action }, {} as ExtensionContext, { applicationService }),
		).rejects.toThrow("was not returned");
	},
);
