import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const dispatchMarkdown = await readFile(resolve("docs/dispatch.md"), "utf8");

interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

interface DispatchFixture {
	sandbox: string;
	root: string;
	workspace: string;
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
	const workspace = join(sandbox, "worker");
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
	return { sandbox, root, workspace, bin, events };
}

async function installFakeBoundaries(bin: string): Promise<void> {
	await writeExecutable(join(bin, "npx"), [
		'printf "npx:%s\\n" "$*" >>"$EVENTS"',
		'case " $* " in',
		'  *" --clear "*) printf \'%s\\n\' \'{"result":{"goal":{"updatedAt":"cleared-at"}}}\' ;;',
		'  *) printf \'%s\\n\' \'{"result":{"goal":{"updatedAt":"claimed-at"}}}\' ;;',
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
		'  pane:split) printf \'%s\\n\' \'{"result":{"pane":{"pane_id":"pane-1"}}}\' ;;',
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
		"  *) exit 95 ;;",
		"esac",
	]);
}

function baseEnvironment(fixture: DispatchFixture): Record<string, string> {
	return {
		PATH: `${fixture.bin}:${process.env.PATH ?? ""}`,
		EVENTS: fixture.events,
		LEASE_WORKSPACE: fixture.workspace,
		PANE_CLOSED: join(fixture.sandbox, "pane-closed"),
		XDG_STATE_HOME: join(fixture.sandbox, "state"),
		goal_id: "safe-dispatch",
		goal_prompt: "Implement the selected goal",
		updated_at: "ready-at",
		HERDR_AGENT_KIND: "claude",
		HERDR_PROMPT_TIMEOUT_MS: "17",
	};
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
		expect(await pathExists(fixture.workspace)).toBe(false);
		const events = await readFile(fixture.events, "utf8");
		expect(events).toContain(
			"npx:-y stepstone@latest project start safe-dispatch --clear --expect-updated-at claimed-at --json",
		);
		const { stdout: branch } = await execFileAsync("git", ["branch", "--list", "stepstone/safe-dispatch"], {
			cwd: fixture.root,
		});
		expect(branch).toBe("");
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
		expect(await pathExists(fixture.workspace)).toBe(false);
		const events = await readFile(fixture.events, "utf8");
		expect(events).not.toContain(" --clear ");
	});

	it("closes Binding B before releasing a pre-submission failure", async () => {
		const fixture = await createRepository();
		await installFakeBoundaries(fixture.bin);
		await execFileAsync("git", ["worktree", "add", "--detach", fixture.workspace, "HEAD"], {
			cwd: fixture.root,
		});
		const result = await runShell(fixture.root, `${bindingBWorkspace}\n${bindingBLaunch}`, {
			...baseEnvironment(fixture),
			HERDR_START_RESULT: "fail",
		});

		expect(result.code).toBe(1);
		expect(await pathExists(fixture.workspace)).toBe(false);
		const events = (await readFile(fixture.events, "utf8")).trim().split("\n");
		const close = events.indexOf("herdr:pane close pane-1");
		const verify = events.indexOf("herdr:pane list");
		const clear = events.indexOf(
			"npx:-y stepstone@latest project start safe-dispatch --clear --expect-updated-at claimed-at --json",
		);
		const returned = events.findIndex((event) => event.startsWith("treehouse:return "));
		expect(close).toBeGreaterThanOrEqual(0);
		expect(verify).toBeGreaterThan(close);
		expect(clear).toBeGreaterThan(verify);
		expect(returned).toBeGreaterThan(clear);
		expect(events[returned]).toContain("--force --if-lease-holder stepstone:safe-dispatch");
		expect(events).toContain("treehouse:return-clean");
	});

	it("preserves Binding B custody after an ambiguous bounded prompt failure", async () => {
		const fixture = await createRepository();
		await installFakeBoundaries(fixture.bin);
		await execFileAsync("git", ["worktree", "add", "--detach", fixture.workspace, "HEAD"], {
			cwd: fixture.root,
		});
		const result = await runShell(fixture.root, `${bindingBWorkspace}\n${bindingBLaunch}`, {
			...baseEnvironment(fixture),
			HERDR_PROMPT_RESULT: "fail",
		});

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("Prompt outcome is ambiguous");
		expect(await pathExists(fixture.workspace)).toBe(true);
		const events = await readFile(fixture.events, "utf8");
		expect(events).toContain("herdr:agent prompt pane-1 Implement the selected goal --wait --timeout 17");
		expect(events).not.toContain("herdr:pane close");
		expect(events).not.toContain(" --clear ");
		expect(events).not.toContain("treehouse:return ");
		await execFileAsync("git", ["worktree", "remove", "--force", fixture.workspace], {
			cwd: fixture.root,
		});
	});

	it("verifies Binding B pane closure and dirty cleanup before returning its lease", async () => {
		const fixture = await createRepository();
		await installFakeBoundaries(fixture.bin);
		await execFileAsync("git", ["worktree", "add", "--detach", fixture.workspace, "HEAD"], {
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
		expect(await pathExists(fixture.workspace)).toBe(false);
		const events = (await readFile(fixture.events, "utf8")).trim().split("\n");
		const close = events.indexOf("herdr:pane close pane-1");
		const verify = events.indexOf("herdr:pane list");
		const returned = events.findIndex((event) => event.startsWith("treehouse:return "));
		expect(verify).toBeGreaterThan(close);
		expect(returned).toBeGreaterThan(verify);
		expect(events[returned]).toContain("--force --if-lease-holder stepstone:safe-dispatch");
		expect(events).toContain("treehouse:return-clean");
		expect(events).not.toContain(" --clear ");
	});
});
