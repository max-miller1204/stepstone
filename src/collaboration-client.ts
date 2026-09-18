import type {
	CollaborationCommand,
	CollaborationEvent,
	CollaborationReceipt,
	CollaborationSnapshot,
} from "./collaboration-protocol.ts";

/** An HTTP refusal, distinct from an unknown transport outcome. */
export class CollaborationRequestError extends Error {
	readonly status: number;
	readonly code?: string;
	constructor(status: number, detail: string, code?: string) {
		super(`Server rejected request (${status}): ${detail}`);
		this.status = status;
		this.code = code;
	}
}

/** Shared HTTP client for the proof CLI, browser, and agent callers. */
export class CollaborationClient {
	readonly url: string;
	readonly token: string;

	constructor(url: string, token: string) {
		const parsed = new URL(url);
		if (
			!["http:", "https:"].includes(parsed.protocol) ||
			parsed.username ||
			parsed.password ||
			parsed.search ||
			parsed.hash ||
			parsed.pathname !== "/"
		) {
			throw new Error("Server URL must be an HTTP(S) origin without credentials.");
		}
		if (!token.trim()) throw new Error("A server credential is required.");
		this.url = parsed.origin;
		this.token = token;
	}

	private async request(path: string, init: RequestInit = {}): Promise<Response> {
		let response: Response;
		try {
			response = await fetch(this.url + path, {
				...init,
				headers: {
					authorization: `Bearer ${this.token}`,
					"content-type": "application/json",
					...init.headers,
				},
			});
		} catch (cause) {
			throw new Error(`Configured collaboration server is unavailable: ${this.url}`, { cause });
		}
		if (!response.ok) {
			const detail = await response.text();
			const failure = JSON.parse(detail) as { code?: unknown } | null;
			if (
				!failure ||
				typeof failure !== "object" ||
				Array.isArray(failure) ||
				(failure.code !== undefined && typeof failure.code !== "string")
			) {
				throw new Error("The collaboration server returned an invalid error response.");
			}
			throw new CollaborationRequestError(response.status, detail, failure.code);
		}
		return response;
	}

	async snapshot(): Promise<CollaborationSnapshot> {
		return (
			await this.request("/api/snapshot", { signal: AbortSignal.timeout(10000) })
		).json() as Promise<CollaborationSnapshot>;
	}

	async command(command: CollaborationCommand): Promise<CollaborationReceipt> {
		return (
			await this.request("/api/commands", {
				method: "POST",
				body: JSON.stringify(command),
				signal: AbortSignal.timeout(10000),
			})
		).json() as Promise<CollaborationReceipt>;
	}

	/** Resume explicitly after the last event applied by the caller. */
	async *events(after: number, signal: AbortSignal): AsyncGenerator<CollaborationEvent> {
		if (!Number.isSafeInteger(after) || after < 0)
			throw new Error("Event cursor must be a nonnegative integer.");
		const response = await this.request("/api/events", {
			headers: { "last-event-id": String(after) },
			signal,
		});
		if (!response.body) throw new Error("Server did not provide an event stream.");
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done)
					throw new Error("Collaboration event stream disconnected. Resume from the last applied cursor.");
				buffer += decoder.decode(value, { stream: true });
				let end = buffer.indexOf("\n\n");
				while (end !== -1) {
					const frame = buffer.slice(0, end);
					buffer = buffer.slice(end + 2);
					const data = frame.split("\n").find((line) => line.startsWith("data: "));
					if (data) yield JSON.parse(data.slice(6)) as CollaborationEvent;
					end = buffer.indexOf("\n\n");
				}
			}
		} finally {
			await reader.cancel();
			reader.releaseLock();
		}
	}
}
