import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
	access,
	appendFile,
	mkdir,
	readdir,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { basename, delimiter, join, resolve } from "node:path";
import { parseTape, selectScenarios, VHS_VERSION } from "./contract.mjs";

const root = resolve(import.meta.dirname, "../..");
const scenariosDirectory = join(import.meta.dirname, "scenarios");
const [action, name, ...extra] = process.argv.slice(2);
assert.ok(
	["list", "check", "render"].includes(action) && extra.length === 0,
	"Usage: node scripts/videos/run.mjs <list|check|render> [scenario|all]",
);
const available = (await readdir(scenariosDirectory, { withFileTypes: true }))
	.filter((entry) => entry.isDirectory())
	.map((entry) => entry.name)
	.sort();
const selected = selectScenarios(available, name);

function execute(binary, args, options = {}) {
	const result = spawnSync(binary, args, {
		cwd: root,
		encoding: "utf8",
		timeout: 120000,
		maxBuffer: 20 * 1024 * 1024,
		...options,
	});
	if (result.error) throw result.error;
	if (result.status !== 0)
		throw new Error(
			`${binary} ${args.join(" ")} failed (${result.status ?? result.signal}):\n${result.stdout}\n${result.stderr}`,
		);
	return result.stdout;
}
// Resolve mise shims before changing HOME. Do not import host trust or credentials.
async function executable(name) {
	assert.ok(process.env.PATH, "PATH is required.");
	for (const directory of process.env.PATH.split(delimiter)) {
		const candidate = resolve(directory, name);
		try {
			await access(candidate, constants.X_OK);
		} catch (error) {
			if (["ENOENT", "EACCES", "ENOTDIR"].includes(error.code)) continue;
			throw error;
		}
		const resolved = await realpath(candidate);
		if (basename(resolved) !== "mise") return resolved;
		const managed = execute(resolved, ["which", name]).trim();
		assert.ok(managed.startsWith("/"), `mise did not resolve ${name} to an absolute path.`);
		await access(managed, constants.X_OK);
		return managed;
	}
	throw new Error(`Required executable is missing: ${name}`);
}

function npm(...args) {
	assert.ok(process.env.npm_execpath, "Invoke video commands through npm run so npm_execpath is set.");
	return execute(process.execPath, [process.env.npm_execpath, ...args]);
}

if (action === "list") {
	console.log(selected.join("\n"));
} else {
	const parsed = new Map();
	for (const scenario of selected) {
		const source = await readFile(join(scenariosDirectory, scenario, "demo.tape"), "utf8");
		parsed.set(scenario, { source, ...parseTape(source) });
		await access(join(scenariosDirectory, scenario, "setup.sh"));
		await access(join(scenariosDirectory, scenario, "verify.mjs"));
	}
	const versions = {
		node: process.version,
		git: execute("git", ["--version"]).trim(),
		jq: execute("jq", ["--version"]).trim(),
	};
	if (action === "render") {
		versions.vhs = execute("vhs", ["--version"]).trim();
		assert.match(
			versions.vhs,
			new RegExp(`\\bv${VHS_VERSION.replaceAll(".", "\\.")}\\b`),
			`Use VHS ${VHS_VERSION}.`,
		);
		versions.ffmpeg = execute("ffmpeg", ["-version"]).split("\n")[0];
		versions.ffprobe = execute("ffprobe", ["-version"]).split("\n")[0];
	}
	const tools = {};
	for (const name of [
		"bash",
		"git",
		"jq",
		...(action === "render" ? ["vhs", "ffmpeg", "ffprobe", "ttyd"] : []),
	]) {
		tools[name] = await executable(name);
	}
	tools.node = process.execPath;
	const outputRoot = join(root, "artifacts/videos");
	await mkdir(outputRoot, { recursive: true });
	// One lock protects the shared build output and every scenario fixture.
	const lock = join(outputRoot, ".lock");
	await mkdir(lock);
	try {
		console.log(npm("run", "build"));
		for (const scenario of selected) {
			const directory = join(scenariosDirectory, scenario);
			const output = join(outputRoot, scenario);
			const workspace = join(output, "fixture");
			const log = join(output, "commands.jsonl");
			const processLog = join(output, "process.log");
			const { source, commands, width, height, fps } = parsed.get(scenario);
			await rm(output, { recursive: true, force: true });
			await mkdir(join(workspace, "home"), { recursive: true });
			await mkdir(join(workspace, "tmp"));
			await mkdir(join(workspace, "bin"));
			for (const [name, target] of Object.entries(tools)) await symlink(target, join(workspace, "bin", name));
			await writeFile(log, "");
			const path = process.env.PATH;
			assert.ok(path, "PATH is required.");
			const env = {
				PATH: `${join(workspace, "bin")}${delimiter}${path}`,
				HOME: join(workspace, "home"),
				TMPDIR: join(workspace, "tmp"),
				TERM: "xterm-256color",
				COLORTERM: "truecolor",
				LANG: "en_US.UTF-8",
				LC_ALL: "C",
				TZ: "UTC",
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_CONFIG_NOSYSTEM: "1",
				VIDEO_REPOSITORY: root,
				VIDEO_WORKSPACE: workspace,
				VIDEO_COMMAND_LOG: log,
			};
			if (action === "render" && process.env.VHS_NO_SANDBOX !== undefined) {
				env.VHS_NO_SANDBOX = process.env.VHS_NO_SANDBOX;
			}
			const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
			await writeFile(
				join(workspace, "bin/stepstone"),
				`#!/usr/bin/env bash\nexec ${quote(process.execPath)} ${quote(join(import.meta.dirname, "record-cli.mjs"))} "$@"\n`,
				{ mode: 0o755 },
			);
			async function logged(binary, args, timeout = 120000) {
				const result = spawnSync(binary, args, {
					cwd: workspace,
					env,
					encoding: "utf8",
					timeout,
					maxBuffer: 50 * 1024 * 1024,
				});
				await appendFile(
					processLog,
					`${JSON.stringify({ binary, args, status: result.status, signal: result.signal })}\n${result.stdout ?? ""}${result.stderr ?? ""}\n`,
				);
				if (result.error) throw result.error;
				assert.equal(result.status, 0, `Command failed: ${binary}. Read ${processLog}`);
				return result.stdout;
			}
			try {
				await logged("bash", [join(directory, "setup.sh")]);
				if (action === "check") {
					const replay = join(workspace, "replay.sh");
					await writeFile(replay, `${commands.join("\n")}\n`);
					await logged("bash", ["--noprofile", "--norc", "-x", replay]);
				} else {
					await logged("vhs", ["validate", join(directory, "demo.tape")]);
					await logged("vhs", [join(directory, "demo.tape")], 600000);
				}
				await access(join(workspace, "complete"));
				console.log((await logged(process.execPath, [join(directory, "verify.mjs")])).trim());
				const metadata = {
					scenario,
					action,
					commit: execute("git", ["rev-parse", "HEAD"]).trim(),
					dirty: execute("git", ["status", "--porcelain"]).trim().length > 0,
					cliVersion: JSON.parse(await readFile(join(root, "package.json"), "utf8")).version,
					tapeSha256: createHash("sha256").update(source).digest("hex"),
					versions,
					platform: process.platform,
					width,
					height,
					fps,
				};
				if (action === "render") {
					const frames = join(workspace, "frames");
					await access(join(frames, "frame-text-00001.png"));
					await access(join(frames, "frame-cursor-00001.png"));
					const video = join(output, `${scenario}.mp4`);
					await logged(
						"ffmpeg",
						[
							"-hide_banner",
							"-loglevel",
							"error",
							"-y",
							"-framerate",
							String(fps),
							"-start_number",
							"1",
							"-i",
							join(frames, "frame-text-%05d.png"),
							"-framerate",
							String(fps),
							"-start_number",
							"1",
							"-i",
							join(frames, "frame-cursor-%05d.png"),
							"-filter_complex",
							`[0:v][1:v]overlay=shortest=1,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=0x282a36,format=yuv420p[video]`,
							"-map",
							"[video]",
							"-c:v",
							"libx264",
							"-crf",
							"20",
							"-movflags",
							"+faststart",
							"-an",
							video,
						],
						300000,
					);
					metadata.media = JSON.parse(
						await logged("ffprobe", [
							"-v",
							"error",
							"-show_entries",
							"format=duration,size:stream=width,height,codec_name",
							"-of",
							"json",
							video,
						]),
					);
					assert.ok(Number(metadata.media.format.duration) > 0, "Empty video.");
					assert.equal(metadata.media.streams[0].width, width);
					assert.equal(metadata.media.streams[0].height, height);
					await logged("ffmpeg", [
						"-hide_banner",
						"-loglevel",
						"error",
						"-y",
						"-ss",
						"10",
						"-i",
						video,
						"-frames:v",
						"1",
						join(output, "preview.png"),
					]);
					await access(join(output, "preview.png"));
					metadata.videoSha256 = createHash("sha256")
						.update(await readFile(video))
						.digest("hex");
				}
				await writeFile(join(output, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
				await rm(workspace, { recursive: true });
				console.log(`${action}: ${scenario} passed. Evidence: ${output}`);
			} catch (error) {
				await writeFile(join(output, "failure.txt"), `${error.stack}\n`);
				throw error;
			}
		}
	} finally {
		await rm(lock, { recursive: true });
	}
}
