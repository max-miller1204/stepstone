import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { loadImportWorklist, parseImportWorklist, parseServerImportArgs } from "../../src/service/import.ts";
import { parseCommand } from "../../src/service/protocol.ts";

test("rejects unsupported plan links at the command boundary", () => {
	expect(() =>
		parseCommand({
			version: 1,
			commandId: randomUUID(),
			projectId: randomUUID(),
			expectedRevision: 1,
			operation: {
				action: "apply-plan",
				plan: [{ title: "Linked task", links: ["https://example.com/context"] }],
			},
		}),
	).toThrow();
});

const stamp = "2026-01-02T03:04:05.000Z";
const goal = (id: string, extra: Record<string, unknown> = {}) => ({
	id,
	title: id,
	status: "open",
	createdAt: stamp,
	updatedAt: stamp,
	...extra,
});

test("import arguments name the file, project, and exactly one write mode", () => {
	expect(
		parseServerImportArgs([
			"--actor",
			"oidc:abc",
			"--project",
			"6f0b9b2e-1c4a-4f2e-9c1a-0d5e6f7a8b9c",
			"roadmap.json",
			"--replace",
			"--confirm",
		]),
	).toEqual({
		file: "roadmap.json",
		projectId: "6f0b9b2e-1c4a-4f2e-9c1a-0d5e6f7a8b9c",
		actorId: "oidc:abc",
		replace: true,
		dryRun: false,
	});
	expect(parseServerImportArgs(["roadmap.json", "--project", "p", "--actor", "a", "--dry-run"]).dryRun).toBe(
		true,
	);
	expect(() => parseServerImportArgs(["roadmap.json", "--project", "p", "--actor", "a"])).toThrow(
		"--confirm or --dry-run",
	);
	expect(() =>
		parseServerImportArgs(["roadmap.json", "--project", "p", "--actor", "a", "--confirm", "--dry-run"]),
	).toThrow("--confirm or --dry-run");
	expect(() => parseServerImportArgs(["--project", "--actor", "a", "--confirm"])).toThrow("requires a value");
	expect(() => parseServerImportArgs(["roadmap.json", "other.json", "--confirm"])).toThrow("Unknown import");
	expect(() => parseServerImportArgs(["--confirm"])).toThrow("worklist file");
});

test("import parsing preserves history and refuses identity or dependency collisions", async () => {
	expect(parseImportWorklist({ version: 1, goals: [goal("draft")] }).revision).toBe(0);
	expect(() => parseImportWorklist({ version: 9, goals: [] })).toThrow(/unsupported schema/);
	expect(() =>
		parseImportWorklist({ version: 1, revision: 0, goals: [goal("draft"), goal("draft")] }),
	).toThrow(/Goal ID draft collides/);
	expect(() =>
		parseImportWorklist({
			version: 1,
			revision: 0,
			retiredIds: ["draft"],
			goals: [goal("draft")],
		}),
	).toThrow(/Goal ID draft collides/);
	expect(() =>
		parseImportWorklist({
			version: 1,
			revision: 0,
			goals: [goal("other"), goal("draft", { previousIds: ["other"] })],
		}),
	).toThrow(/Former ID other collides/);
	expect(() =>
		parseImportWorklist({ version: 1, revision: 0, goals: [goal(" ", { title: "Blank" })] }),
	).toThrow(/Goal ID is empty/);
	expect(() =>
		parseImportWorklist({
			version: 1,
			revision: 0,
			goals: [goal("loop", { dependsOn: ["loop"] })],
		}),
	).toThrow(/Dependency cycle: loop/);
	const directory = await mkdtemp(join(tmpdir(), "stepstone-import-parse-"));
	try {
		await expect(loadImportWorklist(join(directory, "missing.json"))).rejects.toThrow(/was not found/);
		await expect(loadImportWorklist(directory)).rejects.toThrow(/Cannot read worklist file/);
		const broken = join(directory, "broken.json");
		await writeFile(broken, "{");
		await expect(loadImportWorklist(broken)).rejects.toThrow(/invalid JSON/);
	} finally {
		await rm(directory, { recursive: true });
	}
});
