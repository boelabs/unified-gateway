import { getEffectiveSettings, type EffectiveSettings } from "./settings.ts";
import type { AdapterContext } from "#adapters/types.ts";
import { getFallbackPolicy } from "#db/repos/router.ts";
import type { CallType } from "#core/callType.ts";
import { resolveTransport } from "./transport.ts";
import { pickDeployment } from "./strategies.ts";
import { GatewayError } from "#core/errors.ts";
import type { Usage } from "#core/usage.ts";

import {
	partitionByCooldown,
	type CooldownCause,
	getCooldownCauses,
	onAttemptCancel,
	onSuccessFinish,
	onAttemptStart,
	onAttemptFail,
	fetchMetrics,
} from "./state.ts";

import {
	decryptDeploymentCredentials,
	listDeploymentCandidates,
	type DeploymentCandidate,
} from "#gateway/deploymentCandidates.ts";

export interface RouteOptions {
	clientSignal: AbortSignal;
	requestId: string;
	/** Excludes deployments incompatible with the request before balancing, without cooldown. */
	candidateEligibility?: (candidate: DeploymentCandidate) => void;
}

/** Executes the upstream call for a candidate; throws GatewayError on failure. */
export type ExecuteFn<T> = (
	candidate: DeploymentCandidate,
	ctx: AdapterContext,
) => Promise<T>;

/** Record for one router attempt against a deployment (for logs/observability). */
interface AttemptRecord {
	deploymentId: string;
	adapterKey: string;
	transport: string;
	ms: number;
	ok: boolean;
	errorClass?: string;
	httpStatus?: number;
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
	/** Call on completion (json: after responding; stream: in finally) to release inflight and record TPM. */
	finish: (usage: Usage | null) => Promise<void>;
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
		transport: resolveTransport(candidate, callType),
		requestId: opts.requestId,
		signal: AbortSignal.any([
			opts.clientSignal,
			AbortSignal.timeout(settings.timeoutSeconds * 1000),
		]),
	};
}

/**
 * Generic router: balancing + per-deployment retries + cooldown + per-reason fallbacks, for any
 * CallType. The concrete execution is injected via `execute`.
 */
export async function route<T>(
	publicModel: string,
	callType: CallType,
	opts: RouteOptions,
	execute: ExecuteFn<T>,
): Promise<RouteResult<T>> {
	const settings = await getEffectiveSettings();
	let attempts = 0;
	let lastError: GatewayError | undefined;
	let eligibilityError: GatewayError | undefined;
	const attemptLog: AttemptRecord[] = [];

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
		const failureReasons = new Set<FallbackReason>();
		const maxAttemptsPerDeployment = settings.numRetries + 1;
		let reason: FailReason = "exhausted";

		while (true) {
			const withAttemptsLeft = candidates.filter(
				(candidate) =>
					(attemptsByDeployment.get(candidate.row.id) ?? 0) <
					maxAttemptsPerDeployment,
			);
			if (withAttemptsLeft.length === 0) break;

			const { healthy } = await partitionByCooldown(
				withAttemptsLeft.map((c) => c.row.id),
			);
			const healthySet = new Set(healthy);
			const live = withAttemptsLeft.filter((c) => healthySet.has(c.row.id));
			if (live.length === 0) {
				reason = "cooldown";
				break;
			}

			// Exclude deployments that exceed their own RPM/TPM limit.
			const metrics = await fetchMetrics(live.map((c) => c.row.id));
			const available = live.filter((c) => {
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
			const chosen = pickDeployment(settings.routingStrategy, pool, metrics);
			const transport = resolveTransport(chosen, callType);

			attemptsByDeployment.set(
				chosen.row.id,
				(attemptsByDeployment.get(chosen.row.id) ?? 0) + 1,
			);
			attempts += 1;
			await onAttemptStart(chosen.row.id);
			const startedAt = Date.now();
			try {
				const ctx = buildContext(chosen, callType, settings, opts);
				const value = await execute(chosen, ctx);
				const ms = Date.now() - startedAt;
				attemptLog.push({
					deploymentId: chosen.row.id,
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
						finish: (usage) =>
							onSuccessFinish(chosen.row.id, usage?.totalTokens ?? null),
					},
				};
			} catch (err) {
				// If the CLIENT cancelled (not an upstream timeout), it is NOT the deployment's fault:
				// release the inflight, do not count toward allowed_fails/cooldown, and do not retry.
				// Prevents quickly cancelling requests from putting the deployment pool into cooldown.
				if (opts.clientSignal.aborted) {
					await onAttemptCancel(chosen.row.id);
					attemptLog.push({
						deploymentId: chosen.row.id,
						adapterKey: chosen.adapter.key,
						transport,
						ms: Date.now() - startedAt,
						ok: false,
						errorClass: "client_closed_request",
					});
					const cancelled = new GatewayError({
						class: "bad_request",
						status: 499,
						code: "client_closed_request",
						message: "Client closed the request before completion",
					});
					cancelled.attempts = attemptLog;
					throw cancelled;
				}
				const ge = GatewayError.is(err)
					? err
					: new GatewayError({
							class: "server",
							message: String(err),
							cause: err,
						});
				// Attach upstream detail to the cooldown cause (if this failure triggers it).
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
				await onAttemptFail(
					chosen.row.id,
					settings.allowedFails,
					settings.cooldownSeconds,
					cause,
				);
				lastError = ge;
				attemptLog.push({
					deploymentId: chosen.row.id,
					adapterKey: chosen.adapter.key,
					transport,
					ms: Date.now() - startedAt,
					ok: false,
					errorClass: ge.class,
					httpStatus: ge.httpStatus,
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
				if (ge.retryable && hasAttemptsLeft && settings.retryAfterSeconds > 0) {
					await sleep(settings.retryAfterSeconds * 1000);
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

	// If it cut on cooldown (possibly with no attempts in THIS request), retrieve the stored causes
	// of its deployments: they explain why they are all cooling down.
	const cooldownCauses =
		lastReason === "cooldown"
			? await getCooldownCauses(primaryCandidates.map((c) => c.row.id))
			: new Map<string, CooldownCause>();

	// ROUTING error (gateway info, public and specific): explains why it could not be served.
	// The provider detail (lastError) stays in the internal message (logs).
	const routingError = buildRoutingError({
		publicModel,
		callType,
		attempts,
		reason: lastReason,
		triedFallback,
		cooldownSeconds: settings.cooldownSeconds,
		lastError,
		cooldownCauses,
	});
	routingError.attempts = attemptLog;
	throw routingError;
}

type FailReason = "no_candidates" | "cooldown" | "rate_limited" | "exhausted";

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
	cooldownSeconds: number;
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
			class: "rate_limit",
			message: internal,
			publicMessage: `All deployments for public model "${p.publicModel}" are in cooldown${fbNote}. Try again in ~${p.cooldownSeconds}s.`,
			code: "deployments_in_cooldown",
			...causeProvider,
		});
	}
	if (p.reason === "rate_limited") {
		return new GatewayError({
			class: "rate_limit",
			message: internal,
			publicMessage: `All deployments for public model "${p.publicModel}" exceeded their RPM/TPM limit${fbNote}. Please try again later.`,
			code: "rate_limit_exceeded",
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
		...provider,
	});
}
