import { Buffer } from "node:buffer";

/** Visible marker included inside every truncated mutable text field. */
export const TEXT_TRUNCATION_MARKER = " … [truncated]";

export interface TruncatedText {
	value: string;
	truncated: boolean;
}

const graphemeSegmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
const markerBytes = jsonEncodedStringBytes(TEXT_TRUNCATION_MARKER);

/** Number of UTF-8 bytes in a string. */
export function utf8Bytes(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

/** Bytes a string contributes inside JSON quotes, including escape expansion. */
export function jsonEncodedStringBytes(value: string): number {
	return utf8Bytes(JSON.stringify(value)) - 2;
}

/**
 * Keep the longest grapheme-safe prefix whose JSON encoding fits the field.
 * The marker is part of the limit, so every truncated value stays bounded.
 */
export function truncateTextToJsonBytes(value: string, maxBytes: number): TruncatedText {
	if (maxBytes < markerBytes) {
		throw new Error("Bounded text field limit cannot hold its truncation marker.");
	}

	const accepted: Array<{ segment: string; bytes: number }> = [];
	let acceptedBytes = 0;
	for (const { segment } of graphemeSegmenter.segment(value)) {
		const segmentBytes = jsonEncodedStringBytes(segment);
		if (acceptedBytes + segmentBytes <= maxBytes) {
			accepted.push({ segment, bytes: segmentBytes });
			acceptedBytes += segmentBytes;
			continue;
		}
		while (accepted.length > 0 && acceptedBytes + markerBytes > maxBytes) {
			const removed = accepted.pop();
			if (!removed) throw new Error("Bounded text truncation lost its accepted segment.");
			acceptedBytes -= removed.bytes;
		}
		return {
			value: `${accepted.map((entry) => entry.segment).join("")}${TEXT_TRUNCATION_MARKER}`,
			truncated: true,
		};
	}
	return { value: accepted.map((entry) => entry.segment).join(""), truncated: false };
}
