import { candidateMetadata } from "#gateway/candidateMetadata.ts";
import { RequestLogDraft } from "./runtime/requestLog.ts";
import { executeChat } from "#gateway/executor.ts";
import { tapFirstToken } from "#gateway/ttft.ts";
import { log as appLog } from "#logging/log.ts";
import { GatewayError } from "#core/errors.ts";
import { getAuth } from "#auth/middleware.ts";
import type { AppEnv } from "#auth/types.ts";
import type { Usage } from "#core/usage.ts";
import { streamSSE } from "hono/streaming";
import type { Auth } from "#auth/types.ts";
import { route } from "#router/index.ts";
import { env } from "#config/env.ts";
import type { Context } from "hono";

import {
	canonicalChunksToResponsesEvents,
	resolveResponseInputReferences,
	canonicalToResponsesResponse,
	responsesRequestToCanonical,
	normalizeResponseInput,
	type ResponseInputItem,
	type RenderOptions,
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
	deleteResponseStateForScope,
	getResponseStateForScope,
	storeResponseState,
} from "#db/repos/responseStates.ts";

import {
	responsesRequestSchema,
	type ResponsesRequest,
} from "#contracts/openai/responses.ts";

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

	const currentInput = resolveResponseInputReferences(
		normalizeResponseInput(req.input),
		previousItems,
	);
	const effectiveInput = [
		...previousItems.map((item) => structuredClone(item)),
		...currentInput,
	];
	// Resolve `store` against the gateway default so both persistence and the echoed value agree.
	const store = req.store ?? env.RESPONSES_STORE_DEFAULT;
	return { req: { ...req, input: effectiveInput, store }, effectiveInput };
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
}): Promise<void> {
	if (opts.req.store !== true) return;
	await storeResponseState({
		id: responseId(opts.response),
		virtualKeyId: authVirtualKeyId(opts.auth),
		publicModel: opts.req.model,
		deploymentId: opts.deploymentId,
		adapterKey: opts.adapterKey,
		previousResponseId: opts.req.previous_response_id ?? null,
		requestInput: opts.effectiveInput,
		output: outputItemsFromResponse(opts.response),
		response: opts.response,
		metadata: { requestId: opts.requestId, ...opts.metadata },
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
				pipelineReq.store !== true,
		});
		if (cache.hit) return c.json(cache.body as object);

		const routing = await route(
			canonical.model,
			"chat",
			{ clientSignal: c.req.raw.signal, requestId: log.requestId },
			(cand, ctx) => executeChat(cand.adapter, canonical, ctx),
		);
		log.applyRouting(routing);
		const upstreamStartedAt = routing.upstreamStartedAt;
		const meta = routing.candidate.meta;
		const renderOpts: RenderOptions = {
			req: pipelineReq,
			upstreamModel: routing.candidate.upstreamModel,
		};
		const metadata = candidateMetadata(routing.candidate);

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
			const rendered = canonicalToResponsesResponse(response, renderOpts);
			await persistResponseState({
				auth,
				req: pipelineReq,
				effectiveInput: prepared.effectiveInput,
				response: rendered,
				deploymentId: routing.candidate.row.id,
				adapterKey: routing.candidate.adapter.key,
				requestId: log.requestId,
				metadata,
			});
			cache.store(rendered, usage);
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
			return c.json(rendered);
		}

		let firstTokenAt: number | null = null;
		const tapped = tapFirstToken(routing.value.chunks, (at) => {
			firstTokenAt = at;
		});
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
					if (
						ev.event === "response.completed" ||
						ev.event === "response.incomplete"
					) {
						let completed:
							| (Record<string, unknown> & { usage?: unknown })
							| undefined;
						try {
							const data = JSON.parse(ev.data) as {
								response?: Record<string, unknown> & { usage?: unknown };
							};
							completed = data.response;
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
						// Persist best-effort: a state-store failure must never break the client's stream.
						if (completed && !statePersisted) {
							statePersisted = true;
							try {
								await persistResponseState({
									auth,
									req: pipelineReq,
									effectiveInput: prepared.effectiveInput,
									response: completed,
									deploymentId: routing.candidate.row.id,
									adapterKey: routing.candidate.adapter.key,
									requestId: log.requestId,
									metadata,
								});
							} catch (persistErr) {
								appLog.error(
									"responses",
									"failed to persist streamed response state",
									{ err: persistErr },
								);
							}
						}
					}
					await stream.writeSSE({ event: ev.event!, data: ev.data });
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
				await routing.finish(usage);
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
