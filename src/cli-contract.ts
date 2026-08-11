/**
 * The single command contract for the stepstone CLI.
 *
 * CLI usage text, the command reference in docs/cli.md, the installable agent
 * skill in .claude/skills/stepstone/SKILL.md, and agent guidance are all
 * rendered from this structure so they cannot drift from each other or from
 * the implemented command surface.
 */

export interface CliActionContract {
	name: string;
	usage: string;
	summary: string;
	/** Requires --confirm and an explicit user request. */
	confirmRequired?: boolean;
	/** Takes over the terminal until the user quits; agents must never run it. */
	interactive?: boolean;
}

export interface CliFlagContract {
	name: string;
	usage: string;
	summary: string;
	/** Actions the flag applies to. Absent means every action accepts it. */
	actions?: readonly string[];
}

export interface CliExitCodeContract {
	code: number;
	meaning: string;
}

/**
 * The published package name, which is also the bin it installs.
 *
 * The only place the source spells it out. Every other surface reads it back
 * through `CLI_COMMAND_CONTRACT.binary` or interpolates it from here, so a
 * rename cannot leave one generated line naming the package differently from
 * the commands printed beside it. package.json cannot import this, so its
 * `name` and `bin` key hold the one unavoidable copy, and
 * test/compiled-cli.test.ts pins both to this constant.
 */
const BINARY = "stepstone";

/**
 * Directory holding the goal file, and later whatever local state grows beside
 * it: dispatch claims, per-worktree focus, ephemeral board state.
 *
 * A directory rather than a bare dotfile precisely so those have somewhere to
 * live that is not the committed goal file.
 */
export const WORKLIST_DIRECTORY = ".worklist";

/** The goal file's name, the same in the current and the legacy directory. */
export const WORKLIST_FILENAME = "worklist.json";

/**
 * Where the goal file lived when this package was Pi-only.
 *
 * Still read, and still written when it is the only file a repository has, so a
 * Pi checkout keeps working with no migration step. Nothing creates it.
 */
export const LEGACY_WORKLIST_DIRECTORY = ".pi";

/** Repository-relative canonical path, as every generated document spells it. */
export const WORKLIST_RELATIVE_PATH = `${WORKLIST_DIRECTORY}/${WORKLIST_FILENAME}`;

/** Repository-relative legacy path, still read and still documented. */
export const LEGACY_WORKLIST_RELATIVE_PATH = `${LEGACY_WORKLIST_DIRECTORY}/${WORKLIST_FILENAME}`;

/**
 * Environment override naming the goal file outright.
 *
 * Derived from the published binary, like everything else a rename has to move,
 * so the variable cannot come to name a package that no longer exists.
 */
export const WORKLIST_PATH_ENV = `${BINARY.toUpperCase().replaceAll("-", "_")}_WORKLIST`;

/** Repository-relative path of the script that writes every generated artifact. */
export const GENERATOR_PATH = "scripts/generate-docs.ts";

/** Repository-relative path of the generated command reference. */
export const DOCS_PATH = "docs/cli.md";

/**
 * Repository-relative path of the generated agent skill.
 *
 * The directory name is the name agents load the skill by, so it tracks the
 * package rather than being spelled out separately.
 */
export const SKILL_PATH = `.claude/skills/${BINARY}/SKILL.md`;

export const CLI_COMMAND_CONTRACT = {
	binary: BINARY,
	scope: "project",
	intro: `Manage repository-wide Project Goals in <git-root>/${WORKLIST_RELATIVE_PATH} through the same application service, cross-process lock, and atomic replacement as a live Pi session. Session Tasks live inside a Pi session and are deliberately out of scope.`,
	/**
	 * Trigger text agents match against to auto-load the skill. Deliberately
	 * repository-neutral: one skill file serves every checkout, so it must never
	 * assume it was installed alongside this source tree.
	 */
	skillDescription: `Manage ${BINARY} Project Goals (the shared roadmap in a repo's ${WORKLIST_RELATIVE_PATH}) from any Claude session. Use when the user asks to add, list, find, update, activate, complete, reopen, archive, or delete a project goal; apply a JSON goal plan; migrate goal IDs; capture brainstormed ideas or future goals on a project's worklist or roadmap; or ask what to work on next, what is ready or unblocked, what can run in parallel, or how the roadmap's dependency order or waves look.`,
	runtime: {
		/** Node floor for the published compiled bin. Asserted against package.json engines.node. */
		binaryNodeFloor: "20",
		/** Node floor for running src/cli.ts directly, which relies on native type stripping. */
		sourceNodeFloor: "22.18",
	},
	actions: [
		{
			name: "list",
			usage: "list",
			summary: "Show a compact bounded list of project goals",
		},
		{
			name: "show",
			usage: "show <id>",
			summary: "Show one goal with its full description",
		},
		{
			name: "find",
			usage: "find <text...>",
			summary: "List the goals whose title or description contains the text",
		},
		{
			name: "next",
			usage: "next",
			summary: "Show the one goal to start next, the first ready goal in file order",
		},
		{
			name: "ready",
			usage: "ready",
			summary: "List every unblocked, unclaimed open goal: the whole parallel frontier",
		},
		{
			name: "waves",
			usage: "waves",
			summary: "Print unfinished goals in dependency layers, earliest first",
		},
		{
			name: "ui",
			usage: "ui",
			summary: "Open the interactive goal board for a human at the keyboard",
			interactive: true,
		},
		{
			name: "add",
			usage: "add <title...> [--description <text> | -- <description...>]",
			summary: "Add an open goal",
		},
		{
			name: "apply-plan",
			usage: "apply-plan <plan.json>",
			summary: "Validate and atomically add every goal in a JSON plan",
		},
		{
			name: "update",
			usage: "update <id> [title...] [--description <text> | -- <description...>]",
			summary: "Edit a goal's title or description",
		},
		{
			name: "move",
			usage: "move <id> up|down|before <id>|after <id>",
			summary: "Reorder a goal in the roadmap's canonical file order",
		},
		{
			name: "set_active",
			usage: "set_active <id>",
			summary: "Make a goal the single active goal",
		},
		{
			name: "complete",
			usage: "complete <id> --confirm",
			summary: "Mark a goal done",
			confirmRequired: true,
		},
		{
			name: "reopen",
			usage: "reopen <id> --confirm",
			summary: "Reopen a done or archived goal",
			confirmRequired: true,
		},
		{
			name: "archive",
			usage: "archive <id> --confirm",
			summary: "Archive a goal",
			confirmRequired: true,
		},
		{
			name: "delete",
			usage: "delete <id> --confirm",
			summary: "Delete a goal permanently",
			confirmRequired: true,
		},
		{
			name: "migrate_ids",
			usage: "migrate_ids --confirm",
			summary: "Rewrite randomly generated goal IDs as title-derived ones",
			confirmRequired: true,
		},
		{
			name: "migrate_path",
			usage: "migrate_path --confirm",
			summary: `Move the goal file from the legacy path to ${WORKLIST_RELATIVE_PATH}`,
			confirmRequired: true,
		},
		{
			name: "help",
			usage: "help",
			summary: "Print this help",
		},
	] satisfies CliActionContract[],
	flags: [
		{
			name: "--json",
			usage: "--json",
			summary: "Print the deterministic result envelope as JSON (stdout on success, stderr on failure)",
		},
		{
			name: "--confirm",
			usage: "--confirm",
			summary: "Acknowledge an action that requires confirmation; pass it only for an explicit user request",
		},
		{
			name: "--cwd",
			usage: "--cwd <dir>",
			summary: "Resolve the git root from this directory instead of the working directory",
		},
		{
			name: "--file",
			usage: "--file <path>",
			summary: `Read and write this goal file instead of the one the repository resolves to, overriding $${WORKLIST_PATH_ENV}`,
		},
		{
			name: "--description",
			usage: "--description <text>",
			summary:
				"Set the whole description from one argv token; order-independent and preferred for agents and scripts; a new update title must come before it, and an add title must not straddle it",
			actions: ["add", "update"],
		},
		{
			name: "--append-description",
			usage: "--append-description <text>",
			summary:
				"Add one argv token as a new description paragraph without replacing stored prose; cannot be combined with a title change",
			actions: ["update"],
		},
		{
			name: "--append",
			usage: "--append",
			summary:
				"Interactive compatibility form that adds the text after -- as a new paragraph; cannot be combined with a title change",
			actions: ["update"],
		},
		{
			name: "--group",
			usage: "--group <name>",
			summary: "Put the goal in a free-form section, such as Foundation; an empty name clears it",
			actions: ["add", "update"],
		},
		{
			name: "--depends-on",
			usage: "--depends-on <id>",
			summary:
				"Require that goal to land first; repeat it to name several, and pass an empty id alone to clear every edge",
			actions: ["add", "update"],
		},
		{
			name: "--expect-updated-at",
			usage: "--expect-updated-at <timestamp>",
			summary: "Refuse the change as a conflict unless the goal's updatedAt still matches this value",
			actions: ["update", "set_active", "complete", "reopen", "archive", "delete"],
		},
		{
			name: "--dry-run",
			usage: "--dry-run",
			summary:
				"Validate and report an apply-plan projection, ID migration, or path migration without writing",
			actions: ["apply-plan", "migrate_ids", "migrate_path"],
		},
	] satisfies CliFlagContract[],
	/**
	 * Where the goal file is, and how every interface agrees on that.
	 *
	 * Stated on every surface because resolution is the one rule a caller cannot
	 * discover from a command's output: a repository that answers from the legacy
	 * path looks exactly like one that answers from the current path until
	 * somebody writes the other file and splits the roadmap in two.
	 */
	pathRules: [
		`The goal file is \`<git-root>/${WORKLIST_RELATIVE_PATH}\`, a directory rather than a bare dotfile so later local state has somewhere to live beside the committed roadmap.`,
		`One resolution order applies everywhere, in the CLI, the board, and a live Pi session: an explicit \`--file <path>\` or \`$${WORKLIST_PATH_ENV}\` first, then \`${WORKLIST_RELATIVE_PATH}\`, then the legacy \`${LEGACY_WORKLIST_RELATIVE_PATH}\`.`,
		`Reads fall back to the legacy path and writes go to whichever path resolved, so a repository holding only \`${LEGACY_WORKLIST_RELATIVE_PATH}\` keeps using it untouched rather than silently splitting into two roadmaps; a repository with neither file writes \`${WORKLIST_RELATIVE_PATH}\`.`,
		`When both files exist the current path wins and every command warns, because quietly ignoring a populated \`${LEGACY_WORKLIST_RELATIVE_PATH}\` would look exactly like data loss. Merge them by hand; no command picks a winner for you.`,
		"With `--json` that warning moves into the envelope as `meta.shadowedWorklistPath`, naming the file being passed over, because stderr carries the failure envelope and prose in front of it would leave nothing to parse.",
		`\`--file\` and \`$${WORKLIST_PATH_ENV}\` are resolved from the process working directory, independently of \`--cwd\`, which only selects the target Git repository.`,
		`\`migrate_path\` moves a legacy file to \`${WORKLIST_RELATIVE_PATH}\` under the same cross-process lock and atomic replacement as any other write, reporting both paths; it is a location change and leaves the goals, their IDs, and the schema version untouched.`,
		"`migrate_path --dry-run` reports the move it would make without writing and without `--confirm`, and it refuses to run against an explicitly overridden path, which names a file rather than a repository to migrate.",
	],
	/** Description input rules rendered onto every generated caller surface. */
	descriptionRules: [
		"Programmatic callers and agents must use `--description <text>` for a replacement, passing the whole value in one argv token. The flag is order-independent, and its value may itself look like a known flag.",
		"Write a new title before `--description` rather than after its value: on `update`, a trailing word that would become a title is refused with exit code 2 instead of renaming the goal, and on `add` a title split across the value is refused the same way. `add` otherwise folds words after the value into the title rather than failing, so quote the whole description there. `update <id> <title...> --description <text>` still replaces a title and a description at once.",
		"Use `--append-description <text>` to add a paragraph without replaying stored prose. Replacing and appending are mutually exclusive, and an append cannot be combined with a title change.",
		"Reserve `-- <description...>` for a human typing unquoted prose interactively. A standalone known flag after the separator is a usage error with exit code 2; move a real flag before the separator or put flag-looking prose in `--description`.",
		"The legacy `--append -- <text>` interactive form remains supported, while agents and scripts use `--append-description <text>`.",
		"Programmatic callers clear a description with `--description ''`; the interactive `update <id> --` form remains supported.",
	],
	/**
	 * How an ID comes to exist and how a caller names one.
	 *
	 * Every surface states these, because a caller who assumes IDs are opaque
	 * random strings keeps paying for `list --json` plus client-side filtering to
	 * find the goal they already know the name of.
	 */
	idRules: [
		"A goal's ID is derived from its title when the goal is created and frozen from then on, so it reads as words and a later rename never invalidates a reference written down elsewhere.",
		"A title-derived ID never uses the legacy random-ID shape, so `migrate_ids` can identify generated IDs without consulting a title that may have changed.",
		"Read an ID back from `list`, `find`, or `add` instead of deriving it from a title yourself: truncation and collision suffixes make a guessed slug unreliable.",
		"Every `<id>` argument also accepts a unique prefix of an ID, or an ID the goal answered to before `migrate_ids` renamed it.",
		"An ambiguous prefix is refused with the goals it matched instead of resolved by guesswork, so widen the prefix rather than retrying it.",
		"Deleting a goal permanently retires its current and former IDs: they stop resolving, but no later goal can claim them and inherit stale references.",
		"`find <text>` searches titles and descriptions, so locating a goal never needs `list --json` plus client-side filtering.",
	],
	/**
	 * How the roadmap is ordered, and what that order does and does not mean.
	 *
	 * Stated everywhere because a caller who assumes the list is sorted for them
	 * will read `move` as cosmetic and re-sort the file to "fix" an order someone
	 * arranged deliberately.
	 */
	orderRules: [
		"Goals are stored and listed in one canonical order: `add` appends to the end, and `move` is the only action that rearranges them.",
		"`move <id> up` and `move <id> down` step one place, while `move <id> before <anchor>` and `move <id> after <anchor>` land the goal beside a named one.",
		"A move changes the roadmap's order without touching the moved goal's `updatedAt`, so rearranging the list never reads as editing the goals on it.",
		"Reordering needs no confirmation, because it names no new state for a goal, only a new position among the others.",
	],
	/** The strict JSON batch contract and its deterministic reference resolution. */
	planRules: [
		"`apply-plan <plan.json>` reads a plain JSON array whose entries allow exactly `title`, `description`, `group`, and `dependsOn`; `title` is a required non-empty string, `description` and `group` are optional strings, and `dependsOn` is an optional array of non-empty strings.",
		"Each `dependsOn` reference first matches an exact pre-collision slug of a goal in the same batch, then an exact current or former ID of an existing goal; prefixes are not accepted in plans.",
		"Two batch entries with the same pre-collision slug, an unknown reference, or any dependency cycle are hard validation errors and write nothing.",
		"Batch-first resolution is deterministic even when a predicted slug is already taken: the batch goal receives a collision suffix, dependents point to that suffixed ID, and `--dry-run` warns that the batch reference shadows the existing goal.",
		"A non-empty plan appends every goal in document order through one locked atomic replacement and increments the project revision exactly once; an empty plan is a valid no-op.",
		"`apply-plan --dry-run` performs the same locked validation and ID projection without writing or incrementing the revision; its prediction is advisory after the command exits because another writer may change the worklist before a later apply.",
		"The plan path is resolved from the process working directory, independently of `--cwd`, which only selects the target Git repository.",
	],
	/**
	 * What a dependency edge means, and what follows from it.
	 *
	 * Stated on every surface because the graph and the file order answer two
	 * different questions, and a caller who reads them as one thing will either
	 * re-sort the roadmap to match the edges or add edges to justify an order
	 * somebody arranged for another reason entirely.
	 */
	dependencyRules: [
		"`--depends-on <id>` on `add` and `update` records that the named goal must land before this one; repeat the flag to name several, and `--depends-on ''` on its own clears every edge.",
		"An `update` replaces the whole set rather than adding to it, so name every edge the goal should end up with, not just the new one.",
		"An edge means must-land-before whatever its reason, so a logical prerequisite and two goals that would collide in the same files are recorded the same way.",
		"A dependency is satisfied once its target is done or archived, and a goal with an unsatisfied dependency is blocked.",
		"Blocked is derived from the edges on every read and never stored: there is no blocked status, and `set_active` warns about a blocked goal instead of refusing it.",
		"Only the forward direction is stored, and `show <id>` derives what the goal blocks, so an edge is written once and the two directions cannot drift apart.",
		"An update that would form a cycle, including an existing goal naming itself, is refused with `DEPENDENCY_CYCLE`.",
		"Add resolves dependencies before minting the new goal's ID, so an edge naming a guessed future slug is refused with `NOT_FOUND`, like any ID that names no existing goal.",
		"Deleting a goal drops the edges naming it in the same atomic change.",
		"File order is presentation and a tiebreak while the dependency graph is the source of truth for what may start; the two are allowed to disagree, and neither should be edited to mirror the other.",
	],
	/**
	 * What the sequencing reads answer, and why each is defined the way it is.
	 *
	 * Stated on every surface because a driver that picks its own goal off `list`
	 * will hand out work someone is already doing: the frontier is the part of the
	 * graph that has to be read the same way by everyone dispatching from it.
	 */
	sequencingRules: [
		"`ready` lists every open goal whose dependencies have all landed and that nobody has claimed, in canonical file order, so the whole parallel frontier is visible at once.",
		"A goal is claimed when it is active or carries a `branch`, and a claimed goal is left out of `ready` so work already in flight is never handed out twice.",
		"`next` is the first entry of `ready` by definition, so a driver asking for one goal and a human reading the frontier can never be told two different things.",
		"An empty frontier is reported at exit code 0, because a roadmap with nothing to start is an answer rather than a failure; read `result.goal` or `result.goals` to tell it from a goal.",
		"`waves` prints every unfinished goal in the earliest layer it could start in: wave 1 is the unblocked frontier, and each later wave is exactly what the wave before it releases.",
		"`waves` keeps claimed goals in their layer and marks them, because a wave shows the shape of the remaining work rather than what is free to pick up.",
		"A goal whose dependencies can never all land, through a hand-edited cycle or an edge naming no goal, is reported as unreachable instead of being dropped from the layers.",
		"`waves --json` reports the layers as `result.waves`, an array of goal arrays whose position is the wave number, and adds `result.unreachableGoals` only when some goal is unreachable, so an absent field means every unfinished goal found a layer.",
		"All three are reads derived from the stored edges the same way `blocked` is, so nothing is cached and no command has to be re-run to refresh them.",
	],
	exitCodes: [
		{ code: 0, meaning: "success" },
		{ code: 1, meaning: "error" },
		{ code: 2, meaning: "usage error" },
		{ code: 3, meaning: "confirmation required" },
		{ code: 4, meaning: "conflict" },
	] satisfies CliExitCodeContract[],
	agentGuidelines: [
		"Prefer --json and read the deterministic result envelope instead of parsing human output.",
		"Use --description <text> and --append-description <text> for every programmatic description input; reserve the -- separator for a human typing prose interactively.",
		"Read the CLI's own exit code rather than a shell pipeline's; a known flag after the description separator is a usage error with exit code 2.",
		"Never run ui: it is an interactive board for a human, it holds the terminal until they quit, and it refuses to start without one.",
		"Never pass --confirm for complete, reopen, archive, delete, migrate_ids, or migrate_path unless the user explicitly requested that exact action.",
		"Treat exit code 3 as a request for explicit user confirmation, not as a retryable failure.",
		"Treat exit code 4 as a concurrent-change conflict: re-read current state before retrying.",
		"Use list for orientation, find <text> to locate a goal by wording, and show <id> when you need a goal's complete description.",
		"Ask next for the goal to start, ready for everything that could run in parallel, and waves for how the rest of the roadmap is layered; never pick a goal off list yourself, because list cannot tell you what is blocked or already claimed.",
		"Treat an empty next or ready as nothing to start rather than an error: it exits 0, so read result.goal or result.goals instead of the exit code.",
		"Pass a full ID or a prefix long enough to be unique; an ambiguous prefix is refused with candidates rather than resolved by guesswork.",
		"Run migrate_ids only when the user explicitly asks for it; it rewrites stored IDs, though every old ID keeps resolving afterwards.",
		`Leave the goal file where it is unless the user asks to move it: a repository still on \`${LEGACY_WORKLIST_RELATIVE_PATH}\` works untouched, and migrate_path is theirs to request.`,
		`Report the two-worklist warning to the user rather than working around it; only ${BINARY} reads the file it names, and merging them is a decision about which goals survive.`,
		"Add a note with --append-description instead of resending a description you did not write, so nothing in the existing text can be lost in transcription.",
		"Group related goals with --group <name> on add or update, and leave the file order alone unless the user asked for a different sequence.",
		"Record a real must-land-before relationship with --depends-on <id>, including one that exists only because two goals would collide in the same files; do not add an edge merely to justify the order the file happens to be in.",
		"Send the complete set of edges on every --depends-on update, because it replaces the stored set rather than adding to it.",
		"Pass --expect-updated-at with the updatedAt from your own read whenever you change a goal, so your mutation conflicts if the goal changed in the meantime.",
		"Use apply-plan for an approved JSON goal batch, and run it with --dry-run first when the user needs to review predicted IDs, dependencies, or shadow warnings.",
		"Broad outcomes belong in Project Goals; do not mirror your internal step-by-step plan into them.",
	],
} as const;

function padUsage(usage: string): string {
	return usage.length >= 41 ? `${usage}\n${" ".repeat(43)}` : usage.padEnd(41);
}

/** Look up a documented exit code, failing loudly if the contract drops it. */
function exitCodeMeaning(code: number): string {
	const match = CLI_COMMAND_CONTRACT.exitCodes.find((exitCode) => exitCode.code === code);
	if (!match) {
		throw new Error(`Exit code ${code} is referenced by the skill but missing from the contract`);
	}
	return match.meaning;
}

/** Render `a`, `a and b`, or `a`, `b`, and `c`. */
function joinWithAnd(items: readonly string[]): string {
	if (items.length < 2) return items.join("");
	const last = items[items.length - 1];
	const leading = items.slice(0, -1);
	// A two-item list takes no serial comma, so a flag scoped to two actions
	// reads as a sentence rather than as a truncated longer list.
	return leading.length === 1 ? `${leading[0]} and ${last}` : `${leading.join(", ")}, and ${last}`;
}

/** Render `a`, `b`, and `c` from a set of actions. */
function actionNameList(actions: readonly CliActionContract[]): string {
	return joinWithAnd(actions.map((action) => `\`${action.name}\``));
}

/**
 * A flag's summary, stating which actions accept it.
 *
 * The applicable actions are rendered from the same list the CLI enforces, so
 * no surface can promise a flag the command line rejects.
 */
function flagSummary(flag: CliFlagContract): string {
	if (!flag.actions) return flag.summary;
	return `${flag.summary}; only for ${CLI_COMMAND_CONTRACT.scope} ${joinWithAnd(flag.actions)}`;
}

/**
 * A GFM table whose cells survive the contract's own wording.
 *
 * A row is split on every unescaped `|` before its cells are parsed as
 * Markdown, so a code span is no shelter: a usage string that spells
 * alternatives with a pipe would otherwise render as extra columns with the
 * code span torn across them.
 */
function markdownTable(headers: readonly string[], rows: readonly (readonly string[])[]): string[] {
	const renderRow = (cells: readonly string[]) =>
		`| ${cells.map((cell) => cell.replaceAll("|", "\\|")).join(" | ")} |`;
	return [renderRow(headers), `| ${headers.map(() => "---").join(" | ")} |`, ...rows.map(renderRow)];
}

export function renderCliUsage(): string {
	const contract = CLI_COMMAND_CONTRACT;
	const flagColumn = Math.max(...contract.flags.map((flag) => flag.usage.length)) + 2;
	const actionLines = contract.actions.map((action) => `  ${padUsage(action.usage)}${action.summary}`);
	const flagLines = contract.flags.map((flag) => `  ${flag.usage.padEnd(flagColumn)}${flagSummary(flag)}`);
	const exitCodes = contract.exitCodes.map((exitCode) => `${exitCode.code} ${exitCode.meaning}`).join(", ");
	return [
		`Usage: ${contract.binary} ${contract.scope} <action> [arguments] [flags]`,
		"",
		"Actions:",
		...actionLines,
		"",
		"Flags:",
		...flagLines,
		"",
		`Exit codes: ${exitCodes}.`,
	].join("\n");
}

/**
 * The installable agent skill, written to .claude/skills/stepstone/SKILL.md.
 *
 * Every published invocation is the non-interactive `npx -y <binary>@latest`
 * form so the same file works from any repository without stale-cache selection;
 * scope is chosen at install time, never in the content.
 */
export function renderSkillMarkdown(): string {
	const contract = CLI_COMMAND_CONTRACT;
	const publishedBinary = `${contract.binary}@latest`;
	const lifecycleActions = contract.actions.filter((action) => action.confirmRequired);
	const safeActions = contract.actions.filter(
		(action) => !action.confirmRequired && !action.interactive && action.name !== "help",
	);
	const interactiveActions = contract.actions.filter((action) => action.interactive);
	// A title-derived ID in the shape `add` actually mints, so the examples show
	// what `list` and `find` hand back rather than a placeholder.
	const exampleId = "support-goal-templates";
	// A second real-looking ID, so the anchor form of `move` reads unambiguously.
	const anchorExampleId = "retire-the-legacy-importer";
	// A third, so a repeated --depends-on names two different goals.
	const secondDependencyId = "ship-the-new-parser";
	// An `updatedAt` in the stored ISO 8601 shape, as `show` reports it.
	const exampleUpdatedAt = "2026-05-04T09:12:31.004Z";
	const examples = [
		"list --json",
		'add Support goal templates --description "Let teams share reusable goal outlines"',
		"apply-plan plan.json --dry-run --json",
		"apply-plan plan.json --json",
		"find templates --json",
		"next --json",
		"ready --json",
		"waves --json",
		`show ${exampleId} --json`,
		`update ${exampleId} --description "Replace only the description"`,
		`update ${exampleId} Support shared goal templates`,
		`update ${exampleId} --append-description "Blocked on the template schema until it lands"`,
		`update ${exampleId} --expect-updated-at ${exampleUpdatedAt} --append-description "Reviewed and still current"`,
		`update ${exampleId} --group Foundation`,
		`add Retire the legacy importer --depends-on ${exampleId} --depends-on ${secondDependencyId}`,
		`update ${anchorExampleId} --depends-on ${exampleId}`,
		`update ${anchorExampleId} --depends-on ''`,
		`move ${exampleId} up`,
		`move ${exampleId} before ${anchorExampleId}`,
		`set_active ${exampleId}`,
	];
	return [
		"---",
		`name: ${contract.binary}`,
		`description: ${JSON.stringify(contract.skillDescription)}`,
		"---",
		"",
		`<!-- Generated from src/cli-contract.ts by ${GENERATOR_PATH}. Do not edit manually. -->`,
		"",
		`# Managing ${contract.binary} Project Goals`,
		"",
		`Project Goals are a repository-wide roadmap stored in \`<git-root>/${WORKLIST_RELATIVE_PATH}\` and shared with Pi sessions.`,
		"Never edit that file directly: a concurrent Pi session may hold the cross-process lock, and direct edits bypass validation, ID generation, and timestamps.",
		`Always go through the ${contract.binary} CLI, which routes every mutation through the same application service, cross-process lock, and atomic replacement as a live Pi session.`,
		"",
		"## Invoking the CLI",
		"",
		`The published package ships a compiled \`${contract.binary}\` bin (Node ${contract.runtime.binaryNodeFloor} or newer), usable from any repository without installing anything first:`,
		"",
		"```sh",
		`npx -y ${publishedBinary} ${contract.scope} <action> [arguments] [flags]`,
		"```",
		"",
		"Run it from inside the target repository, or pass `--cwd <repo-root>` to target another one.",
		`Inside a ${contract.binary} development checkout, prefer the TypeScript entry point so unreleased changes apply: \`node <checkout>/src/cli.ts ${contract.scope} <action>\` (needs Node ${contract.runtime.sourceNodeFloor} or newer for native type stripping).`,
		"",
		"Actions:",
		"",
		"```text",
		...contract.actions.map((action) => action.usage),
		"```",
		"",
		"Flags:",
		"",
		...contract.flags.map((flag) => `- \`${flag.usage}\` - ${flagSummary(flag)}.`),
		"",
		"Prefer `--json` whenever you need to read IDs, statuses, or errors back rather than parsing human output.",
		"`list` output is compact and omits descriptions; use `show <id>` when you need a goal's complete description.",
		...contract.descriptionRules,
		"`--expect-updated-at <updatedAt>`, copied from your own `show` of that goal, refuses the change when someone edited the goal after you read it.",
		"Pass it on every change you make to a goal you did not just create: without it, your mutation proceeds even if the goal changed after you read it.",
		"",
		"Examples:",
		"",
		"```sh",
		...examples.map((example) => `npx -y ${publishedBinary} ${contract.scope} ${example}`),
		"```",
		"",
		`The full generated command reference lives in the package's \`${DOCS_PATH}\`, rendered from the same contract as this skill.`,
		"",
		"## Where the goal file lives",
		"",
		...contract.pathRules.map((rule) => `- ${rule}`),
		"",
		"## JSON plans",
		"",
		...contract.planRules.map((rule) => `- ${rule}`),
		"",
		"## Goal IDs",
		"",
		...contract.idRules.map((rule) => `- ${rule}`),
		"",
		"## Goal order and grouping",
		"",
		...contract.orderRules.map((rule) => `- ${rule}`),
		"- `--group <name>` on `add` and `update` files a goal under a free-form section; a group exists exactly when some goal names it, and `--group ''` clears the field.",
		"",
		"## Dependencies",
		"",
		...contract.dependencyRules.map((rule) => `- ${rule}`),
		"",
		"## Sequencing",
		"",
		...contract.sequencingRules.map((rule) => `- ${rule}`),
		"",
		"## Guardrails",
		"",
		`- ${actionNameList(lifecycleActions)} are reserved for explicit user intent.`,
		"  Pass `--confirm` only for the exact action the user requested and, when the action names a goal, only for that exact goal.",
		"  Never pass it because a goal merely looks finished or stale.",
		"- `migrate_ids` names no goal and rewrites every generated ID in the repository at once, so it needs an explicit request of its own.",
		"  `--dry-run` reports the rewrites it would make without writing them and without `--confirm`; prefer it when you are showing the user what would change.",
		"- `migrate_path` names no goal either and moves the whole repository's goal file, so it needs its own explicit request and has the same `--dry-run`.",
		`- Exit code 3 (${exitCodeMeaning(3)}) means the command needs \`--confirm\`; stop and ask the user instead of retrying with the flag.`,
		`- Exit code 4 (${exitCodeMeaning(4)}) means a concurrent change conflicted with yours; re-read current state with \`list\` or \`show\` before retrying.`,
		"  A conflicting change wrote nothing at all, so rebuild it against the goal you just re-read and pass that goal's new `updatedAt`.",
		`- ${actionNameList(safeActions)} are safe to run whenever they serve the user's request.`,
		`- ${actionNameList(interactiveActions)} opens a full-screen board for the human at the keyboard, not for you.`,
		"  Never run it: it holds the terminal until the user quits, and it exits with an error when stdin or stdout is not a terminal.",
		`  Suggest \`npx -y ${publishedBinary} ${contract.scope} ui\` when the user wants to browse or edit goals themselves; read state with \`list\` and \`show\` instead.`,
		"- Session Tasks cannot be managed from outside a Pi session; the CLI intentionally rejects `session` scope.",
		"  For your own in-session tracking, use your normal task tools instead.",
		"",
		"## Failure modes",
		"",
		`- Exit code 1 (${exitCodeMeaning(1)}) with a "Malformed" message means the goal file the repository resolved to is corrupt; the message names it, so report it to the user and never rewrite the file by hand.`,
		'- Exit code 1 with a "git repository" message means the working directory is outside a repo; rerun with `--cwd <repo-root>`.',
		"  With `--json`, that failure also arrives as the deterministic result envelope on stderr.",
		`- Exit code 2 (${exitCodeMeaning(2)}) means the action or its flags were not recognized; re-read the action list above instead of guessing.`,
		`- If \`npx -y ${publishedBinary}\` cannot resolve the package, check network access to the npm registry; a local development checkout remains a fallback.`,
		`- Read \`meta.cliVersion\` from any \`--json\` result envelope when you need to verify which published build ran.`,
		"  This reports the package's runtime version directly instead of requiring inspection of the npx cache.",
		"",
	].join("\n");
}

/** The generated command reference and agent guidance document, written to docs/cli.md. */
export function renderCliGuide(): string {
	const contract = CLI_COMMAND_CONTRACT;
	const publishedBinary = `${contract.binary}@latest`;
	const actionRows = contract.actions.map((action) => {
		const notes = [
			action.confirmRequired ? ". Requires explicit user confirmation" : "",
			action.interactive ? ". Requires a terminal; not for scripts or agents" : "",
		].join("");
		return [`\`npx -y ${publishedBinary} ${contract.scope} ${action.usage}\``, `${action.summary}${notes}`];
	});
	const flagRows = contract.flags.map((flag) => [`\`${flag.usage}\``, flagSummary(flag)]);
	const exitCodeRows = contract.exitCodes.map((exitCode) => [`\`${exitCode.code}\``, exitCode.meaning]);
	const guidelineLines = contract.agentGuidelines.map((guideline) => `- ${guideline}`);
	return [
		`<!-- Generated from src/cli-contract.ts by ${GENERATOR_PATH}. Do not edit manually. -->`,
		"",
		`# ${contract.binary} CLI`,
		"",
		contract.intro,
		"",
		"## Invocation",
		"",
		"Use the explicit `@latest` package specifier so a stale local npx cache cannot select an older CLI build:",
		"",
		"```sh",
		`npx -y ${publishedBinary} ${contract.scope} <action> [arguments] [flags]`,
		"```",
		"",
		"Every `--json` result envelope reports the running package version as `meta.cliVersion`.",
		"",
		"## Where the goal file lives",
		"",
		...contract.pathRules.map((rule) => `- ${rule}`),
		"",
		"## Commands",
		"",
		...markdownTable(["Command", "Description"], actionRows),
		"",
		"## Flags",
		"",
		...markdownTable(["Flag", "Description"], flagRows),
		"",
		"## Description input",
		"",
		...contract.descriptionRules,
		"",
		"## JSON plans",
		"",
		...contract.planRules.map((rule) => `- ${rule}`),
		"",
		"## Goal IDs",
		"",
		...contract.idRules.map((rule) => `- ${rule}`),
		"",
		"## Goal order and grouping",
		"",
		...contract.orderRules.map((rule) => `- ${rule}`),
		"- `--group <name>` on `add` and `update` files a goal under a free-form section; a group exists exactly when some goal names it, and `--group ''` clears the field.",
		"",
		"## Dependencies",
		"",
		...contract.dependencyRules.map((rule) => `- ${rule}`),
		"",
		"## Sequencing",
		"",
		...contract.sequencingRules.map((rule) => `- ${rule}`),
		"",
		"## Exit codes",
		"",
		...markdownTable(["Code", "Meaning"], exitCodeRows),
		"",
		"## Agent guidance",
		"",
		...guidelineLines,
		"",
	].join("\n");
}
