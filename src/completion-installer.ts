import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { CLI_COMMAND_CONTRACT } from "./cli-contract.ts";
import {
	COMPLETION_OWNERSHIP_MARKER,
	renderBashCompletion,
	renderZshCompletion,
} from "./shell-completions.ts";

export interface InstalledCompletion {
	shell: "bash" | "zsh";
	path: string;
	changed: boolean;
}

interface CompletionTarget {
	shell: InstalledCompletion["shell"];
	path: string;
	content: string;
}

/** Resolve the standard per-user data directory without guessing another home. */
function userDataHome(env: NodeJS.ProcessEnv): string {
	const configured = env.XDG_DATA_HOME;
	if (configured !== undefined) {
		if (!isAbsolute(configured)) throw new Error("XDG_DATA_HOME must be an absolute path");
		return configured;
	}
	const home = env.HOME;
	if (!home) throw new Error("HOME is required when XDG_DATA_HOME is not set");
	if (!isAbsolute(home)) throw new Error("HOME must be an absolute path");
	return join(home, ".local", "share");
}

/** Paths discovered by bash-completion and by the standard Zsh fpath setup. */
export function installedCompletionPaths(env: NodeJS.ProcessEnv = process.env): {
	bash: string;
	zsh: string;
} {
	const dataHome = userDataHome(env);
	return {
		bash: join(dataHome, "bash-completion", "completions", CLI_COMMAND_CONTRACT.binary),
		zsh: join(dataHome, "zsh", "site-functions", `_${CLI_COMMAND_CONTRACT.binary}`),
	};
}

function isMissingFile(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function inspectTarget(target: CompletionTarget): Promise<InstalledCompletion> {
	let current: string;
	try {
		current = await readFile(target.path, "utf8");
	} catch (error) {
		if (isMissingFile(error)) return { shell: target.shell, path: target.path, changed: true };
		throw error;
	}
	if (current === target.content) return { shell: target.shell, path: target.path, changed: false };
	if (!current.split("\n").slice(0, 3).includes(COMPLETION_OWNERSHIP_MARKER)) {
		throw new Error(
			`Refusing to replace completion file not owned by ${CLI_COMMAND_CONTRACT.binary}: ${target.path}`,
		);
	}
	return { shell: target.shell, path: target.path, changed: true };
}

async function writeAtomically(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o644 });
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
}

/** Install both completion files after checking every existing destination. */
export async function installShellCompletions(
	env: NodeJS.ProcessEnv = process.env,
): Promise<InstalledCompletion[]> {
	const paths = installedCompletionPaths(env);
	const targets: CompletionTarget[] = [
		{ shell: "bash", path: paths.bash, content: renderBashCompletion() },
		{ shell: "zsh", path: paths.zsh, content: renderZshCompletion() },
	];
	const results = await Promise.all(targets.map(inspectTarget));
	for (let index = 0; index < targets.length; index++) {
		if (!results[index]?.changed) continue;
		const target = targets[index];
		if (!target) throw new Error(`Missing completion target at index ${index}`);
		// These writes are sequential so diagnostics name the first destination that failed.
		// pi-lens-ignore: await-in-loop
		await writeAtomically(target.path, target.content);
	}
	return results;
}
