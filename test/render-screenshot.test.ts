import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderScreenshot } from "../scripts/render-screenshot.ts";

describe("README screenshot renderer", () => {
	it("renders repeatable PNG bytes with fixed dimensions", async () => {
		const input = "\x1b[36mProject Goals\x1b[0m\n⇅ Dependency";
		const first = await renderScreenshot(input);
		const second = await renderScreenshot(input);
		expect(first.png.equals(second.png)).toBe(true);
		expect(first.png.subarray(1, 4).toString()).toBe("PNG");
		expect(first.png.readUInt32BE(16)).toBe(1192);
		expect(first.png.readUInt32BE(20)).toBe(824);
		expect(first.svg).toContain('font-family="Noto Sans Math"');
	});

	it("preserves ANSI colors, inverse video, dim text, and decorations", async () => {
		const { svg } = await renderScreenshot("\x1b[38;2;12;34;56;48;5;196;1;2;4mA\x1b[7mB\x1b[0m<&>");
		expect(svg).toContain('fill="#0c2238"');
		expect(svg).toContain('fill="#ff0000"');
		expect(svg).toContain('opacity="0.5" font-weight="700"');
		expect(svg).toContain('text-decoration="underline"');
		expect(svg).toContain("&lt;</text>");
		expect(svg).toContain("&amp;</text>");
		expect(svg).toContain("&gt;</text>");
		expect(svg).toContain('y="12" width="10" height="20" fill="#0c2238"');
	});

	it("freezes wall time in a subprocess without stopping timers", () => {
		const clock = join(import.meta.dirname, "..", "scripts", "screenshot-clock.mjs");
		const output = execFileSync(
			process.execPath,
			[
				"--import",
				clock,
				"--input-type=module",
				"-e",
				`
			const before = Date.now();
			await new Promise(resolve => setTimeout(resolve, 10));
			console.log(JSON.stringify([before, Date.now(), new Date().toISOString(), new Date(0).toISOString(), Date.parse("1970-01-01T00:00:00Z")]));
		`,
			],
			{ encoding: "utf8", timeout: 10_000 },
		);
		expect(JSON.parse(output)).toEqual([
			1780315200000,
			1780315200000,
			"2026-06-01T12:00:00.000Z",
			"1970-01-01T00:00:00.000Z",
			0,
		]);
	});
});
