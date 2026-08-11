import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
	CLI_COMMAND_CONTRACT,
	DOCS_PATH,
	LEGACY_WORKLIST_DIRECTORY,
	renderCliGuide,
	renderCliUsage,
	renderSkillMarkdown,
	SKILL_PATH,
	WORKLIST_DIRECTORY,
	WORKLIST_FILENAME,
	WORKLIST_PATH_ENV,
} from "../src/cli-contract.ts";

const execFileAsync = promisify(execFile);

/**
 * Every page of prose a reader lands on, paired with its contents.
 *
 * The documentation is the README plus `docs/`, so an assertion naming README.md
 * alone would stop covering the page that actually carries the claim as soon as
 * prose moves. Reading the directory also covers a document the day it is added,
 * which is the case a hand-maintained list always misses.
 */
async function readDocumentation(): Promise<(readonly [string, string])[]> {
	const docsDirectory = "docs";
	const entries = await readdir(resolve(docsDirectory));
	const paths = [
		"README.md",
		...entries
			.filter((entry) => entry.endsWith(".md"))
			.sort()
			.map((entry) => join(docsDirectory, entry)),
	];
	return Promise.all(paths.map(async (path) => [path, await readFile(resolve(path), "utf8")] as const));
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
 * Names the contract owns, paired with every spelling a document may state.
 *
 * A rename is a one-line change to the contract, which regenerates the
 * generated artifacts but cannot touch hand-written prose. Pinning one
 * invocation in README.md leaves the rest of the documentation free to go on
 * sending readers to a package, an environment variable, or a directory that no
 * longer exists, which is silent because the old spellings still read as
 * instructions. Each entry collects every occurrence of its shape across the
 * documentation, requires each one to be a spelling the contract renders today,
 * and requires the canonical spelling to appear at all, so a pattern that stops
 * matching fails rather than passing vacuously.
 */
const CONTRACT_SPELLINGS: readonly {
	subject: string;
	pattern: RegExp;
	allowed: readonly string[];
	canonical: string;
}[] = [
	{
		subject: "published package",
		pattern: /npx -y (\S+)@latest/g,
		allowed: [CLI_COMMAND_CONTRACT.binary, FROZEN_PREDECESSOR_PACKAGE],
		canonical: CLI_COMMAND_CONTRACT.binary,
	},
	{
		subject: "goal file environment override",
		pattern: /\$([A-Z][A-Z0-9_]*_WORKLIST)\b/g,
		allowed: [WORKLIST_PATH_ENV],
		canonical: WORKLIST_PATH_ENV,
	},
	{
		subject: "goal file directory",
		pattern: new RegExp(String.raw`([\w.-]+)/${literal(WORKLIST_FILENAME)}`, "g"),
		allowed: [WORKLIST_DIRECTORY, LEGACY_WORKLIST_DIRECTORY],
		canonical: WORKLIST_DIRECTORY,
	},
	{
		subject: "agent skill directory",
		pattern: new RegExp(String.raw`${literal(dirname(SKILL_DIRECTORY))}/([\w.-]+)`, "g"),
		allowed: [basename(SKILL_DIRECTORY)],
		canonical: basename(SKILL_DIRECTORY),
	},
];

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

	it("scopes action-limited flags to documented actions and states the limit everywhere", () => {
		const actionNames = CLI_COMMAND_CONTRACT.actions.map((action) => action.name);
		const scoped = CLI_COMMAND_CONTRACT.flags.filter((flag) => flag.actions !== undefined);
		expect(scoped.length, "no flag declares the actions it applies to").toBeGreaterThan(0);
		const surfaces = [renderCliUsage(), renderCliGuide(), renderSkillMarkdown()];
		for (const flag of scoped) {
			const actions = flag.actions ?? [];
			expect(actions.length, `${flag.name} scopes to no action at all`).toBeGreaterThan(0);
			for (const action of actions) {
				expect(actionNames, `${flag.name} names undocumented action ${action}`).toContain(action);
			}
			// A reader who misses the limit would expect the flag to work everywhere,
			// so every rendered surface has to carry it, not just the help output.
			for (const surface of surfaces) {
				expect(surface, `a surface omits the action limit for ${flag.name}`).toContain(`${flag.usage}`);
				expect(surface, `a surface omits the action limit for ${flag.name}`).toContain(
					`only for ${CLI_COMMAND_CONTRACT.scope} ${actions[0]}`,
				);
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

	it("renders a repository-neutral skill covering the whole contract surface", () => {
		const skill = renderSkillMarkdown();
		expect(skill).toContain(`description: ${JSON.stringify(CLI_COMMAND_CONTRACT.skillDescription)}`);
		// The skill installs globally, so every invocation must use the portable,
		// cache-safe `npx -y <binary>@latest` form and must never name a checkout
		// path that only exists on the author's machine.
		expect(skill).toContain(`npx -y ${CLI_COMMAND_CONTRACT.binary}@latest`);
		expect(skill).not.toMatch(new RegExp(String.raw`\bnpx -y ${CLI_COMMAND_CONTRACT.binary}(?!@latest)`));
		expect(skill).not.toMatch(new RegExp(String.raw`\bnpx ${CLI_COMMAND_CONTRACT.binary}\b`));
		expect(skill).not.toContain("/home/");
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

		for (const { subject, pattern, allowed, canonical } of CONTRACT_SPELLINGS) {
			const stated = documentation.flatMap(([path, contents]) =>
				[...contents.matchAll(pattern)].map((match) => [path, match[1] ?? ""] as const),
			);
			expect(
				stated.filter(([, name]) => !allowed.includes(name)).map(([path, name]) => `${path} states ${name}`),
				`the documentation names a ${subject} the contract does not render`,
			).toEqual([]);
			expect(
				stated.map(([, name]) => name),
				`no document states the ${subject} \`${canonical}\`, so the assertion above pins nothing`,
			).toContain(canonical);
		}
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
		const stated = documentation.flatMap(([path, contents]) =>
			[...contents.matchAll(/Node (\d+(?:\.\d+)*) (?:or newer|floor)/g)].map(
				(match) => [path, match[1]] as const,
			),
		);
		// Set equality asserts both directions at once: both floors have to be stated
		// where a reader will meet them, and no page may state a version the contract
		// does not declare, because a stale floor left behind by a contract bump reads
		// exactly like a current requirement.
		expect(
			new Set(stated.map(([, version]) => version)),
			`the documentation and CLI_COMMAND_CONTRACT.runtime disagree about Node requirements: ${stated
				.map(([path, version]) => `${path} states ${version}`)
				.join(", ")}`,
		).toEqual(new Set([sourceNodeFloor, binaryNodeFloor]));
	});

	it("ships the generated skill in the published package", async () => {
		const manifest = JSON.parse(await readFile(resolve("package.json"), "utf8")) as { files: string[] };
		expect(manifest.files, `${SKILL_PATH} must be packaged so installs carry the skill`).toContain(
			dirname(SKILL_PATH),
		);
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
