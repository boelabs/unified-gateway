import { getEffectiveSettings, type EffectiveSettings } from "./settings.ts";
import type { UpstreamTransport } from "#core/transport.ts";
import type { AdapterContext } from "#adapters/types.ts";
import { getFallbackPolicy } from "#db/repos/router.ts";
import type { CallType } from "#core/callType.ts";
import { resolveTransport } from "./transport.ts";
import { pickDeployment } from "./strategies.ts";
import { GatewayError } from "#core/errors.ts";
import type { Usage } from "#core/usage.ts";

import {
	recordConfigurationFailure,
	recordTransientFailure,
	recordThrottleFailure,
	type CircuitSettings,
	acquireCircuitPermit,
	releaseCircuitPermit,
	getCircuitSnapshots,
	deploymentSubject,
	getCircuitCauses,
	capacitySubject,
	closeCircuits,
} from "./circuit.ts";

import {
	decryptDeploymentCredentials,
	listDeploymentCandidates,
	type DeploymentCandidate,
} from "#gateway/deploymentCandidates.ts";

import {
	type CooldownCause,
	onAttemptFailure,
	onAttemptCancel,
	onSuccessFinish,
	onAttemptStart,
	fetchMetrics,
} from "./state.ts";

export interface RouteOptions {
	clientSignal: AbortSignal;
	requestId: string;
	/** Preferred native transport when the selected adapter supports it. */
	preferredTransport?: UpstreamTransport;
	/** Excludes deployments incompatible with the request before balancing, without cooldown. */
	candidateEligibility?: (candidate: DeploymentCandidate) => void;
	/** Session affinity hint; used only when this deployment is still healthy and eligible. */
	preferredDeploymentId?: string;
}

/** Executes the upstream call for a candidate; throws GatewayError on failure. */
export type ExecuteFn<T> = (
	candidate: DeploymentCandidate,
	ctx: AdapterContext,
) => Promise<T>;

/** Record for one router attempt against a deployment (for logs/observability). */
interface AttemptRecord {
	deploymentId: string;
	/** Operator label of the attempted deployment, snapshotted for failover-readable logs. */
	label?: string;
	adapterKey: string;
	transport: string;
	ms: number;
	ok: boolean;
	errorClass?: string;
	failureKind?: string;
	httpStatus?: number;
	/** Present for failures intentionally excluded from deployment health and cooldown accounting. */
	deploymentHealth?: "neutral";
	/** Raw provider status (if the failure came from upstream). */
	providerStatus?: number;
	/** Raw provider body (truncated before storage). */
	providerBody?: unknown;
}

export interface RouteResult<T> {
	candidate: DeploymentCandidate;
	value: T;
	attempts: number;
	fallbackUsed: boolean;
	/**
	 * Epoch (ms) when the WINNING attempt's execute() started (just before the upstream fetch).
	 * Lets us compute the upstream TTFT: for non-stream, (route-return − this); for stream,
	 * (first-token instant − this). Isolates the gateway overhead (auth/routing/retries).
	 */
	upstreamStartedAt: number;
	/** Per-attempt detail (includes fallbacks). */
	attemptLog: AttemptRecord[];
	/**
	 * Call on completion (json: after responding; stream: in finally) to release inflight and record
	 * TPM. `finishedAt`, if given, is the epoch ms when upstream actually finished responding (e.g. the
	 * last upstream chunk received) - pass it for streaming so latency/throughput metrics reflect
	 * upstream speed, not how long relaying the response to the client additionally took. Defaults to
	 * `Date.now()`, which is accurate for the non-streaming case (finish() runs before the client write).
	 */
	finish: (usage: Usage | null, finishedAt?: number) => Promise<void>;
}

type FallbackReason = "general" | "context_window" | "content_policy";

function fallbackReasonForFailures(
	failures: Set<FallbackReason>,
): FallbackReason {
	if (failures.size !== 1) return "general";
	const [only] = failures;
	return only ?? "general";
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function buildContext(
	candidate: DeploymentCandidate,
	callType: CallType,
	settings: EffectiveSettings,
	opts: RouteOptions,
): AdapterContext {
	return {
		upstreamModel: candidate.upstreamModel,
		credentials: decryptDeploymentCredentials(candidate),
		meta: candidate.meta,
		transport: resolveTransport(candidate, callType, opts.preferredTransport),
		requestId: opts.requestId,
		signal: AbortSignal.any([
			opts.clientSignal,
			AbortSignal.timeout(settings.timeoutSeconds * 1000),
		]),
	};
}

/**
 * Generic router: balancing + bounded retries + atomic circuits + per-reason fallbacks, for any
 * CallType. The concrete execution is injected via `execute`.
 */
export async function route<T>(
	publicModel: string,
	callType: CallType,
	opts: RouteOptions,
	execute: ExecuteFn<T>,
): Promise<RouteResult<T>> {
	const settings = await getEffectiveSettings();
	const circuitSettings: CircuitSettings = {
		enabled: settings.allowedFails > 0 && settings.cooldownSeconds > 0,
		allowedFails: settings.allowedFails,
		failureWindowMs: settings.failureWindowSeconds * 1000,
		baseCooldownMs: settings.cooldownSeconds * 1000,
		maxCooldownMs: settings.maxCooldownSeconds * 1000,
		probeTtlMs: settings.halfOpenProbeSeconds * 1000,
	};
	let attempts = 0;
	let lastError: GatewayError | undefined;
	let eligibilityError: GatewayError | undefined;
	let neutralCandidateError: GatewayError | undefined;
	let deploymentFailureCount = 0;
	let shortestRetryAfterMs: number | undefined;
	const attemptLog: AttemptRecord[] = [];
	const countedTransientDeployments = new Set<string>();

	type PublicModelAttempt =
		| { ok: true; result: RouteResult<T> }
		| { ok: false; fallbackReason: FallbackReason; reason: FailReason };

	// `preloaded` lets us reuse the candidates already queried for the primary public model and
	// avoids a second identical SELECT on the hot path. Fallbacks query on-demand.
	async function tryPublicModel(
		candidatePublicModel: string,
		fallbackUsed: boolean,
		preloaded?: DeploymentCandidate[],
	): Promise<PublicModelAttempt> {
		const listed =
			preloaded ??
			(await listDeploymentCandidates(candidatePublicModel, callType));
		const candidates = opts.candidateEligibility
			? listed.filter((candidate) => {
					try {
						opts.candidateEligibility?.(candidate);
						return true;
					} catch (error) {
						if (!GatewayError.is(error) || error.class !== "bad_request")
							throw error;
						eligibilityError ??= error;
						return false;
					}
				})
			: listed;
		if (candidates.length === 0) {
			return { ok: false, fallbackReason: "general", reason: "no_candidates" };
		}

		const attemptsByDeployment = new Map<string, number>();
		const blockedDeployments = new Set<string>();
		const blockedCapacity = new Set<string>();
		const failureReasons = new Set<FallbackReason>();
		const maxAttemptsPerDeployment = settings.numRetries + 1;
		const poolStartedAt = attempts;
		let reason: FailReason = "exhausted";

		if (circuitSettings.enabled) {
			const subjects = candidates.map((candidate) => ({
				deployment: deploymentSubject(candidate.row.id),
				capacity: capacitySubject(
					candidate.row.id,
					candidate.row.failureDomain,
				),
			}));
			const snapshots = await getCircuitSnapshots(subjects);
			snapshots.forEach((snapshot, index) => {
				const subject = subjects[index];
				if (!snapshot || !subject) return;
				if (snapshot.status === "cooldown")
					blockedDeployments.add(subject.deployment.id);
				if (snapshot.status === "rate_limited")
					blockedCapacity.add(subject.capacity.id);
				if (
					snapshot.status === "half_open" &&
					snapshot.blockedBy === "deployment"
				)
					blockedDeployments.add(subject.deployment.id);
				if (
					snapshot.status === "half_open" &&
					snapshot.blockedBy === "capacity"
				)
					blockedCapacity.add(subject.capacity.id);
				if (snapshot.retryAfterMs !== null) {
					shortestRetryAfterMs =
						shortestRetryAfterMs === undefined
							? snapshot.retryAfterMs
							: Math.min(shortestRetryAfterMs, snapshot.retryAfterMs);
				}
			});
		}

		while (true) {
			if (
				attempts >= settings.maxAttemptsPerRequest ||
				attempts - poolStartedAt >= settings.maxAttemptsPerPool
			) {
				reason = "attempt_budget";
				break;
			}
			const withAttemptsLeft = candidates.filter((candidate) => {
				const capacity = capacitySubject(
					candidate.row.id,
					candidate.row.failureDomain,
				);
				return (
					(attemptsByDeployment.get(candidate.row.id) ?? 0) <
						maxAttemptsPerDeployment &&
					!blockedDeployments.has(candidate.row.id) &&
					!blockedCapacity.has(capacity.id)
				);
			});
			if (withAttemptsLeft.length === 0) {
				if (blockedDeployments.size > 0) reason = "cooldown";
				else if (blockedCapacity.size > 0) reason = "rate_limited";
				break;
			}

			// Exclude deployments that exceed their own RPM/TPM limit.
			const metrics = await fetchMetrics(withAttemptsLeft.map((c) => c.row.id));
			const available = withAttemptsLeft.filter((c) => {
				const m = metrics.get(c.row.id);
				if (!m) return true;
				if (c.row.rpmLimit != null && m.rpm >= c.row.rpmLimit) return false;
				if (c.row.tpmLimit != null && m.tpm >= c.row.tpmLimit) return false;
				return true;
			});
			if (available.length === 0) {
				reason = "rate_limited";
				break;
			}

			// First pass over all deployments before the second, and so on.
			const minAttempts = Math.min(
				...available.map(
					(candidate) => attemptsByDeployment.get(candidate.row.id) ?? 0,
				),
			);
			const pool = available.filter(
				(candidate) =>
					(attemptsByDeployment.get(candidate.row.id) ?? 0) === minAttempts,
			);
			const chosen =
				pool.find(
					(candidate) => candidate.row.id === opts.preferredDeploymentId,
				) ?? pickDeployment(settings.routingStrategy, pool, metrics);
			const transport = resolveTransport(
				chosen,
				callType,
				opts.preferredTransport,
			);
			const deployment = deploymentSubject(chosen.row.id);
			const capacity = capacitySubject(chosen.row.id, chosen.row.failureDomain);
			const permitResult = await acquireCircuitPermit(
				deployment,
				capacity,
				circuitSettings,
			);
			if (!permitResult.allowed) {
				if (permitResult.blockedBy === "deployment")
					blockedDeployments.add(chosen.row.id);
				else blockedCapacity.add(capacity.id);
				shortestRetryAfterMs =
					shortestRetryAfterMs === undefined
						? permitResult.retryAfterMs
						: Math.min(shortestRetryAfterMs, permitResult.retryAfterMs);
				reason =
					permitResult.blockedBy === "capacity" ? "rate_limited" : "cooldown";
				continue;
			}
			const permit = permitResult.permit;

			attemptsByDeployment.set(
				chosen.row.id,
				(attemptsByDeployment.get(chosen.row.id) ?? 0) + 1,
			);
			attempts += 1;
			try {
				await onAttemptStart(chosen.row.id);
			} catch (error) {
				await releaseCircuitPermit(permit);
				throw error;
			}
			const startedAt = Date.now();
			try {
				const ctx = buildContext(chosen, callType, settings, opts);
				const value = await execute(chosen, ctx);
				const ms = Date.now() - startedAt;
				attemptLog.push({
					deploymentId: chosen.row.id,
					...(chosen.row.label != null ? { label: chosen.row.label } : {}),
					adapterKey: chosen.adapter.key,
					transport,
					ms,
					ok: true,
				});
				return {
					ok: true,
					result: {
						candidate: chosen,
						value,
						attempts,
						fallbackUsed,
						upstreamStartedAt: startedAt,
						attemptLog,
						finish: (usage, finishedAt) =>
							onSuccessFinish(
								chosen.row.id,
								{
									totalTokens: usage?.totalTokens ?? null,
									completionTokens: usage?.completionTokens ?? null,
									durationMs: (finishedAt ?? Date.now()) - startedAt,
								},
								permit,
							),
					},
				};
			} catch (err) {
				// If the CLIENT cancelled (not an upstream timeout), it is NOT the deployment's fault:
				// release the inflight, do not count toward allowed_fails/cooldown, and do not retry.
				// Prevents quickly cancelling requests from putting the deployment pool into cooldown.
				if (opts.clientSignal.aborted) {
					await onAttemptCancel(chosen.row.id, permit);
					attemptLog.push({
						deploymentId: chosen.row.id,
						...(chosen.row.label != null ? { label: chosen.row.label } : {}),
						adapterKey: chosen.adapter.key,
						transport,
						ms: Date.now() - startedAt,
						ok: false,
						errorClass: "client_closed_request",
						deploymentHealth: "neutral",
					});
					const cancelled = new GatewayError({
						class: "bad_request",
						status: 499,
						code: "client_closed_request",
						message: "Client closed the request before completion",
						routingScope: "request",
					});
					cancelled.attempts = attemptLog;
					throw cancelled;
				}
				const ge = GatewayError.is(err)
					? err
					: new GatewayError({
							class: "server",
							message: String(err),
							failureKind: "gateway",
							deploymentHealth: "neutral",
							retryable: false,
							cause: err,
						});
				if (ge.routingScope === "request") {
					await onAttemptCancel(chosen.row.id, permit);
					attemptLog.push({
						deploymentId: chosen.row.id,
						...(chosen.row.label != null ? { label: chosen.row.label } : {}),
						adapterKey: chosen.adapter.key,
						transport,
						ms: Date.now() - startedAt,
						ok: false,
						errorClass: ge.class,
						failureKind: ge.failureKind,
						httpStatus: ge.httpStatus,
						deploymentHealth: "neutral",
					});
					ge.attempts = attemptLog;
					throw ge;
				}
				const cause: CooldownCause = {
					class: ge.class,
					message: ge.message,
					...(ge.provider?.status !== undefined
						? { status: ge.provider.status }
						: {}),
					...(ge.provider?.body !== undefined
						? { body: ge.provider.body }
						: {}),
				};
				switch (ge.failureKind) {
					case "transient": {
						await onAttemptFailure(chosen.row.id, true);
						const firstSignal =
							!countedTransientDeployments.has(chosen.row.id) ||
							permit.deploymentMode === "half_open";
						if (firstSignal) {
							countedTransientDeployments.add(chosen.row.id);
							await recordTransientFailure(permit, circuitSettings, cause);
						}
						deploymentFailureCount += 1;
						break;
					}
					case "configuration":
						await onAttemptFailure(chosen.row.id, true);
						await recordConfigurationFailure(
							permit,
							circuitSettings,
							cause,
							settings.configurationCooldownSeconds * 1000,
						);
						deploymentFailureCount += 1;
						break;
					case "throttle": {
						await onAttemptFailure(chosen.row.id, false);
						const throttleMs = Math.max(
							ge.retryAfterMs ?? 0,
							settings.throttleCooldownSeconds * 1000,
						);
						await recordThrottleFailure(
							permit,
							circuitSettings,
							cause,
							throttleMs,
						);
						shortestRetryAfterMs =
							shortestRetryAfterMs === undefined
								? throttleMs
								: Math.min(shortestRetryAfterMs, throttleMs);
						neutralCandidateError ??= ge;
						break;
					}
					case "request":
						await onAttemptFailure(chosen.row.id, false);
						// A deterministic request rejection still proves a half-open upstream is alive.
						await closeCircuits(permit);
						neutralCandidateError ??= ge;
						break;
					case "gateway":
						await onAttemptCancel(chosen.row.id, permit);
						neutralCandidateError ??= ge;
						break;
				}
				lastError = ge;
				attemptLog.push({
					deploymentId: chosen.row.id,
					...(chosen.row.label != null ? { label: chosen.row.label } : {}),
					adapterKey: chosen.adapter.key,
					transport,
					ms: Date.now() - startedAt,
					ok: false,
					errorClass: ge.class,
					failureKind: ge.failureKind,
					httpStatus: ge.httpStatus,
					...(ge.deploymentHealth === "neutral"
						? { deploymentHealth: "neutral" as const }
						: {}),
					...(ge.provider?.status !== undefined
						? { providerStatus: ge.provider.status }
						: {}),
					...(ge.provider?.body !== undefined
						? { providerBody: ge.provider.body }
						: {}),
				});

				const failureReason: FallbackReason =
					ge.class === "context_window"
						? "context_window"
						: ge.class === "content_policy"
							? "content_policy"
							: "general";
				failureReasons.add(failureReason);

				// Deterministic/non-retryable errors exhaust THIS deployment for the request, but do not
				// cut the pool: the other deployments of the same public model are still tried.
				if (!ge.retryable)
					attemptsByDeployment.set(chosen.row.id, maxAttemptsPerDeployment);

				const hasAttemptsLeft = candidates.some(
					(candidate) =>
						(attemptsByDeployment.get(candidate.row.id) ?? 0) <
						maxAttemptsPerDeployment,
				);
				if (
					ge.failureKind === "transient" &&
					ge.retryable &&
					hasAttemptsLeft &&
					attempts < settings.maxAttemptsPerRequest &&
					attempts - poolStartedAt < settings.maxAttemptsPerPool
				) {
					const exponent = Math.min(5, attempts - poolStartedAt - 1);
					const ceiling = Math.min(
						2000,
						Math.max(settings.retryAfterSeconds * 1000, 100 * 2 ** exponent),
					);
					await sleep(Math.floor(Math.random() * ceiling));
				}
			}
		}
		return {
			ok: false,
			fallbackReason:
				reason === "exhausted"
					? fallbackReasonForFailures(failureReasons)
					: "general",
			reason,
		};
	}

	const primaryCandidates = await listDeploymentCandidates(
		publicModel,
		callType,
	);
	if (primaryCandidates.length === 0) {
		throw new GatewayError({
			class: "not_found",
			message: `Public model "${publicModel}" does not exist or has no enabled ${callType} deployments`,
			code: "model_not_found",
		});
	}

	const primary = await tryPublicModel(publicModel, false, primaryCandidates);
	if (primary.ok) return primary.result;

	let lastReason: FailReason = primary.reason;
	let triedFallback = false;
	const fb = await getFallbackPolicy(publicModel, primary.fallbackReason);
	for (const fallbackModel of fb?.fallbackModels ?? []) {
		triedFallback = true;
		const attempt = await tryPublicModel(fallbackModel, true);
		if (attempt.ok) return attempt.result;
		lastReason = attempt.reason;
	}

	if (attempts === 0 && eligibilityError) {
		eligibilityError.attempts = attemptLog;
		throw eligibilityError;
	}
	if (deploymentFailureCount === 0 && neutralCandidateError) {
		neutralCandidateError.attempts = attemptLog;
		throw neutralCandidateError;
	}

	// Stored redacted causes explain a zero-attempt circuit cut without changing the public error.
	const cooldownCauses =
		lastReason === "cooldown"
			? await getCircuitCauses(
					primaryCandidates.flatMap((candidate) => [
						deploymentSubject(candidate.row.id),
						capacitySubject(candidate.row.id, candidate.row.failureDomain),
					]),
				)
			: new Map<string, CooldownCause>();

	// ROUTING error (gateway info, public and specific): explains why it could not be served.
	// The provider detail (lastError) stays in the internal message (logs).
	const routingError = buildRoutingError({
		publicModel,
		callType,
		attempts,
		reason: lastReason,
		triedFallback,
		retryAfterMs: shortestRetryAfterMs,
		lastError,
		cooldownCauses,
	});
	routingError.attempts = attemptLog;
	throw routingError;
}

type FailReason =
	| "no_candidates"
	| "cooldown"
	| "rate_limited"
	| "attempt_budget"
	| "exhausted";

const attemptsLabel = (n: number): string =>
	`${n} attempt${n === 1 ? "" : "s"}`;

/** Readable phrase for the underlying cause (class of the last error), gateway info. */
function causePhrase(cls: GatewayError["class"] | undefined): string {
	switch (cls) {
		case "timeout":
			return "upstream timeouts";
		case "rate_limit":
			return "upstream rate limiting";
		case "context_window":
			return "context window exceeded";
		case "content_policy":
			return "content policy blocks";
		case "auth":
			return "upstream authentication errors";
		default:
			return "upstream errors";
	}
}

function buildRoutingError(p: {
	publicModel: string;
	callType: CallType;
	attempts: number;
	reason: FailReason;
	triedFallback: boolean;
	retryAfterMs: number | undefined;
	lastError: GatewayError | undefined;
	cooldownCauses: Map<string, CooldownCause>;
}): GatewayError {
	const fbNote = p.triedFallback ? " (including fallbacks)" : "";
	const internal =
		`Routing failed for public model "${p.publicModel}" (${p.callType})${fbNote} after ${attemptsLabel(p.attempts)}; ` +
		`reason=${p.reason}; lastError=${p.lastError?.message ?? "n/a"}`;
	// Preserve the RAW response of the last upstream contacted (status + body) in the routing error,
	// so error.provider.body in the logs has the real detail and not just the gateway summary. If no
	// upstream was contacted (e.g. pure cooldown, 0 attempts), lastError is undefined and there is no
	// provider to attach.
	const provider =
		p.lastError?.provider !== undefined
			? { provider: p.lastError.provider }
			: {};

	if (p.reason === "cooldown") {
		// Saved causes (errors that triggered cooldown) -> provider detail for logs.
		const causeProvider =
			p.cooldownCauses.size > 0
				? {
						provider: {
							body: { cooldown_causes: Object.fromEntries(p.cooldownCauses) },
						},
					}
				: provider;
		return new GatewayError({
			class: "server",
			status: 503,
			message: internal,
			publicMessage: `All deployments for public model "${p.publicModel}" are temporarily unavailable${fbNote}. Please retry shortly.`,
			code: "deployments_in_cooldown",
			...(p.retryAfterMs !== undefined
				? {
						headers: {
							"Retry-After": String(
								Math.max(1, Math.ceil(p.retryAfterMs / 1000)),
							),
						},
					}
				: {}),
			...causeProvider,
		});
	}
	if (p.reason === "rate_limited") {
		return new GatewayError({
			class: "rate_limit",
			message: internal,
			publicMessage: `All deployments for public model "${p.publicModel}" exceeded their RPM/TPM limit${fbNote}. Please try again later.`,
			code: "rate_limit_exceeded",
			...(p.retryAfterMs !== undefined
				? {
						headers: {
							"Retry-After": String(
								Math.max(1, Math.ceil(p.retryAfterMs / 1000)),
							),
						},
					}
				: {}),
			...provider,
		});
	}
	// exhausted / no_candidates: there were failed attempts (or no eligible deployment).
	const cls = p.lastError?.class ?? "server";
	const cause = p.lastError ? ` (cause: ${causePhrase(cls)})` : "";
	return new GatewayError({
		class: cls,
		message: internal,
		publicMessage: `No deployments for public model "${p.publicModel}" were able to handle the request${fbNote} after ${attemptsLabel(p.attempts)}${cause}. Please try again later.`,
		code: "no_deployments_available",
		...(p.lastError?.httpStatus ? { status: p.lastError.httpStatus } : {}),
		...(p.lastError?.headers ? { headers: p.lastError.headers } : {}),
		...(p.lastError?.retryAfterMs !== undefined
			? { retryAfterMs: p.lastError.retryAfterMs }
			: {}),
		...provider,
	});
}
