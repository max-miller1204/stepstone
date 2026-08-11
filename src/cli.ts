#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename } from "node:path";
import {
	projectGoalSelectionError,
	projectWorklistMergeRequiredError,
	type WorklistApplicationFailure,
	type WorklistApplicationResult,
	WorklistApplicationService,
	type WorklistOperation,
} from "./application-service.ts";
import {
	CLI_COMMAND_CONTRACT,
	type CliFlagContract,
	renderCliUsage,
	WORKLIST_PATH_ENV,
} from "./cli-contract.ts";
import {
	dependencyWaves,
	dependentGoals,
	type GoalDependency,
	isGoalBlocked,
	nextGoal,
	readyGoals,
	resolveDependencies,
	unfinishedGoals,
} from "./dependencies.ts";
import { goalCount } from "./format.ts";
import {
	createWorklistLocator,
	resolveGitRoot,
	resolveWorklistLocation,
	shadowedWorklistWarning,
	type WorklistLocation,
} from "./git.ts";
import {
	matchesGoalQuery,
	planGoalIdMigration,
	resolveGoalSelector,
	slugifyGoalTitle,
} from "./goal-selection.ts";
import { WORKLIST_ERROR_CODES, type WorklistErrorCode, type WorklistResultMeta } from "./result-envelope.ts";
import { runGoalBoard } from "./tui/goal-board-runtime.ts";
import { singleLine } from "./tui/text.ts";
import type {
	GoalIdMigration,
	ProjectGoal,
	ProjectGoalPlacement,
	ProjectPlanWarning,
	WorklistOperationResult,
} from "./types.ts";

/**
 * Command line entry point for Project Goals, driving the repository's goal file
 * through the same mutation service, cross-process lock, and atomic replacement
 * every other interface uses.
 *
 * Nothing reachable from here may import a Pi package: the compiled bin has to
 * run with only Node and the declared runtime dependencies.
 *
 * Which goal file this operates on comes from `resolveWorklistLocation`, the one
 * resolution order every interface shares, rather than from anything decided here.
 *
 * Session Tasks are out of scope here because they live inside a Pi session tree
 * rather than in the repository.
 */

const LIFECYCLE_ACTIONS = ["complete", "reopen", "archive", "delete"] as const;
type LifecycleAction = (typeof LIFECYCLE_ACTIONS)[number];

const COMPACT_TITLE_LIMIT = 96;

const packageVersion = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

/**
 * The second worklist this invocation resolved past, once resolution has run.
 *
 * It sits beside the version rather than being threaded through every command,
 * because it belongs to every envelope this process emits - including the
 * failure envelope thrown from a call site that never saw the location.
 */
let shadowedWorklistPath: string | undefined;
const USAGE = renderCliUsage();

interface CliInvocation {
	scope: string;
	action: string;
	rest: string[];
	/** Replacement text from --description or the interactive `--` separator. */
	description?: string;
	/** Additive text carried directly by --append-description. */
	appendDescription?: string;
	/** Treat text after the interactive `--` separator as an addition rather than a replacement. */
	append: boolean;
	/** Free-form section name; the empty string clears the goal's group. */
	group?: string;
	/** Goals that must land first, as written; an empty entry clears every edge. */
	dependsOn?: string[];
	expectedUpdatedAt?: string;
	/** Report what a mutation would do without writing it. */
	dryRun: boolean;
	json: boolean;
	confirm: boolean;
	cwd: string;
	/** An explicit goal file from --file, which outranks every other resolution rule. */
	file?: string;
	/** Flag names as written, so action-scoped flags can be refused where they would be ignored. */
	flagsUsed: ReadonlySet<string>;
	/** Positionals written after the --description value, which a title must not be built from. */
	positionalsAfterDescription: number;
	/** Positionals written after the --append-description value, which a title must not be built from. */
	positionalsAfterAppendDescription: number;
}

interface CliResultMeta extends WorklistResultMeta {
	cliVersion: string;
}

type CliResultEnvelope = WorklistApplicationResult & {
	meta: CliResultMeta;
};

function fail(message: string, code: number): never {
	process.stderr.write(`${message}\n`);
	process.exit(code);
}

function exitCodeForError(code: WorklistErrorCode): number {
	if (code === WORKLIST_ERROR_CODES.APPROVAL_REQUIRED) return 3;
	if (code === WORKLIST_ERROR_CODES.CONFLICT) return 4;
	return 1;
}

const GLOBAL_FLAGS_BY_NAME: ReadonlyMap<string, CliFlagContract> = new Map(
	CLI_COMMAND_CONTRACT.flags.map((flag) => [flag.name, flag]),
);

/**
 * Find the interactive description separator without mistaking a literal `--`
 * carried by a description flag for that separator.
 */
function findDescriptionSeparator(argv: readonly string[]): number {
	for (let index = 0; index < argv.length; index++) {
		const part = argv[index];
		if (part === "--description" || part === "--append-description") {
			index++;
			continue;
		}
		if (part === "--") return index;
	}
	return -1;
}

/**
 * Rejects a known flag after the interactive `--` separator.
 *
 * Standalone flag-looking prose remains valid through --description and
 * --append-description, where one argv token is unambiguously the value.
 */
function rejectMisplacedFlags(tokens: readonly string[]): void {
	const names = [...new Set(tokens)].filter((token) => GLOBAL_FLAGS_BY_NAME.has(token));
	if (names.length === 0) return;
	const subject = names.length === 1 ? "a standalone flag" : "standalone flags";
	fail(
		`${names.join(", ")} came after --, where known flags are not accepted as description text.\n` +
			`Use --description <text> to replace, or --append-description <text> to add, a description that contains ${subject}; reserve -- for interactive prose.\n\n${USAGE}`,
		2,
	);
}

/**
 * Refuses an action-scoped flag on an action that would ignore it.
 *
 * The scopes come from the same contract entry the help text and skill render,
 * so a flag can never be quietly dropped by a command they said would honor it.
 */
function validateFlagActions(invocation: CliInvocation): void {
	for (const flag of CLI_COMMAND_CONTRACT.flags) {
		if (!flag.actions || !invocation.flagsUsed.has(flag.name)) continue;
		if (flag.actions.includes(invocation.action)) continue;
		fail(
			`${flag.name} is only supported by ${CLI_COMMAND_CONTRACT.scope} ${flag.actions.join(", ")}\n\n${USAGE}`,
			2,
		);
	}
}

function readFlagValue(head: readonly string[], index: number, flag: string, expected: string): string {
	const value = head[index + 1];
	if (!value || value.startsWith("--")) fail(`${flag} requires ${expected}\n\n${USAGE}`, 2);
	return value;
}

/** A whole description carried in exactly one argv token, even when it looks like a flag. */
function readDescriptionFlagValue(head: readonly string[], index: number, flag: string): string {
	const value = head[index + 1];
	if (value === undefined) fail(`${flag} requires one text argument\n\n${USAGE}`, 2);
	return value;
}

/**
 * A flag value that may be empty, which is how a caller clears the field.
 *
 * A missing value is still a usage error: `--group` with nothing after it is a
 * caller who meant to name a section, not one who meant to remove it.
 */
function readClearableFlagValue(
	head: readonly string[],
	index: number,
	flag: string,
	expected: string,
): string {
	const value = head[index + 1];
	if (value === undefined || value.startsWith("--")) fail(`${flag} requires ${expected}\n\n${USAGE}`, 2);
	return value;
}

interface ParsedCliHead {
	positionals: string[];
	flagsUsed: Set<string>;
	dependsOn: string[];
	/** Positionals written after the --description value, which a title must not be built from. */
	positionalsAfterDescription: number;
	/** Positionals written after the --append-description value, which a title must not be built from. */
	positionalsAfterAppendDescription: number;
	directDescription?: string;
	appendDescription?: string;
	append: boolean;
	dryRun: boolean;
	group?: string;
	expectedUpdatedAt?: string;
	json: boolean;
	confirm: boolean;
	cwd: string;
	file?: string;
}

function parseCliHead(head: readonly string[]): ParsedCliHead {
	const positionals: string[] = [];
	const flagsUsed = new Set<string>();
	const dependsOn: string[] = [];
	let json = false;
	let confirm = false;
	let append = false;
	let dryRun = false;
	let directDescription: string | undefined;
	let appendDescription: string | undefined;
	let group: string | undefined;
	let expectedUpdatedAt: string | undefined;
	let cwd = process.cwd();
	let file: string | undefined;
	const positionalsBeforeFlag = new Map<string, number>();
	for (let index = 0; index < head.length; index++) {
		const part = head[index];
		if (!part.startsWith("--")) {
			positionals.push(part);
			continue;
		}
		flagsUsed.add(part);
		switch (part) {
			case "--json":
				json = true;
				break;
			case "--confirm":
				confirm = true;
				break;
			case "--append":
				append = true;
				break;
			case "--dry-run":
				dryRun = true;
				break;
			case "--description":
				if (directDescription !== undefined) fail(`--description may be provided only once\n\n${USAGE}`, 2);
				directDescription = readDescriptionFlagValue(head, index, part);
				positionalsBeforeFlag.set(part, positionals.length);
				index++;
				break;
			case "--append-description":
				if (appendDescription !== undefined) {
					fail(`--append-description may be provided only once\n\n${USAGE}`, 2);
				}
				appendDescription = readDescriptionFlagValue(head, index, part);
				positionalsBeforeFlag.set(part, positionals.length);
				index++;
				break;
			case "--cwd":
				cwd = readFlagValue(head, index, part, "a directory");
				index++;
				break;
			case "--file":
				file = readFlagValue(head, index, part, "a goal file path");
				index++;
				break;
			case "--group":
				group = readClearableFlagValue(head, index, part, "a section name, or '' to clear it");
				index++;
				break;
			case "--depends-on":
				dependsOn.push(readClearableFlagValue(head, index, part, "a goal id, or '' to clear every edge"));
				index++;
				break;
			case "--expect-updated-at":
				expectedUpdatedAt = readFlagValue(head, index, part, "a timestamp");
				index++;
				break;
			default:
				fail(`Unknown flag ${part}\n\n${USAGE}`, 2);
		}
	}

	// An empty id means "no dependencies at all", which contradicts naming one, so
	// the combination is refused rather than resolved into whichever the caller
	// wrote last: both readings silently discard something they asked for.
	if (dependsOn.some((entry) => entry.trim() === "") && dependsOn.length > 1) {
		fail(`--depends-on '' clears every edge and cannot be combined with another --depends-on\n\n${USAGE}`, 2);
	}
	const positionalsAfter = (flag: string): number => {
		const before = positionalsBeforeFlag.get(flag);
		return before === undefined ? 0 : positionals.length - before;
	};
	return {
		positionals,
		flagsUsed,
		dependsOn,
		positionalsAfterDescription: positionalsAfter("--description"),
		positionalsAfterAppendDescription: positionalsAfter("--append-description"),
		directDescription,
		appendDescription,
		append,
		dryRun,
		group,
		expectedUpdatedAt,
		json,
		confirm,
		cwd,
		file,
	};
}

function validateDescriptionInputs(parsed: ParsedCliHead, hasSeparatorDescription: boolean): void {
	if (parsed.directDescription !== undefined && hasSeparatorDescription) {
		fail(`--description cannot be combined with description text after --\n\n${USAGE}`, 2);
	}
	if (parsed.appendDescription !== undefined && hasSeparatorDescription) {
		fail(`--append-description cannot be combined with description text after --\n\n${USAGE}`, 2);
	}
	if (parsed.directDescription !== undefined && parsed.appendDescription !== undefined) {
		fail(`--description and --append-description are mutually exclusive\n\n${USAGE}`, 2);
	}
	if (parsed.append && parsed.directDescription !== undefined) {
		fail(`--append cannot be combined with --description; use --append-description <text>\n\n${USAGE}`, 2);
	}
	if (parsed.append && parsed.appendDescription !== undefined) {
		fail(
			`--append and --append-description are alternative append forms and cannot be combined\n\n${USAGE}`,
			2,
		);
	}
}

function parseArgs(argv: string[]): CliInvocation {
	const separator = findDescriptionSeparator(argv);
	const head = separator === -1 ? argv : argv.slice(0, separator);
	const descriptionTokens = separator === -1 ? [] : argv.slice(separator + 1);
	rejectMisplacedFlags(descriptionTokens);
	const parsed = parseCliHead(head);
	const hasSeparatorDescription = separator !== -1;
	validateDescriptionInputs(parsed, hasSeparatorDescription);
	const { positionals, directDescription, dependsOn, ...carried } = parsed;
	const [scope, action, ...rest] = positionals;
	if (!scope || !action) fail(USAGE, 2);
	return {
		...carried,
		scope,
		action,
		rest,
		description: directDescription ?? (hasSeparatorDescription ? descriptionTokens.join(" ") : undefined),
		...(carried.flagsUsed.has("--depends-on")
			? { dependsOn: dependsOn.filter((entry) => entry.trim() !== "") }
			: {}),
	};
}

interface ProjectLocation {
	/** Canonical git root, whose basename names the repository in the board header. */
	root: string;
	/** The goal file this invocation reads and writes, and how it was chosen. */
	worklist: WorklistLocation;
}

function resolveProjectLocation(invocation: CliInvocation): ProjectLocation {
	const result = resolveGitRoot(invocation.cwd);
	if (!result.isGit || !result.root) {
		throw new WorklistCliFailure({
			ok: false,
			scope: "project",
			action: invocation.action,
			error: {
				code: WORKLIST_ERROR_CODES.UNAVAILABLE,
				message: "Project goals require a git repository. Run inside a repository or pass --cwd <dir>.",
				retryable: false,
				details: { resolution: "run-inside-git-repository" },
			},
			meta: { changed: false, semanticNoOp: false, changedFields: [] },
		});
	}
	const worklist = resolveWorklistLocation(result.root, { override: invocation.file, env: process.env });
	// Every command reports it, because two roadmaps in a repository is a standing
	// condition rather than one command's outcome. A human reads it on stderr; a
	// `--json` caller reads it in `meta.shadowedWorklistPath`, because stderr is
	// where the failure envelope goes and a sentence in front of it would leave
	// that caller with nothing it can parse.
	shadowedWorklistPath = worklist.shadowedPath;
	const warning = shadowedWorklistWarning(worklist);
	if (warning && !invocation.json) process.stderr.write(`${warning}\n`);
	return { root: result.root, worklist };
}

function requireId(invocation: CliInvocation): string {
	const id = invocation.rest[0];
	if (!id) fail(`project ${invocation.action} requires a goal id\n\n${USAGE}`, 2);
	return id;
}

function compactTitle(title: string): string {
	const flattened = singleLine(title);
	if (flattened.length <= COMPACT_TITLE_LIMIT) return flattened;
	return `${flattened.slice(0, COMPACT_TITLE_LIMIT - 1)}…`;
}

/** Compact bounded list line: one goal per line, no descriptions. */
function formatGoalLine(goal: ProjectGoal): string {
	return `[${goal.status}] ${goal.id}: ${compactTitle(goal.title)}`;
}

function formatGoalList(goals: ProjectGoal[]): string {
	if (goals.length === 0) return "No project goals.";
	return goals.map(formatGoalLine).join("\n");
}

/**
 * Why the frontier is empty, which is three different answers.
 *
 * An empty roadmap, a finished one, and one where everything is waiting all
 * print no goals, and a driver told only "nothing is ready" cannot tell the end
 * of the work from a jam it needs to clear.
 */
function formatEmptyFrontier(goals: readonly ProjectGoal[]): string {
	if (goals.length === 0) return "No project goals.";
	const unfinished = unfinishedGoals(goals).length;
	if (unfinished === 0) return "No project goal is ready; every goal is done or archived.";
	return `No project goal is ready; ${goalCount(unfinished)} unfinished, all blocked or already claimed.`;
}

/**
 * A wave member, with the branch that claimed it when one did.
 *
 * The branch is flattened like every other goal field this format renders,
 * because the layers are read one goal per line: a stored newline would break a
 * member in half and the tail would read as another goal, or as a wave header.
 */
function formatWaveGoalLine(goal: ProjectGoal): string {
	return `  ${formatGoalLine(goal)}${goal.branch === undefined ? "" : ` (branch ${singleLine(goal.branch)})`}`;
}

/**
 * The layers, and then the goals no layer could hold.
 *
 * Unreachable goals are printed last and named as such rather than omitted: a
 * goal missing from the schedule is a goal nobody notices is stuck.
 */
function formatWaves(
	goals: readonly ProjectGoal[],
	waves: readonly ProjectGoal[][],
	unreachable: readonly ProjectGoal[],
): string {
	if (waves.length === 0 && unreachable.length === 0) {
		if (goals.length === 0) return "No project goals.";
		return "No project goal is waiting; every goal is done or archived.";
	}
	const sections = waves.map((wave, index) =>
		[`Wave ${index + 1} (${goalCount(wave.length)}):`, ...wave.map(formatWaveGoalLine)].join("\n"),
	);
	if (unreachable.length > 0) {
		sections.push(
			[
				`Unreachable (${goalCount(unreachable.length)}), waiting on a cycle or a missing goal:`,
				...unreachable.map(formatWaveGoalLine),
			].join("\n"),
		);
	}
	return sections.join("\n");
}

/**
 * One dependency line: the goal it names, and whether it is still in the way.
 *
 * A dependency the file names but no goal answers to is called out rather than
 * quietly listed, because it can never be satisfied and so blocks its dependent
 * forever; that only happens when the file was edited by hand.
 */
function formatDependencyLine(entry: GoalDependency): string {
	if (!entry.goal) return `  ${entry.id} (missing)`;
	return `  ${entry.id} [${entry.goal.status}]${entry.satisfied ? "" : " - waiting"}`;
}

/**
 * Explicit full-detail read: every stored field, plus what the graph derives.
 *
 * Only `dependsOn` is stored, so the goals this one blocks are computed from the
 * other goals' edges here rather than read from a field that could disagree.
 */
function formatGoalDetail(goal: ProjectGoal, goals: readonly ProjectGoal[]): string {
	const previousIds = goal.previousIds ?? [];
	const links = goal.links ?? [];
	const dependencies = resolveDependencies(goals, goal);
	const blocks = dependentGoals(goals, goal);
	return [
		`${goal.id}: ${goal.title}`,
		`status: ${goal.status}${isGoalBlocked(goals, goal) ? " (blocked)" : ""}`,
		...(goal.group !== undefined ? [`group: ${goal.group}`] : []),
		...(goal.branch !== undefined ? [`branch: ${goal.branch}`] : []),
		`created: ${goal.createdAt}`,
		`updated: ${goal.updatedAt}`,
		...(goal.completedAt !== undefined ? [`completed: ${goal.completedAt}`] : []),
		...(previousIds.length > 0 ? [`former ids: ${previousIds.join(", ")}`] : []),
		...(dependencies.length > 0 ? ["depends on:", ...dependencies.map(formatDependencyLine)] : []),
		...(blocks.length > 0 ? ["blocks:", ...blocks.map((blocked) => `  ${blocked.id}`)] : []),
		...(links.length > 0 ? ["links:", ...links.map((link) => `  ${link}`)] : []),
		...(goal.description !== undefined ? ["description:", goal.description] : []),
	].join("\n");
}

/** Sub-argument forms of `move`, each naming exactly one canonical placement. */
const MOVE_USAGE = "project move <id> up|down|before <anchor-id>|after <anchor-id>";

/**
 * The placement a `move` invocation names.
 *
 * `up` and `down` take no anchor and are resolved under the lock, while
 * `before` and `after` require one, so a mistyped form is a usage error rather
 * than a move to a position the caller never named.
 */
function readMovePlacement(invocation: CliInvocation): ProjectGoalPlacement {
	const [mode, anchor, ...extra] = invocation.rest.slice(1);
	if (extra.length > 0) fail(`${MOVE_USAGE} takes one placement\n\n${USAGE}`, 2);
	if (mode === "up" || mode === "down") {
		if (anchor !== undefined) fail(`${MOVE_USAGE}: ${mode} takes no anchor\n\n${USAGE}`, 2);
		return { direction: mode };
	}
	if (mode === "before" || mode === "after") {
		if (!anchor) fail(`${MOVE_USAGE}: ${mode} requires an anchor goal id\n\n${USAGE}`, 2);
		return mode === "before" ? { beforeId: anchor } : { afterId: anchor };
	}
	fail(`${MOVE_USAGE}\n\n${USAGE}`, 2);
}

function formatMigrations(migrations: readonly GoalIdMigration[], headline: string): string {
	if (migrations.length === 0) return "No goal IDs need migration.";
	return [headline, ...migrations.map((migration) => `  ${migration.from} -> ${migration.to}`)].join("\n");
}

function planInputFailure(message: string, details: Record<string, unknown>): WorklistCliFailure {
	return new WorklistCliFailure({
		ok: false,
		scope: "project",
		action: "apply-plan",
		error: {
			code: WORKLIST_ERROR_CODES.VALIDATION_FAILED,
			message,
			retryable: false,
			details,
		},
		meta: { changed: false, semanticNoOp: false, changedFields: [] },
	});
}

async function readPlanDocument(path: string): Promise<unknown> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		throw planInputFailure(`Cannot read project plan ${path}.`, {
			path,
			resolution: "provide-readable-json-plan",
		});
	}
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw planInputFailure(`Project plan ${path} is not valid JSON.`, {
			path,
			resolution: "fix-json-plan",
		});
	}
}

function formatPlanResult(
	addedGoals: readonly ProjectGoal[],
	dryRun: boolean,
	revision: string | undefined,
): string {
	if (addedGoals.length === 0)
		return dryRun ? "Plan is valid and would add no goals." : "Plan added no goals.";
	const headline = dryRun
		? `Would add ${addedGoals.length} project goal(s); revision ${revision ?? "unknown"} is unchanged:`
		: `Applied ${addedGoals.length} project goal(s) at revision ${revision ?? "unknown"}:`;
	return [headline, ...addedGoals.map((goal) => `  ${slugifyGoalTitle(goal.title)} -> ${goal.id}`)].join(
		"\n",
	);
}

function formatPlanWarning(warning: ProjectPlanWarning): string {
	return (
		`Warning: batch dependency ${warning.reference} resolves to new goal ${warning.batchGoalId}, ` +
		`shadowing existing goal ${warning.existingGoalId}.`
	);
}

/** A failed operation, carrying the full deterministic failure envelope for --json output. */
class WorklistCliFailure extends Error {
	readonly envelope: WorklistApplicationFailure;

	constructor(envelope: WorklistApplicationFailure) {
		super(envelope.error.message);
		this.name = envelope.error.code;
		this.envelope = envelope;
	}
}

async function executeCliOperation(
	service: WorklistApplicationService,
	operation: WorklistOperation,
): Promise<WorklistApplicationResult> {
	const envelope = await service.execute(operation, { source: "cli" });
	if (!envelope.ok) throw new WorklistCliFailure(envelope);
	return envelope;
}

/** The goals a read action works over, listed through the shared service. */
async function readGoals(service: WorklistApplicationService): Promise<{
	goals: ProjectGoal[];
	meta: WorklistResultMeta;
}> {
	const envelope = await executeCliOperation(service, { scope: "project", action: "list" });
	return { goals: (envelope.ok ? envelope.result.goals : undefined) ?? [], meta: envelope.meta };
}

async function readProjectSnapshot(
	service: WorklistApplicationService,
	action: string,
): Promise<{ goals: ProjectGoal[]; retiredIds: string[]; meta: WorklistResultMeta }> {
	const envelope = await service.readProjectSnapshot(action);
	if (!envelope.ok) throw new WorklistCliFailure(envelope);
	return {
		goals: envelope.result.goals ?? [],
		retiredIds: envelope.result.retiredIds ?? [],
		meta: envelope.meta,
	};
}

/**
 * The goal a read action's `<id>` argument names.
 *
 * Reads resolve here rather than in the application service because they never
 * mutate, but they resolve through the same function and report the same typed
 * failures, so a prefix or a former ID means exactly what it means everywhere.
 */
function selectGoal(
	goals: readonly ProjectGoal[],
	selector: string,
	action: string,
	retiredIds: readonly string[] = [],
): ProjectGoal {
	const resolution = resolveGoalSelector(goals, selector, retiredIds);
	if (resolution.kind === "found") return resolution.goal;
	throw new WorklistCliFailure({
		ok: false,
		scope: "project",
		action,
		error: projectGoalSelectionError(selector, resolution).toResultError(),
		meta: { changed: false, semanticNoOp: false, changedFields: [] },
	});
}

/** A read-only envelope over goals the CLI selected itself, in the shared shape. */
function readEnvelope(
	action: string,
	result: WorklistOperationResult,
	meta: WorklistResultMeta,
): WorklistApplicationResult {
	return { ok: true, scope: "project", action, result, meta };
}

function report(invocation: CliInvocation, envelope: WorklistApplicationResult, message: string): void {
	if (invocation.json) {
		process.stdout.write(`${JSON.stringify(withCliMetadata(envelope), null, 2)}\n`);
		return;
	}
	process.stdout.write(`${message}\n`);
}

function withCliMetadata(envelope: WorklistApplicationResult): CliResultEnvelope {
	return {
		...envelope,
		meta: {
			...envelope.meta,
			cliVersion: packageVersion,
			...(shadowedWorklistPath ? { shadowedWorklistPath } : {}),
		},
	};
}

async function runLifecycle(
	invocation: CliInvocation,
	service: WorklistApplicationService,
	action: LifecycleAction,
): Promise<void> {
	const id = requireId(invocation);
	const envelope = await executeCliOperation(service, {
		scope: "project",
		action,
		id,
		confirm: invocation.confirm,
		expectedUpdatedAt: invocation.expectedUpdatedAt,
	});
	if (action === "delete") {
		report(invocation, envelope, `Deleted project goal ${id}`);
		return;
	}
	const goal = envelope.ok ? envelope.result.goal : undefined;
	if (!goal) throw new Error(`Project goal ${id} was not returned after ${action}`);
	report(invocation, envelope, `Project goal ${goal.id} is now ${goal.status}`);
}

/** Read, validate, and project or atomically apply one plain JSON goal batch. */
async function runApplyPlan(invocation: CliInvocation, service: WorklistApplicationService): Promise<void> {
	if (invocation.rest.length !== 1) {
		fail(`project apply-plan requires exactly one JSON plan path\n\n${USAGE}`, 2);
	}
	const plan = await readPlanDocument(invocation.rest[0]);
	const envelope = await executeCliOperation(service, {
		scope: "project",
		action: "apply-plan",
		plan,
		dryRun: invocation.dryRun,
	});
	const result = envelope.ok ? envelope.result : undefined;
	const addedGoals = result?.addedGoals ?? [];
	const warnings = result?.warnings ?? [];
	if (invocation.dryRun && !invocation.json) {
		for (const warning of warnings) process.stderr.write(`${formatPlanWarning(warning)}\n`);
	}
	report(
		invocation,
		envelope,
		formatPlanResult(addedGoals, invocation.dryRun, envelope.meta.revisions?.project),
	);
}

/**
 * Rewrite generated goal IDs, or report what such a rewrite would do.
 *
 * A dry run plans over a plain read with the same function the mutation runs
 * under the lock, so it stays a preview by construction: it writes nothing,
 * needs no confirmation, and is advisory about a worklist another process may
 * still be changing.
 */
async function runGoalIdMigration(
	invocation: CliInvocation,
	service: WorklistApplicationService,
): Promise<void> {
	if (invocation.dryRun) {
		// Both flags at once asks to write and not to write. Refusing beats
		// honoring one silently, which would read as a migration that ran.
		if (invocation.confirm) {
			fail(`project migrate_ids cannot combine --dry-run with --confirm\n\n${USAGE}`, 2);
		}
		const { goals, retiredIds, meta } = await readProjectSnapshot(service, "migrate_ids");
		const migrations = planGoalIdMigration({ version: 1, goals, retiredIds });
		const result = { scope: "project", action: "migrate_ids", goals, migrations } as const;
		report(
			invocation,
			readEnvelope("migrate_ids", result, meta),
			formatMigrations(migrations, `${migrations.length} goal ID(s) would change:`),
		);
		return;
	}
	const envelope = await executeCliOperation(service, {
		scope: "project",
		action: "migrate_ids",
		confirm: invocation.confirm,
	});
	const migrations = (envelope.ok ? envelope.result.migrations : undefined) ?? [];
	report(invocation, envelope, formatMigrations(migrations, `Migrated ${migrations.length} goal ID(s):`));
}

/** What a path migration did, or would do, in one line. */
function formatPathMigration(from: string | undefined, to: string, dryRun: boolean): string {
	if (from === undefined) return `Project worklist is already at ${to}.`;
	return dryRun
		? `Would move project worklist ${from} to ${to}.`
		: `Moved project worklist ${from} to ${to}.`;
}

/**
 * Move the goal file to the path it should live at, or report the move.
 *
 * The destination is the canonical path rather than anything the caller names,
 * because this exists to retire the legacy location, not to relocate a worklist
 * anywhere someone fancies; `--file` covers naming a file outright.
 */
async function runPathMigration(
	invocation: CliInvocation,
	service: WorklistApplicationService,
	worklist: WorklistLocation,
): Promise<void> {
	// Both flags at once asks to write and not to write, the same contradiction
	// migrate_ids refuses rather than honoring one of them silently.
	if (invocation.dryRun && invocation.confirm) {
		fail(`project migrate_path cannot combine --dry-run with --confirm\n\n${USAGE}`, 2);
	}
	if (worklist.source === "override") {
		fail(
			`project migrate_path moves the file a repository resolves to, and this run named one outright.\n` +
				`Drop --file and $${WORKLIST_PATH_ENV} to migrate the repository's own goal file.\n\n${USAGE}`,
			2,
		);
	}
	// Two files are two roadmaps. Moving one onto the other is the data loss the
	// warning on every command is there to prevent, and merging them is a
	// decision about which goals survive that only their owner can make.
	if (worklist.shadowedPath) {
		throw new WorklistCliFailure({
			ok: false,
			scope: "project",
			action: "migrate_path",
			error: projectWorklistMergeRequiredError(worklist.path, worklist.shadowedPath).toResultError(),
			meta: { changed: false, semanticNoOp: false, changedFields: [] },
		});
	}
	const from = worklist.path === worklist.currentPath ? undefined : worklist.path;
	if (invocation.dryRun) {
		const { meta } = await readProjectSnapshot(service, "migrate_path");
		const result = {
			scope: "project",
			action: "migrate_path",
			dryRun: true,
			worklistPath: worklist.currentPath,
			...(from !== undefined ? { previousWorklistPath: from } : {}),
		} as const;
		report(
			invocation,
			readEnvelope("migrate_path", result, meta),
			formatPathMigration(from, worklist.currentPath, true),
		);
		return;
	}
	const envelope = await executeCliOperation(service, {
		scope: "project",
		action: "migrate_path",
		targetPath: worklist.currentPath,
		confirm: invocation.confirm,
	});
	const moved = envelope.ok ? envelope.result.previousWorklistPath : undefined;
	report(invocation, envelope, formatPathMigration(moved, worklist.currentPath, false));
}

async function runSetActive(invocation: CliInvocation, service: WorklistApplicationService): Promise<void> {
	const id = requireId(invocation);
	try {
		const envelope = await executeCliOperation(service, {
			scope: "project",
			action: "set_active",
			id,
			expectedUpdatedAt: invocation.expectedUpdatedAt,
		});
		const goal = envelope.ok ? envelope.result.goal : undefined;
		if (!goal) throw new Error(`Activated Project Goal ${id} was not returned`);
		// A warning, not a refusal: the activation already happened, and someone who
		// says a blocked goal is the one in flight may know something the edges do
		// not. It goes to stderr so it cannot be mistaken for the command's output.
		const blockedBy = (envelope.ok ? envelope.result.blockedBy : undefined) ?? [];
		if (blockedBy.length > 0 && !invocation.json) {
			process.stderr.write(
				`Warning: ${goal.id} is blocked; ${blockedBy.join(", ")} ${blockedBy.length === 1 ? "has" : "have"} not landed yet.\n`,
			);
		}
		report(invocation, envelope, `Activated project goal ${goal.id}`);
	} catch (error) {
		if (
			error instanceof WorklistCliFailure &&
			error.envelope.error.details?.resolution === "reopen-project-goal" &&
			!invocation.json
		) {
			fail(
				`${error.message} Reopen it first: ${CLI_COMMAND_CONTRACT.binary} project reopen ${id} --confirm`,
				exitCodeForError(error.envelope.error.code),
			);
		}
		throw error;
	}
}

/**
 * Open the full-screen goal board.
 *
 * The board owns the terminal, so it is refused wherever there is no human to
 * drive it: piped output, CI, and agent shells are directed to `list --json`,
 * the machine-readable read path.
 */
async function runInteractiveBoard(
	invocation: CliInvocation,
	service: WorklistApplicationService,
	location: ProjectLocation,
): Promise<void> {
	if (invocation.json) {
		fail(`project ui is interactive and cannot be combined with --json\n\n${USAGE}`, 2);
	}
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		fail(
			`project ui needs an interactive terminal. Use '${CLI_COMMAND_CONTRACT.binary} project list --json' in scripts and agents.`,
			1,
		);
	}
	// Surface a malformed or unreadable worklist through the normal failure path
	// rather than opening an empty board over a file that could not be read.
	const envelope = await executeCliOperation(service, { scope: "project", action: "list" });
	// Every other command resolves once and exits before the answer can go stale.
	// The board holds the terminal until the user quits, so it is handed the
	// resolution instead: a `migrate_path` in another terminal moves the goal
	// file, and a board still writing to the old path would recreate it beside
	// the migrated one. The board takes the whole screen, so the warning already
	// written to stderr is on a buffer the user will not see again until they
	// quit; it travels with the path. `runGoalBoard` points the service at this
	// same locator, so what the board shows and what it writes cannot come apart.
	await runGoalBoard({
		service,
		resolveLocation: createWorklistLocator(location.root, {
			override: invocation.file,
			env: process.env,
		}),
		repositoryLabel: basename(location.root),
		initialGoals: (envelope.ok ? envelope.result.goals : undefined) ?? [],
		input: process.stdin,
		output: process.stdout,
		env: process.env,
	});
}

async function run(invocation: CliInvocation): Promise<void> {
	if (invocation.scope !== "project") {
		if (invocation.scope === "session") {
			fail("Session Tasks live inside a Pi session and cannot be managed externally. Use /tasks in Pi.", 2);
		}
		fail(`Unknown scope ${invocation.scope}\n\n${USAGE}`, 2);
	}
	validateFlagActions(invocation);
	if (invocation.action === "help") {
		process.stdout.write(`${USAGE}\n`);
		return;
	}
	const location = resolveProjectLocation(invocation);
	const service = new WorklistApplicationService({ projectPath: location.worklist.path });

	switch (invocation.action) {
		case "ui":
			await runInteractiveBoard(invocation, service, location);
			return;
		case "list": {
			const envelope = await executeCliOperation(service, { scope: "project", action: "list" });
			const goals = (envelope.ok ? envelope.result.goals : undefined) ?? [];
			report(invocation, envelope, formatGoalList(goals));
			return;
		}
		case "show": {
			const selector = requireId(invocation);
			const { goals, retiredIds, meta } = await readProjectSnapshot(service, "show");
			const goal = selectGoal(goals, selector, "show", retiredIds);
			const detail = {
				scope: "project",
				action: "show",
				goal,
				blocked: isGoalBlocked(goals, goal, retiredIds),
				blocks: dependentGoals(goals, goal, retiredIds).map((dependent) => dependent.id),
			} as const;
			report(invocation, readEnvelope("show", detail, meta), formatGoalDetail(goal, goals));
			return;
		}
		case "find": {
			const query = invocation.rest.join(" ").trim();
			if (!query) fail(`project find requires search text\n\n${USAGE}`, 2);
			const { goals, meta } = await readGoals(service);
			const matches = goals.filter((goal) => matchesGoalQuery(goal, query));
			const result = { scope: "project", action: "find", goals: matches } as const;
			const message = matches.length === 0 ? `No project goals match ${query}.` : formatGoalList(matches);
			report(invocation, readEnvelope("find", result, meta), message);
			return;
		}
		case "next": {
			const { goals, retiredIds, meta } = await readProjectSnapshot(service, "next");
			const goal = nextGoal(goals, retiredIds);
			// An empty frontier is an answer, not a failure: reporting it as one would
			// make a driver loop read a finished roadmap as a broken command.
			const result = { scope: "project", action: "next", ...(goal ? { goal } : {}) } as const;
			const message = goal ? formatGoalLine(goal) : formatEmptyFrontier(goals);
			report(invocation, readEnvelope("next", result, meta), message);
			return;
		}
		case "ready": {
			const { goals, retiredIds, meta } = await readProjectSnapshot(service, "ready");
			const ready = readyGoals(goals, retiredIds);
			const result = { scope: "project", action: "ready", goals: ready } as const;
			const message = ready.length === 0 ? formatEmptyFrontier(goals) : formatGoalList(ready);
			report(invocation, readEnvelope("ready", result, meta), message);
			return;
		}
		case "waves": {
			const { goals, retiredIds, meta } = await readProjectSnapshot(service, "waves");
			const { waves, unreachable } = dependencyWaves(goals, retiredIds);
			const result = {
				scope: "project",
				action: "waves",
				waves,
				...(unreachable.length > 0 ? { unreachableGoals: unreachable } : {}),
			} as const;
			report(invocation, readEnvelope("waves", result, meta), formatWaves(goals, waves, unreachable));
			return;
		}
		case "apply-plan": {
			await runApplyPlan(invocation, service);
			return;
		}
		case "migrate_ids": {
			await runGoalIdMigration(invocation, service);
			return;
		}
		case "migrate_path": {
			await runPathMigration(invocation, service, location.worklist);
			return;
		}
		case "add": {
			const title = invocation.rest.join(" ").trim();
			if (!title) fail(`project add requires a title\n\n${USAGE}`, 2);
			// A title written on both sides of the --description value is prose that ran
			// past the flag's single token, never a title someone split on purpose.
			if (
				invocation.positionalsAfterDescription > 0 &&
				invocation.positionalsAfterDescription < invocation.rest.length
			) {
				fail(
					`project add reads the words after a --description value as more of the title, so this would split the title across the flag.\n` +
						`Keep the whole title on one side of --description, and pass the whole description as one argument.\n\n${USAGE}`,
					2,
				);
			}
			const description = invocation.description?.trim() || undefined;
			const envelope = await executeCliOperation(service, {
				scope: "project",
				action: "add",
				title,
				description,
				group: invocation.group,
				dependsOn: invocation.dependsOn,
			});
			const goal = envelope.ok ? envelope.result.goal : undefined;
			if (!goal) throw new Error("Added Project Goal was not returned");
			report(invocation, envelope, `Added project goal ${goal.id}: ${goal.title}`);
			return;
		}
		case "move": {
			const id = requireId(invocation);
			const placement = readMovePlacement(invocation);
			const envelope = await executeCliOperation(service, {
				scope: "project",
				action: "move",
				id,
				...placement,
			});
			const goal = envelope.ok ? envelope.result.goal : undefined;
			if (!goal) throw new Error(`Moved Project Goal ${id} was not returned`);
			const message = envelope.meta.changed
				? `Moved project goal ${goal.id}`
				: `Project goal ${goal.id} is already there`;
			report(invocation, envelope, message);
			return;
		}
		case "update": {
			const id = requireId(invocation);
			const title = invocation.rest.slice(1).join(" ").trim() || undefined;
			const appendedText =
				invocation.appendDescription ?? (invocation.append ? invocation.description : undefined);
			if (invocation.append && !invocation.description?.trim()) {
				fail(`project update --append requires the text to append after --\n\n${USAGE}`, 2);
			}
			if (invocation.appendDescription !== undefined && !invocation.appendDescription.trim()) {
				fail(`project update --append-description requires non-empty text\n\n${USAGE}`, 2);
			}
			// Appending is intentionally description-only. Mixing it with a rename
			// makes a caller's intent ambiguous and breaks the additive primitive.
			if (appendedText !== undefined && title !== undefined) {
				if (invocation.positionalsAfterAppendDescription > 0) {
					fail(
						`project update reads the words after an --append-description value as a new title, so this would rename the goal.\n` +
							`Pass the whole note as one argument; appending never changes the title.\n\n${USAGE}`,
						2,
					);
				}
				fail(`project update cannot change the title while appending to the description\n\n${USAGE}`, 2);
			}
			// --description carries exactly one argv token, so unquoted prose runs past
			// it into the positionals and would arrive here as a rename nobody asked for.
			if (title !== undefined && invocation.positionalsAfterDescription > 0) {
				fail(
					`project update reads the words after a --description value as a new title, so this would rename the goal.\n` +
						`Write a new title before --description, and pass the whole description as one argument.\n\n${USAGE}`,
					2,
				);
			}
			if (
				title === undefined &&
				invocation.description === undefined &&
				invocation.appendDescription === undefined &&
				invocation.group === undefined &&
				invocation.dependsOn === undefined
			) {
				fail(
					`project update requires a new title, --description, --append-description, --group, or --depends-on\n\n${USAGE}`,
					2,
				);
			}
			const envelope = await executeCliOperation(service, {
				scope: "project",
				action: "update",
				id,
				title,
				group: invocation.group,
				dependsOn: invocation.dependsOn,
				...(appendedText !== undefined
					? { appendDescription: appendedText }
					: { description: invocation.description }),
				expectedUpdatedAt: invocation.expectedUpdatedAt,
			});
			const goal = envelope.ok ? envelope.result.goal : undefined;
			if (!goal) throw new Error(`Updated Project Goal ${id} was not returned`);
			report(invocation, envelope, `Updated project goal ${goal.id}`);
			return;
		}
		case "set_active":
			await runSetActive(invocation, service);
			return;
		case "complete":
		case "reopen":
		case "archive":
		case "delete":
			await runLifecycle(invocation, service, invocation.action);
			return;
		default:
			fail(`Unknown project action ${invocation.action}\n\n${USAGE}`, 2);
	}
}

const invocation = parseArgs(process.argv.slice(2));
try {
	await run(invocation);
} catch (error) {
	if (error instanceof WorklistCliFailure) {
		const code = exitCodeForError(error.envelope.error.code);
		if (invocation.json) {
			process.stderr.write(`${JSON.stringify(withCliMetadata(error.envelope), null, 2)}\n`);
			process.exit(code);
		}
		if (error.envelope.error.code === WORKLIST_ERROR_CODES.APPROVAL_REQUIRED) {
			fail(`${error.message} Pass --confirm only when the user explicitly requested this action.`, code);
		}
		fail(error.message, code);
	}
	fail(error instanceof Error ? error.message : String(error), 1);
}
