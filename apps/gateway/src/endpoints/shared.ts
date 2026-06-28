import { getConnInfo } from "@hono/node-server/conninfo";
import type { AppEnv } from "#auth/types.ts";
import type { Context } from "hono";

/** Best effort to obtain the client IP (conn info or X-Forwarded-For). */
export function clientIp(c: Context<AppEnv>): string | null {
	try {
		const info = getConnInfo(c);
		if (info.remote.address) return info.remote.address;
	} catch {
		/* ignore */
	}
	const xff = c.req.header("x-forwarded-for");
	return xff ? (xff.split(",")[0]?.trim() ?? null) : null;
}
