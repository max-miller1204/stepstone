/**
 * Fails when the module graph reachable from src/cli.ts stops being runnable
 * with nothing installed but Node.
 *
 *   npm run imports:check
 *
 * The compiled bin ships to people who run `npx pi-worklist` with no Pi
 * installation, so every runtime import it reaches has to resolve from Node's
 * builtins or the package's own `dependencies`. This repository installs every
 * Pi peer as a devDependency, so a stray `@earendil-works/*` import resolves
 * here and fails only for those users. Reading the sources catches that the
 * moment the import is written, well before the pack-and-install job in
 * scripts/no-pi-install-check.ts proves the same thing the slow way.
 *
 * `import type` and `export type` statements are erased before the bin runs and
 * are therefore allowed, which is what lets src/session-store.ts keep its Pi
 * types. An inline `import { type Foo }` is reported instead of erased: the
 * emitted shape depends on how the file is compiled, and the type-only form is
 * already this codebase's convention.
 */
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { dirname, relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const entryPoint = resolve(repoRoot, "src/cli.ts");

export interface ModuleImport {
	specifier: string;
	typeOnly: boolean;
}

export interface DisallowedImport {
	file: string;
	specifier: string;
	reason: string;
}

export interface ScannedSource {
	/** The source with every comment blanked out, line and column preserved. */
	code: string;
	/** True except where a character is the text of a string literal. */
	isCode: boolean[];
}

// A `/` opens a regex only where a value cannot have just ended: after an
// identifier, a literal, or a closing bracket it is division instead. These are
// the characters and the keywords a regex is allowed to follow.
const BEFORE_REGEX = /[([{,;:=!&|?+\-*%^~<>]/;
const KEYWORDS_BEFORE_REGEX = new Set([
	"await",
	"case",
	"delete",
	"do",
	"else",
	"in",
	"instanceof",
	"new",
	"of",
	"return",
	"typeof",
	"void",
	"yield",
]);

/**
 * Separates code from the three places an import can only look like one: a
 * comment, the text of a string, and the body of a regex. Comments are blanked
 * rather than removed so the statement after a multi-line one still starts its
 * own line, and the mask lets a later match be rejected for starting inside a
 * string, which is the only way to tell `require("x")` in a template from a real
 * call. Nothing but a template spans a line, so a quote or a slash that turns out
 * to open neither can only mislead the line it sits on.
 */
export function scanSource(source: string): ScannedSource {
	let code = "";
	const isCode: boolean[] = [];

	function emit(text: string, executable: boolean): void {
		code += text;
		for (let offset = 0; offset < text.length; offset += 1) isCode.push(executable);
	}

	/** Whether a `/` here starts a regex, judged by the code emitted before it. */
	function opensRegex(): boolean {
		let offset = code.length - 1;
		while (offset >= 0 && isCode[offset] && /\s/.test(code[offset] as string)) offset -= 1;
		if (offset < 0) return true;
		if (!isCode[offset]) return false;
		const char = code[offset] as string;
		if (BEFORE_REGEX.test(char)) return true;
		if (!/[\w$]/.test(char)) return false;
		const end = offset + 1;
		while (offset >= 0 && isCode[offset] && /[\w$]/.test(code[offset] as string)) offset -= 1;
		return KEYWORDS_BEFORE_REGEX.has(code.slice(offset + 1, end));
	}

	function emitStringLiteral(start: number): number {
		const quote = source[start];
		emit(quote as string, true);
		let index = start + 1;
		while (index < source.length) {
			const char = source[index];
			if (char === "\\") {
				emit(source.slice(index, index + 2), false);
				index += 2;
				continue;
			}
			if (char === quote) {
				emit(char, true);
				return index + 1;
			}
			// A quoted string cannot hold a raw newline, so one means this quote
			// opened something else - a character class, an apostrophe in prose the
			// comment blanker never saw - and the rest of the file is code again.
			if (quote !== "`" && char === "\n") return index;
			if (quote === "`" && char === "$" && source[index + 1] === "{") {
				emit("${", true);
				index = emitTemplateSpan(index + 2);
				continue;
			}
			emit(char as string, false);
			index += 1;
		}
		return source.length;
	}

	function emitRegexLiteral(start: number): number {
		emit("/", true);
		let index = start + 1;
		let inCharacterClass = false;
		while (index < source.length) {
			const char = source[index] as string;
			if (char === "\n") return index;
			if (char === "\\") {
				emit(source.slice(index, index + 2), false);
				index += 2;
				continue;
			}
			if (char === "[") inCharacterClass = true;
			else if (char === "]") inCharacterClass = false;
			else if (char === "/" && !inCharacterClass) {
				emit(char, true);
				return index + 1;
			}
			emit(char, false);
			index += 1;
		}
		return source.length;
	}

	function emitTemplateSpan(start: number): number {
		let depth = 1;
		let index = start;
		while (index < source.length) {
			const char = source[index];
			if (char === '"' || char === "'" || char === "`") {
				index = emitStringLiteral(index);
				continue;
			}
			if (char === "/" && opensRegex()) {
				index = emitRegexLiteral(index);
				continue;
			}
			emit(char as string, true);
			index += 1;
			if (char === "{") depth += 1;
			else if (char === "}" && --depth === 0) return index;
		}
		return source.length;
	}

	let index = 0;
	while (index < source.length) {
		const char = source[index];
		if (char === '"' || char === "'" || char === "`") {
			index = emitStringLiteral(index);
			continue;
		}
		const lineComment = char === "/" && source[index + 1] === "/";
		const blockComment = char === "/" && source[index + 1] === "*";
		if (lineComment || blockComment) {
			const end = lineComment ? lineCommentEnd(source, index) : blockCommentEnd(source, index);
			// Blanked to spaces, so nothing can match here; marked as code anyway so
			// the leading whitespace a match anchors on is not itself masked out.
			emit(source.slice(index, end).replace(/[^\n]/g, " "), true);
			index = end;
			continue;
		}
		if (char === "/" && opensRegex()) {
			index = emitRegexLiteral(index);
			continue;
		}
		emit(char as string, true);
		index += 1;
	}
	return { code, isCode };
}

function lineCommentEnd(source: string, start: number): number {
	const newline = source.indexOf("\n", start);
	return newline === -1 ? source.length : newline;
}

function blockCommentEnd(source: string, start: number): number {
	const terminator = source.indexOf("*/", start + 2);
	return terminator === -1 ? source.length : terminator + 2;
}

// An import or export clause is only identifiers, braces, commas, stars, and
// whitespace, so refusing every other character stops a statement without a
// `from` - `export const x = 1;` - from reaching forward into the next one.
const FROM_STATEMENT = /^[ \t]*(?:import|export)(\s[\w$*,{}\s]*?)\bfrom\s*["']([^"'\s]+)["']/gm;
const SIDE_EFFECT_IMPORT = /^[ \t]*import\s*["']([^"'\s]+)["']/gm;
const CALLED_IMPORT = /\b(?:import|require)\s*\(\s*["']([^"'\s]+)["']\s*\)/g;

/** Every module specifier the source loads, with the erasable ones marked. */
export function moduleImports(source: string): ModuleImport[] {
	const { code, isCode } = scanSource(source);
	const imports: ModuleImport[] = [];
	for (const match of code.matchAll(FROM_STATEMENT)) {
		if (!isCode[match.index]) continue;
		imports.push({ specifier: match[2] as string, typeOnly: /^\s*type\b/.test(match[1] as string) });
	}
	for (const pattern of [SIDE_EFFECT_IMPORT, CALLED_IMPORT]) {
		for (const match of code.matchAll(pattern)) {
			if (!isCode[match.index]) continue;
			imports.push({ specifier: match[1] as string, typeOnly: false });
		}
	}
	return imports;
}

/**
 * Resolves a relative specifier to the source file behind it, or null when it
 * names something other than a module, such as `../package.json`.
 */
function resolveRelative(fromFile: string, specifier: string): string | null {
	if (!specifier.startsWith(".")) return null;
	const target = resolve(dirname(fromFile), specifier);
	if (target.endsWith(".ts")) return target;
	if (target.endsWith(".js")) return `${target.slice(0, -".js".length)}.ts`;
	return null;
}

/**
 * Walks every module the entry point pulls in, following type-only edges too:
 * the build compiles whatever the entry point references, so those files reach
 * the published tree even when nothing loads them at runtime.
 */
export async function collectModuleGraph(entry = entryPoint): Promise<Map<string, ModuleImport[]>> {
	const graph = new Map<string, ModuleImport[]>();
	const pending = [entry];
	while (pending.length > 0) {
		const file = pending.pop() as string;
		if (graph.has(file)) continue;
		// The graph is discovered as it is walked, so each file is read in turn.
		// pi-lens-ignore: await-in-loop
		const imports = moduleImports(await readFile(file, "utf8"));
		graph.set(file, imports);
		for (const { specifier } of imports) {
			const resolved = resolveRelative(file, specifier);
			if (resolved !== null && !graph.has(resolved)) pending.push(resolved);
		}
	}
	return graph;
}

function packageNameOf(specifier: string): string {
	return specifier.startsWith("@")
		? specifier.split("/").slice(0, 2).join("/")
		: (specifier.split("/")[0] as string);
}

/** Every runtime import in the graph that a Pi-free install could not resolve. */
export async function findDisallowedImports(
	graph?: Map<string, ModuleImport[]>,
): Promise<DisallowedImport[]> {
	const manifest = JSON.parse(await readFile(resolve(repoRoot, "package.json"), "utf8")) as {
		dependencies?: Record<string, string>;
	};
	const declared = new Set(Object.keys(manifest.dependencies ?? {}));
	const modules = graph ?? (await collectModuleGraph());
	const disallowed: DisallowedImport[] = [];
	for (const [file, imports] of modules) {
		for (const { specifier, typeOnly } of imports) {
			if (typeOnly || specifier.startsWith(".") || isBuiltin(specifier)) continue;
			const packageName = packageNameOf(specifier);
			if (declared.has(packageName)) continue;
			disallowed.push({
				file: relative(repoRoot, file),
				specifier,
				reason: packageName.startsWith("@earendil-works/")
					? `${packageName} is a Pi peer, which is absent wherever the bin is installed on its own`
					: `${packageName} is not a declared runtime dependency`,
			});
		}
	}
	return disallowed;
}

/**
 * Whether Node started this file rather than a test importing it. The module URL
 * behind `import.meta.filename` has its symlinks resolved and `process.argv[1]`
 * does not, so both sides have to be realpaths: comparing the raw path would
 * make an invocation through a symlinked checkout exit 0 having checked nothing.
 */
function isEntryPoint(): boolean {
	const invoked = process.argv[1];
	if (invoked === undefined) return false;
	try {
		return realpathSync(resolve(invoked)) === import.meta.filename;
	} catch {
		return false;
	}
}

if (isEntryPoint()) {
	const graph = await collectModuleGraph();
	const disallowed = await findDisallowedImports(graph);
	if (disallowed.length > 0) {
		const report = disallowed.map((entry) => `  ${entry.file} imports ${entry.specifier}: ${entry.reason}`);
		process.stderr.write(`The CLI import graph no longer runs without Pi installed:\n${report.join("\n")}\n`);
		process.exit(1);
	}
	process.stdout.write(
		`Checked ${graph.size} modules reachable from src/cli.ts: no Pi peers, no undeclared imports.\n`,
	);
}
