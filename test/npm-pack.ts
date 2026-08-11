import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface PackedPackage {
	files: Array<{ path: string }>;
}

/**
 * Every path the packer puts in the tarball, asked of the packer itself.
 *
 * The manifest's `files` array is a set of patterns, and whether one of them
 * actually keeps a file out of the tarball is npm's answer to give rather than
 * something a reader of the declaration can tell. `--ignore-scripts` is
 * deliberate: it keeps the dry run from triggering `prepack`, which would
 * rebuild `dist/` underneath the suites reading it.
 *
 * npm has emitted two shapes for this payload: an array of results through
 * npm 11, and an object keyed by package name from npm 12. Both describe the
 * same tarball, and callers only assert what that tarball contains, so this
 * reads either rather than failing on whichever npm happens to be installed.
 * Every caller goes through here, so neither shape is a caller's problem.
 */
export async function packedFilePaths(): Promise<Set<string>> {
	const { stdout } = await execFileAsync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
		cwd: resolve("."),
		maxBuffer: 10 * 1024 * 1024,
	});
	let parsed: PackedPackage[] | Record<string, PackedPackage>;
	try {
		parsed = JSON.parse(stdout) as PackedPackage[] | Record<string, PackedPackage>;
	} catch (error) {
		throw new Error("Expected valid JSON from `npm pack --json`", { cause: error });
	}
	const packs = Array.isArray(parsed) ? parsed : Object.values(parsed);
	// One package is packed, so any other count means the payload was read wrong
	// rather than that the tarball is missing files. Saying so here keeps a
	// misread from reaching a caller as an absent path it would report as a
	// packaging regression.
	if (packs.length !== 1) {
		throw new Error(`Expected \`npm pack --json\` to report one package, read ${packs.length}`);
	}
	return new Set(packs[0].files.map((file) => file.path));
}
