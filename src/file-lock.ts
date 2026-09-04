import { mkdir, realpath, rmdir, rmdirSync, stat, utimes } from "node:fs";
import type { LockOptions } from "proper-lockfile";
import lockfile from "proper-lockfile";

/**
 * The Node file-system calls that proper-lockfile needs, held on a plain object.
 *
 * Pi runs extensions in a Bun executable. Bun can expose CommonJS modules as
 * proxies. proper-lockfile caches timestamp precision by defining a private,
 * immutable symbol on its file-system object. Reading that symbol again through
 * Bun's proxy violates the proxy invariant and ends the Pi process. A plain
 * facade gives the cache a normal target while it still calls Node-compatible
 * file-system functions.
 */
const LOCK_FILESYSTEM = { mkdir, realpath, rmdir, rmdirSync, stat, utimes };

/** Take one proper-lockfile lock without exposing its cache to a module proxy. */
export function acquireFileLock(
	file: string,
	options: Omit<LockOptions, "fs"> = {},
): Promise<() => Promise<void>> {
	return lockfile.lock(file, { ...options, fs: LOCK_FILESYSTEM });
}
