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
const roadmap = new ApplicationRoadmapBinding(root);
class InterruptibleStore extends FileDispatchStateStore {
	override async save(run: DispatchRun): Promise<void> {
		const entry = run.entries.alpha;
		if (fault === "lose-claim-response" && entry?.phase === "prepared") {
			process.stderr.write("Boundary fixture exited after canonical claim, before saving its token.\n");
			process.exit(86);
		}
		await super.save(run);
		if (fault === "competing-claim" && entry?.phase === "claiming" && !entry.preparationFailure) {
			await roadmap.claim("alpha", "operator/alpha", entry.goal.updatedAt);
		}
	}
}
const store = new InterruptibleStore(await defaultDispatchStateDirectory(root));
const driver = new DispatchDriver({
	roadmap,
	workspace: new GitWorktreeBinding(root, parent),
	merges: new GitHubMergeEvidenceBinding(root),
	store,
});

let result: unknown;
switch (action) {
	case "create":
		result = await driver.create({
			repositoryRoot: root,
			approvedGoalIds: ["alpha"],
			maxParallel: 1,
			targetBranch: "main",
			targetRevision: value,
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
