/**
 * Keeps the deprecated alias package pinned to the release it forwards to.
 *
 * The alias carries no implementation, so its only correct version is the one
 * of the package it depends on: shipping `pi-worklist@0.18.0` that resolves
 * `stepstone@0.17.0` would advertise a release it does not contain. The `version`
 * lifecycle script rewrites both fields during `npm version` and stages the
 * result into the version commit, and `--check` fails the build if they ever
 * disagree, so neither can be bumped alone.
 *
 * That one package is also the alias's whole dependency set. A second entry
 * could only name a package the alias no longer forwards to, and publishing it
 * would install the release the rename retired alongside the current one.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const ALIAS_MANIFEST = join(repoRoot, "alias", "pi-worklist", "package.json");

interface Manifest {
	name: string;
	version: string;
	dependencies?: Record<string, string>;
}

async function readManifest(path: string): Promise<Manifest> {
	return JSON.parse(await readFile(path, "utf8")) as Manifest;
}

const root = await readManifest(join(repoRoot, "package.json"));
const alias = await readManifest(ALIAS_MANIFEST);
const pinned = alias.dependencies?.[root.name];
const strays = Object.keys(alias.dependencies ?? {}).filter((name) => name !== root.name);

const drift = [
	alias.version === root.version ? "" : `version is ${alias.version}, expected ${root.version}`,
	pinned === root.version
		? ""
		: `dependency on ${root.name} is ${pinned ?? "missing"}, expected ${root.version}`,
	strays.length === 0 ? "" : `also depends on ${strays.join(", ")}, which it does not forward to`,
].filter(Boolean);

if (process.argv.includes("--check")) {
	if (drift.length === 0) {
		console.log(`alias/pi-worklist matches ${root.name} ${root.version}.`);
		process.exit(0);
	}
	console.error(`alias/pi-worklist has drifted from ${root.name} ${root.version}:`);
	for (const problem of drift) console.error(`  - ${problem}`);
	console.error("Run `npm run alias:sync` and commit the result.");
	process.exit(1);
}

if (drift.length === 0) {
	console.log(`alias/pi-worklist already matches ${root.name} ${root.version}.`);
	process.exit(0);
}

alias.version = root.version;
alias.dependencies = { [root.name]: root.version };
await writeFile(ALIAS_MANIFEST, `${JSON.stringify(alias, null, "\t")}\n`, "utf8");
console.log(`Pinned alias/pi-worklist to ${root.name} ${root.version}.`);
