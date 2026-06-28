import { redis } from "#cache/redis.ts";

/**
 * Router state in Redis. Keys per model (deployment):
 *   rt:inflight:{id}        counter of in-flight requests (least-busy)
 *   rt:rpm:{id}:{minute}    requests in the current minute
 *   rt:tpm:{id}:{minute}    tokens in the current minute
 *   rt:fails:{id}           recent failures (short window)
 *   rt:cooldown:{id}        present ⇒ the deployment is in cooldown
 *   rt:cooldown:cause:{id}  error that triggered the cooldown (to debug the cut with no attempts)
 */

const INFLIGHT_TTL = 300; // s - prevents leaks if a process dies midway
const WINDOW_TTL = 120; // s - RPM/TPM expire on their own
const FAILS_TTL = 60; // s - failures decay

export interface DeploymentMetrics {
	inflight: number;
	rpm: number;
	tpm: number;
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

/** Success (request finished): -1 inflight, +tokens in tpm, resets fails. */
export async function onSuccessFinish(
	id: string,
	totalTokens: number | null,
): Promise<void> {
	await decrInflight(id);
	const b = minuteBucket();
	const pipe = redis.pipeline().del(kFails(id));
	if (totalTokens && totalTokens > 0) {
		pipe.incrby(kTpm(id, b), totalTokens).expire(kTpm(id, b), WINDOW_TTL);
	}
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
	}
	const res = await pipe.exec();
	ids.forEach((id, i) => {
		map.set(id, {
			inflight: Number(res?.[i * 3]?.[1] ?? 0),
			rpm: Number(res?.[i * 3 + 1]?.[1] ?? 0),
			tpm: Number(res?.[i * 3 + 2]?.[1] ?? 0),
		});
	});
	return map;
}
