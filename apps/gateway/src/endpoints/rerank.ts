import { assertRerankResponseValid } from "#gateway/rerankResponseValidation.ts";
import { rerankResponseLog, rerankRequestLog } from "#rerank/logging.ts";
import { candidateMetadata } from "#gateway/candidateMetadata.ts";
import type { RerankExecResult } from "#gateway/executor.ts";
import { route, type RouteResult } from "#router/index.ts";
import { RequestLogDraft } from "./runtime/requestLog.ts";
import { executeRerank } from "#gateway/executor.ts";
import type { AppEnv } from "#auth/types.ts";
import type { Usage } from "#core/usage.ts";
import type { Context } from "hono";

import {
	applyCanonicalResponseExtensions,
	applyCanonicalRequestExtensions,
	notifyExtensionError,
	toGatewayError,
	accountUsage,
	readJsonBody,
	parseBody,
	preflight,
} from "./runtime/pipeline.ts";

import {
	toOpenRouterRerankResponse,
	rerankRequestToCanonical,
	rerankRequestSchema,
} from "#contracts/openrouter/rerank.ts";

import {
	assertRerankProviderSupported,
	assertRerankRequestSupported,
} from "#gateway/rerankRequestValidation.ts";

export const MAX_RERANK_BODY_BYTES = 16 * 1024 * 1024;

/** POST /v1/rerank - OpenRouter-shaped text reranking contract. */
export async function rerankHandler(c: Context<AppEnv>): Promise<Response> {
	const log = new RequestLogDraft(c, "rerank");
	let routing: RouteResult<RerankExecResult> | null = null;
	let finished = false;

	const finish = async (usage: Usage | null): Promise<void> => {
		if (!routing || finished) return;
		finished = true;
		await routing.finish(usage);
	};

	try {
		const json = await readJsonBody(c, MAX_RERANK_BODY_BYTES);
		const parsed = parseBody(rerankRequestSchema, json);
		let canonical = rerankRequestToCanonical(parsed);
		canonical = await applyCanonicalRequestExtensions(c, "rerank", canonical);
		log.requestBody = rerankRequestLog(canonical);
		log.publicModel = canonical.model;
		await preflight(c, canonical.model);

		routing = await route(
			canonical.model,
			"rerank",
			{
				clientSignal: log.clientSignal,
				requestId: log.requestId,
				operationId: log.operationId,
				candidateEligibility: (candidate) => {
					assertRerankRequestSupported(canonical, candidate.meta);
					assertRerankProviderSupported(canonical, candidate.adapter);
				},
			},
			(candidate, ctx) => executeRerank(candidate.adapter, canonical, ctx),
		);
		log.applyRouting(routing);
		log.upstreamTtftMs = Date.now() - routing.upstreamStartedAt;

		const response = await applyCanonicalResponseExtensions(
			c,
			"rerank",
			canonical.model,
			routing.value.response,
		);
		assertRerankResponseValid(canonical, response);
		const usage = response.usage ?? null;
		await finish(usage);
		const cost = accountUsage(c, routing.candidate.meta, usage);
		const rendered = toOpenRouterRerankResponse(canonical, response, cost);
		log.write({
			status: "success",
			httpStatus: 200,
			usage,
			cost,
			ttftMs: log.elapsedMs(),
			responseBody: rerankResponseLog(response, cost),
			metadata: {
				...candidateMetadata(routing.candidate),
				terminal: routing.value.terminal,
			},
			error: null,
		});
		return c.json(rendered);
	} catch (error) {
		const ge = toGatewayError(error);
		log.applyFailedAttempts(ge.attempts);
		await finish(null);
		await notifyExtensionError(c, "rerank", log.publicModel, ge);
		log.writeError(ge);
		throw ge;
	}
}
