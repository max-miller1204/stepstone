import { readdir } from "node:fs/promises";
import { posix, resolve, sep } from "node:path";

/** The directory every documentation page lives under. */
export const DOCS_DIRECTORY = "docs";

/**
 * Every documentation page, as the repository-relative posix paths npm reports.
 *
 * Shared because two suites classify the same directory - one holding each page
 * to the names the contract renders, the other deciding which of them the
 * tarball carries - and a second walk would let those two views of `docs/`
 * drift apart.
 *
 * The walk recurses, so a page filed in a subdirectory is covered the day it
 * lands rather than silently skipped. Separators are posix on every platform,
 * because these paths are compared against `npm pack` output, which is posix
 * everywhere; Node opens a posix path on Windows too, so the same value still
 * reads the file.
 */
export async function documentationPages(): Promise<string[]> {
	const entries = await readdir(resolve(DOCS_DIRECTORY), { recursive: true });
	return entries
		.filter((entry) => entry.endsWith(".md"))
		.map((entry) => posix.join(DOCS_DIRECTORY, entry.split(sep).join(posix.sep)))
		.sort();
}
