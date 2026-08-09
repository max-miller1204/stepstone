import { describe, expect, it } from "vitest";
import { collectModuleGraph, findDisallowedImports, moduleImports } from "../scripts/cli-import-graph.ts";

function specifiers(source: string): string[] {
	return moduleImports(source)
		.filter((entry) => !entry.typeOnly)
		.map((entry) => entry.specifier);
}

describe("CLI module scanner", () => {
	it("reads every shape of runtime import", () => {
		const source = [
			'import "./side-effect.ts";',
			'import defaultExport from "./default.ts";',
			'import * as namespace from "./namespace.ts";',
			'import {\n\talpha,\n\tbeta as gamma,\n} from "./multi-line.ts";',
			'export { alpha } from "./re-export.ts";',
			'export * as everything from "./star.ts";',
			'const lazy = await import("./dynamic.ts");',
			'const legacy = require("./legacy.cjs");',
		].join("\n");
		expect(specifiers(source)).toEqual(
			expect.arrayContaining([
				"./side-effect.ts",
				"./default.ts",
				"./namespace.ts",
				"./multi-line.ts",
				"./re-export.ts",
				"./star.ts",
				"./dynamic.ts",
				"./legacy.cjs",
			]),
		);
		expect(specifiers(source)).toHaveLength(8);
	});

	it("treats a type-only statement as erased and an inline type as runtime", () => {
		const source = [
			'import type { Theme } from "@earendil-works/pi-coding-agent";',
			'export type { Theme } from "@earendil-works/pi-coding-agent";',
			'import { type Key } from "@earendil-works/pi-tui";',
		].join("\n");
		expect(moduleImports(source)).toEqual([
			{ specifier: "@earendil-works/pi-coding-agent", typeOnly: true },
			{ specifier: "@earendil-works/pi-coding-agent", typeOnly: true },
			{ specifier: "@earendil-works/pi-tui", typeOnly: false },
		]);
	});

	it("ignores an import that only appears in a comment", () => {
		const source = [
			'// import { Key } from "@earendil-works/pi-tui";',
			"/*",
			'import { Theme } from "@earendil-works/pi-coding-agent";',
			"*/",
			'import { real } from "./real.ts";',
		].join("\n");
		expect(specifiers(source)).toEqual(["./real.ts"]);
	});

	it("keeps a statement hidden behind a block comment visible", () => {
		// Blanking a comment has to preserve its newlines, or the statement after
		// it stops looking like the start of a line and goes unread.
		const source = 'const version = 1; /* spans\nlines */ import { Key } from "@earendil-works/pi-tui";';
		expect(specifiers(source)).toEqual(["@earendil-works/pi-tui"]);
	});

	it("does not let a statement without a specifier reach into the next one", () => {
		const source = [
			"export const RETRIES = 3;",
			"export interface Options {\n\tretries: number;\n}",
			'import type { Theme } from "@earendil-works/pi-coding-agent";',
		].join("\n");
		expect(moduleImports(source)).toEqual([{ specifier: "@earendil-works/pi-coding-agent", typeOnly: true }]);
	});

	it("reads no import out of ordinary strings and templates", () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: source text under test, not a template
		const template = 'const hint = `use ${help} or require("@earendil-works/pi-ai")`;';
		const source = ["const help = \"run import x from '@earendil-works/pi-tui'\";", template].join("\n");
		expect(moduleImports(source)).toEqual([]);
	});

	it("still reads code inside a template placeholder", () => {
		// The counterpart to the case above: a placeholder holds code, not text, so
		// the scanner must not skip a whole template on sight.
		// biome-ignore lint/suspicious/noTemplateCurlyInString: source text under test, not a template
		const source = 'const loaded = `${await import("./lazy.ts")}`;';
		expect(specifiers(source)).toEqual(["./lazy.ts"]);
	});
});

describe("the module graph behind the CLI bin", () => {
	it("reaches the terminal board, which is where a Pi import is most tempting", async () => {
		const graph = await collectModuleGraph();
		const files = [...graph.keys()].map((file) => file.slice(file.lastIndexOf("/src/") + 1));
		expect(files).toContain("src/tui/goal-board-runtime.ts");
		expect(files).toContain("src/tui/goal-board.ts");
	});

	it("imports nothing at runtime that a Pi-free install could not resolve", async () => {
		// The slow proof lives in scripts/no-pi-install-check.ts, which packs and
		// installs the tarball; this is the same invariant read off the sources.
		expect(await findDisallowedImports()).toEqual([]);
	});
});
