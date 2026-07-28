/**
 * Integration coverage for router metrics and the Redis circuit breaker. Every test uses unique
 * subjects so it is safe across concurrently running integration files.
 */

import { redisAvailable } from "#test-support/infra.ts";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { redis } from "#cache/redis.ts";
import { test } from "node:test";

import {
	recordTransientFailure,
	recordThrottleFailure,
	type CircuitSettings,
	acquireCircuitPermit,
	getCircuitSnapshots,
	deploymentSubject,
	getCircuitCauses,
	capacitySubject,
	closeCircuits,
} from "#router/circuit.ts";

import {
	onAttemptCancel,
	onSuccessFinish,
	onAttemptStart,
	fetchMetrics,
} from "#router/state.ts";

const skip = (await redisAvailable()) ? false : "Redis unavailable";
const wait = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

function settings(overrides: Partial<CircuitSettings> = {}): CircuitSettings {
	return {
		enabled: true,
		allowedFails: 2,
		failureWindowMs: 1000,
		baseCooldownMs: 100,
		maxCooldownMs: 1000,
		probeTtlMs: 500,
		...overrides,
	};
}

async function cleanup(
	ids: string[],
	circuitPrefixes: string[] = [],
): Promise<void> {
	const bucket = Math.floor(Date.now() / 60_000);
	const keys = ids.flatMap((id) => [
		`rt:inflight:${id}`,
		`rt:failures:${id}`,
		`rt:successes:${id}`,
		`rt:latency_ms:${id}`,
		`rt:throughput_tps:${id}`,
		`rt:rpm:${id}:${bucket}`,
		`rt:tpm:${id}:${bucket}`,
	]);
	for (const prefix of circuitPrefixes) {
		for (const suffix of ["cooldown", "cause", "failures", "history", "probe"])
			keys.push(`${prefix}:${suffix}`);
	}
	if (keys.length > 0) await redis.del(...keys);
}

function prefix(subject: { kind: string; id: string }): string {
	return `rt:circuit:${subject.kind}:${subject.id}`;
}

test("inflight/rpm: start counts, success/cancel release without penalty", {
	skip,
}, async () => {
	const id = randomUUID();
	try {
		await onAttemptStart(id);
		await onAttemptStart(id);
		let metrics = (await fetchMetrics([id])).get(id)!;
		assert.equal(metrics.inflight, 2);
		assert.equal(metrics.rpm, 2);

		await onAttemptCancel(id);
		metrics = (await fetchMetrics([id])).get(id)!;
		assert.equal(metrics.inflight, 1);
		assert.equal(metrics.failures, 0);

		await onSuccessFinish(id, {
			totalTokens: 100,
			completionTokens: 25,
			durationMs: 1000,
		});
		metrics = (await fetchMetrics([id])).get(id)!;
		assert.equal(metrics.inflight, 0);
		assert.equal(metrics.tpm, 100);
		assert.equal(metrics.throughputTps, 25);
	} finally {
		await cleanup([id]);
	}
});

test("circuit: fixed failure window does not slide on every failure", {
	skip,
}, async () => {
	const id = randomUUID();
	const deployment = deploymentSubject(id);
	const capacity = capacitySubject(id, null);
	const config = settings({ failureWindowMs: 60 });
	try {
		const first = await acquireCircuitPermit(deployment, capacity, config);
		assert.equal(first.allowed, true);
		if (!first.allowed) return;
		await recordTransientFailure(first.permit, config, {
			class: "server",
			message: "first",
		});
		await wait(90);
		const second = await acquireCircuitPermit(deployment, capacity, config);
		assert.equal(second.allowed, true);
		if (!second.allowed) return;
		await recordTransientFailure(second.permit, config, {
			class: "server",
			message: "second",
		});
		const [snapshot] = await getCircuitSnapshots([{ deployment, capacity }]);
		assert.equal(snapshot?.status, "available");
	} finally {
		await cleanup([], [prefix(deployment), prefix(capacity)]);
	}
});

test("circuit: threshold is atomic, half-open admits one probe, and backoff recovers", {
	skip,
}, async () => {
	const id = randomUUID();
	const deployment = deploymentSubject(id);
	const capacity = capacitySubject(id, null);
	const config = settings({
		baseCooldownMs: 1000,
		maxCooldownMs: 5000,
		probeTtlMs: 2000,
	});
	try {
		for (const message of ["first", "second"]) {
			const acquired = await acquireCircuitPermit(deployment, capacity, config);
			assert.equal(acquired.allowed, true);
			if (!acquired.allowed) return;
			await recordTransientFailure(acquired.permit, config, {
				class: "server",
				message,
				...(message === "second"
					? { body: { error: { message: "sensitive provider detail" } } }
					: {}),
			});
		}
		let [snapshot] = await getCircuitSnapshots([{ deployment, capacity }]);
		assert.equal(snapshot?.status, "cooldown");
		assert.ok((snapshot?.retryAfterMs ?? 0) > 0);
		const causes = await getCircuitCauses([deployment]);
		const cause = causes.get(`deployment:${id}`);
		assert.equal(cause?.message, "Upstream server failure");
		assert.match(cause?.fingerprint ?? "", /^[a-f0-9]{24}$/);
		assert.equal(cause?.body, undefined);

		await wait(1250);
		const probes = await Promise.all([
			acquireCircuitPermit(deployment, capacity, config),
			acquireCircuitPermit(deployment, capacity, config),
		]);
		assert.equal(probes.filter((probe) => probe.allowed).length, 1);
		const probe = probes.find((candidate) => candidate.allowed);
		assert.ok(probe?.allowed);
		if (!probe?.allowed) return;
		assert.equal(probe.permit.deploymentMode, "half_open");
		await recordTransientFailure(probe.permit, config, {
			class: "server",
			message: "probe failed",
		});

		[snapshot] = await getCircuitSnapshots([{ deployment, capacity }]);
		assert.equal(snapshot?.status, "cooldown");
		assert.ok((snapshot?.retryAfterMs ?? 0) >= 900);

		await wait(2300);
		const recovery = await acquireCircuitPermit(deployment, capacity, config);
		assert.equal(recovery.allowed, true);
		if (!recovery.allowed) return;
		assert.equal(recovery.permit.deploymentMode, "half_open");
		await closeCircuits(recovery.permit);
		[snapshot] = await getCircuitSnapshots([{ deployment, capacity }]);
		assert.equal(snapshot?.status, "available");
	} finally {
		await cleanup([], [prefix(deployment), prefix(capacity)]);
	}
});

test("capacity circuit: Retry-After state is shared by one configured failure domain", {
	skip,
}, async () => {
	const firstDeployment = deploymentSubject(randomUUID());
	const secondDeployment = deploymentSubject(randomUUID());
	const capacity = capacitySubject(firstDeployment.id, "provider-account-a");
	const sameCapacity = capacitySubject(
		secondDeployment.id,
		"provider-account-a",
	);
	const config = settings();
	assert.equal(capacity.id, sameCapacity.id);
	try {
		const first = await acquireCircuitPermit(firstDeployment, capacity, config);
		assert.equal(first.allowed, true);
		if (!first.allowed) return;
		await recordThrottleFailure(
			first.permit,
			config,
			{ class: "rate_limit", message: "quota exhausted", status: 429 },
			1000,
		);
		const second = await acquireCircuitPermit(
			secondDeployment,
			sameCapacity,
			config,
		);
		assert.equal(second.allowed, false);
		if (second.allowed) return;
		assert.equal(second.blockedBy, "capacity");
		assert.ok(second.retryAfterMs > 0);

		const bypass = await acquireCircuitPermit(secondDeployment, sameCapacity, {
			...config,
			enabled: false,
		});
		assert.equal(bypass.allowed, true);
		const [cleared] = await getCircuitSnapshots([
			{ deployment: secondDeployment, capacity: sameCapacity },
		]);
		assert.equal(cleared?.status, "available");
	} finally {
		await cleanup(
			[],
			[prefix(firstDeployment), prefix(secondDeployment), prefix(capacity)],
		);
	}
});
