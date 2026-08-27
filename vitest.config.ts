import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: false,
		environment: "node",
		include: ["test/**/*.test.ts"],
		testTimeout: 30000,
		hookTimeout: 30000,
		// Dispatch integration tests launch real short-lived processes. Bounding file
		// workers keeps their startup probes deterministic on loaded CI and gate hosts.
		maxWorkers: 4,
	},
});
