import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { CLI_COMMAND_CONTRACT } from "../src/cli-contract.ts";
import { installedCompletionPaths, installShellCompletions } from "../src/completion-installer.ts";
import {
	COMPLETION_OWNERSHIP_MARKER,
	renderBashCompletion,
	renderZshCompletion,
} from "../src/shell-completions.ts";

const execFileAsync = promisify(execFile);
const SHELL_PARAMETER_START = "$" + "{";

async function runBashCompletion(path: string, words: string[], env?: NodeJS.ProcessEnv): Promise<string[]> {
	const script = [
		'source "$1"',
		"shift",
		'COMP_WORDS=("$@")',
		`COMP_CWORD=$((${SHELL_PARAMETER_START}#COMP_WORDS[@]} - 1))`,
		`_${CLI_COMMAND_CONTRACT.binary}`,
		`printf '%s\\n' "${SHELL_PARAMETER_START}COMPREPLY[@]}"`,
	].join("\n");
	const { stdout } = await execFileAsync("bash", ["-c", script, "completion-test", path, ...words], {
		env: { ...process.env, ...env },
	});
	return stdout.trim() === "" ? [] : stdout.trimEnd().split("\n");
}

describe("shell completion installation", () => {
	it("installs both generated files in standard XDG data directories", async () => {
		const dataHome = await mkdtemp(join(tmpdir(), "stepstone-completion-data-"));
		const env = { XDG_DATA_HOME: dataHome };
		const paths = installedCompletionPaths(env);
		const installed = await installShellCompletions(env);

		expect(installed).toEqual([
			{ shell: "bash", path: paths.bash, changed: true },
			{ shell: "zsh", path: paths.zsh, changed: true },
		]);
		expect(await readFile(paths.bash, "utf8")).toBe(renderBashCompletion());
		expect(await readFile(paths.zsh, "utf8")).toBe(renderZshCompletion());
		expect((await installShellCompletions(env)).every((entry) => !entry.changed)).toBe(true);
	});

	it("uses HOME only when XDG_DATA_HOME is not set", () => {
		expect(installedCompletionPaths({ HOME: "/home/example" })).toEqual({
			bash: "/home/example/.local/share/bash-completion/completions/stepstone",
			zsh: "/home/example/.local/share/zsh/site-functions/_stepstone",
		});
		expect(() => installedCompletionPaths({})).toThrow("HOME is required");
		expect(() => installedCompletionPaths({ XDG_DATA_HOME: "relative" })).toThrow(
			"XDG_DATA_HOME must be an absolute path",
		);
	});

	it("updates owned files and refuses an unrelated destination before writing", async () => {
		const updateHome = await mkdtemp(join(tmpdir(), "stepstone-completion-update-"));
		const updatePaths = installedCompletionPaths({ XDG_DATA_HOME: updateHome });
		for (const path of Object.values(updatePaths)) {
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, `${COMPLETION_OWNERSHIP_MARKER}\nold\n`, "utf8");
		}
		expect(
			(await installShellCompletions({ XDG_DATA_HOME: updateHome })).every((entry) => entry.changed),
		).toBe(true);
		expect(await readFile(updatePaths.bash, "utf8")).toBe(renderBashCompletion());
		expect(await readFile(updatePaths.zsh, "utf8")).toBe(renderZshCompletion());

		const refusedHome = await mkdtemp(join(tmpdir(), "stepstone-completion-refuse-"));
		const refusedPaths = installedCompletionPaths({ XDG_DATA_HOME: refusedHome });
		await mkdir(dirname(refusedPaths.zsh), { recursive: true });
		await writeFile(refusedPaths.zsh, "# unrelated completion\n", "utf8");
		await expect(installShellCompletions({ XDG_DATA_HOME: refusedHome })).rejects.toThrow(
			`Refusing to replace completion file not owned by ${CLI_COMMAND_CONTRACT.binary}`,
		);
		await expect(readFile(refusedPaths.bash, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("passes Bash and Zsh syntax checks", async () => {
		const dataHome = await mkdtemp(join(tmpdir(), "stepstone-completion-syntax-"));
		const paths = installedCompletionPaths({ XDG_DATA_HOME: dataHome });
		await installShellCompletions({ XDG_DATA_HOME: dataHome });
		await expect(execFileAsync("bash", ["-n", paths.bash])).resolves.toBeDefined();
		await expect(execFileAsync("zsh", ["-n", paths.zsh])).resolves.toBeDefined();
	});

	it("completes the scope, actions, action flags, and move placements in Bash", async () => {
		const dataHome = await mkdtemp(join(tmpdir(), "stepstone-completion-behavior-"));
		const paths = installedCompletionPaths({ XDG_DATA_HOME: dataHome });
		await installShellCompletions({ XDG_DATA_HOME: dataHome });
		expect(await runBashCompletion(paths.bash, [CLI_COMMAND_CONTRACT.binary, "pro"])).toEqual(["project"]);
		expect(await runBashCompletion(paths.bash, [CLI_COMMAND_CONTRACT.binary, "com"])).toEqual(["completion"]);
		expect(await runBashCompletion(paths.bash, [CLI_COMMAND_CONTRACT.binary, "completion", "in"])).toEqual([
			"install",
		]);
		expect(await runBashCompletion(paths.bash, [CLI_COMMAND_CONTRACT.binary, "project", "re"])).toEqual([
			"ready",
			"reopen",
		]);
		expect(
			await runBashCompletion(paths.bash, [CLI_COMMAND_CONTRACT.binary, "project", "start", "goal", "--b"]),
		).toEqual(["--branch"]);
		expect(
			await runBashCompletion(paths.bash, [CLI_COMMAND_CONTRACT.binary, "project", "move", "goal", "b"]),
		).toEqual(["before"]);
	});

	it("reads goal IDs through the CLI and forwards location selectors", async () => {
		const root = await mkdtemp(join(tmpdir(), "stepstone-completion-goals-"));
		const paths = installedCompletionPaths({ XDG_DATA_HOME: root });
		await installShellCompletions({ XDG_DATA_HOME: root });
		const executable = join(root, "stepstone-test");
		const log = join(root, "args.log");
		await writeFile(
			executable,
			[
				"#!/bin/sh",
				'printf \'%s\\n\' "$@" > "$STEPSTONE_COMPLETION_LOG"',
				"printf '[open] alpha-goal: Alpha goal\\n[done] beta-goal: Beta goal\\n'",
				"",
			].join("\n"),
			"utf8",
		);
		await chmod(executable, 0o755);

		const completions = await runBashCompletion(
			paths.bash,
			[executable, "project", "show", "--cwd", root, "a"],
			{ STEPSTONE_COMPLETION_LOG: log },
		);
		expect(completions).toEqual(["alpha-goal"]);
		expect((await readFile(log, "utf8")).trimEnd().split("\n")).toEqual(["project", "list", "--cwd", root]);
	});

	it("runs completion install without a Git repository", async () => {
		const root = await mkdtemp(join(tmpdir(), "stepstone-completion-cli-"));
		const dataHome = join(root, "data");
		const { stdout } = await execFileAsync(
			process.execPath,
			[resolve("src/cli.ts"), "completion", "install"],
			{ cwd: root, env: { ...process.env, XDG_DATA_HOME: dataHome } },
		);
		expect(stdout).toContain("Installed Bash completion:");
		expect(stdout).toContain("Installed Zsh completion:");
		const paths = installedCompletionPaths({ XDG_DATA_HOME: dataHome });
		expect(await readFile(paths.bash, "utf8")).toBe(renderBashCompletion());
		expect(await readFile(paths.zsh, "utf8")).toBe(renderZshCompletion());
	});
});
