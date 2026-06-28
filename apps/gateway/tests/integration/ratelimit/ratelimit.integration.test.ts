/**
 * Integration (real Redis) for per-virtual-key rate limiting: atomic RPM (Lua) and budget.
 * Runs with `bun run test:integration`. Uses unique ids and cleans their keys.
 */

import { redisAvailable } from "#test-support/infra.ts";
import { enforceVirtualKey } from "#ratelimit/index.ts";
import type { VirtualKeyAuth } from "#auth/types.ts";
import { GatewayError } from "#core/errors.ts";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { redis } from "#cache/redis.ts";
import { test } from "node:test";

const skip = (await redisAvailable()) ? false : "Redis unavailable";

function key(over: Partial<VirtualKeyAuth>): VirtualKeyAuth {
	return {
		id: randomUUID(),
		name: "test",
		allowedModels: [],
		enabled: true,
		expiresAt: null,
		maxBudgetCents: null,
		budgetReset: null,
		budgetResetAt: null,
		spendCents: 0,
		tpm: null,
		rpm: null,
		...over,
	};
}

test("RPM: allows up to the limit and then throws 429 (atomic check+incr)", {
	skip,
}, async () => {
	const k = key({ rpm: 3 });
	const b = Math.floor(Date.now() / 60_000);
	try {
		await enforceVirtualKey(k);
		await enforceVirtualKey(k);
		await enforceVirtualKey(k); // 3/3 ok
		await assert.rejects(
			() => enforceVirtualKey(k),
			(err) =>
				GatewayError.is(err) &&
				err.class === "rate_limit" &&
				err.code === "rate_limit_exceeded",
		);
	} finally {
		await redis.del(
			`krpm:${k.id}:${b}`,
			`krpm:${k.id}:${b - 1}`,
			`krpm:${k.id}:${b + 1}`,
		);
	}
});

test("Budget: if Redis spend reaches the limit, throws budget_exceeded", {
	skip,
}, async () => {
	const k = key({ maxBudgetCents: 100 });
	try {
		await redis.set(`kbud:${k.id}`, "100"); // full budget already spent
		await assert.rejects(
			() => enforceVirtualKey(k),
			(err) =>
				GatewayError.is(err) &&
				err.class === "rate_limit" &&
				err.code === "budget_exceeded",
		);
	} finally {
		await redis.del(`kbud:${k.id}`);
	}
});
