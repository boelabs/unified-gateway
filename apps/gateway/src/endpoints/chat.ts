import { candidateMetadata } from "#gateway/candidateMetadata.ts";
import { getEffectiveSettings } from "#router/settings.ts";
import { RequestLogDraft } from "./runtime/requestLog.ts";
import { hasFileInputs } from "#files/requestFiles.ts";
import { reasoningLogInfo } from "#core/reasoning.ts";
import { tapFirstToken } from "#gateway/ttft.ts";
import { GatewayError } from "#core/errors.ts";
import type { AppEnv } from "#auth/types.ts";
import type { Usage } from "#core/usage.ts";
import { streamSSE } from "hono/streaming";
import type { Context } from "hono";

import {
	applyCanonicalResponseExtensions,
	applyCanonicalRequestExtensions,
	applyStreamEventExtensions,
	notifyExtensionError,
	openResponseCache,
	toGatewayError,
	accountUsage,
	readJsonBody,
	parseBody,
	preflight,
} from "./runtime/pipeline.ts";

import {
	toCanonicalChatRequest,
	toOpenAIChatResponse,
	chatRequestSchema,
	toOpenAIChatChunk,
} from "#contracts/openai/chat.ts";

import {
	routingMetadataRequested,
	publicRoutingMetadata,
	attachRoutingMetadata,
} from "./runtime/routingMetadata.ts";

import {
	parameterPolicyLogMetadata,
	fileResolutionLogMetadata,
	routeChat,
} from "./runtime/parameterPolicy.ts";

/** POST /v1/chat/completions - compatible public contract, stream and non-stream, with logging. */
export async function chatCompletionsHandler(
	c: Context<AppEnv>,
): Promise<Response> {
	const log = new RequestLogDraft(c, "chat");

	try {
		const json = await readJsonBody(c);
		log.requestBody = json;
		const parsed = parseBody(chatRequestSchema, json);

		let canonical = toCanonicalChatRequest(parsed);
		canonical = await applyCanonicalRequestExtensions(c, "chat", canonical);
		log.publicModel = canonical.model;
		await preflight(c, canonical.model);

		// Cache (opt-in, safe): only non-stream and without tools. Isolated per virtual key (no leak
		// between tenants); the MASTER never caches (it has no tenant to isolate).
		const cache = await openResponseCache({
			c,
			draft: log,
			namespace: "chat",
			payload: canonical as unknown as Record<string, unknown>,
			eligible:
				!canonical.stream &&
				!canonical.tools?.length &&
				!hasFileInputs(canonical),
		});
		if (cache.hit) return c.json(cache.body as object);

		const settings = await getEffectiveSettings();
		const { routing, parameterPolicy, fileResolution } = await routeChat(
			c,
			canonical,
			log.requestId,
			settings,
		);
		log.applyRouting(routing);
		const upstreamStartedAt = routing.upstreamStartedAt;
		const meta = routing.candidate.meta;
		const metadata = candidateMetadata(routing.candidate);
		const reasoning = reasoningLogInfo(
			canonical.reasoning,
			meta.capabilities.reasoning ? meta.reasoning : undefined,
		);
		if (reasoning) metadata.reasoning = reasoning;
		const parameterMetadata = parameterPolicyLogMetadata(
			parameterPolicy,
			settings.unsupportedParameterStrategy,
		);
		if (parameterMetadata) metadata.parameterPolicy = parameterMetadata;
		const fileMetadata = fileResolutionLogMetadata(fileResolution);
		if (fileMetadata) metadata.fileParser = fileMetadata;
		const routingMetadata = routingMetadataRequested(c)
			? publicRoutingMetadata(routing, settings)
			: null;

		if (routing.value.kind === "json") {
			// no-stream: the response arrives complete -> the "first token" is the whole response.
			log.upstreamTtftMs = Date.now() - upstreamStartedAt;
			const response = await applyCanonicalResponseExtensions(
				c,
				"chat",
				canonical.model,
				routing.value.response,
			);
			await routing.finish(response.usage);
			const cost = accountUsage(c, meta, response.usage);
			const baseResponse = toOpenAIChatResponse(response);
			cache.store(baseResponse, response.usage);
			const oa = attachRoutingMetadata(
				baseResponse as unknown as Record<string, unknown>,
				routingMetadata,
			);
			log.write({
				status: "success",
				httpStatus: 200,
				usage: response.usage,
				cost,
				ttftMs: log.elapsedMs(), // non-stream: the response arrives complete at once
				responseBody: oa,
				metadata,
				error: null,
			});
			return c.json(oa);
		}

		let firstTokenAt: number | null = null;
		let lastChunkAt: number | null = null;
		const chunks = tapFirstToken(
			routing.value.chunks,
			(at) => {
				firstTokenAt = at;
			},
			(at) => {
				lastChunkAt = at;
			},
		);
		return streamSSE(c, async (stream) => {
			let finalUsage: Usage | null = null;
			let content = "";
			let streamError: GatewayError | null = null;
			try {
				for await (const chunk of chunks) {
					const transformed = await applyStreamEventExtensions(
						c,
						"chat",
						canonical.model,
						chunk,
					);
					const delta = transformed.choices[0]?.delta;
					if (delta?.content) content += delta.content;
					if (transformed.usage) finalUsage = transformed.usage; // capture ALWAYS for accounting

					// Fidelity to the client: we only send usage if it was requested (include_usage).
					let out = transformed;
					if (!canonical.includeUsage && transformed.usage !== undefined) {
						if (transformed.choices.length === 0) continue; // usage-only chunk -> do not forward
						out = { ...transformed };
						delete out.usage;
					}
					await stream.writeSSE({
						data: JSON.stringify(toOpenAIChatChunk(out)),
					});
				}
				if (routingMetadata) {
					await stream.writeSSE({
						data: JSON.stringify({
							id: `chatcmpl-${log.requestId}`,
							object: "chat.completion.chunk",
							created: Math.floor(Date.now() / 1000),
							model: routing.candidate.row.publicModel,
							choices: [],
							unified_routing: routingMetadata,
						}),
					});
				}
				await stream.writeSSE({ data: "[DONE]" });
			} catch (err) {
				streamError = GatewayError.is(err)
					? err
					: new GatewayError({
							class: "server",
							message: "Error during streaming",
							cause: err,
						});
				await notifyExtensionError(c, "chat", canonical.model, streamError);
				await stream.writeSSE({ data: JSON.stringify(streamError.toOpenAI()) });
			} finally {
				if (firstTokenAt !== null)
					log.upstreamTtftMs = firstTokenAt - upstreamStartedAt;
				await routing.finish(finalUsage, lastChunkAt ?? undefined);
				const cost = accountUsage(c, meta, finalUsage);
				log.write({
					status: streamError ? "error" : "success",
					httpStatus: 200,
					usage: finalUsage,
					cost,
					ttftMs: firstTokenAt !== null ? firstTokenAt - log.startedAt : null,
					responseBody: { streamed: true, content },
					metadata,
					error: streamError ? streamError.toLog() : null,
				});
			}
		});
	} catch (err) {
		const ge = toGatewayError(err);
		log.applyFailedAttempts(ge.attempts);
		await notifyExtensionError(c, "chat", log.publicModel, ge);
		log.writeError(ge);
		throw err; // the global onError formats the OpenAI response
	}
}
