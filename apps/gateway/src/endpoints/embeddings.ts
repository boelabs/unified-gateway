import { assertEmbeddingsRequestSupported } from "#gateway/embeddingsRequestValidation.ts";
import { candidateMetadata } from "#gateway/candidateMetadata.ts";
import type { EmbeddingsExecResult } from "#gateway/executor.ts";
import { embeddingsResponseLog } from "#embeddings/logging.ts";
import { embeddingsUsageToCore } from "#core/embeddings.ts";
import { route, type RouteResult } from "#router/index.ts";
import { RequestLogDraft } from "./runtime/requestLog.ts";
import { executeEmbeddings } from "#gateway/executor.ts";
import type { AppEnv } from "#auth/types.ts";
import type { Context } from "hono";

import {
	applyCanonicalResponseExtensions,
	applyCanonicalRequestExtensions,
	notifyExtensionError,
	openResponseCache,
	toGatewayError,
	accountUsage,
	readJsonBody,
	parseBody,
	preflight,
} from "./runtime/pipeline.ts";

import {
	embeddingsRequestToCanonical,
	toOpenAIEmbeddingsResponse,
	embeddingsRequestSchema,
} from "#contracts/openai/embeddings.ts";

/** POST /v1/embeddings - OpenAI-compatible contract, no-stream, cacheable. */
export async function embeddingsHandler(c: Context<AppEnv>): Promise<Response> {
	const log = new RequestLogDraft(c, "embeddings");
	let routing: RouteResult<EmbeddingsExecResult> | null = null;
	let finished = false;

	const finish = async (
		usage: ReturnType<typeof embeddingsUsageToCore>,
	): Promise<void> => {
		if (!routing || finished) return;
		finished = true;
		await routing.finish(usage);
	};

	try {
		const json = await readJsonBody(c);
		log.requestBody = json;
		const parsed = parseBody(embeddingsRequestSchema, json);
		let canonical = embeddingsRequestToCanonical(parsed);
		canonical = await applyCanonicalRequestExtensions(
			c,
			"embeddings",
			canonical,
		);
		log.publicModel = canonical.model;
		await preflight(c, canonical.model);

		const cache = await openResponseCache({
			c,
			draft: log,
			namespace: "embeddings",
			payload: canonical as unknown as Record<string, unknown>,
			eligible: true,
			logBody: embeddingsResponseLog,
		});
		if (cache.hit) return c.json(cache.body as object);

		routing = await route(
			canonical.model,
			"embeddings",
			{
				clientSignal: c.req.raw.signal,
				requestId: log.requestId,
				candidateEligibility: (candidate) =>
					assertEmbeddingsRequestSupported(canonical, candidate.meta),
			},
			(candidate, ctx) => executeEmbeddings(candidate.adapter, canonical, ctx),
		);
		log.applyRouting(routing);
		log.upstreamTtftMs = Date.now() - routing.upstreamStartedAt;

		const response = await applyCanonicalResponseExtensions(
			c,
			"embeddings",
			canonical.model,
			routing.value.response,
		);
		const usage = embeddingsUsageToCore(response.usage);
		await finish(usage);
		const cost = accountUsage(c, routing.candidate.meta, usage);
		const rendered = toOpenAIEmbeddingsResponse(response);
		if (usage) cache.store(rendered, usage);
		log.write({
			status: "success",
			httpStatus: 200,
			usage,
			cost,
			ttftMs: log.elapsedMs(),
			responseBody: embeddingsResponseLog(rendered),
			metadata: candidateMetadata(routing.candidate),
			error: null,
		});
		return c.json(rendered);
	} catch (error) {
		const ge = toGatewayError(error);
		log.applyFailedAttempts(ge.attempts);
		await finish(null);
		await notifyExtensionError(c, "embeddings", log.publicModel, ge);
		log.writeError(ge);
		throw ge;
	}
}
