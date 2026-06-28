/**
 * Integration (real Redis) for router state: inflight/rpm, cooldown + cause, and cancellation.
 * Runs with `bun run test:integration`. Uses unique ids per test and cleans their keys.
 */

import { redisAvailable } from "#test-support/infra.ts";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { redis } from "#cache/redis.ts";
import { test } from "node:test";

import {
	partitionByCooldown,
	getCooldownCauses,
	onAttemptCancel,
	onSuccessFinish,
	onAttemptStart,
	onAttemptFail,
	fetchMetrics,
} from "#router/state.ts";

const skip = (await redisAvailable()) ? false : "Redis unavailable";

async function cleanup(id: string): Promise<void> {
	const b = Math.floor(Date.now() / 60_000);
	const keys = [
		`rt:inflight:${id}`,
		`rt:fails:${id}`,
		`rt:cooldown:${id}`,
		`rt:cooldown:cause:${id}`,
	];
	for (const bb of [b - 1, b, b + 1])
		keys.push(`rt:rpm:${id}:${bb}`, `rt:tpm:${id}:${bb}`);
	await redis.del(...keys);
}

test("inflight/rpm: start counts, success/cancel release without penalty", {
	skip,
}, async () => {
	const id = randomUUID();
	try {
		await onAttemptStart(id);
		await onAttemptStart(id);
		let m = (await fetchMetrics([id])).get(id)!;
		assert.equal(m.inflight, 2);
		assert.equal(m.rpm, 2);

		// Client cancellation: releases 1 inflight, does NOT add fails or cooldown.
		await onAttemptCancel(id);
		m = (await fetchMetrics([id])).get(id)!;
		assert.equal(m.inflight, 1);
		assert.equal((await partitionByCooldown([id])).cooling.length, 0);

		// Success: releases inflight and adds tpm.
		await onSuccessFinish(id, 100);
		m = (await fetchMetrics([id])).get(id)!;
		assert.equal(m.inflight, 0);
		assert.equal(m.tpm, 100);
	} finally {
		await cleanup(id);
	}
});

test("cooldown: after allowedFails it cools down and stores the real cause", {
	skip,
}, async () => {
	const id = randomUUID();
	try {
		const cause = {
			class: "rate_limit",
			message: "429 from upstream",
			status: 429,
			body: { error: "quota" },
		};

		// 1st failure (allowedFails=2): does not cool down yet.
		await onAttemptFail(id, 2, 5, cause);
		assert.equal((await partitionByCooldown([id])).cooling.length, 0);

		// 2nd failure: reaches the threshold -> cooldown + cause.
		await onAttemptFail(id, 2, 5, cause);
		const part = await partitionByCooldown([id]);
		assert.deepEqual(part.cooling, [id]);
		assert.equal(part.healthy.length, 0);

		const causes = await getCooldownCauses([id]);
		assert.equal(causes.get(id)?.status, 429);
		assert.deepEqual(causes.get(id)?.body, { error: "quota" });
	} finally {
		await cleanup(id);
	}
});
