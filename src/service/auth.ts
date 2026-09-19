import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import type { Principal } from "./protocol.ts";
import { hash, oidcActor, ServiceError } from "./protocol.ts";

const secureUrl = z.url().refine((value) => {
	const url = new URL(value);
	return (
		!url.username &&
		!url.password &&
		(url.protocol === "https:" ||
			(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
	);
}, "Use HTTPS, or HTTP on loopback.");
export const configSchema = z
	.object({
		host: z.string().min(1),
		port: z.number().int().min(0).max(65535),
		publicOrigin: secureUrl,
		oidc: z
			.object({
				issuer: secureUrl,
				audience: z.string().min(1),
				jwksUri: secureUrl,
				administratorSubjects: z.array(z.string().min(1)).min(1),
			})
			.strict(),
	})
	.strict()
	.superRefine((config, context) => {
		const url = new URL(config.publicOrigin);
		if (url.origin !== config.publicOrigin)
			context.addIssue({ code: "custom", message: "publicOrigin must contain only scheme, host, and port." });
	});
export type ServiceConfig = z.infer<typeof configSchema>;

export function createAuthenticator(config: ServiceConfig["oidc"]): (token: string) => Promise<Principal> {
	const keys = createRemoteJWKSet(new URL(config.jwksUri), { timeoutDuration: 5000, cooldownDuration: 1000 });
	return async (token) => {
		if (token.startsWith("sts_")) {
			const match = /^sts_([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/.exec(token);
			if (!match || !z.uuid().safeParse(match[1]).success)
				throw new ServiceError("UNAUTHORIZED", "Invalid service credential.", 401);
			return {
				actorId: `service:${match[1]}`,
				credential: { id: match[1], hash: hash(token) },
				administrator: false,
				expiresAt: Infinity,
			};
		}
		try {
			const { payload } = await jwtVerify(token, keys, {
				issuer: config.issuer,
				audience: config.audience,
				algorithms: ["RS256", "ES256"],
				requiredClaims: ["iss", "aud", "sub", "exp", "iat"],
				maxTokenAge: "24h",
			});
			if (!payload.sub || !payload.exp) throw new Error("Missing identity claims.");
			return {
				actorId: oidcActor(config.issuer, payload.sub),
				expiresAt: payload.exp * 1000,
				administrator: config.administratorSubjects.includes(payload.sub),
			};
		} catch {
			throw new ServiceError("UNAUTHORIZED", "OIDC token validation failed.", 401);
		}
	};
}
