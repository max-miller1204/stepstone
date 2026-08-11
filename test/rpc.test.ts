import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const children: ChildProcessWithoutNullStreams[] = [];
afterEach(() => {
	for (const child of children.splice(0)) child.kill("SIGTERM");
});

function parseJson<T>(value: string): T {
	try {
		return JSON.parse(value) as T;
	} catch (error) {
		throw new Error(`Invalid JSON: ${String(error)}`);
	}
}

function rpc(child: ChildProcessWithoutNullStreams, request: object): Promise<Record<string, unknown>> {
	return new Promise((resolveResponse, reject) => {
		let buffer = "";
		const cleanup = () => {
			clearTimeout(timer);
			child.stdout.off("data", onData);
		};
		const onData = (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) break;
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (!line.trim()) continue;
				const value = parseJson<Record<string, unknown>>(line);
				if (value.type === "extension_error") {
					cleanup();
					reject(new Error(JSON.stringify(value)));
					return;
				}
				if (value.type === "response" && value.id === "test") {
					cleanup();
					resolveResponse(value);
					return;
				}
			}
		};
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error("RPC response timed out"));
		}, 20_000);
		child.stdout.on("data", onData);
		child.stdin.write(`${JSON.stringify({ id: "test", ...request })}\n`);
	});
}

describe("real Pi load", () => {
	it("loads the package and registers /tasks", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "stepstone-rpc-"));
		execFileSync("git", ["init", "-q"], { cwd });
		const child = spawn(
			"pi",
			[
				"--mode",
				"rpc",
				"--offline",
				"--no-extensions",
				"--no-skills",
				"--no-prompt-templates",
				"--no-themes",
				"--no-context-files",
				"--session-dir",
				join(cwd, "sessions"),
				"-e",
				resolve("."),
			],
			{ cwd, stdio: ["pipe", "pipe", "pipe"] },
		);
		children.push(child);
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		const response = await rpc(child, { type: "get_commands" });
		expect(response.success, stderr).toBe(true);
		const data = response.data as { commands: Array<{ name: string; path?: string }> };
		expect(data.commands.some((command) => command.name.startsWith("tasks"))).toBe(true);

		expect(
			(
				await rpc(child, {
					type: "prompt",
					message: "/tasks session add RPC task -- Extra context for the task",
				})
			).success,
		).toBe(true);
		const rejectedEntries = (await rpc(child, { type: "get_entries" })).data as {
			entries: Array<{ customType?: string }>;
		};
		expect(rejectedEntries.entries.some((entry) => entry.customType === "worklist-session-snapshot")).toBe(
			false,
		);

		expect((await rpc(child, { type: "prompt", message: "/tasks session add RPC task" })).success).toBe(true);
		const initialSessionEntries = (await rpc(child, { type: "get_entries" })).data as {
			entries: Array<{
				type: string;
				customType?: string;
				data?: { version?: number; tasks?: Array<{ id?: string; title?: string; status?: string }> };
			}>;
		};
		const initialSnapshot = initialSessionEntries.entries
			.filter((entry) => entry.type === "custom" && entry.customType === "worklist-session-snapshot")
			.at(-1);
		const baseId = initialSnapshot?.data?.tasks?.[0]?.id;
		expect(baseId).toBeTruthy();
		expect(initialSnapshot?.data?.tasks?.[0]).toMatchObject({ title: "RPC task", status: "todo" });
		expect(initialSnapshot?.data?.tasks?.[0]).not.toHaveProperty("description");

		expect(
			(
				await rpc(child, {
					type: "prompt",
					message: `/tasks session add --before ${baseId} RPC first step`,
				})
			).success,
		).toBe(true);
		expect(
			(
				await rpc(child, {
					type: "prompt",
					message: `/tasks session add --after ${baseId} RPC follow-up`,
				})
			).success,
		).toBe(true);
		const insertedEntries = (await rpc(child, { type: "get_entries" })).data as typeof initialSessionEntries;
		const insertedSnapshot = insertedEntries.entries
			.filter((entry) => entry.type === "custom" && entry.customType === "worklist-session-snapshot")
			.at(-1);
		expect(insertedSnapshot?.data?.tasks?.map((task) => task.title)).toEqual([
			"RPC first step",
			"RPC task",
			"RPC follow-up",
		]);
		const firstId = insertedSnapshot?.data?.tasks?.[0]?.id;
		const followUpId = insertedSnapshot?.data?.tasks?.[2]?.id;
		expect(firstId).toBeTruthy();
		expect(followUpId).toBeTruthy();

		expect(
			(
				await rpc(child, {
					type: "prompt",
					message: `/tasks session move ${followUpId} --before ${firstId}`,
				})
			).success,
		).toBe(true);
		const movedEntries = (await rpc(child, { type: "get_entries" })).data as typeof initialSessionEntries;
		const movedSnapshots = movedEntries.entries.filter(
			(entry) => entry.type === "custom" && entry.customType === "worklist-session-snapshot",
		);
		expect(movedSnapshots.at(-1)?.data).toMatchObject({ version: 3 });
		expect(movedSnapshots.at(-1)?.data?.tasks?.map((task) => task.title)).toEqual([
			"RPC follow-up",
			"RPC first step",
			"RPC task",
		]);
		expect(movedSnapshots).toHaveLength(4);

		expect(
			(
				await rpc(child, {
					type: "prompt",
					message: `/tasks session move ${followUpId} --before ${followUpId}`,
				})
			).success,
		).toBe(true);
		const noOpEntries = (await rpc(child, { type: "get_entries" })).data as typeof initialSessionEntries;
		expect(
			noOpEntries.entries.filter(
				(entry) => entry.type === "custom" && entry.customType === "worklist-session-snapshot",
			),
		).toHaveLength(4);

		expect(
			(
				await rpc(child, {
					type: "prompt",
					message: "/tasks project add RPC goal -- Repository-wide outcome",
				})
			).success,
		).toBe(true);
		const project = parseJson<{ goals: Array<{ title: string; description?: string }> }>(
			await readFile(join(cwd, ".worklist", "worklist.json"), "utf8"),
		);
		expect(project.goals).toContainEqual(
			expect.objectContaining({ title: "RPC goal", description: "Repository-wide outcome" }),
		);

		expect((await rpc(child, { type: "new_session" })).success).toBe(true);
		const freshEntries = (await rpc(child, { type: "get_entries" })).data as {
			entries: Array<{ customType?: string }>;
		};
		expect(freshEntries.entries.some((entry) => entry.customType === "worklist-session-snapshot")).toBe(
			false,
		);
		expect(
			parseJson<{ goals: unknown[] }>(await readFile(join(cwd, ".worklist", "worklist.json"), "utf8")).goals,
		).toHaveLength(1);
	});
});
