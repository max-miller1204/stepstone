import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

// Each suite owns a separate output directory: neither may race the other's
// compiler or the package tests' rebuild of dist/. Node 20 executes this output
// directly, without a TypeScript loader or Pi runtime.
export async function compileWorkspaceFixture(suite: "process-boundary" | "cleanup-cli"): Promise<string> {
	const output = resolve(import.meta.dirname, `../../artifacts/process-boundaries/compiled-${suite}`);
	await promisify(execFile)(
		process.execPath,
		[
			resolve(import.meta.dirname, "../../node_modules/typescript/bin/tsc"),
			"-p",
			resolve(import.meta.dirname, "tsconfig.json"),
			"--outDir",
			output,
		],
		{ timeout: 30_000 },
	);
	return output;
}
