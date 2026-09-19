import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { expect, test, vi } from "vitest";
import { writeEventChunk } from "../../src/service/http.ts";

function blockedResponse() {
	return Object.assign(new EventEmitter(), { destroyed: false, write: () => false });
}
test("event writer waits for drain and removes listeners after success", async () => {
	const response = blockedResponse();
	const write = writeEventChunk(response as unknown as ServerResponse, "frame");
	response.emit("drain");
	await write;
	expect(response.eventNames()).toEqual([]);
});
test("closed and failed subscriptions stop waiting for a slow consumer", async () => {
	for (const event of ["close", "error"]) {
		const response = blockedResponse();
		const write = writeEventChunk(response as unknown as ServerResponse, "frame");
		response.emit(event, new Error("socket error"));
		await expect(write).rejects.toThrow();
		expect(response.eventNames()).toEqual([]);
	}
});
test("a stalled consumer has a bounded lifetime", async () => {
	vi.useFakeTimers();
	try {
		const response = blockedResponse();
		const write = expect(writeEventChunk(response as unknown as ServerResponse, "frame")).rejects.toThrow(
			"backpressure timeout",
		);
		await vi.advanceTimersByTimeAsync(5000);
		await write;
		expect(response.eventNames()).toEqual([]);
	} finally {
		vi.useRealTimers();
	}
});
