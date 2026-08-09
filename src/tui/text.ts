/**
 * Terminal text measurement, truncation, and wrapping.
 *
 * The standalone Project Goal board runs from the compiled `stepstone` bin,
 * which must work with nothing installed but Node. Pi's `@earendil-works/pi-tui`
 * helpers are therefore unavailable here, so this module re-implements the small
 * subset the board needs with no dependencies.
 *
 * Widths are grapheme-aware: goal titles and descriptions are arbitrary user
 * text and may contain combining marks, emoji, or East Asian characters, all of
 * which would misalign the box drawing if counted by UTF-16 code unit.
 */

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Select Graphic Rendition sequences, the only escapes this module emits. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the ESC byte is the purpose of this terminal decoder.
const SGR_PATTERN = /(\u001b\[[0-9;]*m)/;

/** Common prefix of every escape sequence this module emits or measures. */
const CSI = "\u001b[";

const SGR_RESET = `${CSI}0m`;

/** Ranges rendered as two terminal cells, sorted ascending and non-overlapping. */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
	[0x1100, 0x115f],
	[0x2329, 0x232a],
	[0x2e80, 0x303e],
	[0x3041, 0x33ff],
	[0x3400, 0x4dbf],
	[0x4e00, 0x9fff],
	[0xa000, 0xa4cf],
	[0xa960, 0xa97f],
	[0xac00, 0xd7a3],
	[0xf900, 0xfaff],
	[0xfe10, 0xfe19],
	[0xfe30, 0xfe6f],
	[0xff00, 0xff60],
	[0xffe0, 0xffe6],
	[0x1f004, 0x1f004],
	[0x1f0cf, 0x1f0cf],
	[0x1f18e, 0x1f18e],
	[0x1f191, 0x1f19a],
	[0x1f200, 0x1f320],
	[0x1f32d, 0x1f335],
	[0x1f337, 0x1f37c],
	[0x1f37e, 0x1f393],
	[0x1f3a0, 0x1f3ca],
	[0x1f3cf, 0x1f3d3],
	[0x1f3e0, 0x1f3f0],
	[0x1f3f4, 0x1f3f4],
	[0x1f3f8, 0x1f43e],
	[0x1f440, 0x1f440],
	[0x1f442, 0x1f4fc],
	[0x1f4ff, 0x1f53d],
	[0x1f54b, 0x1f54e],
	[0x1f550, 0x1f567],
	[0x1f57a, 0x1f57a],
	[0x1f595, 0x1f596],
	[0x1f5a4, 0x1f5a4],
	[0x1f5fb, 0x1f64f],
	[0x1f680, 0x1f6c5],
	[0x1f6cc, 0x1f6cc],
	[0x1f6d0, 0x1f6d2],
	[0x1f6eb, 0x1f6ec],
	[0x1f6f4, 0x1f6fc],
	[0x1f7e0, 0x1f7eb],
	[0x1f90c, 0x1f93a],
	[0x1f93c, 0x1f945],
	[0x1f947, 0x1f9ff],
	[0x1fa70, 0x1faff],
	[0x20000, 0x2fffd],
	[0x30000, 0x3fffd],
];

/** Ranges that occupy no terminal cell of their own, sorted ascending. */
const ZERO_WIDTH_RANGES: ReadonlyArray<readonly [number, number]> = [
	[0x0300, 0x036f],
	[0x0483, 0x0489],
	[0x0591, 0x05bd],
	[0x0610, 0x061a],
	[0x064b, 0x065f],
	[0x0670, 0x0670],
	[0x06d6, 0x06dc],
	[0x0711, 0x0711],
	[0x0730, 0x074a],
	[0x07a6, 0x07b0],
	[0x0816, 0x0819],
	[0x081b, 0x0823],
	[0x0900, 0x0903],
	[0x093a, 0x094f],
	[0x0951, 0x0957],
	[0x0e31, 0x0e31],
	[0x0e34, 0x0e3a],
	[0x0e47, 0x0e4e],
	[0x1ab0, 0x1aff],
	[0x1dc0, 0x1dff],
	[0x200b, 0x200f],
	[0x2028, 0x202e],
	[0x2060, 0x2064],
	[0x20d0, 0x20f0],
	[0xfe00, 0xfe0f],
	[0xfe20, 0xfe2f],
	[0xfeff, 0xfeff],
	[0xe0100, 0xe01ef],
];

/** Regional indicators pair into one double-width flag grapheme. */
const REGIONAL_INDICATOR_START = 0x1f1e6;
const REGIONAL_INDICATOR_END = 0x1f1ff;

const EMOJI_PRESENTATION_SELECTOR = 0xfe0f;

function inSortedRanges(code: number, ranges: ReadonlyArray<readonly [number, number]>): boolean {
	for (const [start, end] of ranges) {
		if (code < start) return false;
		if (code <= end) return true;
	}
	return false;
}

function codePointWidth(code: number): number {
	// C0 and C1 controls, including DEL, never advance the cursor by a cell.
	if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return 0;
	if (inSortedRanges(code, ZERO_WIDTH_RANGES)) return 0;
	if (inSortedRanges(code, WIDE_RANGES)) return 2;
	return 1;
}

/**
 * Width of one grapheme cluster.
 *
 * A cluster advances the cursor by its base character, not by the sum of its
 * parts, so `e` plus a combining acute is one cell wide. Two exceptions render
 * wide despite a narrow base: a flag built from regional indicators, and any
 * base followed by the emoji presentation selector.
 */
function graphemeWidth(cluster: string): number {
	const first = cluster.codePointAt(0);
	if (first === undefined) return 0;
	if (first >= REGIONAL_INDICATOR_START && first <= REGIONAL_INDICATOR_END) return 2;

	let width = 0;
	let emojiPresentation = false;
	for (const character of cluster) {
		const code = character.codePointAt(0) ?? 0;
		if (code === EMOJI_PRESENTATION_SELECTOR) emojiPresentation = true;
		if (width === 0) width = codePointWidth(code);
	}
	if (emojiPresentation && width === 1) return 2;
	return width;
}

export interface TextCell {
	/** Either one grapheme cluster or one complete SGR escape sequence. */
	text: string;
	/** Terminal cells consumed; always 0 for escape sequences. */
	width: number;
}

/** Split styled text into escape sequences and measured grapheme clusters. */
export function toCells(text: string): TextCell[] {
	const cells: TextCell[] = [];
	// String.split with a capturing group alternates plain text and escape sequences.
	for (const part of text.split(SGR_PATTERN)) {
		if (part === "") continue;
		if (part.startsWith(CSI)) {
			cells.push({ text: part, width: 0 });
			continue;
		}
		for (const { segment } of GRAPHEME_SEGMENTER.segment(part)) {
			cells.push({ text: segment, width: graphemeWidth(segment) });
		}
	}
	return cells;
}

/** Terminal cells `text` occupies, ignoring any escape sequences it carries. */
export function visibleWidth(text: string): number {
	let total = 0;
	for (const cell of toCells(text)) total += cell.width;
	return total;
}

function needsReset(text: string): boolean {
	return text.includes(CSI);
}

/**
 * Cut `text` to at most `width` cells, appending `ellipsis` when content is lost.
 *
 * Styling is preserved verbatim, and a reset is appended whenever the cut could
 * have discarded one, so a truncated line never bleeds color into the next.
 */
export function truncateToWidth(text: string, width: number, ellipsis = "…"): string {
	if (width <= 0) return "";
	const cells = toCells(text);
	let total = 0;
	for (const cell of cells) total += cell.width;
	if (total <= width) return text;

	const ellipsisWidth = visibleWidth(ellipsis);
	const budget = Math.max(0, width - ellipsisWidth);
	let used = 0;
	let output = "";
	for (const cell of cells) {
		if (cell.width === 0) {
			output += cell.text;
			continue;
		}
		if (used + cell.width > budget) break;
		used += cell.width;
		output += cell.text;
	}
	output += ellipsis;
	// A wide grapheme may have left one cell unusable; pad so borders still align.
	output += " ".repeat(Math.max(0, width - used - ellipsisWidth));
	return needsReset(output) ? `${output}${SGR_RESET}` : output;
}

/** Pad `text` with spaces to exactly `width` cells, truncating when it overflows. */
export function fitToWidth(text: string, width: number, ellipsis = "…"): string {
	if (width <= 0) return "";
	const current = visibleWidth(text);
	if (current === width) return text;
	if (current > width) return truncateToWidth(text, width, ellipsis);
	return text + " ".repeat(width - current);
}

/** Break one long word that cannot fit on a line of its own. */
function breakWord(word: string, width: number): string[] {
	const pieces: string[] = [];
	let current = "";
	let used = 0;
	for (const cell of toCells(word)) {
		if (used + cell.width > width && current !== "") {
			pieces.push(current);
			current = "";
			used = 0;
		}
		current += cell.text;
		used += cell.width;
	}
	if (current !== "") pieces.push(current);
	return pieces;
}

/**
 * Word-wrap plain text to `width` cells.
 *
 * Explicit line breaks are honored, including blank lines, so a description
 * keeps the paragraph structure its author typed.
 */
export function wrapText(text: string, width: number): string[] {
	if (width <= 0) return [];
	const lines: string[] = [];
	for (const paragraph of text.replace(/\r\n?/g, "\n").split("\n")) {
		const words = paragraph.split(/[ \t]+/).filter((word) => word !== "");
		if (words.length === 0) {
			lines.push("");
			continue;
		}
		let current = "";
		let used = 0;
		for (const word of words) {
			const wordWidth = visibleWidth(word);
			if (wordWidth > width) {
				if (current !== "") {
					lines.push(current);
					current = "";
					used = 0;
				}
				const pieces = breakWord(word, width);
				lines.push(...pieces.slice(0, -1));
				current = pieces.at(-1) ?? "";
				used = visibleWidth(current);
				continue;
			}
			if (current === "") {
				current = word;
				used = wordWidth;
				continue;
			}
			if (used + 1 + wordWidth > width) {
				lines.push(current);
				current = word;
				used = wordWidth;
				continue;
			}
			current += ` ${word}`;
			used += 1 + wordWidth;
		}
		if (current !== "") lines.push(current);
	}
	return lines;
}

/** Collapse whitespace so a multi-line value fits one list row. */
export function singleLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}
