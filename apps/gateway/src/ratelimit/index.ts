import { periodSeconds, secondsUntilReset } from "./period.ts";
import type { VirtualKeyAuth } from "#auth/types.ts";
import { GatewayError } from "#core/errors.ts";
import { redis } from "#cache/redis.ts";
import { log } from "#logging/log.ts";

import {
	resetVirtualKeySpend,
	addVirtualKeySpend,
} from "#db/repos/virtualKeys.ts";

/**
 * Rate limiting (TPM/RPM) and budgets per virtual key, with atomic state in Redis.
 * - RPM: per-minute window, atomic check+incr (Lua).
 * - TPM: per-minute window; checked on entry and incremented after the response.
 * - Budget: cents counter with TTL = period (automatic rolling reset).
 * MODEL limits (rpmLimit/tpmLimit) are applied by the router when choosing a deployment.
 */

function minuteBucket(): number {
	return Math.floor(Date.now() / 60_000);
}

// Lua: check + incr (RPM). Returns -1 if it would exceed the limit, or the new value.
const RPM_LUA = `
local cur = tonumber(redis.call('GET', KEYS[1]) or '0')
if cur + 1 > tonumber(ARGV[1]) then return -1 end
redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], 120)
return cur + 1
`;

// Lua: budget increment (float). Sets TTL only when creating the key (rolling reset).
const BUDGET_LUA = `
local v = redis.call('INCRBYFLOAT', KEYS[1], ARGV[1])
if tonumber(ARGV[2]) > 0 and redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return v
`;

const kRpm = (id: string, b: number) => `krpm:${id}:${b}`;
const kTpm = (id: string, b: number) => `ktpm:${id}:${b}`;
const kBudget = (id: string) => `kbud:${id}`;

export async function clearVirtualKeyBudget(id: string): Promise<void> {
	await redis.del(kBudget(id));
}

export interface RateLimitSnapshot {
	headers: Record<string, string>;
}

function minuteResetSeconds(): number {
	return 60 - (Math.floor(Date.now() / 1000) % 60);
}

function withHeader(
	headers: Record<string, string>,
	name: string,
	value: number | string | null | undefined,
): void {
	if (value === null || value === undefined) return;
	headers[name] = String(value);
}

function makeHeaders(p: {
	key: VirtualKeyAuth;
	rpmUsed?: number;
	tpmUsed?: number;
	budgetUsed?: number;
}): Record<string, string> {
	const headers: Record<string, string> = {};
	const reset = minuteResetSeconds();
	if (p.key.rpm != null) {
		withHeader(headers, "x-ratelimit-limit-requests", p.key.rpm);
		withHeader(
			headers,
			"x-ratelimit-remaining-requests",
			Math.max(0, p.key.rpm - (p.rpmUsed ?? 0)),
		);
		withHeader(headers, "x-ratelimit-reset-requests", reset);
	}
	if (p.key.tpm != null) {
		withHeader(headers, "x-ratelimit-limit-tokens", p.key.tpm);
		withHeader(
			headers,
			"x-ratelimit-remaining-tokens",
			Math.max(0, p.key.tpm - (p.tpmUsed ?? 0)),
		);
		withHeader(headers, "x-ratelimit-reset-tokens", reset);
	}
	if (p.key.maxBudgetCents != null) {
		withHeader(headers, "x-ratelimit-limit-budget-cents", p.key.maxBudgetCents);
		withHeader(
			headers,
			"x-ratelimit-remaining-budget-cents",
			Math.max(0, p.key.maxBudgetCents - (p.budgetUsed ?? 0)).toFixed(10),
		);
		withHeader(headers, "x-ratelimit-reset-budget", secondsUntilReset(p.key));
	}
	return headers;
}

function makeHeaderArgs(
	key: VirtualKeyAuth,
	values: {
		rpmUsed?: number | undefined;
		tpmUsed?: number | undefined;
		budgetUsed?: number | undefined;
	},
): Parameters<typeof makeHeaders>[0] {
	const args: Parameters<typeof makeHeaders>[0] = { key };
	if (values.rpmUsed !== undefined) args.rpmUsed = values.rpmUsed;
	if (values.tpmUsed !== undefined) args.tpmUsed = values.tpmUsed;
	if (values.budgetUsed !== undefined) args.budgetUsed = values.budgetUsed;
	return args;
}

async function budgetSpendFromRedisOrDb(key: VirtualKeyAuth): Promise<number> {
	const raw = await redis.get(kBudget(key.id));
	if (raw !== null) return Number(raw);

	const resetAt = key.budgetResetAt
		? new Date(key.budgetResetAt).getTime()
		: null;
	const seed = resetAt !== null && resetAt <= Date.now() ? 0 : key.spendCents;
	if (resetAt !== null && resetAt <= Date.now()) {
		void resetVirtualKeySpend(key.id, key.budgetReset).catch((err: unknown) => {
			log.error("ratelimit", "budget reset failed", { err });
		});
	}
	if (seed > 0) {
		const ttl = secondsUntilReset(key);
		if (ttl > 0) await redis.set(kBudget(key.id), String(seed), "EX", ttl);
		else await redis.set(kBudget(key.id), String(seed));
	}
	return seed;
}

/**
 * Applies the virtual key RPM, TPM, and budget BEFORE calling upstream.
 * Throws GatewayError(rate_limit, 429) if any limit is exceeded.
 */
export async function enforceVirtualKey(
	key: VirtualKeyAuth,
): Promise<RateLimitSnapshot> {
	const b = minuteBucket();
	let rpmUsed: number | undefined;
	let tpmUsed: number | undefined;
	let budgetUsed: number | undefined;

	if (key.rpm != null) {
		const res = (await redis.eval(
			RPM_LUA,
			1,
			kRpm(key.id, b),
			String(key.rpm),
		)) as number;
		rpmUsed = res;
		if (res === -1) {
			throw new GatewayError({
				class: "rate_limit",
				message: `RPM limit exceeded (${key.rpm}/min) for this API key`,
				code: "rate_limit_exceeded",
				headers: makeHeaders(
					makeHeaderArgs(key, { rpmUsed: key.rpm, tpmUsed, budgetUsed }),
				),
			});
		}
	}

	if (key.tpm != null) {
		// TPM is a SOFT limit by nature: the real tokens are only known AFTER the response, so it
		// cannot be atomic check+incr like RPM. Under high concurrency it may be exceeded within the
		// minute (just like OpenAI's TPM, which is also approximate).
		const cur = Number((await redis.get(kTpm(key.id, b))) ?? 0);
		tpmUsed = cur;
		if (cur >= key.tpm) {
			throw new GatewayError({
				class: "rate_limit",
				message: `TPM limit exceeded (${key.tpm}/min) for this API key`,
				code: "rate_limit_exceeded",
				headers: makeHeaders(
					makeHeaderArgs(key, { rpmUsed, tpmUsed: key.tpm, budgetUsed }),
				),
			});
		}
	}

	if (key.maxBudgetCents != null) {
		const spend = await budgetSpendFromRedisOrDb(key);
		budgetUsed = spend;
		if (spend >= key.maxBudgetCents) {
			throw new GatewayError({
				class: "rate_limit",
				message: `Budget exhausted for this API key (limit ${key.maxBudgetCents} cents)`,
				code: "budget_exceeded",
				headers: makeHeaders(
					makeHeaderArgs(key, {
						rpmUsed,
						tpmUsed,
						budgetUsed: key.maxBudgetCents,
					}),
				),
			});
		}
	}

	return {
		headers: makeHeaders(makeHeaderArgs(key, { rpmUsed, tpmUsed, budgetUsed })),
	};
}

/**
 * Records consumption for a FINISHED request: adds tokens to the minute TPM and the cost
 * to the budget. Safe fire-and-forget (does not block the response).
 */
export function recordVirtualKeyUsage(
	key: VirtualKeyAuth,
	totalTokens: number,
	costCents: number,
): void {
	const b = minuteBucket();
	const ops: Promise<unknown>[] = [];

	if (key.tpm != null && totalTokens > 0) {
		ops.push(
			redis
				.multi()
				.incrby(kTpm(key.id, b), totalTokens)
				.expire(kTpm(key.id, b), 120)
				.exec(),
		);
	}
	if (key.maxBudgetCents != null && costCents > 0) {
		ops.push(
			redis.eval(
				BUDGET_LUA,
				1,
				kBudget(key.id),
				String(costCents),
				String(periodSeconds(key.budgetReset)),
			),
		);
	}
	if (costCents > 0) {
		ops.push(addVirtualKeySpend(key.id, costCents));
	}

	if (ops.length > 0) {
		Promise.all(ops).catch((err: unknown) => {
			log.error("ratelimit", "record failed", { err });
		});
	}
}
