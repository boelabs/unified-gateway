import { releaseCircuitPermit, closeCircuits } from "./circuit.ts";
import type { CircuitPermit } from "./circuit.ts";
import { redis } from "#cache/redis.ts";

/**
 * Router state in Redis. Keys per model (deployment):
 *   rt:inflight:{id}        counter of in-flight requests (least-busy)
 *   rt:rpm:{id}:{minute}    requests in the current minute
 *   rt:tpm:{id}:{minute}    tokens in the current minute
 *   rt:successes:{id}       recent successful completions
 *   rt:failures:{id}        recent failed upstream attempts
 *   rt:latency_ms:{id}      EWMA of successful completion latency
 *   rt:throughput_tps:{id}  EWMA of output tokens/second
 *
 * Circuit state uses its own atomic implementation in circuit.ts.
 */

// Longer than the largest execution policy (15 minutes) so a valid long-running audio/video stream
// is never silently removed from least-busy accounting. Crashes still self-heal.
const INFLIGHT_TTL = 1_200;
const WINDOW_TTL = 120; // s - RPM/TPM expire on their own
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

/** Detail of the error that put a deployment into cooldown. Raw provider data is never persisted. */
export interface CooldownCause {
	class: string;
	message: string;
	status?: number;
	/** Stable correlation value for the original message/body, without retaining either one. */
	fingerprint?: string;
	/** Accepted only as transient input to the circuit serializer; never stored in Redis. */
	body?: unknown;
}

function minuteBucket(): number {
	return Math.floor(Date.now() / 60_000);
}

const kInflight = (id: string) => `rt:inflight:${id}`;
const kRpm = (id: string, b: number) => `rt:rpm:${id}:${b}`;
const kTpm = (id: string, b: number) => `rt:tpm:${id}:${b}`;
const kSuccesses = (id: string) => `rt:successes:${id}`;
const kFailures = (id: string) => `rt:failures:${id}`;
const kLatencyMs = (id: string) => `rt:latency_ms:${id}`;
const kThroughputTps = (id: string) => `rt:throughput_tps:${id}`;

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

/**
 * Finishes a failed attempt. Throttling and request/gateway failures release inflight without
 * lowering health; transient/configuration failures contribute to health-aware routing.
 */
export async function onAttemptFailure(
	id: string,
	penalizeHealth: boolean,
): Promise<void> {
	await decrInflight(id);
	if (!penalizeHealth) return;
	await redis
		.pipeline()
		.incr(kFailures(id))
		.expire(kFailures(id), HEALTH_TTL)
		.exec();
}

/** Client cancellation: releases the inflight slot WITHOUT penalizing (no fails, no cooldown). */
export async function onAttemptCancel(
	id: string,
	permit?: CircuitPermit,
): Promise<void> {
	await decrInflight(id);
	if (permit) await releaseCircuitPermit(permit);
}

function ewma(previous: string | null, sample: number): number {
	const old = previous === null ? NaN : Number(previous);
	return Number.isFinite(old)
		? old * (1 - EWMA_ALPHA) + sample * EWMA_ALPHA
		: sample;
}

/** Success: updates telemetry, closes owned probes, and resets closed-circuit failure counters. */
export async function onSuccessFinish(
	id: string,
	telemetry: SuccessTelemetry,
	permit?: CircuitPermit,
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
	if (permit) await closeCircuits(permit);
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
