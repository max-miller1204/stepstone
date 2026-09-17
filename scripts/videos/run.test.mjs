import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

for (const setting of [undefined, "1"]) {
	test(`render forwards the explicit VHS sandbox setting: ${setting}`, async () => {
		const root = await mkdtemp(join(tmpdir(), "stepstone-video-env-"));
		try {
			const scripts = join(root, "scripts/videos");
			const scenario = join(scripts, "scenarios/probe");
			const bin = join(root, "bin");
			await mkdir(scenario, { recursive: true });
			await mkdir(bin);
			for (const file of ["run.mjs", "contract.mjs"]) {
				await cp(new URL(file, import.meta.url), join(scripts, file));
			}
			await cp(
				new URL("scenarios/tracker-retirement/demo.tape", import.meta.url),
				join(scenario, "demo.tape"),
			);
			await writeFile(join(scenario, "setup.sh"), "");
			await writeFile(join(scenario, "verify.mjs"), "");
			await writeFile(join(root, "npm.mjs"), "");
			const observed = join(root, "vhs-env.json");
			// Probe the executable boundary without a browser or recording tools.
			for (const tool of ["bash", "git", "jq", "vhs", "ffmpeg", "ffprobe", "ttyd"]) {
				await writeFile(
					join(bin, tool),
					`#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nif (${JSON.stringify(tool)} === 'vhs' && process.argv[2] === 'validate') {\nwriteFileSync(${JSON.stringify(observed)}, JSON.stringify(process.env));\nprocess.exit(23);\n}\nconsole.log('v0.12.0');\n`,
					{ mode: 0o755 },
				);
			}
			const env = { ...process.env, PATH: bin, npm_execpath: join(root, "npm.mjs"), GH_TOKEN: "test-secret" };
			delete env.VHS_NO_SANDBOX;
			if (setting !== undefined) env.VHS_NO_SANDBOX = setting;
			const result = spawnSync(process.execPath, [join(scripts, "run.mjs"), "render", "probe"], {
				env,
				encoding: "utf8",
				timeout: 30000,
			});
			assert.equal(result.error, undefined);
			assert.equal(result.status, 1, result.stderr);
			assert.match(result.stderr, /Command failed: vhs/);
			const child = JSON.parse(await readFile(observed, "utf8"));
			assert.equal(child.VHS_NO_SANDBOX, setting);
			assert.equal(child.GH_TOKEN, undefined);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
}
