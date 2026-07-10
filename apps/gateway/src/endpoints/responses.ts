import { candidateMetadata } from "#gateway/candidateMetadata.ts";
import { getEffectiveSettings } from "#router/settings.ts";
import { RequestLogDraft } from "./runtime/requestLog.ts";
import { hasFileInputs } from "#files/requestFiles.ts";
import { reasoningLogInfo } from "#core/reasoning.ts";
import { tapFirstToken } from "#gateway/ttft.ts";
import { GatewayError } from "#core/errors.ts";
import { getAuth } from "#auth/middleware.ts";
import type { AppEnv } from "#auth/types.ts";
import type { Usage } from "#core/usage.ts";
import { streamSSE } from "hono/streaming";
import type { Auth } from "#auth/types.ts";
import { randomUUID } from "node:crypto";
import { env } from "#config/env.ts";
import type { Context } from "hono";

import {
	canonicalChunksToResponsesEvents,
	canonicalToResponsesResponse,
	responsesRequestToCanonical,
	responseEventForClient,
	normalizeResponseInput,
	type ResponseInputItem,
	expandInputReferences,
	type RenderOptions,
	responseForClient,
	toResponsesUsage,
} from "#contracts/openai/responsesRender.ts";

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
	compactResponseRequestSchema,
	type CompactResponseRequest,
	responsesRequestSchema,
	type ResponsesRequest,
} from "#contracts/openai/responses.ts";

import {
	findResponseItemByIdForScope,
	deleteResponseStateForScope,
	getResponseStateForScope,
	storeResponseState,
} from "#db/repos/responseStates.ts";

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

import {
	expandLocalCompactionItems,
	encodeCompactionSummary,
} from "./runtime/responseCompaction.ts";

interface PreparedResponsesRequest {
	req: ResponsesRequest;
	effectiveInput: ResponseInputItem[];
}

function authVirtualKeyId(auth: Auth): string | null {
	return auth.type === "virtual" ? auth.key.id : null;
}

function outputItemsFromResponse(
	response: Record<string, unknown>,
): ResponseInputItem[] {
	return Array.isArray(response.output)
		? response.output.map((item) => structuredClone(item as ResponseInputItem))
		: [];
}

function responseId(response: Record<string, unknown>): string {
	if (typeof response.id === "string" && response.id.length > 0)
		return response.id;
	throw new GatewayError({
		class: "server",
		message: "Rendered response is missing id",
	});
}

async function prepareResponsesRequest(
	req: ResponsesRequest,
	auth: Auth,
): Promise<PreparedResponsesRequest> {
	const virtualKeyId = authVirtualKeyId(auth);
	let previousItems: ResponseInputItem[] = [];

	if (req.previous_response_id != null) {
		const previous = await getResponseStateForScope(
			req.previous_response_id,
			virtualKeyId,
		);
		if (!previous) {
			throw new GatewayError({
				class: "bad_request",
				message: `previous_response_id not found: ${req.previous_response_id}`,
				publicMessage: "Previous response was not found.",
				code: "previous_response_not_found",
				param: "previous_response_id",
			});
		}
		previousItems = [...previous.requestInput, ...previous.output];
	}

	const currentInput = await expandInputReferences(
		normalizeResponseInput(req.input),
		previousItems,
		(id) => findResponseItemByIdForScope(id, virtualKeyId),
	);
	const effectiveInput = expandLocalCompactionItems([
		...previousItems.map((item) => structuredClone(item)),
		...currentInput,
	]);
	// Resolve `store` against the gateway default so both persistence and the echoed value agree.
	const store = req.store ?? env.RESPONSES_STORE_DEFAULT;
	return { req: { ...req, input: effectiveInput, store }, effectiveInput };
}

const COMPACTION_INSTRUCTIONS =
	"Create a compact, faithful conversation state for a later model turn. Preserve user intent, constraints, decisions, tool results, unresolved work, and identifiers that are still needed. Remove repetition and incidental wording. Return only the compacted state.";

/** POST /v1/responses/compact - provider-agnostic conversation compaction. */
export async function compactResponseHandler(
	c: Context<AppEnv>,
): Promise<Response> {
	const log = new RequestLogDraft(c, "responses.compact");
	const auth = getAuth(c);
	try {
		const json = await readJsonBody(c);
		log.requestBody = json;
		const compact: CompactResponseRequest = parseBody(
			compactResponseRequestSchema,
			json,
		);
		log.publicModel = compact.model;
		const request = responsesRequestSchema.parse({
			model: compact.model,
			...(compact.input !== undefined ? { input: compact.input } : {}),
			...(compact.previous_response_id != null
				? { previous_response_id: compact.previous_response_id }
				: {}),
			instructions: [COMPACTION_INSTRUCTIONS, compact.instructions]
				.filter(
					(value): value is string =>
						typeof value === "string" && value.length > 0,
				)
				.join("\n\n"),
			...(compact.prompt_cache_key !== undefined
				? { prompt_cache_key: compact.prompt_cache_key }
				: {}),
			stream: false,
			store: false,
		});
		const prepared = await prepareResponsesRequest(request, auth);
		let canonical = responsesRequestToCanonical(prepared.req);
		canonical = await applyCanonicalRequestExtensions(c, "chat", canonical);
		log.publicModel = canonical.model;
		await preflight(c, canonical.model);
		const settings = await getEffectiveSettings();
		const { routing, parameterPolicy, fileResolution } = await routeChat(
			c,
			canonical,
			log.requestId,
			settings,
		);
		log.applyRouting(routing);
		if (routing.value.kind !== "json")
			throw new GatewayError({
				class: "server",
				message: "Compaction unexpectedly returned a stream",
			});
		const response = await applyCanonicalResponseExtensions(
			c,
			"chat",
			canonical.model,
			routing.value.response,
		);
		const summary = response.choices[0]?.message.content;
		if (typeof summary !== "string" || summary.length === 0)
			throw new GatewayError({
				class: "server",
				message: "Compaction returned no summary",
			});
		await routing.finish(response.usage);
		const meta = routing.candidate.meta;
		const cost = accountUsage(c, meta, response.usage);
		const metadata = candidateMetadata(routing.candidate);
		const parameterMetadata = parameterPolicyLogMetadata(
			parameterPolicy,
			settings.unsupportedParameterStrategy,
		);
		if (parameterMetadata) metadata.parameterPolicy = parameterMetadata;
		const fileMetadata = fileResolutionLogMetadata(fileResolution);
		if (fileMetadata) metadata.fileParser = fileMetadata;
		const createdAt = Math.floor(Date.now() / 1000);
		const body = {
			id: `resp_${randomUUID()}`,
			object: "response.compaction",
			created_at: createdAt,
			output: [
				{
					id: `cmp_${randomUUID()}`,
					type: "compaction",
					encrypted_content: encodeCompactionSummary(summary),
				},
			],
			usage: toResponsesUsage(response.usage),
		};
		log.write({
			status: "success",
			httpStatus: 200,
			usage: response.usage,
			cost,
			ttftMs: log.elapsedMs(),
			responseBody: body,
			metadata,
			error: null,
		});
		return c.json(body);
	} catch (error) {
		const gatewayError = toGatewayError(error);
		log.applyFailedAttempts(gatewayError.attempts);
		await notifyExtensionError(c, "chat", log.publicModel, gatewayError);
		log.writeError(gatewayError);
		throw error;
	}
}

async function persistResponseState(opts: {
	auth: Auth;
	req: ResponsesRequest;
	effectiveInput: ResponseInputItem[];
	response: Record<string, unknown>;
	deploymentId: string | null;
	adapterKey: string | null;
	requestId: string;
	metadata: Record<string, unknown>;
	internalOutput?: ResponseInputItem[];
}): Promise<void> {
	// Opaque tool-call state round-trips statelessly through the client (thought signatures ride
	// inside call ids); only client-requested storage (`store: true`) persists anything.
	if (opts.req.store !== true) return;
	const output = opts.internalOutput ?? outputItemsFromResponse(opts.response);
	const id = responseId(opts.response);
	await storeResponseState({
		id,
		virtualKeyId: authVirtualKeyId(opts.auth),
		publicModel: opts.req.model,
		deploymentId: opts.deploymentId,
		adapterKey: opts.adapterKey,
		previousResponseId: opts.req.previous_response_id ?? null,
		store: true,
		requestInput: opts.effectiveInput,
		output,
		response: opts.response,
		metadata: {
			requestId: opts.requestId,
			...opts.metadata,
		},
	});
}

/**
 * POST /v1/responses - OpenResponses API, provider-agnostic.
 * Translates the request to canonical, routes to an adapter with a `chat` handler, and renders the
 * canonical result to the OpenResponses contract. Works with any provider.
 */
export async function responsesHandler(c: Context<AppEnv>): Promise<Response> {
	const log = new RequestLogDraft(c, "responses");
	const auth = getAuth(c);

	try {
		const json = await readJsonBody(c);
		log.requestBody = json;
		const req: ResponsesRequest = parseBody(responsesRequestSchema, json);
		log.publicModel = req.model;

		const prepared = await prepareResponsesRequest(req, auth);
		const pipelineReq = prepared.req;
		let canonical = responsesRequestToCanonical(pipelineReq);
		canonical = await applyCanonicalRequestExtensions(c, "chat", canonical);
		log.publicModel = canonical.model;
		await preflight(c, canonical.model);

		// Cache (opt-in, safe): only non-stream, without tools and without server-side state. Isolated per virtual
		// key (no cross-tenant leak); MASTER never caches.
		const cache = await openResponseCache({
			c,
			draft: log,
			namespace: "responses",
			payload: canonical as unknown as Record<string, unknown>,
			eligible:
				!canonical.stream &&
				!canonical.tools?.length &&
				pipelineReq.previous_response_id == null &&
				pipelineReq.store !== true &&
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
		const renderOpts: RenderOptions = {
			req: pipelineReq,
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
			const usage = response.usage;
			await routing.finish(usage);
			const cost = accountUsage(c, meta, usage);
			const internalRendered = canonicalToResponsesResponse(
				response,
				renderOpts,
			);
			const rendered = responseForClient(internalRendered, pipelineReq.include);
			await persistResponseState({
				auth,
				req: pipelineReq,
				effectiveInput: prepared.effectiveInput,
				response: rendered,
				internalOutput: outputItemsFromResponse(internalRendered),
				deploymentId: routing.candidate.row.id,
				adapterKey: routing.candidate.adapter.key,
				requestId: log.requestId,
				metadata,
			});
			cache.store(rendered, usage);
			const body = attachRoutingMetadata(rendered, routingMetadata);
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
		const events = canonicalChunksToResponsesEvents(
			transformedChunks(),
			renderOpts,
		);
		return streamSSE(c, async (stream) => {
			let usage: Usage | null = null;
			let streamError: GatewayError | null = null;
			let statePersisted = false;
			try {
				for await (const ev of events) {
					const clientEvent = responseEventForClient(ev, pipelineReq.include);
					let eventData = clientEvent.data;
					if (
						ev.event === "response.completed" ||
						ev.event === "response.incomplete"
					) {
						let completed:
							| (Record<string, unknown> & { usage?: unknown })
							| undefined;
						let internalResponse: Record<string, unknown> | undefined;
						try {
							const internalData = JSON.parse(ev.data) as {
								response?: Record<string, unknown> & { usage?: unknown };
							};
							internalResponse = internalData.response;
							const data = JSON.parse(clientEvent.data) as {
								response?: Record<string, unknown> & { usage?: unknown };
							};
							completed = data.response;
							if (routingMetadata && completed) {
								eventData = JSON.stringify({
									...data,
									response: {
										...completed,
										unified_routing: routingMetadata,
									},
								});
							}
							const u = completed?.usage as
								| {
										input_tokens?: number;
										output_tokens?: number;
										total_tokens?: number;
								  }
								| undefined;
							if (u) {
								usage = {
									promptTokens: u.input_tokens ?? 0,
									completionTokens: u.output_tokens ?? 0,
									totalTokens: u.total_tokens ?? 0,
								};
							}
						} catch {
							completed = undefined; // malformed final event: skip usage/persist, still forward to client
						}
						// Persist before the terminal event: store=true must never acknowledge an unretrievable id.
						if (completed && !statePersisted) {
							await persistResponseState({
								auth,
								req: pipelineReq,
								effectiveInput: prepared.effectiveInput,
								response: completed,
								...(internalResponse
									? {
											internalOutput: outputItemsFromResponse(internalResponse),
										}
									: {}),
								deploymentId: routing.candidate.row.id,
								adapterKey: routing.candidate.adapter.key,
								requestId: log.requestId,
								metadata,
							});
							statePersisted = true;
						}
					}
					await stream.writeSSE({ event: clientEvent.event!, data: eventData });
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
					data: JSON.stringify(streamError.toOpenAI()),
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
		throw err;
	}
}

/* ------------------------------------------------- state endpoints (server-side store) */

function requireId(c: Context<AppEnv>): string {
	const id = c.req.param("id");
	if (!id)
		throw new GatewayError({
			class: "bad_request",
			message: "Missing response id",
			param: "id",
		});
	return id;
}

/** Loads a state within the key's scope or throws not_found with the OpenResponses shape. */
async function loadStateOr404(c: Context<AppEnv>): Promise<{
	id: string;
	row: Awaited<ReturnType<typeof getResponseStateForScope>>;
}> {
	const id = requireId(c);
	const row = await getResponseStateForScope(id, authVirtualKeyId(getAuth(c)));
	if (!row) {
		throw new GatewayError({
			class: "not_found",
			message: `response not found: ${id}`,
			publicMessage: `Response with id '${id}' not found.`,
			code: "response_not_found",
			param: "id",
		});
	}
	return { id, row };
}

/** GET /v1/responses/{id} - returns the stored canonical `response` object. */
export async function retrieveResponseHandler(
	c: Context<AppEnv>,
): Promise<Response> {
	const { row } = await loadStateOr404(c);
	return c.json(row!.response as object);
}

/** DELETE /v1/responses/{id} - deletes the saved state. */
export async function deleteResponseHandler(
	c: Context<AppEnv>,
): Promise<Response> {
	const id = requireId(c);
	const deleted = await deleteResponseStateForScope(
		id,
		authVirtualKeyId(getAuth(c)),
	);
	if (!deleted) {
		throw new GatewayError({
			class: "not_found",
			message: `response not found: ${id}`,
			publicMessage: `Response with id '${id}' not found.`,
			code: "response_not_found",
			param: "id",
		});
	}
	return c.json({ id, object: "response.deleted", deleted: true });
}

/** GET /v1/responses/{id}/input_items - lists the stored input items. */
export async function listResponseInputItemsHandler(
	c: Context<AppEnv>,
): Promise<Response> {
	const { row } = await loadStateOr404(c);
	const items = row!.requestInput;
	const idOf = (it: Record<string, unknown>): string | null =>
		typeof it.id === "string" ? it.id : null;
	return c.json({
		object: "list",
		data: items,
		first_id: items.length > 0 ? idOf(items[0]!) : null,
		last_id: items.length > 0 ? idOf(items[items.length - 1]!) : null,
		has_more: false,
	});
}
