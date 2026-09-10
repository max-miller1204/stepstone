import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import xterm from "@xterm/headless";

export const columns = 116;
export const rows = 40;
const background = "#1e1e2e";
const foreground = "#cdd6f4";
const palette = [
	"#45475a",
	"#f38ba8",
	"#a6e3a1",
	"#f9e2af",
	"#89b4fa",
	"#f5c2e7",
	"#94e2d5",
	"#bac2de",
	"#585b70",
	"#f38ba8",
	"#a6e3a1",
	"#f9e2af",
	"#89b4fa",
	"#f5c2e7",
	"#94e2d5",
	"#a6adc8",
];

function color(value: number, indexed: boolean): string {
	if (!indexed) return `#${value.toString(16).padStart(6, "0")}`;
	if (value < 16) return palette[value];
	if (value >= 232) return color((8 + (value - 232) * 10) * 0x010101, false);
	const index = value - 16;
	const levels = [0, 95, 135, 175, 215, 255];
	return color(
		levels[Math.floor(index / 36)] * 65536 + levels[Math.floor(index / 6) % 6] * 256 + levels[index % 6],
		false,
	);
}

function escapeXml(text: string): string {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

/** Render captured terminal cells with a fixed font, palette, and geometry. */
export async function renderScreenshot(capture: string): Promise<{ svg: string; png: Buffer }> {
	const terminal = new xterm.Terminal({ cols: columns, rows, allowProposedApi: true });
	try {
		await new Promise<void>((done) => terminal.write(capture.trimEnd().replaceAll("\n", "\r\n"), done));
		const cells: string[] = [];
		for (let y = 0; y < rows; y++) {
			const line = terminal.buffer.active.getLine(y);
			if (!line) throw new Error(`Missing terminal row ${y}.`);
			for (let x = 0; x < columns; x++) {
				const cell = line.getCell(x);
				if (!cell) throw new Error(`Missing terminal cell ${x},${y}.`);
				if (cell.getWidth() === 0) continue;
				let fg = cell.isFgDefault() ? foreground : color(cell.getFgColor(), cell.isFgPalette());
				let bg = cell.isBgDefault() ? background : color(cell.getBgColor(), cell.isBgPalette());
				if (cell.isInverse()) [fg, bg] = [bg, fg];
				const left = 16 + x * 10;
				const top = 12 + y * 20;
				const width = cell.getWidth() * 10;
				cells.push(`<rect x="${left}" y="${top}" width="${width}" height="20" fill="${bg}"/>`);
				if (cell.isInvisible() || !cell.getChars()) continue;
				const decoration = [
					cell.isUnderline() ? "underline" : "",
					cell.isStrikethrough() ? "line-through" : "",
					cell.isOverline() ? "overline" : "",
				]
					.filter(Boolean)
					.join(" ");
				cells.push(
					`<text font-family="${cell.getChars() === "⇅" ? "Noto Sans Math" : "JetBrains Mono"}" x="${left}" y="${top + 15}" fill="${fg}" opacity="${cell.isDim() ? 0.5 : 1}" font-weight="${cell.isBold() ? 700 : 400}" font-style="${cell.isItalic() ? "italic" : "normal"}" text-decoration="${decoration}">${escapeXml(cell.getChars())}</text>`,
				);
			}
		}
		const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1192" height="824" font-family="JetBrains Mono" font-size="16" xml:space="preserve"><rect width="100%" height="100%" fill="${background}"/>${cells.join("")}</svg>`;
		const png = new Resvg(svg, {
			font: {
				loadSystemFonts: false,
				fontFiles: ["JetBrainsMono-Regular.ttf", "JetBrainsMono-Bold.ttf", "NotoSansMath-Regular.ttf"].map(
					(file) => join(import.meta.dirname, "screenshot-assets", file),
				),
				defaultFontFamily: "JetBrains Mono",
			},
		})
			.render()
			.asPng();
		return { svg, png };
	} finally {
		terminal.dispose();
	}
}
