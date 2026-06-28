import { truncateJson, type TruncateStats } from "./truncate.ts";
import { recordRequestTelemetry } from "#telemetry/index.ts";
import type { CostBreakdown } from "./cost.ts";
import { requestLogs } from "#db/schema.ts";
import type { Usage } from "#core/usage.ts";
import { env } from "#config/env.ts";
import { db } from "#db/client.ts";
import { log } from "./log.ts";

export interface RequestLogInput {
	requestId: string;
	virtualKeyId: string | null;
	publicModel: string | null;
	deploymentId: string | null;
	adapterKey: string | null;
	callType: string;
	status: "success" | "error";
	httpStatus: number | null;
	usage: Usage | null;
	cost: CostBreakdown | null;
	durationMs: number;
	ttftMs: number | null;
	/** TTFT of the winning upstream (ms): fetch dispatch -> first token. null if there was no first token. */
	upstreamTtftMs?: number | null;
	cacheHit: boolean;
	retries: number;
	fallbackUsed: boolean;
	ip: string | null;
	userAgent: string | null;
	startTime: Date;
	endTime: Date;
	requestBody: unknown;
	responseBody: unknown;
	metadata: Record<string, unknown>;
	/** Classified error + raw provider detail. */
	error: Record<string, unknown> | null;
	/** Per-attempt router detail (AttemptRecord[]). */
	attempts?: unknown[] | null;
}

/**
 * Persists a request_log ASYNCHRONOUSLY (fire-and-forget): it does not block the client response.
 * Long strings are truncated according to MAX_STRING_LENGTH_PROMPT_IN_DB.
 */
export function logRequest(input: RequestLogInput): void {
	recordRequestTelemetry(input);
	const maxLen = env.MAX_STRING_LENGTH_PROMPT_IN_DB;
	const stats: TruncateStats = { fields: 0, omittedChars: 0 };
	void db
		.insert(requestLogs)
		.values({
			requestId: input.requestId,
			virtualKeyId: input.virtualKeyId,
			publicModel: input.publicModel,
			deploymentId: input.deploymentId,
			adapterKey: input.adapterKey,
			callType: input.callType,
			status: input.status,
			httpStatus: input.httpStatus,
			promptTokens: input.usage?.promptTokens ?? null,
			completionTokens: input.usage?.completionTokens ?? null,
			totalTokens: input.usage?.totalTokens ?? null,
			costCents: input.cost ? input.cost.totalCents.toFixed(10) : null,
			durationMs: input.durationMs,
			ttftMs: input.ttftMs,
			upstreamTtftMs: input.upstreamTtftMs ?? null,
			cacheHit: input.cacheHit,
			retries: input.retries,
			fallbackUsed: input.fallbackUsed,
			ip: input.ip,
			userAgent: input.userAgent,
			startTime: input.startTime,
			endTime: input.endTime,
			requestBody: truncateJson(input.requestBody, maxLen, stats),
			responseBody: truncateJson(input.responseBody, maxLen, stats),
			metadata: {
				...input.metadata,
				...(input.cost ? { costBreakdown: input.cost } : {}),
			},
			// error and attempts may contain the raw provider body -> truncated too.
			error: input.error
				? (truncateJson(input.error, maxLen, stats) as Record<string, unknown>)
				: null,
			attempts: input.attempts
				? (truncateJson(input.attempts, maxLen, stats) as unknown[])
				: null,
		})
		.catch((err: unknown) => {
			log.error("request-log", "insert failed", { err });
		});

	// Truncation is expected and silent at info level; it is only reported at debug, in case a
	// trimmed payload is hiding what is being investigated.
	if (stats.fields > 0 && env.LOG_LEVEL === "debug") {
		log.debug("request-log", "truncated fields", {
			requestId: input.requestId,
			fields: stats.fields,
			omittedChars: stats.omittedChars,
			maxStringLength: maxLen,
		});
	}
}
