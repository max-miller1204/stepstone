import type { TestModule } from "vitest/node";
import type { Reporter } from "vitest/reporters";

function location(module: TestModule, line?: number): string {
	return `${module.relativeModuleId}${line === undefined ? "" : `:${line}`}`;
}

export default class TestPolicyReporter implements Reporter {
	onTestRunEnd(modules: readonly TestModule[]): void {
		const violations: string[] = [];
		for (const module of modules) {
			for (const test of module.children.allTests("skipped")) {
				violations.push(`${location(module, test.location?.line)} skipped or left todo: ${test.fullName}`);
			}
			for (const suite of module.children.allSuites()) {
				if (suite.children.size === 0) {
					violations.push(`${location(module, suite.location?.line)} has an empty suite: ${suite.fullName}`);
				}
			}
		}
		if (violations.length > 0) {
			throw new Error(`test policy violations:\n${violations.join("\n")}`);
		}
	}
}
