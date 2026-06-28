import { enforceVirtualKey, recordVirtualKeyUsage } from "#ratelimit/index.ts";
import { computeCost, type CostBreakdown } from "#logging/cost.ts";
import { getRequestId, setHeaders } from "#http/requestContext.ts";
import { buildCacheKey, cachePayload } from "#cache/cacheKey.ts";
import type { ResolvedModelMetadata } from "#catalog/types.ts";
import { extensionRuntime } from "#extensions/runtime.ts";
import type { RequestLogDraft } from "./requestLog.ts";
import { assertModelAllowed } from "#auth/scope.ts";
import type { CallType } from "#core/callType.ts";
import { GatewayError } from "#core/errors.ts";
import { getAuth } from "#auth/middleware.ts";
import type { AppEnv } from "#auth/types.ts";
import type { Usage } from "#core/usage.ts";
import type { Context } from "hono";
import type * as z from "zod/v4";

import type {
	ExtensionCanonicalResponse,
	ExtensionCanonicalRequest,
	ExtensionImageOutput,
	ExtensionStreamEvent,
	ExtensionPublicAuth,
} from "#extensions/sdk.ts";

import {
	cacheConfigFromHeaders,
	cacheGet,
	cacheSet,
} from "#cache/responseCache.ts";

/** Normalizes any thrown value to GatewayError (`server` class if it was not one already). */
export function toGatewayError(
	err: unknown,
	message = "Internal error",
): GatewayError {
	return GatewayError.is(err)
		? err
		: new GatewayError({ class: "server", message, cause: err });
}

/** Translates a zod validation error to the `bad_request` GatewayError, with the issue detail. */
function zodToGatewayError(error: z.ZodError): GatewayError {
	const first = error.issues[0];
	return new GatewayError({
		class: "bad_request",
		message: error.issues
			.map((issue) =>
				issue.path.length
					? `${issue.path.join(".")}: ${issue.message}`
					: issue.message,
			)
			.join("; "),
		param: first ? first.path.join(".") : null,
	});
}

/** Reads the JSON body; throws `bad_request` if missing or not valid JSON. */
export async function readJsonBody(c: Context<AppEnv>): Promise<unknown> {
	const json = await c.req.json().catch(() => undefined);
	if (json === undefined) {
		throw new GatewayError({
			class: "bad_request",
			message: "Invalid or missing JSON body",
		});
	}
	return json;
}

/** Validates `json` against a zod schema; throws `bad_request` with the detail if it does not pass. */
export function parseBody<T>(schema: z.ZodType<T>, json: unknown): T {
	const parsed = schema.safeParse(json);
	if (!parsed.success) throw zodToGatewayError(parsed.error);
	return parsed.data;
}

/**
 * Preflight common to every endpoint: validates the model scope and, if the key is virtual, applies
 * the rate limit and propagates its headers (x-ratelimit-*). Throws if the model is not allowed or a
 * limit is exceeded.
 */
export async function preflight(
	c: Context<AppEnv>,
	model: string,
): Promise<void> {
	const auth = getAuth(c);
	assertModelAllowed(auth, model);
	if (auth.type === "virtual")
		setHeaders(c, (await enforceVirtualKey(auth.key)).headers);
}

export function extensionScope(
	c: Context<AppEnv>,
	callType: CallType,
	publicModel: string | null,
) {
	const auth = getAuth(c);
	const publicAuth: ExtensionPublicAuth =
		auth.type === "virtual"
			? {
					type: "virtual",
					virtualKeyId: auth.key.id,
					virtualKeyName: auth.key.name,
				}
			: { type: "master" };
	return {
		requestId: getRequestId(c),
		callType,
		endpoint: c.req.path,
		publicModel,
		auth: publicAuth,
		signal: c.req.raw.signal,
	};
}

export async function applyCanonicalRequestExtensions<
	T extends ExtensionCanonicalRequest,
>(c: Context<AppEnv>, callType: CallType, request: T): Promise<T> {
	return extensionRuntime.runCanonicalRequest(
		extensionScope(c, callType, request.model),
		request,
	);
}

export async function applyCanonicalResponseExtensions<
	T extends ExtensionCanonicalResponse,
>(
	c: Context<AppEnv>,
	callType: CallType,
	publicModel: string | null,
	response: T,
): Promise<T> {
	return extensionRuntime.runCanonicalResponse(
		extensionScope(c, callType, publicModel),
		response,
	);
}

export async function applyStreamEventExtensions<
	T extends ExtensionStreamEvent,
>(
	c: Context<AppEnv>,
	callType: CallType,
	publicModel: string | null,
	event: T,
): Promise<T> {
	return extensionRuntime.runStreamEvent(
		extensionScope(c, callType, publicModel),
		event,
	);
}

export async function applyImageOutputExtensions(
	scope: ReturnType<typeof extensionScope>,
	output: ExtensionImageOutput,
): Promise<ExtensionImageOutput> {
	return extensionRuntime.runImageOutput(scope, output);
}

export async function notifyExtensionError(
	c: Context<AppEnv>,
	callType: CallType,
	publicModel: string | null,
	error: unknown,
): Promise<void> {
	try {
		await extensionRuntime.runErrorHooks(
			extensionScope(c, callType, publicModel),
			error,
		);
	} catch {
		// Error hooks are observability hooks; never replace the original request failure.
	}
}

/**
 * Computes the consumption cost and, if the key is virtual, accounts for it (TPM/budget/spend).
 * Returns the cost breakdown, or null if there was no usage to charge.
 */
export function accountUsage(
	c: Context<AppEnv>,
	meta: Pick<ResolvedModelMetadata, "pricing">,
	usage: Usage | null,
): CostBreakdown | null {
	if (!usage) return null;
	const cost = computeCost(meta, usage);
	const auth = getAuth(c);
	if (auth.type === "virtual")
		recordVirtualKeyUsage(auth.key, usage.totalTokens, cost.totalCents);
	return cost;
}

/** Response-cache slot: on hit, `body` is the response to return; `store` persists on miss. */
export interface CacheSlot {
	hit: boolean;
	body: unknown;
	store(body: unknown, usage: Usage): void;
}

const NO_CACHE: CacheSlot = { hit: false, body: null, store: () => {} };

/**
 * Opt-in response cache for text endpoints (chat/responses/messages). Isolated per virtual key
 * -the MASTER never caches- and governed by the x-unified-cache headers. On a hit it logs the request
 * as `cacheHit` via the draft and returns the body to respond with; on a miss it returns a `store()`
 * that persists the final response. `eligible` captures the endpoint-specific conditions (no
 * stream, no tools, no server-side state...).
 */
export async function openResponseCache(opts: {
	c: Context<AppEnv>;
	draft: RequestLogDraft;
	namespace: string;
	payload: Record<string, unknown>;
	eligible: boolean;
	logBody?: (body: unknown) => unknown;
}): Promise<CacheSlot> {
	const auth = getAuth(opts.c);
	const cfg = cacheConfigFromHeaders((name) => opts.c.req.header(name));
	if (auth.type !== "virtual" || !cfg.enabled || !opts.eligible)
		return NO_CACHE;

	const key = buildCacheKey(
		opts.namespace,
		auth.key.id,
		cachePayload(opts.payload),
	);
	const cached = await cacheGet(key);
	if (cached) {
		opts.draft.writeCacheHit(
			cached.body,
			cached.usage,
			opts.logBody ? opts.logBody(cached.body) : cached.body,
		);
		return { hit: true, body: cached.body, store: () => {} };
	}
	return {
		hit: false,
		body: null,
		store: (body, usage) => void cacheSet(key, { body, usage }, cfg.ttlSeconds),
	};
}
