import { defineConfig } from "vitest/config";
export default defineConfig({
	test: {
		include: ["test/service/**/*.test.ts"],
		testTimeout: 30000,
		hookTimeout: 30000,
		expect: { requireAssertions: true },
		allowOnly: false,
		passWithNoTests: false,
		coverage: {
			provider: "v8",
			include: ["src/service/**/*.ts"],
			reporter: ["text", "json-summary"],
			reportsDirectory: "artifacts/service-coverage",
			thresholds: { lines: 85, functions: 90, branches: 75, statements: 85 },
		},
	},
});
