// Freeze wall time only in screenshot subprocesses. Keep real timers for terminal I/O.
const NativeDate = Date;
const epoch = NativeDate.parse("2026-06-01T12:00:00.000Z");
globalThis.Date = class extends NativeDate {
	constructor(...args) {
		if (args.length === 0) super(epoch);
		else super(...args);
	}

	static now() {
		return epoch;
	}
};
