import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const dispatchMarkdown = await readFile(resolve("docs/dispatch.md"), "utf8");
const goalId = "safe-dispatch";
const goalBranch = `stepstone/${goalId}`;
const leaseHolder = `stepstone:${goalId}`;
const claimEvent = `npx:-y stepstone@latest project start ${goalId} --branch ${goalBranch} --expect-updated-at ready-at --json`;
const clearEvent = `npx:-y stepstone@latest project start ${goalId} --clear --expect-updated-at claimed-at --json`;

interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

interface DispatchFixture {
	sandbox: string;
	root: string;
	leasedWorkspace: string;
	detachedWorkspace: string;
	bin: string;
	events: string;
}

function dispatchExample(name: string): string {
	const marker = `# dispatch-example: ${name}`;
	for (const match of dispatchMarkdown.matchAll(/```sh\n([\s\S]*?)\n```/g)) {
		const script = match[1] ?? "";
		if (script.includes(marker)) return script;
	}
	throw new Error(`Missing dispatch example ${name}`);
}

function dispatchCommand(fragment: string): string {
	for (const match of dispatchMarkdown.matchAll(/`([^`\n]+)`/g)) {
		const command = match[1] ?? "";
		if (command.includes(fragment)) return command;
	}
	throw new Error(`Missing dispatch command ${fragment}`);
}

async function runShell(cwd: string, script: string, env: Record<string, string>): Promise<CommandResult> {
	try {
		const { stdout, stderr } = await execFileAsync("sh", ["-u", "-c", script], {
			cwd,
			env: { ...process.env, ...env },
		});
		return { code: 0, stdout, stderr };
	} catch (error) {
		const failure = error as CommandResult & { code: number | null };
		return {
			code: failure.code ?? 1,
			stdout: failure.stdout,
			stderr: failure.stderr,
		};
	}
}

async function writeExecutable(path: string, lines: string[]): Promise<void> {
	await writeFile(path, ["#!/bin/sh", ...lines, ""].join("\n"));
	await chmod(path, 0o755);
}

async function createRepository(): Promise<DispatchFixture> {
	const sandbox = await realpath(await mkdtemp(join(tmpdir(), "stepstone-dispatch-docs-")));
	const root = join(sandbox, "root");
	const leasedWorkspace = join(sandbox, "worker");
	const detachedWorkspace = join(sandbox, `stepstone-${goalId}`);
	const bin = join(sandbox, "bin");
	const events = join(sandbox, "events.log");
	await mkdir(root);
	await mkdir(bin);
	await execFileAsync("git", ["init", "-b", "main"], { cwd: root });
	await execFileAsync("git", ["config", "user.email", "dispatch-test@example.invalid"], {
		cwd: root,
	});
	await execFileAsync("git", ["config", "user.name", "Dispatch Test"], { cwd: root });
	await writeFile(join(root, "README.md"), "dispatch fixture\n");
	await writeFile(join(root, ".gitignore"), ".cache/\n");
	await execFileAsync("git", ["add", "."], { cwd: root });
	await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: root });
	return { sandbox, root, leasedWorkspace, detachedWorkspace, bin, events };
}

async function installFakeBoundaries(bin: string): Promise<void> {
	await writeExecutable(join(bin, "npx"), [
		'printf "npx:%s\\n" "$*" >>"$EVENTS"',
		'case " $* " in',
		'  *" --clear "*) printf \'%s\\n\' \'{"result":{"goal":{"updatedAt":"cleared-at"}}}\' ;;',
		"  *)",
		'    case "${STEPSTONE_CLAIM_RESULT:-ok}" in',
		'      ok) printf \'%s\\n\' \'{"result":{"goal":{"updatedAt":"claimed-at"}}}\' ;;',
		"      malformed) printf '%s\\n' '{\"result\":{}}' ;;",
		"      *) exit 4 ;;",
		"    esac",
		"    ;;",
		"esac",
	]);
	await writeExecutable(join(bin, "treehouse"), [
		'printf "treehouse:%s\\n" "$*" >>"$EVENTS"',
		'case "$1" in',
		"  get) printf '%s\\n' \"$LEASE_WORKSPACE\" ;;",
		"  return)",
		'    case " $* " in *" --force "*) ;; *) exit 90 ;; esac',
		'    workspace_status=$(git -C "$2" status --porcelain) || exit 91',
		'    test -z "$workspace_status" || exit 92',
		'    git worktree remove --force "$2" || exit 93',
		'    printf "treehouse:return-clean\\n" >>"$EVENTS"',
		"    ;;",
		"  *) exit 94 ;;",
		"esac",
	]);
	await writeExecutable(join(bin, "herdr"), [
		'printf "herdr:%s\\n" "$*" >>"$EVENTS"',
		'case "$1:$2" in',
		"  pane:split)",
		'    case "${HERDR_SPLIT_RESULT:-ok}" in',
		'      ok) printf \'%s\\n\' \'{"result":{"pane":{"pane_id":"pane-1"}}}\' ;;',
		"      malformed) printf '%s\\n' '{\"result\":{}}' ;;",
		"      *) exit 4 ;;",
		"    esac",
		"    ;;",
		'  pane:close) : >"$PANE_CLOSED" ;;',
		"  pane:list)",
		'    if test -f "$PANE_CLOSED"; then',
		"      printf '%s\\n' '{\"result\":{\"panes\":[]}}'",
		"    else",
		'      printf \'%s\\n\' \'{"result":{"panes":[{"pane_id":"pane-1"}]}}\'',
		"    fi",
		"    ;;",
		'  agent:start) test "${HERDR_START_RESULT:-ok}" = ok ;;',
		'  agent:prompt) test "${HERDR_PROMPT_RESULT:-ok}" = ok ;;',
		"  agent:wait) : ;;",
		"  *) exit 95 ;;",
		"esac",
	]);
}

function baseEnvironment(fixture: DispatchFixture): Record<string, string> {
	return {
		PATH: `${fixture.bin}:${process.env.PATH ?? ""}`,
		EVENTS: fixture.events,
		LEASE_WORKSPACE: fixture.leasedWorkspace,
		PANE_CLOSED: join(fixture.sandbox, "pane-closed"),
		XDG_STATE_HOME: join(fixture.sandbox, "state"),
		goal_id: goalId,
		goal_prompt: "Implement the selected goal",
		updated_at: "ready-at",
		HERDR_AGENT_KIND: "claude",
		HERDR_PROMPT_TIMEOUT_MS: "17",
	};
}

async function readEvents(fixture: DispatchFixture): Promise<string[]> {
	return (await readFile(fixture.events, "utf8")).trim().split("\n");
}

function eventsMatching(events: string[], fragment: string): string[] {
	return events.filter((event) => event.includes(fragment));
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

const bindingAWorkspace = dispatchExample("binding-a-workspace");
const bindingALaunch = dispatchExample("binding-a-launch");
const bindingACleanup = dispatchExample("binding-a-cleanup");
const bindingBWorkspace = dispatchExample("binding-b-workspace");
const bindingBLaunch = dispatchExample("binding-b-launch");
const bindingBCleanup = dispatchExample("binding-b-cleanup");

describe("documented dispatch bindings", () => {
	it.each([
		["missing executable", "/definitely/missing/stepstone-agent", false],
		["immediate executable failure", "failing-agent", true],
	])("releases Binding A safely after %s", async (_label, configuredCommand, createCommand) => {
		const fixture = await createRepository();
		await installFakeBoundaries(fixture.bin);
		if (createCommand) {
			await writeExecutable(join(fixture.bin, configuredCommand), ["exit 127"]);
		}
		const result = await runShell(fixture.root, `${bindingAWorkspace}\n${bindingALaunch}`, {
			...baseEnvironment(fixture),
			AGENT_COMMAND: configuredCommand,
			AGENT_STARTUP_GRACE_SECONDS: "0.05",
		});

		expect(result.code).toBe(1);
		expect(await pathExists(fixture.detachedWorkspace)).toBe(false);
		const events = await readEvents(fixture);
		expect(events).toContain(clearEvent);
		const { stdout: branch } = await execFileAsync("git", ["branch", "--list", goalBranch], {
			cwd: fixture.root,
		});
		expect(branch).toBe("");
	});

	it.each([
		["Binding A", () => `${bindingAWorkspace}\n${bindingALaunch}`],
		["Binding B", () => `${bindingBWorkspace}\n${bindingBLaunch}`],
	])("stops %s on a rejected claim without clearing a claim it never held", async (label, buildScript) => {
		const fixture = await createRepository();
		await installFakeBoundaries(fixture.bin);
		const bindingB = label === "Binding B";
		if (bindingB) {
			await execFileAsync("git", ["worktree", "add", "--detach", fixture.leasedWorkspace, "HEAD"], {
				cwd: fixture.root,
			});
		}
		const result = await runShell(fixture.root, buildScript(), {
			...baseEnvironment(fixture),
			AGENT_COMMAND: "never-launched-agent",
			AGENT_STARTUP_GRACE_SECONDS: "0.05",
			STEPSTONE_CLAIM_RESULT: "reject",
		});

		expect(result.code).toBe(1);
		const events = await readEvents(fixture);
		if (bindingB) {
			expect(await pathExists(fixture.leasedWorkspace)).toBe(false);
			expect(events).toEqual([
				`treehouse:get --lease --lease-holder ${leaseHolder}`,
				claimEvent,
				`treehouse:return ${fixture.leasedWorkspace} --force --if-lease-holder ${leaseHolder}`,
				"treehouse:return-clean",
			]);
			return;
		}
		expect(await pathExists(fixture.detachedWorkspace)).toBe(false);
		expect(events).toEqual([claimEvent]);
		const { stdout: branch } = await execFileAsync("git", ["branch", "--list", goalBranch], {
			cwd: fixture.root,
		});
		expect(branch).toBe("");
	});

	it.each([
		["Binding A", () => `${bindingAWorkspace}\n${bindingALaunch}`],
		["Binding B", () => `${bindingBWorkspace}\n${bindingBLaunch}`],
	])("preserves %s custody when its own claim token is unreadable", async (label, buildScript) => {
		const fixture = await createRepository();
		await installFakeBoundaries(fixture.bin);
		const bindingB = label === "Binding B";
		if (bindingB) {
			await execFileAsync("git", ["worktree", "add", "--detach", fixture.leasedWorkspace, "HEAD"], {
				cwd: fixture.root,
			});
		}
		const result = await runShell(fixture.root, buildScript(), {
			...baseEnvironment(fixture),
			AGENT_COMMAND: "never-launched-agent",
			AGENT_STARTUP_GRACE_SECONDS: "0.05",
			STEPSTONE_CLAIM_RESULT: "malformed",
		});

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("Claim succeeded but its updatedAt could not be read");
		const events = await readEvents(fixture);
		if (bindingB) {
			expect(await pathExists(fixture.leasedWorkspace)).toBe(true);
			expect(events).toEqual([`treehouse:get --lease --lease-holder ${leaseHolder}`, claimEvent]);
			await execFileAsync("git", ["worktree", "remove", "--force", fixture.leasedWorkspace], {
				cwd: fixture.root,
			});
			return;
		}
		expect(await pathExists(fixture.detachedWorkspace)).toBe(true);
		expect(events).toEqual([claimEvent]);
		const { stdout: branch } = await execFileAsync("git", ["branch", "--list", goalBranch], {
			cwd: fixture.root,
		});
		expect(branch).toContain(goalBranch);
	});

	it("preserves Binding B custody when its pane ID is unreadable", async () => {
		const fixture = await createRepository();
		await installFakeBoundaries(fixture.bin);
		await execFileAsync("git", ["worktree", "add", "--detach", fixture.leasedWorkspace, "HEAD"], {
			cwd: fixture.root,
		});
		const result = await runShell(fixture.root, `${bindingBWorkspace}\n${bindingBLaunch}`, {
			...baseEnvironment(fixture),
			HERDR_SPLIT_RESULT: "malformed",
		});

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("A pane may exist but its ID could not be read");
		expect(await pathExists(fixture.leasedWorkspace)).toBe(true);
		const events = await readEvents(fixture);
		expect(events).toEqual([
			`treehouse:get --lease --lease-holder ${leaseHolder}`,
			claimEvent,
			`herdr:pane split --current --direction right --cwd ${fixture.leasedWorkspace} --no-focus`,
		]);
		await execFileAsync("git", ["worktree", "remove", "--force", fixture.leasedWorkspace], {
			cwd: fixture.root,
		});
	});

	it("scrubs dirty Binding A workspaces after completion", async () => {
		const fixture = await createRepository();
		await installFakeBoundaries(fixture.bin);
		const agent = join(fixture.bin, "long-running-agent");
		await writeExecutable(agent, ["exec sleep 30"]);
		const dirtyThenCleanup = [
			bindingAWorkspace,
			bindingALaunch,
			'agent_pid=$(cat "$XDG_STATE_HOME/stepstone/dispatch/$goal_id/agent.pid")',
			'test -d "$workspace" || exit 3',
			"printf 'changed\\n' >\"$workspace/README.md\"",
			'mkdir -p "$workspace/.cache"',
			': >"$workspace/.cache/ignored"',
			': >"$workspace/untracked"',
			bindingACleanup,
			'kill "$agent_pid" 2>/dev/null || true',
		].join("\n");
		const result = await runShell(fixture.root, dirtyThenCleanup, {
			...baseEnvironment(fixture),
			AGENT_COMMAND: agent,
			AGENT_STARTUP_GRACE_SECONDS: "0.05",
		});

		expect(result.code).toBe(0);
		expect(await pathExists(fixture.detachedWorkspace)).toBe(false);
		const { stdout: branch } = await execFileAsync("git", ["branch", "--list", goalBranch], {
			cwd: fixture.root,
		});
		expect(branch).toBe("");
		const events = await readEvents(fixture);
		expect(eventsMatching(events, " --clear ")).toEqual([]);
	});

	it("closes Binding B before releasing a pre-submission failure", async () => {
		const fixture = await createRepository();
		await installFakeBoundaries(fixture.bin);
		await execFileAsync("git", ["worktree", "add", "--detach", fixture.leasedWorkspace, "HEAD"], {
			cwd: fixture.root,
		});
		const result = await runShell(fixture.root, `${bindingBWorkspace}\n${bindingBLaunch}`, {
			...baseEnvironment(fixture),
			HERDR_START_RESULT: "fail",
		});

		expect(result.code).toBe(1);
		expect(await pathExists(fixture.leasedWorkspace)).toBe(false);
		const events = await readEvents(fixture);
		const close = events.indexOf("herdr:pane close pane-1");
		const verify = events.indexOf("herdr:pane list");
		const clear = events.indexOf(clearEvent);
		const returned = events.findIndex((event) => event.startsWith("treehouse:return "));
		expect(close).toBeGreaterThanOrEqual(0);
		expect(verify).toBeGreaterThan(close);
		expect(clear).toBeGreaterThan(verify);
		expect(returned).toBeGreaterThan(clear);
		expect(events[returned]).toContain(`--force --if-lease-holder ${leaseHolder}`);
		expect(events).toContain("treehouse:return-clean");
	});

	it("bounds the documented Herdr wait when no timeout is configured", async () => {
		const fixture = await createRepository();
		await installFakeBoundaries(fixture.bin);
		const script = `pane_id=pane-1\n${dispatchCommand("herdr agent wait")}`;
		const result = await runShell(fixture.root, script, baseEnvironment(fixture));

		expect(result.code).toBe(0);
		expect(await readEvents(fixture)).toEqual(["herdr:agent wait pane-1 --timeout 300000"]);
	});

	it("preserves Binding B custody after an ambiguous bounded prompt failure", async () => {
		const fixture = await createRepository();
		await installFakeBoundaries(fixture.bin);
		await execFileAsync("git", ["worktree", "add", "--detach", fixture.leasedWorkspace, "HEAD"], {
			cwd: fixture.root,
		});
		const result = await runShell(fixture.root, `${bindingBWorkspace}\n${bindingBLaunch}`, {
			...baseEnvironment(fixture),
			HERDR_PROMPT_RESULT: "fail",
		});

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("Prompt outcome is ambiguous");
		expect(await pathExists(fixture.leasedWorkspace)).toBe(true);
		const events = await readEvents(fixture);
		expect(events).toContain("herdr:agent prompt pane-1 Implement the selected goal --wait --timeout 17");
		expect(eventsMatching(events, "herdr:pane close")).toEqual([]);
		expect(eventsMatching(events, " --clear ")).toEqual([]);
		expect(eventsMatching(events, "treehouse:return ")).toEqual([]);
		await execFileAsync("git", ["worktree", "remove", "--force", fixture.leasedWorkspace], {
			cwd: fixture.root,
		});
	});

	it("verifies Binding B pane closure and dirty cleanup before returning its lease", async () => {
		const fixture = await createRepository();
		await installFakeBoundaries(fixture.bin);
		await execFileAsync("git", ["worktree", "add", "--detach", fixture.leasedWorkspace, "HEAD"], {
			cwd: fixture.root,
		});
		const dirtyThenCleanup = [
			bindingBWorkspace,
			bindingBLaunch,
			"printf 'changed\\n' >\"$workspace/README.md\"",
			'mkdir -p "$workspace/.cache"',
			': >"$workspace/.cache/ignored"',
			': >"$workspace/untracked"',
			bindingBCleanup,
		].join("\n");
		const result = await runShell(fixture.root, dirtyThenCleanup, baseEnvironment(fixture));

		expect(result.code).toBe(0);
		expect(await pathExists(fixture.leasedWorkspace)).toBe(false);
		const events = await readEvents(fixture);
		const close = events.indexOf("herdr:pane close pane-1");
		const verify = events.indexOf("herdr:pane list");
		const returned = events.findIndex((event) => event.startsWith("treehouse:return "));
		expect(close).toBeGreaterThanOrEqual(0);
		expect(verify).toBeGreaterThan(close);
		expect(returned).toBeGreaterThan(verify);
		expect(events[returned]).toContain(`--force --if-lease-holder ${leaseHolder}`);
		expect(events).toContain("treehouse:return-clean");
		expect(eventsMatching(events, " --clear ")).toEqual([]);
	});
});
