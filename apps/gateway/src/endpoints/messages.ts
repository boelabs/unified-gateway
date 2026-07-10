import { messagesRequestSchema } from "#contracts/anthropic/messages.ts";
import { candidateMetadata } from "#gateway/candidateMetadata.ts";
import { hasContentInputs } from "#files/requestContentInputs.ts";
import { getEffectiveSettings } from "#router/settings.ts";
import { RequestLogDraft } from "./runtime/requestLog.ts";
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
	canonicalChunksToMessagesEvents,
	canonicalToMessagesResponse,
	messagesRequestToCanonical,
	type MessagesRenderOptions,
} from "#contracts/anthropic/messagesRender.ts";

import {
	contentInputResolutionLogMetadata,
	parameterPolicyLogMetadata,
	routeChat,
} from "./runtime/parameterPolicy.ts";

import {
	routingMetadataRequested,
	publicRoutingMetadata,
	attachRoutingMetadata,
} from "./runtime/routingMetadata.ts";

/**
 * POST /v1/messages - Anthropic Messages API, provider-agnostic. Translates the request to canonical,
 * routes to an adapter with a `chat` handler, and renders the result to the Anthropic format. Errors
 * are returned with the Anthropic shape (onError decides based on the path).
 */
export async function messagesHandler(c: Context<AppEnv>): Promise<Response> {
	const log = new RequestLogDraft(c, "messages");

	try {
		const json = await readJsonBody(c);
		log.requestBody = json;
		const req = parseBody(messagesRequestSchema, json);
		log.publicModel = req.model;
		let canonical = messagesRequestToCanonical(req);
		canonical = await applyCanonicalRequestExtensions(c, "chat", canonical);
		log.publicModel = canonical.model;
		await preflight(c, canonical.model);

		// Isolated per virtual key (no leak between tenants); the MASTER never caches.
		const cache = await openResponseCache({
			c,
			draft: log,
			namespace: "messages",
			payload: canonical as unknown as Record<string, unknown>,
			eligible:
				!canonical.stream &&
				!canonical.tools?.length &&
				!hasContentInputs(canonical),
		});
		if (cache.hit) return c.json(cache.body as object);

		const settings = await getEffectiveSettings();
		const { routing, parameterPolicy, contentInputResolution } =
			await routeChat(c, canonical, log.requestId, settings);
		log.applyRouting(routing);
		const upstreamStartedAt = routing.upstreamStartedAt;
		const meta = routing.candidate.meta;
		const renderOpts: MessagesRenderOptions = {
			upstreamModel: routing.candidate.upstreamModel,
		};
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
		const contentInputMetadata = contentInputResolutionLogMetadata(
			contentInputResolution,
		);
		if (contentInputMetadata) metadata.contentInputs = contentInputMetadata;
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
			const usage = response.usage;
			await routing.finish(usage);
			const cost = accountUsage(c, meta, usage);
			const rendered = canonicalToMessagesResponse(response, renderOpts);
			cache.store(rendered, usage);
			const body = attachRoutingMetadata(
				rendered as Record<string, unknown>,
				routingMetadata,
			);
			log.write({
				status: "success",
				httpStatus: 200,
				usage,
				cost,
				ttftMs: log.elapsedMs(),
				responseBody: rendered,
				metadata,
				error: null,
			});
			return c.json(body);
		}

		let firstTokenAt: number | null = null;
		let lastChunkAt: number | null = null;
		const tapped = tapFirstToken(
			routing.value.chunks,
			(at) => {
				firstTokenAt = at;
			},
			(at) => {
				lastChunkAt = at;
			},
		);
		async function* transformedChunks() {
			for await (const chunk of tapped) {
				yield await applyStreamEventExtensions(
					c,
					"chat",
					canonical.model,
					chunk,
				);
			}
		}
		const events = canonicalChunksToMessagesEvents(
			transformedChunks(),
			renderOpts,
		);
		return streamSSE(c, async (stream) => {
			let usage: Usage | null = null;
			let streamError: GatewayError | null = null;
			try {
				for await (const ev of events) {
					if (ev.event === "message_delta") {
						try {
							const u = (
								JSON.parse(ev.data) as {
									usage?: { input_tokens?: number; output_tokens?: number };
								}
							).usage;
							if (u) {
								usage = {
									promptTokens: u.input_tokens ?? 0,
									completionTokens: u.output_tokens ?? 0,
									totalTokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
								};
							}
						} catch {
							/* ignore */
						}
					}
					await stream.writeSSE({ event: ev.event!, data: ev.data });
				}
				if (routingMetadata) {
					await stream.writeSSE({
						event: "routing_metadata",
						data: JSON.stringify({
							type: "routing_metadata",
							unified_routing: routingMetadata,
						}),
					});
				}
			} catch (err) {
				streamError = GatewayError.is(err)
					? err
					: new GatewayError({
							class: "server",
							message: "Error during streaming",
							cause: err,
						});
				await notifyExtensionError(c, "chat", canonical.model, streamError);
				await stream.writeSSE({
					event: "error",
					data: JSON.stringify(streamError.toAnthropic()),
				});
			} finally {
				if (firstTokenAt !== null)
					log.upstreamTtftMs = firstTokenAt - upstreamStartedAt;
				await routing.finish(usage, lastChunkAt ?? undefined);
				const cost = accountUsage(c, meta, usage);
				log.write({
					status: streamError ? "error" : "success",
					httpStatus: 200,
					usage,
					cost,
					ttftMs: firstTokenAt !== null ? firstTokenAt - log.startedAt : null,
					responseBody: { streamed: true },
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
		throw err; // onError formats it in the Anthropic shape (based on the path)
	}
}
