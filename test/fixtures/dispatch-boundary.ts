// A fresh process for every operation: all application/process bindings are real.
// Only the persistence interruption points below are controlled by the harness.
import {
	ApplicationRoadmapBinding,
	defaultDispatchStateDirectory,
	FileDispatchStateStore,
	GitHubMergeEvidenceBinding,
	GitWorktreeBinding,
} from "../../src/dispatch-bindings.ts";
import { DispatchDriver, type DispatchRun } from "../../src/dispatch-driver.ts";

const [root, parent, action, value, token, fault] = process.argv.slice(2);
if (!root || !parent || !action) throw new Error("root, workspace parent, and action are required");
class InterruptibleRoadmap extends ApplicationRoadmapBinding {
	override async complete(goalId: string, expectedUpdatedAt: string) {
		const result = await super.complete(goalId, expectedUpdatedAt);
		if (fault === "lose-completion-response") process.exit(88);
		return result;
	}
}
const roadmap = new InterruptibleRoadmap(root);
class InterruptibleStore extends FileDispatchStateStore {
	override async write(run: DispatchRun): Promise<void> {
		if (fault === "creation-before-state" && Object.keys(run.entries).length === 0) process.exit(90);
		await super.write(run);
		if (fault === "creation-after-state" && Object.keys(run.entries).length === 0) process.exit(91);
		if (fault === "removal-intent" && run.custodyRemoval) process.exit(92);
	}
	override async removeRunFile(run: DispatchRun): Promise<void> {
		if (fault === "removal-refs") process.exit(93);
		await super.removeRunFile(run);
		if (fault === "removal-file") process.exit(94);
	}
	override async save(run: DispatchRun): Promise<void> {
		const entry = run.entries.alpha;
		if (fault === "lose-claim-response" && entry?.phase === "prepared") {
			process.stderr.write("Boundary fixture exited after canonical claim, before saving its token.\n");
			process.exit(86);
		}
		await super.save(run);
		if (fault === "after-completion-intent" && entry?.completionTarget && !entry.completionUpdatedAt)
			process.exit(89);
		if (fault === "after-completion" && entry?.phase === "completed") {
			process.stderr.write("Boundary fixture exited after completion, before cleanup.\n");
			process.exit(87);
		}
		if (fault === "competing-claim" && entry?.phase === "claiming" && !entry.preparationFailure) {
			await roadmap.claim("alpha", "operator/alpha", entry.goal.updatedAt);
		}
	}
}
class InterruptibleMerges extends GitHubMergeEvidenceBinding {
	override async syncTarget(...args: Parameters<GitHubMergeEvidenceBinding["syncTarget"]>): Promise<string> {
		const revision = await super.syncTarget(...args);
		if (fault === "target-before-receipt") process.exit(95);
		return revision;
	}
}
const store = new InterruptibleStore(await defaultDispatchStateDirectory(root), root);
const driver = new DispatchDriver({
	roadmap,
	workspace: new GitWorktreeBinding(root, parent),
	merges: new InterruptibleMerges(root),
	store,
	id: () => "boundary-run",
});

let result: unknown;
switch (action) {
	case "create":
		result = await driver.create({
			repositoryRoot: root,
			approvedGoalIds: ["alpha"],
			maxParallel: 1,
			baseRef: "main",
			baseRevision: value,
			targetBranch: "main",
			workspaceConfig: { workspaceParent: parent },
		});
		break;
	case "advance":
		result = await driver.advance(value);
		break;
	case "recover":
		result = await driver.recoverRelease(value, "alpha", token || undefined);
		break;
	case "cleanup":
		result = await driver.cleanup(value, token || undefined);
		break;
	case "load":
		result = await store.load(value);
		break;
	case "read":
		result = await roadmap.read();
		break;
	default:
		throw new Error(`Unknown boundary action: ${action}`);
}
process.stdout.write(`${JSON.stringify(result ?? null)}\n`);
