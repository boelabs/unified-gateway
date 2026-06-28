import { getRouterSettings } from "#db/repos/router.ts";

export type RoutingStrategy =
	| "simple-shuffle"
	| "least-busy"
	| "usage-based-tpm"
	| "usage-based-rpm";

export interface EffectiveSettings {
	routingStrategy: RoutingStrategy;
	allowedFails: number;
	cooldownSeconds: number;
	/** Maximum retries per deployment, on top of the initial attempt. */
	numRetries: number;
	timeoutSeconds: number;
	retryAfterSeconds: number;
}

const DEFAULTS: EffectiveSettings = {
	routingStrategy: "simple-shuffle",
	allowedFails: 3,
	cooldownSeconds: 5,
	numRetries: 3,
	timeoutSeconds: 600,
	retryAfterSeconds: 0,
};

// Short-lived cache for global config (avoids one SELECT per request).
const GLOBAL_TTL_MS = 5000;
let globalCache: { at: number; value: EffectiveSettings } | undefined;

async function loadGlobal(): Promise<EffectiveSettings> {
	if (globalCache && Date.now() - globalCache.at < GLOBAL_TTL_MS)
		return globalCache.value;
	const row = await getRouterSettings();
	const value: EffectiveSettings = row
		? {
				routingStrategy: row.routingStrategy,
				allowedFails: row.allowedFails,
				cooldownSeconds: row.cooldownSeconds,
				numRetries: row.numRetries,
				timeoutSeconds: row.timeoutSeconds,
				retryAfterSeconds: row.retryAfterSeconds,
			}
		: DEFAULTS;
	globalCache = { at: Date.now(), value };
	return value;
}

/** The router's effective global configuration. */
export async function getEffectiveSettings(): Promise<EffectiveSettings> {
	return loadGlobal();
}
