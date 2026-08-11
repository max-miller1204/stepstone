import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
	CLI_COMMAND_CONTRACT,
	DOCS_PATH,
	renderCliGuide,
	renderCliUsage,
	renderSkillMarkdown,
	SKILL_PATH,
} from "../src/cli-contract.ts";

const execFileAsync = promisify(execFile);

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
		const artifacts = [
			[SKILL_PATH, renderSkillMarkdown()],
			[DOCS_PATH, renderCliGuide()],
			["README.md", await readFile(resolve("README.md"), "utf8")],
		] as const;

		for (const [path, contents] of artifacts) {
			expect(contents, `${path} is missing the published CLI invocation`).toContain(publishedInvocation);
			expect(contents, `${path} contains a bare published CLI invocation`).not.toMatch(bareInvocation);
		}
		expect(renderSkillMarkdown()).toContain("node <checkout>/src/cli.ts project <action>");
		expect(artifacts[2][1]).toContain("node src/cli.ts project <action>");
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

	it("states the same Node floors in the README the contract declares", async () => {
		const readme = await readFile(resolve("README.md"), "utf8");
		const { binaryNodeFloor, sourceNodeFloor } = CLI_COMMAND_CONTRACT.runtime;
		expect(readme, "README.md and CLI_COMMAND_CONTRACT.runtime.sourceNodeFloor disagree").toContain(
			`Node ${sourceNodeFloor} or newer`,
		);
		expect(readme, "README.md and CLI_COMMAND_CONTRACT.runtime.binaryNodeFloor disagree").toContain(
			`Node ${binaryNodeFloor} floor`,
		);
		// A stale floor left behind by a contract bump would still satisfy the assertions above,
		// so every version the README states as a requirement has to be one the contract declares.
		const stated = [...readme.matchAll(/Node (\d+(?:\.\d+)*) (?:or newer|floor)/g)].map((match) => match[1]);
		expect(new Set(stated), "README.md states a Node requirement the contract does not declare").toEqual(
			new Set([sourceNodeFloor, binaryNodeFloor]),
		);
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
