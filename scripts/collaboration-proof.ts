import { readFile } from "node:fs/promises";
import { CollaborationClient } from "../src/collaboration-client.ts";
import { CollaborationService } from "../src/collaboration-protocol.ts";
import { startCollaborationServer } from "../src/collaboration-server.ts";
import { createWorklistLocator } from "../src/git.ts";

try {
	const [action, ...args] = process.argv.slice(2);
	if (action === "init") {
		const [store, title, confirm] = args;
		if (!store || !title || confirm !== "--confirm" || args.length !== 3)
			throw new Error("Usage: init <store> <title> --confirm");
		const locator = createWorklistLocator(null, { override: store, overrideBase: process.cwd(), env: {} });
		const service = new CollaborationService({ resolvePath: () => locator().path });
		console.log(
			JSON.stringify(
				await service.initialize({ id: "proof-bootstrap", role: "owner" }, { title, confirm: true }),
			),
		);
	} else if (action === "serve") {
		if (args.length !== 1) throw new Error("Usage: serve <config.json>");
		const server = await startCollaborationServer(JSON.parse(await readFile(args[0], "utf8")));
		console.log(JSON.stringify({ url: server.url }));
		for (const signal of ["SIGTERM", "SIGINT"] as const)
			process.once(signal, () => {
				server.close().catch((error) => {
					console.error(error);
					process.exitCode = 1;
				});
			});
	} else if (action === "snapshot" || action === "command") {
		const url = process.env.STEPSTONE_SERVER,
			token = process.env.STEPSTONE_TOKEN;
		if (!url || !token) throw new Error("STEPSTONE_SERVER and STEPSTONE_TOKEN are required.");
		const client = new CollaborationClient(url, token);
		if (action === "snapshot") {
			if (args.length) throw new Error("Usage: snapshot");
			console.log(JSON.stringify(await client.snapshot()));
		} else {
			if (args.length !== 1) throw new Error("Usage: command <command.json>");
			console.log(JSON.stringify(await client.command(JSON.parse(await readFile(args[0], "utf8")))));
		}
	} else throw new Error("Usage: collaboration-proof.ts <init|serve|snapshot|command>");
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
