import { defineConfig } from "vitest/config";
import TestPolicyReporter from "./scripts/test-policy-reporter.ts";

export default defineConfig({
	test: {
		globals: false,
		environment: "node",
		include: ["test/**/*.test.ts"],
		exclude: ["test/service/**"],
		reporters: ["default", new TestPolicyReporter()],
		allowOnly: false,
		passWithNoTests: false,
		expect: {
			requireAssertions: true,
		},
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts"],
			// Service modules have a PostgreSQL coverage gate. The server executable has
			// packed-install and container backup/restore checks.
			exclude: ["src/service/**", "src/server-cli.ts"],
			reporter: ["text", "json-summary"],
			reportsDirectory: "coverage",
		},
		testTimeout: 30000,
		hookTimeout: 30000,
		// Dispatch integration tests launch real short-lived processes. Bounding file
		// workers keeps their startup probes deterministic on loaded CI and gate hosts.
		maxWorkers: 4,
	},
});
