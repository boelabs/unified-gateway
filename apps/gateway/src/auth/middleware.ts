import { getCachedVirtualKey } from "./virtualKeyCache.ts";
import type { Context, MiddlewareHandler } from "hono";
import { GatewayError } from "#core/errors.ts";
import type { AppEnv, Auth } from "./types.ts";
import { env } from "#config/env.ts";

/**
 * Extracts the key from: Authorization: Bearer <key>, x-api-key, or ?api_key= (query).
 * The query param is for clients that cannot set headers, like browser EventSource. The hono logger
 * records the path without the query, so the key does not leak to logs; still, prefer the header
 * whenever possible.
 */
function extractKey(c: Context): string | undefined {
	const auth = c.req.header("authorization");
	if (auth) {
		const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
		if (m) return m[1]!.trim();
		return auth.trim();
	}
	const x = c.req.header("x-api-key");
	if (x) return x.trim();
	const q = c.req.query("api_key");
	return q ? q.trim() : undefined;
}

/** Resolves the identity (master or virtual key) and stores it in c.get('auth'). */
export function authMiddleware(): MiddlewareHandler<AppEnv> {
	return async (c, next) => {
		const key = extractKey(c);
		if (!key) {
			throw new GatewayError({
				class: "auth",
				message: "Missing API key (Authorization: Bearer <key>)",
			});
		}

		if (key === env.MASTER_KEY) {
			c.set("auth", { type: "master" });
			return next();
		}

		const vk = await getCachedVirtualKey(key);
		if (!vk)
			throw new GatewayError({ class: "auth", message: "Invalid API key" });
		if (!vk.enabled)
			throw new GatewayError({ class: "auth", message: "API key is disabled" });
		if (vk.expiresAt && new Date(vk.expiresAt).getTime() < Date.now()) {
			throw new GatewayError({ class: "auth", message: "API key has expired" });
		}

		c.set("auth", { type: "virtual", key: vk });
		return next();
	};
}

/** Requires the resolved auth to be the master key (for /admin). */
export function requireMaster(): MiddlewareHandler<AppEnv> {
	return async (c, next) => {
		const auth = c.get("auth") as Auth | undefined;
		if (auth?.type !== "master") {
			throw new GatewayError({
				class: "permission",
				message: "This operation requires the master key",
			});
		}
		return next();
	};
}

export function getAuth(c: Context<AppEnv>): Auth {
	return c.get("auth");
}
