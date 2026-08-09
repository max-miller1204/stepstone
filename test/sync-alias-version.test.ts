import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptPath = resolve(import.meta.dirname, "..", "scripts", "sync-alias-version.ts");
const ALIAS_MANIFEST = join("alias", "pi-worklist", "package.json");

interface Manifest {
	name: string;
	version: string;
	dependencies?: Record<string, string>;
	[field: string]: unknown;
}

interface ScriptResult {
	code: number;
	stdout: string;
	stderr: string;
}

/**
 * A scratch checkout to run the real script against.
 *
 * It resolves the repository root from its own directory, so a copy under a
 * temporary root reads and rewrites these fixture manifests rather than this
 * repository's own. Manifests are serialised the way the script writes them, so
 * a run that changes nothing leaves the file byte-identical.
 */
async function fixtureCheckout(root: Manifest, alias: Manifest): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "stepstone-alias-sync-"));
	await Promise.all([
		mkdir(join(dir, "scripts"), { recursive: true }),
		mkdir(join(dir, "alias", "pi-worklist"), { recursive: true }),
	]);
	await Promise.all([
		copyFile(scriptPath, join(dir, "scripts", "sync-alias-version.ts")),
		writeFile(join(dir, "package.json"), `${JSON.stringify(root, null, "\t")}\n`, "utf8"),
		writeFile(join(dir, ALIAS_MANIFEST), `${JSON.stringify(alias, null, "\t")}\n`, "utf8"),
	]);
	return dir;
}

async function runSync(dir: string, args: string[] = []): Promise<ScriptResult> {
	try {
		const { stdout, stderr } = await execFileAsync(
			process.execPath,
			[join(dir, "scripts", "sync-alias-version.ts"), ...args],
			{ cwd: dir },
		);
		return { code: 0, stdout, stderr };
	} catch (error) {
		const failure = error as ScriptResult & { code: number | null };
		return { code: failure.code ?? 1, stdout: failure.stdout, stderr: failure.stderr };
	}
}

async function readAliasManifest(dir: string): Promise<Manifest> {
	return JSON.parse(await readFile(join(dir, ALIAS_MANIFEST), "utf8")) as Manifest;
}

describe("alias:sync", () => {
	it("leaves the alias depending on the renamed package alone", async () => {
		// A rename is documented as a one-line change, so the repair runs against
		// an alias still pinned to the previous name. Merging into what is already
		// there would publish the retired package alongside the current one, and
		// the pin the check reads would be correct in a manifest that is not.
		const dir = await fixtureCheckout(
			{ name: "newname", version: "0.18.0" },
			{
				name: "pi-worklist",
				version: "0.17.0",
				dependencies: { stepstone: "0.17.0" },
				pi: { extensions: ["./src/extension.ts"] },
				bin: { "pi-worklist": "bin/pi-worklist.js" },
			},
		);
		try {
			expect((await runSync(dir)).code).toBe(0);

			const alias = await readAliasManifest(dir);
			expect(alias.dependencies).toEqual({ newname: "0.18.0" });
			expect(alias.version).toBe("0.18.0");
			// The rewrite reserialises the whole manifest, so the fields that make
			// the alias forward at all have to survive it.
			expect(alias.pi).toEqual({ extensions: ["./src/extension.ts"] });
			expect(alias.bin).toEqual({ "pi-worklist": "bin/pi-worklist.js" });
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("reports a leftover dependency the alias no longer forwards to", async () => {
		// The pin itself is correct here, so a check that reads only that key calls
		// this manifest clean and lets the release ship it.
		const dir = await fixtureCheckout(
			{ name: "newname", version: "0.18.0" },
			{
				name: "pi-worklist",
				version: "0.18.0",
				dependencies: { stepstone: "0.17.0", newname: "0.18.0" },
			},
		);
		try {
			const checked = await runSync(dir, ["--check"]);
			expect(checked.code).toBe(1);
			// The message has to name the offending package: "run alias:sync" is not
			// actionable when the manifest looks correct at the key that drifted.
			expect(checked.stderr).toContain("stepstone");

			expect((await runSync(dir)).code).toBe(0);
			expect((await readAliasManifest(dir)).dependencies).toEqual({ newname: "0.18.0" });
			expect((await runSync(dir, ["--check"])).code).toBe(0);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("passes and rewrites nothing once the alias already matches", async () => {
		const dir = await fixtureCheckout(
			{ name: "stepstone", version: "0.17.0" },
			{ name: "pi-worklist", version: "0.17.0", dependencies: { stepstone: "0.17.0" } },
		);
		try {
			expect((await runSync(dir, ["--check"])).code).toBe(0);

			const before = await readFile(join(dir, ALIAS_MANIFEST), "utf8");
			expect((await runSync(dir)).code).toBe(0);
			expect(await readFile(join(dir, ALIAS_MANIFEST), "utf8")).toBe(before);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("reports a version bumped on one side only", async () => {
		const dir = await fixtureCheckout(
			{ name: "stepstone", version: "0.18.0" },
			{ name: "pi-worklist", version: "0.17.0", dependencies: { stepstone: "0.17.0" } },
		);
		try {
			expect((await runSync(dir, ["--check"])).code).toBe(1);

			expect((await runSync(dir)).code).toBe(0);
			const alias = await readAliasManifest(dir);
			expect(alias.version).toBe("0.18.0");
			expect(alias.dependencies).toEqual({ stepstone: "0.18.0" });
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
