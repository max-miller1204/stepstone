import { isUtf8 } from "node:buffer";
import { randomBytes } from "node:crypto";
import { chmod, lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import lockfile from "proper-lockfile";
import { AGENTS_BLOCK_END, AGENTS_BLOCK_START, renderAgentsMarkdownBlock } from "./cli-contract.ts";

/** Repository-root file carrying harness-neutral instructions for coding agents. */
export const AGENTS_PATH = "AGENTS.md";

/** Lock shared by every Stepstone process refreshing a repository's AGENTS.md. */
const AGENTS_LOCK_PATH = ".stepstone-agents.lock";

export type AgentsBlockProblem =
	| "duplicate-markers"
	| "malformed-markers"
	| "invalid-encoding"
	| "unsupported-file";

/**
 * A marker layout that cannot be refreshed without guessing what the user intended.
 *
 * The refused file is named in the message rather than only carried beside it,
 * because `--cwd` points init at a repository other than the one the person is
 * standing in, and a bare `AGENTS.md` leaves them nothing to go and repair.
 */
export class AgentsBlockError extends Error {
	readonly problem: AgentsBlockProblem;
	readonly path: string;

	constructor(problem: AgentsBlockProblem, path: string, detail: string) {
		super(`Refusing to update ${path}: ${detail}`);
		this.name = "AgentsBlockError";
		this.problem = problem;
		this.path = path;
	}
}

function markerOffsets(contents: string, marker: string, path: string): number[] {
	const offsets: number[] = [];
	let offset = 0;
	while (offset <= contents.length - marker.length) {
		const found = contents.indexOf(marker, offset);
		if (found === -1) break;
		const before = found === 0 ? "" : contents[found - 1];
		const after = contents[found + marker.length];
		if ((before !== "" && before !== "\n") || (after !== undefined && after !== "\n" && after !== "\r")) {
			throw new AgentsBlockError(
				"malformed-markers",
				path,
				"Stepstone AGENTS markers must occupy complete lines.",
			);
		}
		offsets.push(found);
		offset = found + marker.length;
	}
	return offsets;
}

/**
 * Return the exact contents one init should persist to `path`.
 *
 * Bytes outside a single valid marker pair are copied verbatim. Missing markers
 * append one block, while every ambiguous layout is refused rather than repaired.
 * The path is passed rather than assumed so a refusal names the file it read.
 */
export function updateAgentsContents(
	path: string,
	contents: string,
	block: string = renderAgentsMarkdownBlock(),
): string {
	const starts = markerOffsets(contents, AGENTS_BLOCK_START, path);
	const ends = markerOffsets(contents, AGENTS_BLOCK_END, path);
	if (starts.length > 1 || ends.length > 1) {
		throw new AgentsBlockError(
			"duplicate-markers",
			path,
			"duplicate Stepstone AGENTS markers were found. Keep exactly one start marker and one end marker.",
		);
	}
	if (starts.length !== ends.length || (starts.length === 1 && starts[0] > ends[0])) {
		throw new AgentsBlockError(
			"malformed-markers",
			path,
			"the Stepstone AGENTS markers are incomplete or out of order. Keep one start marker before one end marker, or remove both.",
		);
	}
	if (starts.length === 1) {
		const suffixOffset = (ends[0] ?? 0) + AGENTS_BLOCK_END.length;
		return `${contents.slice(0, starts[0])}${block}${contents.slice(suffixOffset)}`;
	}
	if (contents.length === 0) return `${block}\n`;
	const separator = contents.endsWith("\n\n") ? "" : contents.endsWith("\n") ? "\n" : "\n\n";
	return `${contents}${separator}${block}\n`;
}

export interface AgentsRefreshResult {
	path: string;
	changed: boolean;
}

interface AgentsFileState {
	path: string;
	/** Permission bits of an existing regular file, absent when there is no file yet. */
	mode?: number;
	contents: string;
}

/**
 * Read one repository's AGENTS.md, refusing every shape a refresh could not
 * preserve.
 *
 * The refusals live with the read rather than with the write so a caller that
 * only inspects the file, such as the documentation check, reports the same
 * problem the writer would rather than the replacement characters a lossy
 * decode invents for bytes that are not UTF-8.
 */
async function readAgentsState(root: string): Promise<AgentsFileState> {
	const path = resolve(root, AGENTS_PATH);
	const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
	if (existing && !existing.isFile()) {
		throw new AgentsBlockError("unsupported-file", path, "the existing path is not a regular file.");
	}
	const bytes = existing ? await readFile(path) : Buffer.alloc(0);
	if (!isUtf8(bytes)) {
		throw new AgentsBlockError("invalid-encoding", path, "the existing file is not valid UTF-8.");
	}
	return {
		path,
		...(existing ? { mode: existing.mode & 0o7777 } : {}),
		contents: bytes.toString("utf8"),
	};
}

/** Whether one repository's AGENTS.md would change if it were refreshed now. */
export async function agentsFileNeedsRefresh(root: string): Promise<boolean> {
	const { path, contents } = await readAgentsState(root);
	return updateAgentsContents(path, contents) !== contents;
}

/**
 * Refresh one repository's generated block under a cross-process lock, then
 * atomically rename the complete file over its prior version.
 */
export async function refreshAgentsFile(root: string): Promise<AgentsRefreshResult> {
	const release = await lockfile.lock(root, {
		lockfilePath: resolve(root, AGENTS_LOCK_PATH),
		retries: { retries: 20, factor: 1.5, minTimeout: 10, maxTimeout: 250 },
		stale: 10000,
	});
	let tempPath: string | undefined;
	try {
		const { path, mode, contents } = await readAgentsState(root);
		const updated = updateAgentsContents(path, contents);
		if (updated === contents) return { path, changed: false };

		tempPath = resolve(root, `.stepstone-agents-${randomBytes(8).toString("hex")}.tmp`);
		await writeFile(tempPath, updated, { encoding: "utf8" });
		if (mode !== undefined) await chmod(tempPath, mode);
		await rename(tempPath, path);
		tempPath = undefined;
		return { path, changed: true };
	} finally {
		if (tempPath) await rm(tempPath, { force: true });
		await release();
	}
}
