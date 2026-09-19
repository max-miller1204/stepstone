import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { parseCommand } from "../../src/service/protocol.ts";

test("rejects unsupported plan links at the command boundary", () => {
	expect(() =>
		parseCommand({
			version: 1,
			commandId: randomUUID(),
			projectId: randomUUID(),
			expectedRevision: 1,
			operation: {
				action: "apply-plan",
				plan: [{ title: "Linked task", links: ["https://example.com/context"] }],
			},
		}),
	).toThrow();
});
