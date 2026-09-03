import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
	AGENTS_BLOCK_END,
	AGENTS_BLOCK_START,
	CLI_COMMAND_CONTRACT,
	type CliFlagContract,
	DOCS_PATH,
	flagActionScope,
	LEGACY_WORKLIST_DIRECTORY,
	renderAgentsMarkdownBlock,
	renderCliGuide,
	renderCliUsage,
	renderSkillMarkdown,
	SKILL_PATH,
	WORKLIST_DIRECTORY,
	WORKLIST_FILENAME,
	WORKLIST_PATH_ENV,
} from "../src/cli-contract.ts";
import { ROADMAP_PATH } from "../src/roadmap.ts";
import { documentationPages } from "./docs-pages.ts";

const execFileAsync = promisify(execFile);

/**
 * Every page of prose a reader lands on, paired with its contents.
 *
 * The documentation is the README plus `docs/`, so an assertion naming README.md
 * alone would stop covering the page that actually carries the claim as soon as
 * prose moves. Reading the directory also covers a document the day it is added,
 * which is the case a hand-maintained list always misses.
 *
 * The generated roadmap is the one exclusion: its body is goal prose rendered
 * from the committed goal file rather than documentation somebody authored. A
 * goal describing a command in passing would fail the copy-paste-safety
 * assertion, and holding goals to the names the contract renders today would
 * make a rename a demand to rewrite descriptions written before it, which are a
 * record of what was decided rather than instructions to follow.
 * test/roadmap.test.ts pins the prose that page does author.
 */
async function readDocumentation(): Promise<(readonly [string, string])[]> {
	const pages = await documentationPages();
	const paths = ["README.md", ...pages.filter((path) => path !== ROADMAP_PATH)];
	return Promise.all(paths.map(async (path) => [path, await readFile(resolve(path), "utf8")] as const));
}

/**
 * Every absolute filesystem path a string names.
 *
 * A path rooted at `/` is a path on whoever generated the file, so the generated
 * skill must never carry one; it roots its paths at a placeholder instead. The
 * tell is a slash that starts a token rather than continuing one, which is what
 * separates `/opt/tools/x` from `docs/cli.md`, from `<git-root>/.worklist`, and
 * from the `//` inside a URL.
 */
function absolutePathsIn(text: string): string[] {
	return [...text.matchAll(/(?<![\w>:~./-])\/[A-Za-z0-9_.~-]+(?:\/[A-Za-z0-9_.~-]+)*/g)].map(
		(match) => match[0],
	);
}

/**
 * Every angle-bracket placeholder a rendered document hands to GFM as raw HTML.
 *
 * Fenced blocks, code spans, and HTML comments are the three places a rendered
 * document means its angle brackets literally, so they are removed before the
 * remaining prose is read for anything CommonMark would accept as an open tag.
 */
function rawHtmlPlaceholdersIn(markdown: string): string[] {
	const prose = markdown
		.replaceAll(/^```[\s\S]*?^```/gm, "")
		.replaceAll(/<!--[\s\S]*?-->/g, "")
		.replaceAll(/`[^`\n]*`/g, "");
	return [...prose.matchAll(/<[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>/g)].map((match) => match[0]);
}

/** Escape a contract value so a pattern built around it matches it literally. */
function literal(value: string): string {
	return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/**
 * The package this one was published as before the rename.
 *
 * docs/releasing.md names it deliberately, in the prose about the frozen build
 * that stays published under the old name, so it is the one npx target in the
 * documentation that is not the contract's binary. A later rename never moves
 * it: it states what npm already carries, not what this package is called.
 */
const FROZEN_PREDECESSOR_PACKAGE = "pi-worklist";

/** Directory holding the generated skill, whose name is the published binary. */
const SKILL_DIRECTORY = dirname(SKILL_PATH);

/**
 * How a document spells a package name: never leading with the dash of a flag,
 * so an option that follows the command being matched is not read as its target.
 */
const PACKAGE_NAME = String.raw`[\w@][\w@./-]*`;

/**
 * One spelling a document may use for a name, and whether one has to exist.
 *
 * A required shape has to occur at least once across the documentation, so a
 * shape that quietly stops matching fails rather than passing vacuously on the
 * strength of the shapes still matching. An optional shape is held to the same
 * spellings wherever it appears but is never demanded, because prose exists for a
 * reader rather than to keep a pattern non-empty: a `<name>@1.2.3` pin is written
 * only where a page has a reason to name one version, and the day the last such
 * page is deleted there is nothing to fix.
 */
type SpellingShape = { readonly pattern: RegExp; readonly required: boolean };

/** A shape some document has to state, so its disappearance is a failure. */
function required(pattern: RegExp): SpellingShape {
	return { pattern, required: true };
}

/** A shape checked wherever it appears and not required to appear at all. */
function optional(pattern: RegExp): SpellingShape {
	return { pattern, required: false };
}

/** A name the contract owns, paired with every spelling a document may state. */
type SpellingEntry = {
	readonly subject: string;
	readonly shapes: readonly SpellingShape[];
	readonly allowed: readonly string[];
	readonly canonical: string;
};

/**
 * Every shape a document uses to name this published package.
 *
 * Built from the binary rather than closing over the contract's own value, so the
 * check can be run against a renamed contract - the failure it exists to catch,
 * and otherwise only reachable by editing the source it is asserting about.
 *
 * Some shapes name any package equally well - `npm i <name>`, a `<name>@1.2.3`
 * pin - and a page may legitimately print one for a dependency or a toolchain
 * version. Matching only this package's own names there keeps the check from
 * reporting correct prose as a contract disagreement; a rename is still caught,
 * because the shape then finds nothing and fails the check that it names this
 * package at all.
 */
function publishedPackageSpellings(binary: string): SpellingEntry {
	const ownPackage = `(?:${[binary, FROZEN_PREDECESSOR_PACKAGE].map(literal).join("|")})`;
	return {
		subject: "published package",
		shapes: [
			required(new RegExp(`npx -y (${PACKAGE_NAME})@latest`, "g")),
			required(new RegExp(String.raw`\bnpm:(${PACKAGE_NAME})`, "g")),
			required(new RegExp(String.raw`\bnpm (?:view|deprecate|i|install) (${ownPackage})(?![\w@./-])`, "g")),
			required(new RegExp(String.raw`\bnpmjs\.com/package/(${PACKAGE_NAME})`, "g")),
			required(new RegExp(String.raw`\bshields\.io/npm/v/(${PACKAGE_NAME})\.svg`, "g")),
			required(new RegExp(String.raw`\bpi\.dev/packages/(${PACKAGE_NAME})`, "g")),
			optional(new RegExp(String.raw`(?<![\w@./-])(${ownPackage})@\d+\.\d+\.\d+`, "g")),
			required(new RegExp(`from "(${PACKAGE_NAME})/src/`, "g")),
		],
		allowed: [binary, FROZEN_PREDECESSOR_PACKAGE],
		canonical: binary,
	};
}

/**
 * Names the contract owns, paired with every spelling a document may state.
 *
 * A rename is a one-line change to the contract, which regenerates the
 * generated artifacts but cannot touch hand-written prose. Pinning one
 * invocation in README.md leaves the rest of the documentation free to go on
 * sending readers to a package, an environment variable, or a directory that no
 * longer exists, which is silent because the old spellings still read as
 * instructions.
 *
 * Every shape is checked on its own, and each occurrence it finds has to be a
 * spelling the contract renders today. The shapes cover the places a name is an
 * instruction a reader follows - a command, a registry or gallery URL, an import
 * specifier, a path - and deliberately not running prose, where the product name
 * is a word rather than a target and a sweep has to be done by hand.
 */
const CONTRACT_SPELLINGS: readonly SpellingEntry[] = [
	publishedPackageSpellings(CLI_COMMAND_CONTRACT.binary),
	{
		subject: "goal file environment override",
		shapes: [required(/\$([A-Z][A-Z0-9_]*_WORKLIST)\b/g)],
		allowed: [WORKLIST_PATH_ENV],
		canonical: WORKLIST_PATH_ENV,
	},
	{
		subject: "goal file directory",
		// Anchored to the dot-directory form the contract renders, because `--file`
		// and the environment override exist precisely so a document may print the
		// path of a goal file living anywhere else.
		shapes: [required(new RegExp(String.raw`(?<![\w.-])(\.[\w-]+)/${literal(WORKLIST_FILENAME)}`, "g"))],
		allowed: [WORKLIST_DIRECTORY, LEGACY_WORKLIST_DIRECTORY],
		canonical: WORKLIST_DIRECTORY,
	},
	{
		subject: "agent skill directory",
		shapes: [
			required(new RegExp(String.raw`${literal(dirname(SKILL_DIRECTORY))}/([\w.-]+)`, "g")),
			required(/--skill ([\w.-]+)/g),
		],
		allowed: [basename(SKILL_DIRECTORY)],
		canonical: basename(SKILL_DIRECTORY),
	},
];

/** Every disagreement between a set of documents and one entry's spellings. */
function spellingProblems(
	documentation: readonly (readonly [string, string])[],
	{ subject, shapes, allowed, canonical }: SpellingEntry,
): string[] {
	const problems: string[] = [];
	for (const shape of shapes) {
		const stated = documentation.flatMap(([path, contents]) =>
			[...contents.matchAll(shape.pattern)].map((match) => [path, match[1] ?? ""] as const),
		);
		problems.push(
			...stated.filter(([, name]) => !allowed.includes(name)).map(([path, name]) => `${path} states ${name}`),
		);
		if (shape.required && !stated.some(([, name]) => name === canonical)) {
			problems.push(
				`no document spells the ${subject} \`${canonical}\` as \`${shape.pattern.source}\`, so that shape pins nothing`,
			);
		}
	}
	return problems;
}

/** Split a GFM table row into its cells: on unescaped pipes only, as a renderer does. */
function tableCells(row: string): string[] {
	const cells: string[] = [];
	let cell = "";
	for (let index = 0; index < row.length; index += 1) {
		if (row[index] === "\\" && row[index + 1] === "|") {
			cell += "|";
			index += 1;
			continue;
		}
		if (row[index] === "|") {
			cells.push(cell);
			cell = "";
			continue;
		}
		cell += row[index];
	}
	cells.push(cell);
	// The leading and trailing pipes bound the row rather than opening cells.
	return cells.slice(1, -1).map((entry) => entry.trim());
}

/**
 * Every entry a surface renders for one flag: the text from its usage to the
 * end of that entry.
 *
 * An entry ends at the line break or at the next flag's usage, whichever comes
 * first, because the compact AGENTS.md block lists every flag on a single line
 * while the other surfaces give each one its own line. Anchoring this way is
 * what makes a per-flag assertion mean anything: several flags word their
 * action limit identically, so a check against the whole surface still passes
 * after one flag loses its annotation. A usage that merely prefixes a longer
 * flag name is not an entry for it, which keeps `--append` from matching inside
 * `--append-description`.
 */
function flagEntries(surface: string, flag: CliFlagContract): string[] {
	const others = CLI_COMMAND_CONTRACT.flags.filter((other) => other !== flag).map((other) => other.usage);
	const entries: string[] = [];
	for (let at = surface.indexOf(flag.usage); at >= 0; at = surface.indexOf(flag.usage, at + 1)) {
		const rest = surface.slice(at + flag.usage.length);
		if (/^[\w-]/.test(rest)) continue;
		const bounds = [rest.indexOf("\n"), ...others.map((usage) => rest.indexOf(usage))].filter(
			(index) => index >= 0,
		);
		entries.push(rest.slice(0, Math.min(...bounds, rest.length)));
	}
	return entries;
}

/** The body rows of the table under a `## heading`, parsed into cells. */
function tableRowsUnder(markdown: string, heading: string): string[][] {
	const section = markdown.split(`\n## ${heading}\n`)[1]?.split("\n## ")[0] ?? "";
	return section
		.split("\n")
		.filter((line) => line.startsWith("|"))
		.slice(2)
		.map(tableCells);
}

describe("single CLI command contract", () => {
	it("keeps the generated docs/cli.md guide in sync with the contract", async () => {
		const generated = await readFile(resolve(DOCS_PATH), "utf8");
		expect(generated, `${DOCS_PATH} is stale; run \`npm run docs\` to regenerate it`).toBe(renderCliGuide());
	});

	it("derives help output, the skill guide, and agent guidance from one contract", async () => {
		const usage = renderCliUsage();
		const guide = renderCliGuide();
		const commands = tableRowsUnder(guide, "Commands").map((cells) => cells[0]);
		const flags = tableRowsUnder(guide, "Flags").map((cells) => cells[0]);
		for (const action of CLI_COMMAND_CONTRACT.actions) {
			expect(usage).toContain(action.usage);
			expect(usage).toContain(action.summary);
			expect(commands).toContain(`\`npx -y ${CLI_COMMAND_CONTRACT.binary}@latest project ${action.usage}\``);
		}
		for (const flag of CLI_COMMAND_CONTRACT.flags) {
			expect(usage).toContain(flag.usage);
			expect(flags).toContain(`\`${flag.usage}\``);
		}
		for (const exitCode of CLI_COMMAND_CONTRACT.exitCodes) {
			expect(usage).toContain(`${exitCode.code} ${exitCode.meaning}`);
		}
		for (const guideline of CLI_COMMAND_CONTRACT.agentGuidelines) {
			expect(guide).toContain(guideline);
		}
		expect(guide).toContain("## Agent guidance");
		const confirmGuidance = CLI_COMMAND_CONTRACT.agentGuidelines.filter((guideline) =>
			guideline.includes("--confirm"),
		);
		expect(confirmGuidance.length).toBeGreaterThan(0);
		// The guidance names its actions in prose, so a newly confirm-gated action
		// would otherwise be documented everywhere except where an agent reads the rule.
		for (const action of CLI_COMMAND_CONTRACT.actions.filter((entry) => entry.confirmRequired)) {
			expect(
				confirmGuidance.some((guideline) => guideline.includes(action.name)),
				`agent guidance never names the confirm-gated action \`${action.name}\``,
			).toBe(true);
		}
	});

	it("propagates bounded mutation receipt guidance to agent-facing renderers", () => {
		for (const rule of CLI_COMMAND_CONTRACT.resultRules) {
			for (const surface of [renderSkillMarkdown(), renderCliGuide()]) expect(surface).toContain(rule);
		}
		expect(renderAgentsMarkdownBlock()).toContain("mutations return bounded receipts");
		expect(renderAgentsMarkdownBlock()).toContain("run `list` only when later work needs");
	});

	it("propagates the single capture workflow to every agent-facing renderer", () => {
		const workflowActions = CLI_COMMAND_CONTRACT.actions.filter(
			(action) => action.captureWorkflow !== undefined,
		);
		expect(workflowActions).toHaveLength(1);
		const action = workflowActions[0];
		if (!action?.captureWorkflow) throw new Error("apply-plan capture workflow is missing");
		expect(action.name).toBe("apply-plan");

		const surfaces = [renderSkillMarkdown(), renderAgentsMarkdownBlock(), renderCliGuide()];
		for (const step of action.captureWorkflow.steps) {
			for (const surface of surfaces) expect(surface).toContain(step);
		}
		expect(renderSkillMarkdown()).toContain(`## ${action.captureWorkflow.title}`);
		expect(renderCliGuide()).toContain(`## ${action.captureWorkflow.title}`);
	});

	it("keeps the mutating capture action out of the unconditionally safe actions", () => {
		// The skill's guardrails tell an agent which actions need no user approval,
		// so the action that only runs against a plan the user approved must not be
		// listed there however the surrounding prose is rewritten.
		const safeLine = renderSkillMarkdown()
			.split("\n")
			.find((line) => line.includes("are safe to run whenever they serve the user's request."));
		if (!safeLine) throw new Error("the skill names no unconditionally safe actions");
		const unconditionallySafe = new Set([...safeLine.matchAll(/`([a-z_-]+)`/g)].map(([, name]) => name));

		for (const action of CLI_COMMAND_CONTRACT.actions) {
			const gated = action.confirmRequired || action.interactive || action.name === "help";
			const owned = action.captureWorkflow !== undefined;
			expect(
				unconditionallySafe.has(action.name),
				`\`${action.name}\` is ${unconditionallySafe.has(action.name) ? "" : "not "}listed as unconditionally safe`,
			).toBe(!gated && !owned);
		}
	});

	it("derives the repository-neutral AGENTS.md block from the same contract", async () => {
		expect(AGENTS_BLOCK_START).toBe("<!-- stepstone:project-goals:start -->");
		expect(AGENTS_BLOCK_END).toBe("<!-- stepstone:project-goals:end -->");
		const block = renderAgentsMarkdownBlock();
		expect(block).toContain("shared roadmap");
		expect(block.startsWith(AGENTS_BLOCK_START)).toBe(true);
		expect(block.endsWith(AGENTS_BLOCK_END)).toBe(true);
		expect(block).toContain(`<git-root>/${WORKLIST_DIRECTORY}/${WORKLIST_FILENAME}`);
		expect(block).toContain("--file");
		expect(block).toContain(`$${WORKLIST_PATH_ENV}`);
		expect(absolutePathsIn(block)).toEqual([]);
		for (const action of CLI_COMMAND_CONTRACT.actions) {
			expect(block, `AGENTS.md is missing action usage \`${action.usage}\``).toContain(action.usage);
		}
		for (const flag of CLI_COMMAND_CONTRACT.flags) {
			expect(block, `AGENTS.md is missing flag usage \`${flag.usage}\``).toContain(flag.usage);
		}
		for (const action of CLI_COMMAND_CONTRACT.actions.filter((entry) => entry.confirmRequired)) {
			expect(block, `AGENTS.md is missing confirmation guardrail for ${action.name}`).toContain(
				`\`${action.name}\``,
			);
		}
		for (const { code, meaning } of CLI_COMMAND_CONTRACT.exitCodes) {
			expect(block).toContain(`\`${code}\` ${meaning}`);
		}

		const committed = await readFile(resolve("AGENTS.md"), "utf8");
		const start = committed.indexOf(AGENTS_BLOCK_START);
		const end = committed.indexOf(AGENTS_BLOCK_END);
		expect(start, "AGENTS.md is missing the generated Stepstone block").toBeGreaterThanOrEqual(0);
		expect(end, "AGENTS.md is missing the generated Stepstone block end").toBeGreaterThan(start);
		expect(committed.slice(start, end + AGENTS_BLOCK_END.length)).toBe(block);
		expect(committed.indexOf(AGENTS_BLOCK_START, start + AGENTS_BLOCK_START.length)).toBe(-1);
		expect(committed.indexOf(AGENTS_BLOCK_END, end + AGENTS_BLOCK_END.length)).toBe(-1);
	});

	it("keeps every guide table two columns wide despite pipes in the contract's own wording", () => {
		// `move <id> up|down|...` and the description alternatives spell their choices
		// with a pipe, which GFM reads as a cell delimiter even inside a code span.
		const guide = renderCliGuide();
		const tables = {
			Commands: CLI_COMMAND_CONTRACT.actions.map(
				(action) => `\`npx -y ${CLI_COMMAND_CONTRACT.binary}@latest project ${action.usage}\``,
			),
			Flags: CLI_COMMAND_CONTRACT.flags.map((flag) => `\`${flag.usage}\``),
			"Exit codes": CLI_COMMAND_CONTRACT.exitCodes.map((exitCode) => `\`${exitCode.code}\``),
		};
		for (const [heading, expectedFirstCells] of Object.entries(tables)) {
			const rows = tableRowsUnder(guide, heading);
			expect(rows.length, `the ${heading} table rendered no rows`).toBe(expectedFirstCells.length);
			for (const cells of rows) {
				expect(
					cells,
					`a ${heading} row splits into ${cells.length} cells: ${cells.join(" / ")}`,
				).toHaveLength(2);
			}
			expect(rows.map((cells) => cells[0])).toEqual(expectedFirstCells);
		}
	});

	it("leaves no angle-bracket placeholder for GFM to parse away as raw HTML", () => {
		// `<git-root>` and `<text>` satisfy CommonMark's open tag production, so a
		// placeholder written outside a code span parses as an HTML tag and GitHub's
		// sanitizer drops it, deleting the very token the sentence is about.
		const surfaces = {
			[DOCS_PATH]: renderCliGuide(),
			[SKILL_PATH]: renderSkillMarkdown(),
			"the AGENTS.md block": renderAgentsMarkdownBlock(),
		};
		for (const [name, rendered] of Object.entries(surfaces)) {
			expect(
				rawHtmlPlaceholdersIn(rendered),
				`${name} spells a placeholder GFM would swallow as raw HTML`,
			).toEqual([]);
		}
	});

	it("scopes action-limited flags to documented actions and states the limit everywhere", () => {
		const actionNames = CLI_COMMAND_CONTRACT.actions.map((action) => action.name);
		const scoped = CLI_COMMAND_CONTRACT.flags.filter((flag) => flag.actions !== undefined);
		expect(scoped.length, "no flag declares the actions it applies to").toBeGreaterThan(0);
		const surfaces = {
			"the help output": renderCliUsage(),
			[DOCS_PATH]: renderCliGuide(),
			[SKILL_PATH]: renderSkillMarkdown(),
			"the AGENTS.md block": renderAgentsMarkdownBlock(),
		};
		for (const flag of scoped) {
			const actions = flag.actions ?? [];
			expect(actions.length, `${flag.name} scopes to no action at all`).toBeGreaterThan(0);
			for (const action of actions) {
				expect(actionNames, `${flag.name} names undocumented action ${action}`).toContain(action);
			}
			// A reader who misses the limit would expect the flag to work everywhere,
			// so every rendered surface has to carry it, not just the help output.
			// The limit has to name every action the CLI accepts too: a truncated
			// list sends a reader to an exit code 2 the flag never warned about.
			const scope = flagActionScope(flag);
			const prefix = `only for ${CLI_COMMAND_CONTRACT.scope} `;
			expect(scope.startsWith(prefix), `${flag.name} renders the limit as "${scope}"`).toBe(true);
			expect(
				scope
					.slice(prefix.length)
					.split(/,\s*(?:and\s+)?|\s+and\s+/)
					.filter(Boolean),
				`${flag.name}'s rendered limit does not name every action it applies to`,
			).toEqual([...actions]);
			for (const [name, surface] of Object.entries(surfaces)) {
				const entries = flagEntries(surface, flag);
				expect(entries.length, `${name} never renders ${flag.name}`).toBeGreaterThan(0);
				expect(
					entries.some((entry) => entry.includes(scope)),
					`${name} omits "${scope}" beside ${flag.usage}; it renders ${JSON.stringify(entries)}`,
				).toBe(true);
			}
		}
	});

	it("renders every stated rule onto both published surfaces", () => {
		// A rule added to the contract but rendered nowhere is worse than no rule at
		// all: it reads as settled in the source and is invisible to every caller.
		const surfaces = [
			[DOCS_PATH, renderCliGuide()],
			[SKILL_PATH, renderSkillMarkdown()],
		] as const;
		const ruleSets = {
			descriptionRules: CLI_COMMAND_CONTRACT.descriptionRules,
			planRules: CLI_COMMAND_CONTRACT.planRules,
			idRules: CLI_COMMAND_CONTRACT.idRules,
			orderRules: CLI_COMMAND_CONTRACT.orderRules,
			dependencyRules: CLI_COMMAND_CONTRACT.dependencyRules,
			sequencingRules: CLI_COMMAND_CONTRACT.sequencingRules,
		};
		for (const [name, rules] of Object.entries(ruleSets)) {
			expect(rules.length, `${name} states no rules`).toBeGreaterThan(0);
			for (const rule of rules) {
				for (const [path, surface] of surfaces) {
					expect(surface, `${path} omits a ${name} entry`).toContain(rule);
				}
			}
		}
	});

	it("keeps the committed worklist skill byte-identical to the contract render", async () => {
		const skill = await readFile(resolve(SKILL_PATH), "utf8");
		expect(skill, `${SKILL_PATH} is stale; run \`npm run docs\` to regenerate it`).toBe(
			renderSkillMarkdown(),
		);
	});

	it("finds the absolute paths the skill is checked against, and nothing else", () => {
		// The check the skill's neutrality rests on, exercised against inputs, because a
		// matcher only ever run over a file that has none cannot tell "no absolute path"
		// from "this pattern stopped matching".
		expect(absolutePathsIn("node /Users/someone/checkout/src/cli.ts project list")).toEqual([
			"/Users/someone/checkout/src/cli.ts",
		]);
		expect(absolutePathsIn("the skill file lands at /opt/stepstone/SKILL.md")).toEqual([
			"/opt/stepstone/SKILL.md",
		]);
		expect(absolutePathsIn("generated from /home/max/checkouts/stepstone by hand")).toEqual([
			"/home/max/checkouts/stepstone",
		]);
		expect(absolutePathsIn("two paths: /var/tmp/one and /etc/two")).toEqual(["/var/tmp/one", "/etc/two"]);
		// The spellings the skill legitimately carries: repository-relative paths, the
		// placeholder roots it uses instead of a real one, a home-relative path, and a URL.
		expect(
			absolutePathsIn(
				"`.worklist/worklist.json`, `docs/cli.md`, `.claude/skills/stepstone/SKILL.md`, " +
					"`<git-root>/.worklist/worklist.json`, `<checkout>/src/cli.ts`, `~/.claude/skills/`, " +
					"and https://example.com/a/b",
			),
		).toEqual([]);
	});

	it("renders a repository-neutral skill covering the whole contract surface", () => {
		const skill = renderSkillMarkdown();
		expect(skill).toContain(`description: ${JSON.stringify(CLI_COMMAND_CONTRACT.skillDescription)}`);
		// The skill installs globally, so every invocation must use the portable,
		// cache-safe `npx -y <binary>@latest` form and must never name a checkout
		// path that only exists on the author's machine.
		expect(skill).toContain(`npx -y ${CLI_COMMAND_CONTRACT.binary}@latest`);
		expect(skill).not.toMatch(new RegExp(String.raw`\bnpx -y ${CLI_COMMAND_CONTRACT.binary}(?!@latest)`));
		expect(skill).not.toMatch(new RegExp(String.raw`\bnpx ${CLI_COMMAND_CONTRACT.binary}\b`));
		expect(
			absolutePathsIn(skill),
			"SKILL.md names an absolute path, which exists only on the machine that generated it",
		).toEqual([]);
		expect(skill).toContain(DOCS_PATH);
		const exampleBlock = skill.match(/Examples:\n\n```sh\n([\s\S]*?)\n```/)?.[1];
		expect(exampleBlock, "SKILL.md is missing its Examples block").toBeDefined();
		for (const action of CLI_COMMAND_CONTRACT.actions.filter((entry) => entry.confirmRequired)) {
			expect(
				exampleBlock,
				`Examples must not hand an agent a copy-paste \`${action.name}\`; lifecycle actions need explicit user intent`,
			).not.toContain(`${CLI_COMMAND_CONTRACT.scope} ${action.name} `);
		}
		expect(exampleBlock, "Examples must not demonstrate `--confirm`").not.toContain("--confirm");
		expect(exampleBlock, "Programmatic description examples must use --description").toContain(
			"--description",
		);
		expect(exampleBlock, "Programmatic append examples must use --append-description").toContain(
			"--append-description",
		);
		expect(exampleBlock, "Programmatic examples must reserve the -- separator for humans").not.toMatch(
			/\s--\s/,
		);
		for (const action of CLI_COMMAND_CONTRACT.actions) {
			expect(skill, `SKILL.md is missing action usage \`${action.usage}\``).toContain(action.usage);
		}
		for (const flag of CLI_COMMAND_CONTRACT.flags) {
			expect(skill, `SKILL.md is missing flag \`${flag.usage}\``).toContain(flag.usage);
		}
		for (const exitCode of CLI_COMMAND_CONTRACT.exitCodes.filter((entry) => entry.code >= 1)) {
			expect(skill, `SKILL.md is missing exit code ${exitCode.code}`).toContain(`Exit code ${exitCode.code}`);
		}
	});

	it("uses cache-safe invocations across every published CLI artifact", async () => {
		const publishedInvocation = `npx -y ${CLI_COMMAND_CONTRACT.binary}@latest ${CLI_COMMAND_CONTRACT.scope}`;
		const bareInvocation = new RegExp(
			String.raw`\b${CLI_COMMAND_CONTRACT.binary} ${CLI_COMMAND_CONTRACT.scope}\b`,
		);
		const generated = [
			[SKILL_PATH, renderSkillMarkdown()],
			[DOCS_PATH, renderCliGuide()],
		] as const;
		const documentation = await readDocumentation();

		// A bare invocation anywhere is the hazard: it lets a stale npx cache serve an
		// older build, which is silent while it happens wherever it was copied from.
		for (const [path, contents] of [...generated, ...documentation]) {
			expect(contents, `${path} contains a bare published CLI invocation`).not.toMatch(bareInvocation);
		}
		for (const [path, contents] of generated) {
			expect(contents, `${path} is missing the published CLI invocation`).toContain(publishedInvocation);
		}
		const readme = documentation.find(([path]) => path === "README.md");
		expect(readme?.[1], "README.md is missing the published CLI invocation").toContain(publishedInvocation);
		expect(renderSkillMarkdown()).toContain("node <checkout>/src/cli.ts project <action>");
		expect(
			documentation.some(([, contents]) => contents.includes("node src/cli.ts project <action>")),
			"no document states the checkout entry point the skill sends contributors to",
		).toBe(true);
	});

	it("spells the names the contract owns the way the contract renders them", async () => {
		const documentation = await readDocumentation();

		for (const entry of CONTRACT_SPELLINGS) {
			expect(
				spellingProblems(documentation, entry),
				`the documentation disagrees with the ${entry.subject} the contract renders; if the prose is right, add the name to this entry's allowed list, or declare that shape optional if no page should have to state it`,
			).toEqual([]);
		}
	});

	it("catches a rename the generated artifacts absorb and the prose does not", async () => {
		// Renaming the contract regenerates docs/cli.md and SKILL.md and cannot touch a
		// hand-written page, so every spelling in the prose is stale the moment it lands.
		const documentation = await readDocumentation();
		const problems = spellingProblems(documentation, publishedPackageSpellings("stepstone-renamed"));
		const stale = problems.filter((problem) => problem.endsWith(` states ${CLI_COMMAND_CONTRACT.binary}`));
		expect(stale, "a rename leaves the prose unchanged and is reported nowhere").not.toEqual([]);
		expect(stale, "the report names the page a reader would be sent to the wrong package from").toContain(
			`README.md states ${CLI_COMMAND_CONTRACT.binary}`,
		);
		// The renamed spellings are absent everywhere, so each required shape also reports
		// that it now pins nothing rather than passing on an empty match set.
		expect(problems.filter((problem) => problem.includes("pins nothing"))).not.toEqual([]);
	});

	it("requires a declared shape to be stated and lets an optional shape be absent", () => {
		const documentation = [["docs/example.md", "Install it with `npm i example-package`."]] as const;
		const versionPin = /(example-[\w-]+)@\d+\.\d+\.\d+/g;
		const entry: SpellingEntry = {
			subject: "example package",
			shapes: [required(/npm i (example-[\w-]+)/g), optional(versionPin)],
			allowed: ["example-package"],
			canonical: "example-package",
		};
		// No page pins a version, which is a page's choice rather than a defect.
		expect(spellingProblems(documentation, entry)).toEqual([]);
		// The same absence in a required shape is the vacuous pass the check exists for.
		expect(spellingProblems(documentation, { ...entry, shapes: [required(versionPin)] })).toEqual([
			`no document spells the example package \`example-package\` as \`${versionPin.source}\`, so that shape pins nothing`,
		]);
		// A name the entry does not allow is reported wherever a shape finds it.
		expect(spellingProblems([["docs/example.md", "`npm i example-other`"]], entry)).toContain(
			"docs/example.md states example-other",
		);
	});

	it("declares the same Node floor the package does", async () => {
		const manifest = JSON.parse(await readFile(resolve("package.json"), "utf8")) as {
			engines: { node: string };
		};
		expect(
			manifest.engines.node,
			"package.json engines.node and CLI_COMMAND_CONTRACT.runtime.binaryNodeFloor disagree",
		).toBe(`>=${CLI_COMMAND_CONTRACT.runtime.binaryNodeFloor}`);
	});

	it("states the same Node floors in the documentation the contract declares", async () => {
		const documentation = await readDocumentation();
		const { binaryNodeFloor, sourceNodeFloor } = CLI_COMMAND_CONTRACT.runtime;
		// A floor is only useful paired with the runtime it applies to: the two are far
		// enough apart that a reader on the lower one, told the TypeScript entry point
		// works, meets `Unknown file extension ".ts"` instead. Matching the sentence
		// rather than the page keeps that pairing wherever the prose moves.
		const runtimes = [
			{
				runtime: "the compiled bin the published package ships",
				floor: binaryNodeFloor,
				named: [/compiled bin/, /published package/],
			},
			{
				runtime: "the TypeScript entry point run from a checkout",
				floor: sourceNodeFloor,
				named: [/TypeScript entry point/, /src\/cli\.ts/],
			},
		];
		const stated = documentation.flatMap(([path, contents]) =>
			contents.split("\n").flatMap((line) =>
				[...line.matchAll(/Node (\d+(?:\.\d+)*) (?:or newer|floor)/g)].map((match) => ({
					path,
					line,
					version: match[1] ?? "",
				})),
			),
		);
		for (const { path, line, version } of stated) {
			const named = runtimes.filter((entry) => entry.named.some((marker) => marker.test(line)));
			expect(
				named.map((entry) => entry.runtime),
				`${path} states Node ${version} without naming exactly one runtime it applies to: ${line}`,
			).toHaveLength(1);
			expect(version, `${path} states the wrong Node floor for ${named[0]?.runtime}: ${line}`).toBe(
				named[0]?.floor,
			);
		}
		// Set equality closes the other direction: both floors have to be stated where a
		// reader will meet them, and no page may state a version the contract does not
		// declare, because a stale floor left behind by a bump reads like a requirement.
		expect(
			new Set(stated.map(({ version }) => version)),
			`the documentation and CLI_COMMAND_CONTRACT.runtime disagree about Node requirements: ${stated
				.map(({ path, version }) => `${path} states ${version}`)
				.join(", ")}`,
		).toEqual(new Set([sourceNodeFloor, binaryNodeFloor]));
	});

	it("prints the contract-rendered help from the CLI itself", async () => {
		const root = await mkdtemp(join(tmpdir(), "stepstone-cli-help-"));
		await execFileAsync("git", ["init", "-q"], { cwd: root });
		const { stdout } = await execFileAsync(process.execPath, [resolve("src/cli.ts"), "project", "help"], {
			cwd: root,
		});
		expect(stdout.trimEnd()).toBe(renderCliUsage());
	});

	it("documents every implemented action and implements every documented action", async () => {
		const root = await mkdtemp(join(tmpdir(), "stepstone-cli-surface-"));
		await execFileAsync("git", ["init", "-q"], { cwd: root });
		const documented = CLI_COMMAND_CONTRACT.actions.map((action) => action.name);
		expect(documented).toEqual([
			"init",
			"list",
			"show",
			"find",
			"next",
			"ready",
			"waves",
			"ui",
			"add",
			"apply-plan",
			"update",
			"move",
			"start",
			"set_active",
			"complete",
			"reopen",
			"archive",
			"delete",
			"migrate_ids",
			"migrate_path",
			"help",
		]);

		// A documented read action must not be rejected as unknown.
		for (const action of ["list", "next", "ready", "waves", "help"]) {
			// Each invocation is independent; sequential execution keeps output readable.
			// pi-lens-ignore: await-in-loop
			const result = await execFileAsync(process.execPath, [resolve("src/cli.ts"), "project", action], {
				cwd: root,
			});
			expect(result.stdout.length).toBeGreaterThan(0);
		}

		// An undocumented action fails as a usage error, proving the switch and contract agree.
		await expect(
			execFileAsync(process.execPath, [resolve("src/cli.ts"), "project", "undocumented"], { cwd: root }),
		).rejects.toMatchObject({ code: 2 });
	});
});
