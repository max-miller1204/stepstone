/**
 * The two deterministic gates Lefthook maps Git's hooks to.
 *
 *   node scripts/quality-gates.ts pre-commit
 *   node scripts/quality-gates.ts pre-push [<revision>...]
 *
 * Lefthook only maps a lifecycle event to one of these, so the gate a hook runs
 * is the gate a person runs, and neither can drift from the other.
 *
 * The pre-commit gate is meant to cost a second. It checks the exact bytes that
 * are staged, materialized out of the index, so an unstaged edit in the working
 * tree can neither hide a problem nor invent one.
 *
 * The pre-push gate is the comprehensive one. It validates the exact commit
 * being pushed in a detached worktree of its own, installed from that commit's
 * own shrinkwrap, so what passes is the tree the remote is about to receive
 * rather than whatever this checkout happens to contain. Successful verdicts are
 * cached, because pushing the same commit twice asks the same question.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { GIT_COMMAND_TIMEOUT_MS, gitRootDiagnostic, resolveGitRoot } from "../src/git.ts";

/** The object name Git writes for the missing side of a ref update. */
const ZERO_SHA = "0".repeat(40);

/** The Biome configuration the gate reads, named once for both of its uses. */
const BIOME_CONFIG = "biome.json";

/** The manifest script the comprehensive gate is defined by. */
const GATE_SCRIPT = "quality:push:worktree";

/** How long Git may take to write a tree to disk: an index snapshot, a worktree. */
const GIT_CHECKOUT_TIMEOUT_MS = 5 * 60_000;

/** How long Biome may take over one commit's staged files. */
const BIOME_TIMEOUT_MS = 5 * 60_000;

/** How long installing one commit's pinned dependency tree may take. */
const INSTALL_TIMEOUT_MS = 10 * 60_000;

/** How long the comprehensive gate - types, tests, pack, isolated install - may take. */
const GATE_TIMEOUT_MS = 30 * 60_000;

/** How long a recorded pass stays worth keeping before it is pruned. */
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60_000;

/**
 * npm reaches a Windows command line as the `npm.cmd` batch shim, which Node has
 * refused to spawn directly since the fix for CVE-2024-27980. Only the two runs
 * that need npm go through a shell, and both pass arguments written here as
 * literals, which is what makes handing them to a shell safe.
 */
const NPM_NEEDS_SHELL = process.platform === "win32";

interface RunOptions {
	/** Where to run. Defaults to the repository root. */
	cwd?: string;
	/** How long the child may take before it is killed and the run fails. */
	timeoutMs: number;
	/** Fed to the child on stdin, for the plumbing that reads a list of paths. */
	input?: string;
	/** Return the child's stdout rather than letting it write to this process's. */
	capture?: boolean;
	/** Run through the platform shell. See `NPM_NEEDS_SHELL`, its only caller. */
	shell?: boolean;
}

let resolvedRoot: string | undefined;

/**
 * The checkout these gates run against.
 *
 * Asked of Git through `src/git.ts` rather than derived from this file's own
 * location, so how a repository root is found stays in the one module that owns
 * that question.
 */
function repositoryRoot(): string {
	if (resolvedRoot !== undefined) return resolvedRoot;
	const { root, failure } = resolveGitRoot(import.meta.dirname);
	if (!root) {
		throw new Error(
			`the quality gates need a Git repository: ${failure ? gitRootDiagnostic(failure) : "no root was named"}`,
		);
	}
	resolvedRoot = root;
	return root;
}

function run(command: string, args: string[], options: RunOptions): string {
	const invocation = `${command} ${args.join(" ")}`;
	const result = spawnSync(command, args, {
		cwd: options.cwd ?? repositoryRoot(),
		encoding: "utf8",
		input: options.input,
		// Git's own plumbing answers with a path list rather than a page of text,
		// and npm's output is inherited rather than captured, so the default megabyte
		// is only ever reached by a run large enough that truncating it would be the
		// wrong answer.
		maxBuffer: 32 * 1024 * 1024,
		shell: options.shell ?? false,
		timeout: options.timeoutMs,
		stdio: [
			options.input === undefined ? "ignore" : "pipe",
			options.capture ? "pipe" : "inherit",
			options.capture ? "pipe" : "inherit",
		],
	});
	// A run that never produced a child has no exit status and no streams to
	// report. npm missing from a hook's PATH arrives here as `error` alone, and
	// reading `stderr` for it would replace the cause with a type error about an
	// undefined chunk - which is the one failure a hook has to explain clearly,
	// because a hook shell never sources a profile and so never sees a Node that
	// a version manager put on an interactive PATH.
	if (result.error) {
		const timedOut = (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
		throw new Error(
			timedOut
				? `\`${invocation}\` was killed after ${Math.round(options.timeoutMs / 1000)}s without exiting`
				: `\`${invocation}\` could not run: ${result.error.message}`,
		);
	}
	if (result.status !== 0) {
		if (options.capture && typeof result.stderr === "string") process.stderr.write(result.stderr);
		throw new Error(
			result.signal
				? `\`${invocation}\` was killed by ${result.signal}`
				: `\`${invocation}\` exited with status ${result.status}`,
		);
	}
	return options.capture ? result.stdout : "";
}

function git(args: string[], options: Partial<RunOptions> = {}): string {
	return run("git", args, { capture: true, timeoutMs: GIT_COMMAND_TIMEOUT_MS, ...options });
}

function nulSeparated(output: string): string[] {
	return output.split("\0").filter(Boolean);
}

function stagedPaths(): string[] {
	return nulSeparated(git(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]));
}

/**
 * The Biome configuration as the commit will carry it, when it carries one.
 *
 * Empty for a checkout with no configuration, or one staging its removal, where
 * Biome falls back to its own defaults exactly as `npm run check` would.
 */
function trackedConfig(): string[] {
	return nulSeparated(git(["ls-files", "-z", "--", BIOME_CONFIG]));
}

/**
 * The staged bytes, written out where Biome can read them as ordinary files.
 *
 * Git materializes the blobs itself, leading directories included, so no file
 * streams through this process and nothing reads the working tree. `--prefix` is
 * concatenated with each path rather than joined, so it ends in a separator; Git
 * reads a forward slash on every platform, and a Windows temporary path does not
 * arrive with one.
 */
function snapshotIndex(paths: string[], destination: string): void {
	git(["checkout-index", "--force", "-z", "--stdin", `--prefix=${destination.replaceAll("\\", "/")}/`], {
		input: `${paths.join("\0")}\0`,
		timeoutMs: GIT_CHECKOUT_TIMEOUT_MS,
	});
}

function preCommit(): void {
	const paths = stagedPaths();
	if (paths.length === 0) {
		console.log("quality:pre-commit: nothing staged");
		return;
	}

	// Biome's package entry is run through this Node rather than through the
	// `node_modules/.bin` shim, because that shim is `biome.cmd` on Windows.
	const biome = join(repositoryRoot(), "node_modules", "@biomejs", "biome", "bin", "biome");
	if (!existsSync(biome)) throw new Error("Biome is not installed; run npm install before committing");

	const config = trackedConfig();
	const snapshot = mkdtempSync(join(tmpdir(), "stepstone-index-"));
	try {
		// The configuration is materialized beside the files it governs, and Biome
		// is run from there, because every path pattern in it is relative: read from
		// the repository while the files themselves are somewhere else, `!.worklist`
		// and the rest of `files.includes` match nothing, and the gate reports on
		// paths this project has deliberately excluded. The staged copy is the one
		// used, so a commit is checked against the configuration it carries.
		snapshotIndex([...new Set([...paths, ...config])], snapshot);
		// Every staged path is handed over and Biome decides which of them it can
		// read. A list of supported extensions written here would be a copy of a
		// decision Biome already owns, and a copy that claims too much refuses
		// ordinary commits: a run that processes nothing is a failed run, so a
		// documentation edit or a roadmap regeneration could not be committed at
		// all. The two flags are what turn "nothing to process" back into a pass,
		// for a file type Biome does not read and for a path this configuration
		// ignores alike.
		run(
			process.execPath,
			[
				biome,
				"check",
				...(config.length > 0 ? ["--config-path", snapshot] : []),
				"--files-ignore-unknown=true",
				"--no-errors-on-unmatched",
				...paths,
			],
			{ cwd: snapshot, timeoutMs: BIOME_TIMEOUT_MS },
		);
		console.log(`quality:pre-commit: ${paths.length} staged path${paths.length === 1 ? "" : "s"} passed`);
	} finally {
		rmSync(snapshot, { recursive: true, force: true });
	}
}

/** The commit a name points at, whatever kind of object the name itself is. */
function commitFor(revision: string): string {
	return git(["rev-parse", "--verify", `${revision}^{commit}`]).trim();
}

/**
 * The commits a push is asking about, as Git describes them on stdin.
 *
 * One line per ref, `<local-ref> <local-sha> <remote-ref> <remote-sha>`. A
 * deletion names the zero SHA on the local side and ships no commit, so it is
 * dropped rather than validated.
 *
 * Every name is peeled before the set collapses it, because Git names an
 * annotated tag by its tag object rather than by the commit under it. Without
 * that, `git push --follow-tags` hands the gate one tree under two names and
 * pays for the whole comprehensive gate twice to learn the same thing.
 */
function pushedCommits(input: string): string[] {
	const named = input
		.split(/\r?\n/u)
		.filter(Boolean)
		.map((line) => line.trim().split(/\s+/u))
		.filter((parts) => parts.length === 4 && parts[1] !== ZERO_SHA)
		.map((parts) => parts[1] as string);
	return [...new Set(named.map(commitFor))];
}

/**
 * What this run has to validate.
 *
 * Git runs the pre-push hook for an up-to-date push and for a branch deletion
 * too, and both describe a push that ships no commit: the first writes no lines
 * at all, the second names only the zero SHA. Neither is a reason to fall back
 * to HEAD. HEAD is not what is being pushed, so validating it would approve the
 * push on evidence about a different commit and then cache that verdict, and a
 * branch deletion would pay for the whole gate to ship nothing.
 *
 * Run from a terminal there is no hook feeding stdin, so reading it would block
 * on the keyboard. There, named revisions are what the reader asked for and HEAD
 * is the obvious default.
 */
function requestedCommits(revisions: string[]): string[] {
	if (revisions.length > 0) return [...new Set(revisions.map(commitFor))];
	if (process.stdin.isTTY) {
		console.log("quality:pre-push: no push to read; validating HEAD");
		return [commitFor("HEAD")];
	}
	return pushedCommits(readFileSync(0, "utf8"));
}

/**
 * Whether the commit defines the gate this hook would run over it.
 *
 * A commit from before these gates existed carries no `quality:push:worktree`,
 * and `npm run` on a script that is not there fails. Every branch forked before
 * this file landed, and every tag cut before it, would otherwise be unpushable
 * until it was rebased, which is a worse answer than saying plainly that the
 * commit describes nothing to run.
 */
function definesGate(sha: string): boolean {
	const named = nulSeparated(git(["ls-tree", "-z", "--name-only", sha, "--", "package.json"]));
	if (named.length === 0) return false;
	const { scripts } = JSON.parse(git(["show", `${sha}:package.json`])) as {
		scripts?: Record<string, unknown>;
	};
	return typeof scripts?.[GATE_SCRIPT] === "string";
}

/**
 * What a recorded pass is a pass for.
 *
 * The commit already fixes the content of every tracked file at that commit -
 * the shrinkwrap, this script, the Biome and TypeScript configuration, the test
 * setup - because two different trees cannot share a commit name. Hashing any of
 * them again would only restate the SHA, at the price of a subprocess each and
 * of aborting on a commit that predates a file the list happens to name. What
 * the commit cannot speak for is the toolchain the run happened on, which is
 * what the rest of the key is.
 */
function cacheKey(sha: string): string {
	const hash = createHash("sha256");
	hash.update(`stepstone-pre-push-v2\0${sha}\0${process.platform}\0${process.arch}\0${process.version}\0`);
	return hash.digest("hex");
}

/**
 * Drop verdicts nothing will ask for again.
 *
 * A marker is written per commit per toolchain and read only by a push of that
 * same commit, so without this the directory keeps one file for every commit
 * ever pushed, rebased away, or abandoned with its branch.
 */
function pruneCache(cacheDir: string): void {
	const cutoff = Date.now() - CACHE_MAX_AGE_MS;
	for (const entry of readdirSync(cacheDir)) {
		const marker = join(cacheDir, entry);
		try {
			if (statSync(marker).mtimeMs < cutoff) rmSync(marker, { force: true });
		} catch {
			// A marker a concurrent push removed first is already what this wanted.
		}
	}
}

/**
 * Give the checkout back, and its registration with it.
 *
 * This runs in a `finally`, so anything thrown here would replace the gate's own
 * verdict with a janitorial error. Deleting the directory is also not enough on
 * its own: the entry under the common directory outlives it, and Git keeps
 * listing a worktree that is no longer there, one dead stub per failed push.
 */
function removeWorktree(path: string): void {
	try {
		git(["worktree", "remove", "--force", path], { timeoutMs: GIT_CHECKOUT_TIMEOUT_MS });
		return;
	} catch {
		// Git kept the checkout; take it apart by hand below.
	}
	try {
		rmSync(path, { recursive: true, force: true });
		git(["worktree", "prune"]);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		process.stderr.write(`quality:pre-push: could not clean up ${path}: ${detail}\n`);
	}
}

/** Runs the comprehensive gate over one commit, in a checkout of its own. */
function validateCommit(sha: string): void {
	const worktree = mkdtempSync(join(tmpdir(), "stepstone-push-"));
	// Git insists on creating the checkout itself, so the reserved directory is
	// handed straight back and only its name is kept.
	rmSync(worktree, { recursive: true, force: true });
	try {
		git(["worktree", "add", "--detach", "--quiet", worktree, sha], { timeoutMs: GIT_CHECKOUT_TIMEOUT_MS });
		console.log(`quality:pre-push: validating ${sha.slice(0, 12)} in a detached worktree`);
		// Offline, from the commit's own shrinkwrap, so the gate proves what that
		// commit pins rather than what this checkout happens to have installed.
		run("npm", ["ci", "--ignore-scripts", "--offline"], {
			cwd: worktree,
			shell: NPM_NEEDS_SHELL,
			timeoutMs: INSTALL_TIMEOUT_MS,
		});
		run("npm", ["run", GATE_SCRIPT], {
			cwd: worktree,
			shell: NPM_NEEDS_SHELL,
			timeoutMs: GATE_TIMEOUT_MS,
		});
	} finally {
		removeWorktree(worktree);
	}
}

function prePush(commits: string[]): void {
	if (commits.length === 0) {
		console.log("quality:pre-push: no commits to validate");
		return;
	}

	const gitCommonDir = resolve(repositoryRoot(), git(["rev-parse", "--git-common-dir"]).trim());
	const cacheDir = join(gitCommonDir, "stepstone-quality-cache", "pre-push");
	mkdirSync(cacheDir, { recursive: true });
	pruneCache(cacheDir);

	for (const sha of commits) {
		const marker = join(cacheDir, cacheKey(sha));
		if (existsSync(marker)) {
			console.log(`quality:pre-push: cached ${sha.slice(0, 12)}`);
			continue;
		}
		if (!definesGate(sha)) {
			console.log(`quality:pre-push: ${sha.slice(0, 12)} defines no ${GATE_SCRIPT}; nothing to run`);
			continue;
		}
		validateCommit(sha);
		writeFileSync(marker, `${sha}\n${process.version}\n`);
	}
}

const [command, ...revisions] = process.argv.slice(2);
try {
	if (command === "pre-commit") {
		if (revisions.length > 0) throw new Error("pre-commit takes no arguments");
		preCommit();
	} else if (command === "pre-push") {
		prePush(requestedCommits(revisions));
	} else {
		throw new Error("Usage: node scripts/quality-gates.ts pre-commit | pre-push [<revision>...]");
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
