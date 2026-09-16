import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const SUMMARY_PATH = resolve("coverage/coverage-summary.json");
const BASELINE_PATH = resolve("test/coverage-baseline.json");
const METRICS = ["lines", "branches", "functions", "statements"] as const;
type Metric = (typeof METRICS)[number];
type Thresholds = Record<Metric, number>;
type Baseline = Record<string, Thresholds>;
interface SummaryMetric {
	pct: number;
}
type Summary = Record<string, Record<Metric, SummaryMetric>>;

function readSummary(): Baseline {
	if (!existsSync(SUMMARY_PATH)) {
		throw new Error(`coverage summary is missing: ${relative(process.cwd(), SUMMARY_PATH)}`);
	}
	const raw = JSON.parse(readFileSync(SUMMARY_PATH, "utf8")) as Summary;
	const baseline: Baseline = {};
	for (const [absolutePath, value] of Object.entries(raw)) {
		const path =
			absolutePath === "total" ? "total" : relative(process.cwd(), absolutePath).replaceAll("\\", "/");
		baseline[path] = Object.fromEntries(METRICS.map((metric) => [metric, value[metric].pct])) as Thresholds;
	}
	return Object.fromEntries(Object.entries(baseline).sort(([left], [right]) => left.localeCompare(right)));
}

function readBaseline(): Baseline {
	if (!existsSync(BASELINE_PATH))
		throw new Error("coverage baseline is missing; run npm run test:coverage:update");
	return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
}

function regressions(baseline: Baseline, current: Baseline): string[] {
	const failures: string[] = [];
	for (const path of Object.keys(baseline)) {
		if (current[path] === undefined) {
			failures.push(`${path} disappeared from the coverage report`);
			continue;
		}
		for (const metric of METRICS) {
			if (current[path][metric] < baseline[path][metric]) {
				failures.push(`${path} ${metric}: ${current[path][metric]} < ${baseline[path][metric]}`);
			}
		}
	}
	for (const path of Object.keys(current)) {
		if (baseline[path] === undefined) failures.push(`${path} has no committed coverage baseline`);
	}
	return failures;
}

const current = readSummary();
const update = process.argv.slice(2);
if (update.length > 1 || (update.length === 1 && update[0] !== "--update")) {
	throw new Error("Usage: node scripts/coverage-ratchet.ts [--update]");
}

if (update[0] === "--update") {
	if (existsSync(BASELINE_PATH)) {
		const failures = regressions(readBaseline(), current).filter(
			(failure) => !failure.includes("has no committed"),
		);
		if (failures.length > 0) {
			throw new Error(`coverage baselines only move up:\n${failures.join("\n")}`);
		}
	}
	writeFileSync(BASELINE_PATH, `${JSON.stringify(current, null, "\t")}\n`);
	console.log(`coverage:ratchet: wrote ${relative(process.cwd(), BASELINE_PATH)}`);
} else {
	const failures = regressions(readBaseline(), current);
	if (failures.length > 0)
		throw new Error(`coverage fell below the committed per-file baseline:\n${failures.join("\n")}`);
	console.log(`coverage:ratchet: ${Object.keys(current).length - 1} source files meet their baselines`);
}
