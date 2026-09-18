import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorklistApplicationService } from "../src/application-service.ts";
import { WORKLIST_PATH_ENV } from "../src/cli-contract.ts";
import { createWorklistLocator } from "../src/git.ts";
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
	vi.restoreAllMocks();
	await Promise.all(apps.splice(0).map((app) => app.close()));
	await Promise.all(workspacePaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Stepstone web application", () => {
	it("serves the application from loopback and projects roadmap state", async () => {
		const { app, token } = await openApp();
		expect(new URL(app.url).hostname).toBe("127.0.0.1");
		const page = await (await fetch(app.url)).text();
		expect(page).toContain('id="goal-detail-dialog"');
		expect(page).toContain("data-view-goal");
		expect(page).toContain("data-goal-id");
		expect(page).not.toContain(".run:target");
		expect(page).not.toContain("Your next steps, in view");
		expect(page).not.toContain("See what’s ready, what’s moving, and what needs to happen next.");
		expect(page).not.toContain("Your workspaces");
		expect(page).not.toContain("Project board");
		expect(page).not.toContain("Project workspace");
		expect(page).not.toContain("<h1>");
		expect(page).toContain('id="repository-label"');
		expect(page).toContain('id="group-select"');
		expect(page).toContain("Create new group");
		expect(page).toContain('id="dependency-search"');
		expect(page).toContain('class="dependency-options"');
		expect(page).not.toContain('<label for="group">Section</label>');
		expect(page).toContain('id="action-toast"');
		expect(page).not.toContain("/api/dispatch");
		expect(page).not.toContain("Prepare workspaces");
		expect(page).not.toContain("notice('Updating workspaces…'");
		expect(page).not.toContain('id="runs"');
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

	it("projects both dependency directions and clears them when a prerequisite settles", async () => {
		const { app, token } = await openApp();
		await post(app, token, { action: "add", title: "Prerequisite" });
		await post(app, token, { action: "add", title: "Dependent", dependsOn: ["prerequisite"] });
		const before = (await (await fetch(`${app.url}/api/state`)).json()) as { result: { goals: unknown[] } };
		expect(before.result.goals).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "prerequisite", blockedBy: [], blocking: ["dependent"] }),
				expect.objectContaining({
					id: "dependent",
					blockedBy: ["prerequisite"],
					blocking: [],
					blocked: true,
				}),
			]),
		);
		await post(app, token, { action: "complete", id: "prerequisite", confirm: true });
		const after = (await (await fetch(`${app.url}/api/state`)).json()) as { result: { goals: unknown[] } };
		expect(after.result.goals).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "prerequisite", blockedBy: [], blocking: [] }),
				expect.objectContaining({ id: "dependent", blockedBy: [], blocking: [], blocked: false }),
			]),
		);
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

	it("loads claimed goals and edits the roadmap without dispatch journals or activity inspection", async () => {
		const root = await repository();
		const directory = join(root, ".git", "stepstone-dispatch");
		await mkdir(directory);
		await writeFile(join(directory, "broken.json"), "not valid JSON");
		const service = new WorklistApplicationService({ projectPath: null });
		service.setProjectPathResolver(() => createWorklistLocator(root)().path);
		expect(
			(
				await service.execute(
					{
						scope: "project",
						action: "add",
						title: "Claimed feature",
						links: ["https://github.com/example/repo/pull/42"],
					},
					{ source: "cli" },
				)
			).ok,
		).toBe(true);
		expect(
			(
				await service.execute(
					{
						scope: "project",
						action: "start",
						id: "claimed-feature",
						branch: "feature/claimed",
					},
					{ source: "cli" },
				)
			).ok,
		).toBe(true);
		const app = await startStepstoneWebApp({ repositoryRoot: root });
		apps.push(app);
		const page = await (await fetch(app.url)).text();
		const token = page.match(/name="stepstone-token" content="([^"]+)"/)?.[1];
		if (!token) throw new Error("Missing token");
		const response = await fetch(`${app.url}/api/state`);
		expect(response.status).toBe(200);
		const state = (await response.json()) as {
			result: { readyGoalIds: string[]; goals: Array<{ updatedAt: string }> };
		};
		expect(state.result).not.toHaveProperty("runs");
		expect(state.result.readyGoalIds).toEqual([]);
		expect(state.result.goals[0]).toMatchObject({
			branch: "feature/claimed",
			links: ["https://github.com/example/repo/pull/42"],
		});
		expect(state.result.goals[0]).not.toHaveProperty("dispatchCustody");
		expect(
			(
				await post(app, token, {
					action: "update",
					id: "claimed-feature",
					title: "Updated claimed feature",
					expectedUpdatedAt: state.result.goals[0].updatedAt,
				})
			).status,
		).toBe(200);
		expect(await readFile(join(directory, "broken.json"), "utf8")).toBe("not valid JSON");
	});

	it("refuses every removed workspace endpoint without changing roadmap or worktrees", async () => {
		const { app, token } = await openApp();
		const before = await (await fetch(`${app.url}/api/state`)).json();
		for (const path of [
			"/api/dispatch/start",
			"/api/dispatch/run/continue",
			"/api/dispatch/run/recover",
			"/api/dispatch/run/cleanup",
		]) {
			const response = await postPath(app, token, path, {
				confirm: true,
				approvedGoalIds: ["goal"],
				maxParallel: 1,
			});
			expect(response.status).toBe(404);
			expect(await response.json()).toMatchObject({ ok: false, error: { message: "Route not found." } });
		}
		expect(await (await fetch(`${app.url}/api/state`)).json()).toEqual(before);
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
