import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WORKLIST_PATH_ENV } from "../src/cli-contract.ts";
import { type StepstoneWebApp, startStepstoneWebApp } from "../src/web-app.ts";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const workspacePaths: string[] = [];
const apps: StepstoneWebApp[] = [];

async function repository(): Promise<string> {
	const root = await realpath(await mkdtemp(join(tmpdir(), "stepstone-web-")));
	roots.push(root);
	await execFileAsync("git", ["init", "-b", "main"], { cwd: root });
	await execFileAsync("git", ["config", "user.name", "Stepstone Test"], { cwd: root });
	await execFileAsync("git", ["config", "user.email", "stepstone@example.test"], { cwd: root });
	await execFileAsync("git", ["commit", "--allow-empty", "-m", "initial"], { cwd: root });
	return root;
}

async function openApp(): Promise<{ app: StepstoneWebApp; token: string }> {
	const app = await startStepstoneWebApp({ repositoryRoot: await repository(), port: 0 });
	apps.push(app);
	const page = await fetch(app.url);
	const html = await page.text();
	const token = html.match(/name="stepstone-token" content="([^"]+)"/)?.[1];
	if (!token) throw new Error("Web page did not contain the mutation token");
	return { app, token };
}

async function postPath(app: StepstoneWebApp, token: string, path: string, body: object, origin = app.url) {
	return fetch(`${app.url}${path}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			origin,
			"x-stepstone-token": token,
		},
		body: JSON.stringify(body),
	});
}

function post(app: StepstoneWebApp, token: string, body: object, origin = app.url) {
	return postPath(app, token, "/api/goals", body, origin);
}

afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(apps.splice(0).map((app) => app.close()));
	await Promise.all(workspacePaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Stepstone web application", () => {
	it("serves the application from loopback and projects roadmap state", async () => {
		const { app, token } = await openApp();
		expect(new URL(app.url).hostname).toBe("127.0.0.1");
		const created = await post(app, token, {
			action: "add",
			title: "Ship local roadmap",
			description: "Manage goals in the browser.",
			group: "Interfaces",
			dependsOn: [],
			links: [],
		});
		expect(created.status).toBe(200);
		const state = (await (await fetch(`${app.url}/api/state`)).json()) as { result: unknown };
		expect(state).toMatchObject({
			ok: true,
			result: {
				readyGoalIds: ["ship-local-roadmap"],
				goals: [
					{
						id: "ship-local-roadmap",
						blocked: false,
						wave: 1,
					},
				],
			},
		});
	});

	it("rejects cross-origin and tokenless mutations without writing", async () => {
		const { app, token } = await openApp();
		expect(
			(await post(app, token, { action: "add", title: "Cross site" }, "https://attacker.test")).status,
		).toBe(403);
		const tokenless = await fetch(`${app.url}/api/goals`, {
			method: "POST",
			headers: { "content-type": "application/json", origin: app.url },
			body: JSON.stringify({ action: "add", title: "No token" }),
		});
		expect(tokenless.status).toBe(403);
		const state = (await (await fetch(`${app.url}/api/state`)).json()) as {
			result: { goals: unknown[] };
		};
		expect(state.result.goals).toEqual([]);
	});

	it("requires explicit lifecycle confirmation and reports optimistic conflicts", async () => {
		const { app, token } = await openApp();
		const createResponse = await post(app, token, { action: "add", title: "Guarded goal" });
		const created = (await createResponse.json()) as {
			result: { goal: { id: string; updatedAt: string } };
		};
		const goal = created.result.goal;
		const unconfirmed = await post(app, token, {
			action: "complete",
			id: goal.id,
			expectedUpdatedAt: goal.updatedAt,
		});
		expect(unconfirmed.status).toBe(400);
		expect((await unconfirmed.json()) as { error: { code: string } }).toMatchObject({
			error: { code: "APPROVAL_REQUIRED" },
		});

		const updated = await post(app, token, {
			action: "update",
			id: goal.id,
			title: "Changed goal",
			expectedUpdatedAt: goal.updatedAt,
		});
		expect(updated.status).toBe(200);
		const stale = await post(app, token, {
			action: "complete",
			id: goal.id,
			expectedUpdatedAt: goal.updatedAt,
			confirm: true,
		});
		expect(stale.status).toBe(409);
		expect((await stale.json()) as { error: { code: string } }).toMatchObject({
			error: { code: "CONFLICT" },
		});
	});

	it("validates request routes, content, actions, and lifecycle confirmation", async () => {
		const { app, token } = await openApp();
		const headers = { origin: app.url, "x-stepstone-token": token };
		expect((await fetch(`${app.url}/missing`)).status).toBe(404);
		expect((await fetch(`${app.url}/api/goals`, { method: "PUT" })).status).toBe(404);
		expect(
			(
				await fetch(`${app.url}/api/goals`, {
					method: "POST",
					headers,
					body: "{}",
				})
			).status,
		).toBe(415);
		expect(
			(
				await fetch(`${app.url}/api/goals`, {
					method: "POST",
					headers: { ...headers, "content-type": "application/json" },
					body: "{",
				})
			).status,
		).toBe(400);
		expect((await post(app, token, { action: "migrate_ids" })).status).toBe(400);

		const created = (await (await post(app, token, { action: "add", title: "Lifecycle goal" })).json()) as {
			result: { goal: { id: string; updatedAt: string } };
		};
		const completed = await post(app, token, {
			action: "complete",
			id: created.result.goal.id,
			expectedUpdatedAt: created.result.goal.updatedAt,
			confirm: true,
		});
		expect(completed.status).toBe(200);
		expect(await completed.json()).toMatchObject({ result: { goal: { status: "done" } } });
	});

	it("prepares an explicitly approved ready goal and exposes its shell-quoted command", async () => {
		const { app, token } = await openApp();
		const created = (await (
			await post(app, token, { action: "add", title: `Prepare browser ${randomUUID()}` })
		).json()) as {
			result: { goal: { id: string } };
		};
		expect(
			(await postPath(app, token, "/api/dispatch/start", { approvedGoalIds: [created.result.goal.id] }))
				.status,
		).toBe(403);
		expect(
			(
				await postPath(app, token, "/api/dispatch/start", {
					confirm: true,
					approvedGoalIds: "not-an-array",
					maxParallel: 1,
				})
			).status,
		).toBe(400);
		const tooMany = await postPath(app, token, "/api/dispatch/start", {
			confirm: true,
			approvedGoalIds: [created.result.goal.id],
			maxParallel: 1025,
		});
		expect(tooMany.status).toBe(400);
		expect(await tooMany.json()).toMatchObject({ error: { message: expect.stringContaining("1024") } });
		const prepared = await postPath(app, token, "/api/dispatch/start", {
			confirm: true,
			approvedGoalIds: [created.result.goal.id],
			maxParallel: 1024,
		});
		expect(prepared.status).toBe(200);
		const result = (await prepared.json()) as {
			result: {
				id: string;
				entries: Record<string, { phase: string; workspace: string; cdCommand: string }>;
			};
		};
		const entry = result.result.entries[created.result.goal.id];
		workspacePaths.push(entry.workspace);
		expect(entry.phase).toBe("prepared");
		expect(entry.cdCommand).toBe(`cd '${entry.workspace}'`);
		expect((await postPath(app, token, `/api/dispatch/${result.result.id}/continue`, {})).status).toBe(403);

		const state = (await (await fetch(`${app.url}/api/state`)).json()) as {
			result: { readyGoalIds: string[]; runs: Array<{ id: string }> };
		};
		expect(state.result.readyGoalIds).toEqual([]);
		expect(state.result.runs).toEqual([expect.objectContaining({ id: result.result.id })]);
		const before = (await (await fetch(`${app.url}/api/state`)).json()) as {
			result: { revision: string; goals: unknown[] };
		};
		for (const action of ["update", "complete", "archive", "delete", "reopen"]) {
			const refused = await post(app, token, {
				action,
				id: created.result.goal.id,
				title: "Changed claim",
				confirm: true,
			});
			expect(refused.status).toBe(409);
			expect(await refused.json()).toMatchObject({
				error: { message: expect.stringContaining("workspace custody") },
			});
		}
		expect(
			(
				await post(app, token, {
					action: "update",
					id: created.result.goal.id.slice(0, 12),
					title: "Prefix edit",
				})
			).status,
		).toBe(409);
		expect(await (await fetch(`${app.url}/api/state`)).json()).toMatchObject({
			result: { revision: before.result.revision, goals: before.result.goals },
		});
		expect(before).toMatchObject({ result: { goals: [{ dispatchCustody: true }] } });
		expect((await post(app, token, { action: "add", title: "Other goal" })).status).toBe(200);
		expect(
			(await post(app, token, { action: "move", id: created.result.goal.id, direction: "down" })).status,
		).toBe(200);
		const moved = (await (await fetch(`${app.url}/api/state`)).json()) as { result: { goals: unknown[] } };
		expect(moved.result.goals[1]).toEqual(before.result.goals[0]);
		const cleanup = await postPath(app, token, `/api/dispatch/${result.result.id}/cleanup`, {
			confirm: true,
		});
		expect(cleanup.status).toBe(500);
		expect(await cleanup.json()).toMatchObject({
			error: { message: expect.stringContaining("still has custody") },
		});
		await writeFile(join(entry.workspace, "uncommitted.txt"), "Inspect this work before release.\n");
		expect(await (await fetch(`${app.url}/api/state`)).json()).toMatchObject({
			result: {
				runs: [
					{
						entries: {
							[created.result.goal.id]: {
								claimEvidence: {
									canonical: { state: "matches" },
									workspace: { state: "observed", hasUncommittedChanges: true },
								},
							},
						},
					},
				],
			},
		});
		const unacknowledged = await postPath(app, token, `/api/dispatch/${result.result.id}/recover`, {
			confirm: true,
			goalId: created.result.goal.id,
		});
		expect(unacknowledged.status).toBe(403);
		await rename(entry.workspace, `${entry.workspace}-unavailable`);
		try {
			const unavailable = await postPath(app, token, `/api/dispatch/${result.result.id}/recover`, {
				confirm: true,
				acknowledgeEvidence: true,
				goalId: created.result.goal.id,
			});
			expect(unavailable.status).toBe(409);
			expect(await unavailable.json()).toMatchObject({
				error: { message: expect.stringContaining("CLI inspection") },
			});
		} finally {
			await rename(`${entry.workspace}-unavailable`, entry.workspace);
		}
		await rm(join(entry.workspace, "uncommitted.txt"));
		const recovered = await postPath(app, token, `/api/dispatch/${result.result.id}/recover`, {
			confirm: true,
			acknowledgeEvidence: true,
			goalId: created.result.goal.id,
		});
		expect(recovered.status).toBe(200);
		expect(await recovered.json()).toMatchObject({
			result: {
				entries: {
					[created.result.goal.id]: {
						phase: "cleanup-pending",
						message: expect.stringContaining("no configured Git remote"),
					},
				},
			},
		});
		const duplicate = await postPath(app, token, "/api/dispatch/start", {
			confirm: true,
			approvedGoalIds: [created.result.goal.id],
			maxParallel: 1,
		});
		expect(duplicate.status).toBe(409);
		expect(await duplicate.json()).toMatchObject({
			error: { message: expect.stringContaining("reserved by an existing run") },
		});
	});

	it("retains blocked approval and prepares it on continue after its dependency settles", async () => {
		const { app, token } = await openApp();
		const prerequisite = (await (
			await post(app, token, { action: "add", title: "Prerequisite" })
		).json()) as {
			result: { goal: { id: string } };
		};
		const dependent = (await (
			await post(app, token, {
				action: "add",
				title: `Dependent ${randomUUID()}`,
				dependsOn: [prerequisite.result.goal.id],
			})
		).json()) as { result: { goal: { id: string } } };
		const started = await postPath(app, token, "/api/dispatch/start", {
			confirm: true,
			approvedGoalIds: [dependent.result.goal.id],
			maxParallel: 1,
		});
		expect(started.status).toBe(200);
		const run = (await started.json()) as {
			result: { id: string; approvedGoalIds: string[]; entries: object };
		};
		expect(run.result.approvedGoalIds).toEqual([dependent.result.goal.id]);
		expect(run.result.entries).toEqual({});
		expect(
			(await post(app, token, { action: "complete", id: prerequisite.result.goal.id, confirm: true })).status,
		).toBe(200);
		const continued = await postPath(app, token, `/api/dispatch/${run.result.id}/continue`, {
			confirm: true,
		});
		expect(continued.status).toBe(200);
		const advanced = (await continued.json()) as {
			result: { entries: Record<string, { phase: string; workspace: string }> };
		};
		const entry = advanced.result.entries[dependent.result.goal.id];
		workspacePaths.push(entry.workspace);
		expect(entry.phase).toBe("prepared");
	});

	it("continues a stored blocked approval after CLI ID migration without changing run references", async () => {
		const root = await repository();
		const prerequisiteId = `goal-review-${randomUUID().slice(0, 8)}`;
		const approvedId = `goal-review-${randomUUID().slice(0, 8)}`;
		const timestamp = new Date().toISOString();
		await mkdir(join(root, ".worklist"));
		await writeFile(
			join(root, ".worklist", "worklist.json"),
			JSON.stringify({
				version: 1,
				revision: 0,
				retiredIds: [],
				goals: [
					{
						id: prerequisiteId,
						title: "Migration prerequisite",
						status: "open",
						createdAt: timestamp,
						updatedAt: timestamp,
					},
					{
						id: approvedId,
						title: "Migrated dependent",
						status: "open",
						createdAt: timestamp,
						updatedAt: timestamp,
						dependsOn: [prerequisiteId],
					},
				],
			}),
		);
		const app = await startStepstoneWebApp({ repositoryRoot: root });
		apps.push(app);
		const token = (await (await fetch(app.url)).text()).match(
			/name="stepstone-token" content="([^"]+)"/,
		)?.[1];
		if (!token) throw new Error("Missing token");
		const started = await postPath(app, token, "/api/dispatch/start", {
			confirm: true,
			approvedGoalIds: [approvedId],
			maxParallel: 1,
		});
		expect(started.status).toBe(200);
		const run = (await started.json()) as { result: { id: string; entries: object } };
		expect(run.result.entries).toEqual({});
		await execFileAsync(process.execPath, [
			fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
			"project",
			"migrate_ids",
			"--confirm",
			"--cwd",
			root,
			"--json",
		]);
		expect(await (await fetch(`${app.url}/api/state`)).json()).toMatchObject({
			result: {
				goals: expect.arrayContaining([
					expect.objectContaining({
						id: "migrated-dependent",
						previousIds: [approvedId],
						dispatchEligible: false,
					}),
				]),
			},
		});
		expect(
			(
				await postPath(app, token, "/api/dispatch/start", {
					confirm: true,
					approvedGoalIds: [approvedId],
					maxParallel: 1,
				})
			).status,
		).toBe(409);
		expect((await post(app, token, { action: "complete", id: prerequisiteId, confirm: true })).status).toBe(
			200,
		);
		const continued = await postPath(app, token, `/api/dispatch/${run.result.id}/continue`, {
			confirm: true,
		});
		expect(continued.status).toBe(200);
		const advanced = (await continued.json()) as {
			result: {
				approvedGoalIds: string[];
				entries: Record<string, { phase: string; workspace: string; branch: string }>;
			};
		};
		const entry = advanced.result.entries[approvedId];
		if (entry?.workspace) workspacePaths.push(entry.workspace);
		expect(entry?.phase).toBe("prepared");
		expect(entry.branch).toBe(`stepstone/${approvedId}`);
		expect(advanced.result.approvedGoalIds).toEqual([approvedId]);
		expect(Object.keys(advanced.result.entries)).toEqual([approvedId]);
		const state = await (await fetch(`${app.url}/api/state`)).json();
		expect(state).toMatchObject({
			result: {
				goals: expect.arrayContaining([
					expect.objectContaining({
						id: "migrated-dependent",
						previousIds: [approvedId],
						branch: entry.branch,
						dispatchCustody: true,
					}),
				]),
			},
		});
		expect(
			(
				await postPath(app, token, `/api/dispatch/${run.result.id}/recover`, {
					confirm: true,
					acknowledgeEvidence: true,
					goalId: approvedId,
				})
			).status,
		).toBe(200);
		const resumed = await postPath(app, token, `/api/dispatch/${run.result.id}/continue`, { confirm: true });
		expect(resumed.status).toBe(200);
		const resumedRun = (await resumed.json()) as {
			result: { approvedGoalIds: string[]; entries: Record<string, { phase: string }> };
		};
		expect(resumedRun.result.approvedGoalIds).toEqual([approvedId]);
		expect(Object.keys(resumedRun.result.entries)).toEqual([approvedId]);
		expect(resumedRun.result.entries[approvedId].phase).toBe("cleanup-pending");
	});

	it("allows only one concurrent web start to reserve the same goal", async () => {
		const root = await repository();
		const servers = await Promise.all(
			[0, 1].map(async () => {
				const app = await startStepstoneWebApp({ repositoryRoot: root });
				apps.push(app);
				const token = (await (await fetch(app.url)).text()).match(
					/name="stepstone-token" content="([^"]+)"/,
				)?.[1];
				if (!token) throw new Error("Missing token");
				return { app, token };
			}),
		);
		const created = await post(servers[0].app, servers[0].token, {
			action: "add",
			title: `Concurrent ${randomUUID()}`,
		});
		expect(created.status).toBe(200);
		const goalId = ((await created.json()) as { result: { goal: { id: string } } }).result.goal.id;
		const responses = await Promise.all(
			servers.map(({ app, token }) =>
				postPath(app, token, "/api/dispatch/start", {
					confirm: true,
					approvedGoalIds: [goalId],
					maxParallel: 1,
				}),
			),
		);
		const state = (await (await fetch(`${servers[0].app.url}/api/state`)).json()) as {
			result: { runs: Array<{ entries: Record<string, { phase: string; workspace?: string }> }> };
		};
		for (const run of state.result.runs) {
			const workspace = run.entries[goalId]?.workspace;
			if (workspace) workspacePaths.push(workspace);
		}
		expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
		expect(state.result.runs).toHaveLength(1);
		expect(state.result.runs[0].entries[goalId].phase).toBe("prepared");
	});

	it("shares reservation between a web start and a real CLI start", async () => {
		const root = await repository();
		const app = await startStepstoneWebApp({ repositoryRoot: root });
		apps.push(app);
		const token = (await (await fetch(app.url)).text()).match(
			/name="stepstone-token" content="([^"]+)"/,
		)?.[1];
		if (!token) throw new Error("Missing token");
		const created = (await (
			await post(app, token, { action: "add", title: `Shared start ${randomUUID()}` })
		).json()) as { result: { goal: { id: string } } };
		const goalId = created.result.goal.id;
		const outcomes = await Promise.allSettled([
			postPath(app, token, "/api/dispatch/start", {
				confirm: true,
				approvedGoalIds: [goalId],
				maxParallel: 1,
			}).then(async (response) => ({ ok: response.ok, body: await response.json() })),
			execFileAsync(
				process.execPath,
				[
					fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
					"project",
					"workspace",
					"start",
					"--goal",
					goalId,
					"--cwd",
					root,
					"--json",
				],
				{ timeout: 30000 },
			).then(({ stdout }) => ({ ok: true, body: JSON.parse(stdout) })),
		]);
		const state = (await (await fetch(`${app.url}/api/state`)).json()) as {
			result: { runs: Array<{ entries: Record<string, { phase: string; workspace?: string }> }> };
		};
		for (const run of state.result.runs) {
			const path = run.entries[goalId]?.workspace;
			if (path) workspacePaths.push(path);
		}
		expect(outcomes.filter((outcome) => outcome.status === "fulfilled" && outcome.value.ok)).toHaveLength(1);
		expect(state.result.runs).toHaveLength(1);
		expect(state.result.runs[0].entries[goalId].phase).toBe("prepared");
	});

	it("refuses explicit and environment roadmap overrides before serving", async () => {
		const root = await repository();
		await expect(
			startStepstoneWebApp({ repositoryRoot: root, worklistOverride: join(root, "other.json") }).then(
				(app) => {
					apps.push(app);
					return app;
				},
			),
		).rejects.toThrow("does not support --file");
		vi.stubEnv(WORKLIST_PATH_ENV, join(root, "other.json"));
		await expect(
			startStepstoneWebApp({ repositoryRoot: root }).then((app) => {
				apps.push(app);
				return app;
			}),
		).rejects.toThrow(`does not support ${WORKLIST_PATH_ENV}`);
	});

	it("refuses a stale reorder without changing the current order", async () => {
		const { app, token } = await openApp();
		for (const title of ["A", "B", "C"]) {
			expect((await post(app, token, { action: "add", title })).status).toBe(200);
		}
		const snapshot = (await (await fetch(`${app.url}/api/state`)).json()) as {
			result: { revision: string; goals: Array<{ id: string }> };
		};
		const [a, b, c] = snapshot.result.goals.map((goal) => goal.id);
		expect(
			(
				await post(app, token, {
					action: "move",
					id: c,
					direction: "up",
					expectedRevision: snapshot.result.revision,
				})
			).status,
		).toBe(200);
		const stale = await post(app, token, {
			action: "move",
			id: b,
			direction: "up",
			expectedRevision: snapshot.result.revision,
		});
		expect(stale.status).toBe(409);
		expect(await stale.json()).toMatchObject({ error: { code: "CONFLICT" } });
		const current = (await (await fetch(`${app.url}/api/state`)).json()) as {
			result: { goals: Array<{ id: string }> };
		};
		expect(current.result.goals.map((goal) => goal.id)).toEqual([a, c, b]);
	});

	it("refuses invalid ports and linked-worktree hosting", async () => {
		const root = await repository();
		await expect(startStepstoneWebApp({ repositoryRoot: root, port: -1 })).rejects.toThrow(
			"port must be an integer",
		);
		const linked = `${root}-linked`;
		workspacePaths.push(linked);
		await execFileAsync("git", ["worktree", "add", "-b", "linked", linked], { cwd: root });
		await expect(startStepstoneWebApp({ repositoryRoot: linked })).rejects.toThrow("main worktree");
	});

	it("does not write the goal file outside the application service", async () => {
		const root = await repository();
		const app = await startStepstoneWebApp({ repositoryRoot: root });
		apps.push(app);
		const page = await fetch(app.url);
		const token = (await page.text()).match(/name="stepstone-token" content="([^"]+)"/)?.[1];
		if (!token) throw new Error("Missing token");
		await post(app, token, { action: "add", title: "Atomic goal" });
		const stored = JSON.parse(await readFile(join(root, ".worklist", "worklist.json"), "utf8"));
		expect(stored).toMatchObject({ revision: 1, goals: [{ id: "atomic-goal" }] });
	});
});
