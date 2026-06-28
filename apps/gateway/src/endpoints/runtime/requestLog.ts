import { logRequest, type RequestLogInput } from "#logging/logger.ts";
import { getRequestId } from "#http/requestContext.ts";
import type { GatewayError } from "#core/errors.ts";
import { clientIp } from "#endpoints/shared.ts";
import { getAuth } from "#auth/middleware.ts";
import type { AppEnv } from "#auth/types.ts";
import type { Usage } from "#core/usage.ts";
import type { Context } from "hono";

/** Fields the endpoint fills in when closing the request lifecycle (success or error). */
export type LogOutcome = Pick<
	RequestLogInput,
	| "status"
	| "httpStatus"
	| "usage"
	| "cost"
	| "ttftMs"
	| "responseBody"
	| "metadata"
	| "error"
>;

/** Subset of RouteResult the draft needs (avoids coupling it to the generic router). */
interface RoutingLike {
	candidate: { row: { id: string }; adapter: { key: string } };
	attempts: number;
	fallbackUsed: boolean;
	attemptLog: unknown[];
}

interface AttemptLike {
	deploymentId?: string;
	adapterKey?: string;
}

/**
 * Mutable accumulator of the request_log during a request's lifecycle. Centralizes the draft that
 * each endpoint used to repeat as a dozen loose `let`s plus a `writeLog` closure: built on entry,
 * progressively filled (model, routing, TTFT), and emits a single log on close.
 *
 * `applyRouting` fills in the winning attempt's fields; `applyFailedAttempts` reconstructs what is
 * known from the attempt log when `route()` fails before choosing a deployment.
 */
export class RequestLogDraft {
	/** Epoch (ms) of handler entry. Public for computing relative TTFTs. */
	readonly startedAt = Date.now();
	private readonly startTime = new Date(this.startedAt);
	/** Request correlation id (header/UUID). Public for routing and persistence. */
	readonly requestId: string;
	private readonly virtualKeyId: string | null;
	private readonly callType: string;
	private readonly ip: string | null;
	private readonly userAgent: string | null;

	/** Requested public model. Mutable: in text endpoints it is known after parsing the body. */
	publicModel: string | null = null;
	/** Request body as it is logged (raw JSON or a reduced multipart form). */
	requestBody: unknown = undefined;
	/** TTFT of the winning upstream (ms). null if there was no first token. */
	upstreamTtftMs: number | null = null;

	private deploymentId: string | null = null;
	private adapterKey: string | null = null;
	private retries = 0;
	private fallbackUsed = false;
	private attemptLog: unknown[] | null = null;

	constructor(
		c: Context<AppEnv>,
		callType: string,
		opts?: { publicModel?: string },
	) {
		const auth = getAuth(c);
		this.requestId = getRequestId(c);
		this.virtualKeyId = auth.type === "virtual" ? auth.key.id : null;
		this.callType = callType;
		this.ip = clientIp(c);
		this.userAgent = c.req.header("user-agent") ?? null;
		if (opts?.publicModel !== undefined) this.publicModel = opts.publicModel;
	}

	/** ms elapsed since entering the handler. */
	elapsedMs(): number {
		return Date.now() - this.startedAt;
	}

	/** Fills the draft with the router's winning attempt. */
	applyRouting(routing: RoutingLike): void {
		this.deploymentId = routing.candidate.row.id;
		this.adapterKey = routing.candidate.adapter.key;
		this.retries = Math.max(0, routing.attempts - 1);
		this.fallbackUsed = routing.fallbackUsed;
		this.attemptLog = routing.attemptLog;
	}

	/**
	 * Reconstructs deployment/adapter/retries from the attempt log when `route()` threw before
	 * assigning a deployment. Does not overwrite values already set by `applyRouting`.
	 */
	applyFailedAttempts(attempts: unknown[] | null | undefined): void {
		const list = (attempts ?? this.attemptLog) as AttemptLike[] | null;
		if (!list || list.length === 0) return;
		this.attemptLog = list;
		this.retries = Math.max(0, list.length - 1);
		const last = list[list.length - 1]!;
		if (this.deploymentId === null && last.deploymentId)
			this.deploymentId = last.deploymentId;
		if (this.adapterKey === null && last.adapterKey)
			this.adapterKey = last.adapterKey;
	}

	/** Always-present log fields, resolved at write time. */
	private base(): Omit<RequestLogInput, keyof LogOutcome | "cacheHit"> {
		const now = Date.now();
		return {
			requestId: this.requestId,
			virtualKeyId: this.virtualKeyId,
			publicModel: this.publicModel,
			deploymentId: this.deploymentId,
			adapterKey: this.adapterKey,
			callType: this.callType,
			durationMs: now - this.startedAt,
			upstreamTtftMs: this.upstreamTtftMs,
			retries: this.retries,
			fallbackUsed: this.fallbackUsed,
			ip: this.ip,
			userAgent: this.userAgent,
			startTime: this.startTime,
			endTime: new Date(now),
			requestBody: this.requestBody,
			attempts: this.attemptLog,
		};
	}

	/** Emits the request's final log (not a cache hit). */
	write(outcome: LogOutcome): void {
		logRequest({ ...this.base(), cacheHit: false, ...outcome });
	}

	/** Shortcut for the error log from an already-normalized GatewayError. */
	writeError(error: GatewayError): void {
		this.write({
			status: "error",
			httpStatus: error.httpStatus,
			usage: null,
			cost: null,
			ttftMs: null,
			responseBody: null,
			metadata: {},
			error: error.toLog(),
		});
	}

	/** Emits the log of a response served from cache (TTFT = local serving time). */
	writeCacheHit(
		body: unknown,
		usage: Usage,
		responseBody: unknown = body,
	): void {
		logRequest({
			...this.base(),
			cacheHit: true,
			status: "success",
			httpStatus: 200,
			usage,
			cost: null,
			ttftMs: this.elapsedMs(),
			responseBody,
			metadata: { cached: true },
			error: null,
		});
	}
}
