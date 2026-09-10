import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { columns, renderScreenshot, rows } from "./render-screenshot.ts";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const output = join(root, "artifacts", "screenshots");
const demo = join(root, "artifacts", "stepstone-ui-demo");
// A dedicated socket and an atomic directory claim prevent concurrent capture runs.
const socket = join(tmpdir(), `stepstone-screenshots-${process.pid}.sock`);
const lock = join(root, "artifacts", "screenshots.lock");
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const env = {
	PATH: process.env.PATH,
	HOME: join(root, "artifacts"),
	// A dummy key selects the model offline. This script sends only extension commands.
	ANTHROPIC_API_KEY: "screenshot-fixture-not-a-real-key",
	PI_CODING_AGENT_DIR: join(output, "agent"),
	PI_TRUE_COLOR: "1",
	PI_IMAGE_PROTOCOL: "none",
	PI_TELEMETRY: "0",
	TERM: "xterm-256color",
	COLORTERM: "truecolor",
	LANG: "en_US.UTF-8",
	LC_ALL: "en_US.UTF-8",
	TZ: "UTC",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_CONFIG_GLOBAL: "/dev/null",
	NODE_OPTIONS: `--import=${JSON.stringify(join(import.meta.dirname, "screenshot-clock.mjs"))}`,
};

async function tmux(...args: string[]): Promise<string> {
	return (await exec("tmux", ["-S", socket, ...args], { env, timeout: 10_000, maxBuffer: 1024 * 1024 }))
		.stdout;
}

async function settledCapture(target: string, required: string[]): Promise<string> {
	let previous = "";
	let stable = 0;
	for (let attempt = 0; attempt < 100; attempt++) {
		const dead = (await tmux("display-message", "-p", "-t", target, "#{pane_dead}")).trim();
		const capture = await tmux("capture-pane", "-p", "-e", "-N", "-t", target);
		if (dead === "1") throw new Error(`Screenshot process exited:\n${capture}`);
		stable = capture === previous ? stable + 1 : 0;
		if (stable >= 4 && required.every((text) => capture.includes(text))) return capture;
		previous = capture;
		await delay(100);
	}
	throw new Error(`Screenshot did not settle with ${required.join(", ")}:\n${previous}`);
}

async function capture(
	name: string,
	launcher: string,
	required: string[],
	keys: string[] = [],
	finalRequired: string[] = [],
): Promise<void> {
	const target = `demo:${name}`;
	await tmux(
		"new-window",
		"-d",
		"-t",
		"demo",
		"-n",
		name,
		"-c",
		demo,
		`exec /bin/sh ${quote(join(demo, launcher))}`,
	);
	if (name === "pi-ui") {
		await settledCapture(target, ["Trust project folder?"]);
		await tmux("send-keys", "-t", target, "Enter");
	}
	await settledCapture(target, required);
	for (const key of keys) await tmux("send-keys", "-t", target, key);
	const ansi = await settledCapture(target, [...required, ...finalRequired]);
	if (ansi.includes("Warning:") || ansi.includes("Error:")) {
		throw new Error(`Screenshot contains a diagnostic:\n${ansi}`);
	}
	await writeFile(join(output, `${name}.ansi`), ansi);
	const { svg, png } = await renderScreenshot(ansi);
	await writeFile(join(output, `${name}.svg`), svg);
	await writeFile(join(output, `stepstone-${name}.png`), png);
	await tmux("kill-window", "-t", target);
}

await mkdir(join(root, "artifacts"), { recursive: true });
await mkdir(lock);
let started = false;
try {
	const version = (await exec("tmux", ["-V"], { timeout: 10_000 })).stdout.trim();
	const parsed = /^tmux (\d+)\.(\d+)/.exec(version);
	if (!parsed || Number(parsed[1]) < 3 || (Number(parsed[1]) === 3 && Number(parsed[2]) < 5)) {
		throw new Error(`Use tmux 3.5 or newer. Found: ${version}`);
	}
	await rm(output, { recursive: true, force: true });
	await mkdir(env.HOME, { recursive: true });
	await mkdir(env.PI_CODING_AGENT_DIR, { recursive: true });
	await writeFile(
		join(env.PI_CODING_AGENT_DIR, "settings.json"),
		JSON.stringify({
			theme: "dark",
			quietStartup: true,
			defaultProvider: "anthropic",
			defaultModel: "claude-sonnet-4-6",
		}),
	);
	await exec(process.execPath, [join(import.meta.dirname, "create-screenshot-demo.ts")], {
		cwd: root,
		env,
		timeout: 120_000,
		maxBuffer: 1024 * 1024,
	});
	await writeFile(
		join(output, "tmux.conf"),
		"set -g status off\nset -g extended-keys on\nset -g extended-keys-format csi-u\nset -g default-terminal xterm-256color\nset -g remain-on-exit on\nset -g window-size manual\n",
	);
	await tmux(
		"-f",
		join(output, "tmux.conf"),
		"new-session",
		"-d",
		"-s",
		"demo",
		"-n",
		"holder",
		"-x",
		String(columns),
		"-y",
		String(rows),
		"exec /bin/cat",
	);
	started = true;
	await capture(
		"project-ui",
		"open-project-ui.sh",
		["Dependency", "Product"],
		[
			"Right",
			"Down",
			"Down",
			"Down",
			"Down",
			"Right",
			"Down",
			"Down",
			"Down",
			"Right",
			"Down",
			"Down",
			"Down",
			"Down",
			"Down",
			"Down",
			"Right",
			"Home",
			"Down",
			"Down",
		],
		["DEPENDS", "https://example.com/releases/public-beta", "STUCK"],
	);
	await capture("pi-ui", "open-pi.sh", ["Session Tasks", "Project Goals", "Update the onboarding guide"]);
	// Replace the README images only after both captures succeed.
	for (const name of ["project-ui", "pi-ui"]) {
		const destination = join(root, "docs", "images", `stepstone-${name}.png`);
		await writeFile(`${destination}.tmp`, await readFile(join(output, `stepstone-${name}.png`)));
		await rename(`${destination}.tmp`, destination);
	}
	console.log("Updated both README images. Captures and SVGs: artifacts/screenshots/");
} finally {
	try {
		if (started) await tmux("kill-server");
	} finally {
		await rm(socket, { force: true });
		await rm(lock, { recursive: true });
	}
}
