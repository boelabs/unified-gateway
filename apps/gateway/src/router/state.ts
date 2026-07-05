import { redis } from "#cache/redis.ts";

/**
 * Router state in Redis. Keys per model (deployment):
 *   rt:inflight:{id}        counter of in-flight requests (least-busy)
 *   rt:rpm:{id}:{minute}    requests in the current minute
 *   rt:tpm:{id}:{minute}    tokens in the current minute
 *   rt:fails:{id}           recent failures (short window)
 *   rt:successes:{id}       recent successful completions
 *   rt:failures:{id}        recent failed upstream attempts
 *   rt:latency_ms:{id}      EWMA of successful completion latency
 *   rt:throughput_tps:{id}  EWMA of output tokens/second
 *   rt:cooldown:{id}        present ⇒ the deployment is in cooldown
 *   rt:cooldown:cause:{id}  error that triggered the cooldown (to debug the cut with no attempts)
 */

const INFLIGHT_TTL = 300; // s - prevents leaks if a process dies midway
const WINDOW_TTL = 120; // s - RPM/TPM expire on their own
const FAILS_TTL = 60; // s - failures decay
const HEALTH_TTL = 600; // s - rolling success/failure and performance memory
const EWMA_ALPHA = 0.2;

export interface DeploymentMetrics {
	inflight: number;
	rpm: number;
	tpm: number;
	successes: number;
	failures: number;
	latencyMs: number | null;
	throughputTps: number | null;
	healthScore: number;
}

export interface SuccessTelemetry {
	totalTokens: number | null;
	completionTokens: number | null;
	durationMs: number;
}

/** Detail of the error that put a deployment into cooldown (stored for debugging). */
export interface CooldownCause {
	class: string;
	message: string;
	status?: number;
	body?: unknown;
}

function minuteBucket(): number {
	return Math.floor(Date.now() / 60_000);
}

const kInflight = (id: string) => `rt:inflight:${id}`;
const kRpm = (id: string, b: number) => `rt:rpm:${id}:${b}`;
const kTpm = (id: string, b: number) => `rt:tpm:${id}:${b}`;
const kFails = (id: string) => `rt:fails:${id}`;
const kSuccesses = (id: string) => `rt:successes:${id}`;
const kFailures = (id: string) => `rt:failures:${id}`;
const kLatencyMs = (id: string) => `rt:latency_ms:${id}`;
const kThroughputTps = (id: string) => `rt:throughput_tps:${id}`;
const kCooldown = (id: string) => `rt:cooldown:${id}`;
const kCooldownCause = (id: string) => `rt:cooldown:cause:${id}`;

/** Attempt start: +1 inflight, +1 rpm in the current minute. */
export async function onAttemptStart(id: string): Promise<void> {
	const b = minuteBucket();
	await redis
		.pipeline()
		.incr(kInflight(id))
		.expire(kInflight(id), INFLIGHT_TTL)
		.incr(kRpm(id, b))
		.expire(kRpm(id, b), WINDOW_TTL)
		.exec();
}

async function decrInflight(id: string): Promise<void> {
	const v = await redis.decr(kInflight(id));
	if (v < 0) await redis.set(kInflight(id), 0);
}

/** Attempt failure: -1 inflight, +1 fails; if it exceeds allowedFails => cooldown (+ cause). */
export async function onAttemptFail(
	id: string,
	allowedFails: number,
	cooldownSeconds: number,
	cause?: CooldownCause,
): Promise<void> {
	await decrInflight(id);
	const res = await redis
		.multi()
		.incr(kFails(id))
		.expire(kFails(id), FAILS_TTL)
		.incr(kFailures(id))
		.expire(kFailures(id), HEALTH_TTL)
		.exec();
	const fails = Number(res?.[0]?.[1] ?? 0);
	if (fails >= allowedFails) {
		const m = redis
			.multi()
			.set(kCooldown(id), "1", "EX", cooldownSeconds)
			.del(kFails(id));
		// Store the error that caused the cooldown, with the same TTL, so a request that later cuts
		// on cooldown (0 attempts) can explain the real upstream cause.
		if (cause !== undefined)
			m.set(kCooldownCause(id), JSON.stringify(cause), "EX", cooldownSeconds);
		await m.exec();
	}
}

/** Reads stored cooldown causes for the given deployments. */
export async function getCooldownCauses(
	ids: string[],
): Promise<Map<string, CooldownCause>> {
	const map = new Map<string, CooldownCause>();
	if (ids.length === 0) return map;
	const pipe = redis.pipeline();
	for (const id of ids) pipe.get(kCooldownCause(id));
	const res = await pipe.exec();
	ids.forEach((id, i) => {
		const raw = res?.[i]?.[1];
		if (typeof raw === "string") {
			try {
				map.set(id, JSON.parse(raw) as CooldownCause);
			} catch {
				/* corrupt cause: ignored */
			}
		}
	});
	return map;
}

/** Client cancellation: releases the inflight slot WITHOUT penalizing (no fails, no cooldown). */
export async function onAttemptCancel(id: string): Promise<void> {
	await decrInflight(id);
}

function ewma(previous: string | null, sample: number): number {
	const old = previous === null ? NaN : Number(previous);
	return Number.isFinite(old)
		? old * (1 - EWMA_ALPHA) + sample * EWMA_ALPHA
		: sample;
}

/** Success (request finished): -1 inflight, +tokens in tpm, resets fails, updates latency/throughput. */
export async function onSuccessFinish(
	id: string,
	telemetry: SuccessTelemetry,
): Promise<void> {
	await decrInflight(id);
	const b = minuteBucket();
	const [oldLatency = null, oldThroughput = null] = await redis.mget(
		kLatencyMs(id),
		kThroughputTps(id),
	);
	const latencyMs =
		telemetry.durationMs > 0 ? ewma(oldLatency, telemetry.durationMs) : null;
	const throughputTps =
		telemetry.completionTokens !== null &&
		telemetry.completionTokens > 0 &&
		telemetry.durationMs > 0
			? ewma(
					oldThroughput,
					telemetry.completionTokens / (telemetry.durationMs / 1000),
				)
			: null;

	const pipe = redis
		.pipeline()
		.del(kFails(id))
		.incr(kSuccesses(id))
		.expire(kSuccesses(id), HEALTH_TTL);
	if (telemetry.totalTokens && telemetry.totalTokens > 0) {
		pipe
			.incrby(kTpm(id, b), telemetry.totalTokens)
			.expire(kTpm(id, b), WINDOW_TTL);
	}
	if (latencyMs !== null)
		pipe.set(kLatencyMs(id), String(latencyMs), "EX", HEALTH_TTL);
	if (throughputTps !== null)
		pipe.set(kThroughputTps(id), String(throughputTps), "EX", HEALTH_TTL);
	await pipe.exec();
}

/** Separates ids in cooldown from healthy ids. */
export async function partitionByCooldown(
	ids: string[],
): Promise<{ healthy: string[]; cooling: string[] }> {
	if (ids.length === 0) return { healthy: [], cooling: [] };
	const pipe = redis.pipeline();
	for (const id of ids) pipe.exists(kCooldown(id));
	const res = await pipe.exec();
	const healthy: string[] = [];
	const cooling: string[] = [];
	ids.forEach((id, i) => {
		(Number(res?.[i]?.[1] ?? 0) === 1 ? cooling : healthy).push(id);
	});
	return { healthy, cooling };
}

/** Current metrics (inflight/rpm/tpm) of several deployments. */
// Must match the number of pipe.get() calls pushed per id below (inflight, rpm, tpm, successes,
// failures, latency, throughput) - the read side indexes into `res` using this stride.
const FIELDS_PER_DEPLOYMENT = 7;

/**
 * `healthScore` for a deployment with no recorded attempts in the HEALTH_TTL window defaults to a
 * neutral 0.5 rather than a perfect 1.0. A perfect default would let `health-aware` routing blindly
 * resend full traffic to a deployment that was failing minutes ago: it gets routed away from (so it
 * stops accumulating attempts), its success/failure counters then expire from inactivity, and a
 * "perfect" default would make it look as good as a proven-healthy deployment again with zero new
 * evidence. A neutral default keeps it ranked behind any deployment with an actual track record.
 */
const NEUTRAL_HEALTH_SCORE = 0.5;

export async function fetchMetrics(
	ids: string[],
): Promise<Map<string, DeploymentMetrics>> {
	const map = new Map<string, DeploymentMetrics>();
	if (ids.length === 0) return map;
	const b = minuteBucket();
	const pipe = redis.pipeline();
	for (const id of ids) {
		pipe.get(kInflight(id));
		pipe.get(kRpm(id, b));
		pipe.get(kTpm(id, b));
		pipe.get(kSuccesses(id));
		pipe.get(kFailures(id));
		pipe.get(kLatencyMs(id));
		pipe.get(kThroughputTps(id));
	}
	const res = await pipe.exec();
	ids.forEach((id, i) => {
		const base = i * FIELDS_PER_DEPLOYMENT;
		const successes = Number(res?.[base + 3]?.[1] ?? 0);
		const failures = Number(res?.[base + 4]?.[1] ?? 0);
		const latency = res?.[base + 5]?.[1];
		const throughput = res?.[base + 6]?.[1];
		const total = successes + failures;
		map.set(id, {
			inflight: Number(res?.[base]?.[1] ?? 0),
			rpm: Number(res?.[base + 1]?.[1] ?? 0),
			tpm: Number(res?.[base + 2]?.[1] ?? 0),
			successes,
			failures,
			latencyMs: typeof latency === "string" ? Number(latency) : null,
			throughputTps: typeof throughput === "string" ? Number(throughput) : null,
			healthScore: total > 0 ? successes / total : NEUTRAL_HEALTH_SCORE,
		});
	});
	return map;
}
