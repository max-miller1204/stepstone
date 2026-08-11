import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface PackedPackage {
	files: Array<{ path: string }>;
}

/**
 * The compile this worker ran, so packing can insist on having ordered itself
 * behind it, and a second suite cannot start one beside it.
 */
let build: Promise<void> | undefined;

/** The tarball's contents, read once: nothing in a run changes the worktree. */
let packed: Promise<Set<string>> | undefined;

/**
 * Compile `dist/`, and claim this worker as the one that may pack.
 *
 * `npm run build` deletes `dist/` and writes it again, while a pack walks the
 * whole worktree including that directory, so the two race wherever they are not
 * ordered. Vitest runs test files in parallel workers, which leaves exactly one
 * place they are ordered: inside a single file, where the build is awaited in
 * `beforeAll` before any test runs.
 *
 * Owning both halves here is what makes that a rule the code enforces rather
 * than a comment a reader has to find: `packedFilePaths` refuses to run in a
 * worker that never called this, so a pack assertion written in another suite
 * fails immediately and says why, instead of passing until it happens to
 * interleave with the rebuild one day in CI.
 */
export function buildPackage(): Promise<void> {
	build ??= execFileAsync("npm", ["run", "build"], { cwd: resolve(".") }).then(() => undefined);
	return build;
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
	if (!build) {
		throw new Error(
			"Pack assertions belong in the suite that awaits buildPackage() in `beforeAll`: a pack from any other " +
				"worker races that rebuild of dist/ and reads a tree being deleted underneath it.",
		);
	}
	await build;
	packed ??= readPackedFilePaths();
	return packed;
}

async function readPackedFilePaths(): Promise<Set<string>> {
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
