import type { Adapter, AdapterContext, ChatHandler } from "./types.ts";
import { looksLikeContextWindowError } from "#core/httpError.ts";
import { GatewayError, type ErrorClass } from "#core/errors.ts";
import { type BaseCreds, requireApiKeyCreds } from "./creds.ts";
import type { ReasoningControlKind } from "#core/reasoning.ts";
import type { UpstreamTransport } from "#core/transport.ts";
import { mapUpstreamHttpError } from "./upstreamError.ts";
import type { ImageOperation } from "#core/images.ts";
import { imageProfileFor } from "#catalog/types.ts";
import { parseSSE } from "#core/sse.ts";

import {
	buildDirectImageGenerationBody,
	parseDirectImagesResponse,
	buildDirectImageEditForm,
	parseDirectImageStream,
	parseOmniImageResponse,
	buildOmniImageBody,
} from "#contracts/openai/imagesTransport.ts";

import {
	responsesEventsToCanonicalChunks,
	buildResponsesRequestBody,
	parseResponsesResponse,
} from "#contracts/openai/responsesTransport.ts";

import {
	parseTranscriptionResponse,
	parseTranscriptionStream,
	buildTranscriptionForm,
} from "#contracts/openai/audioTransport.ts";

import {
	parseOpenAIChatResponse,
	parseOpenAIChatChunk,
	buildOpenAIChatBody,
} from "#contracts/openai/chatTransport.ts";

import {
	parseEmbeddingsResponse,
	buildEmbeddingsBody,
} from "#contracts/openai/embeddingsTransport.ts";

import type {
	TranscriptionHandler,
	EmbeddingsHandler,
	ImageHandler,
} from "./types.ts";

/**
 * Factory for OpenAI Chat Completions-style adapters. Serves both the real OpenAI API and any
 * compatible provider (xAI, Mistral, Groq, Together, OpenRouter, vLLM, Ollama...). The differences are
 * parametrized; everything else is shared.
 */
export interface OpenAIStyleConfig {
	key: string;
	label: string;
	/** Default base URL. If undefined, `baseUrl` in credentials is REQUIRED. */
	defaultBaseUrl?: string;
	/**
	 * Default upstream transport. The adapter supports BOTH (chat_completions and responses); the
	 * default distinguishes them (openai: responses; compatibles: chat_completions).
	 */
	defaultTransport: "chat_completions" | "responses";
	/** Text transports actually exposed by this provider. Defaults to both. */
	supportedChatTransports?: readonly ("chat_completions" | "responses")[];
	/** Output-limit field (chat_completions transport only). OpenAI: max_completion_tokens; compatibles: max_tokens. */
	maxTokensField: "max_completion_tokens" | "max_tokens";
	/** OpenAI uses Bearer; Azure v1 with a key uses the api-key header. */
	authScheme?: "bearer" | "api-key";
	/** Base-URL-specific normalization/validation. */
	normalizeBaseUrl?: (baseUrl: string) => string;
	/** Send the openai-organization header if there is an org in credentials. */
	sendOrganization?: boolean;
	/**
	 * Refines a 400 to a more specific class (e.g. context_length_exceeded -> context_window), keeping
	 * status and provider. Receives the upstream message and the body. `null` = no change.
	 */
	refineBadRequest?: (message: string, body: unknown) => ErrorClass | null;
	/** Image protocols this adapter implements. Absent = chat only. */
	imageTransports?: readonly Extract<
		UpstreamTransport,
		"images" | "chat_completions"
	>[];
	defaultImageTransport?: Extract<
		UpstreamTransport,
		"images" | "chat_completions"
	>;
	/** The provider implements POST /audio/transcriptions (multipart). Absent = no audio. */
	audioTranscriptions?: boolean;
	/** The provider implements POST /embeddings. Absent = no embeddings. */
	embeddings?: boolean;
}

/**
 * Generic 400/422 refinement for OpenAI-compatible providers without a dedicated `code`:
 * reclassifies to `context_window` when the message reveals a context overflow (DeepSeek, GLM,
 * MiniMax, Kimi... report it by message). Reusable as `refineBadRequest`.
 */
export function contextWindowRefine(message: string): ErrorClass | null {
	return looksLikeContextWindowError(message) ? "context_window" : null;
}

interface Creds extends BaseCreds {
	organization?: string;
}

interface ResolvedCreds {
	apiKey: string;
	base: string;
	organization?: string;
	headers?: Record<string, string>;
}

export function makeOpenAIStyleAdapter(config: OpenAIStyleConfig): Adapter {
	function resolveCreds(ctx: AdapterContext): ResolvedCreds {
		const c = requireApiKeyCreds<Creds>(ctx.credentials, config.label);
		const base = c.baseUrl ?? config.defaultBaseUrl;
		if (!base) {
			throw new GatewayError({
				class: "bad_request",
				message: `${config.label}: missing 'baseUrl' in credentials`,
			});
		}
		const normalizedBase = config.normalizeBaseUrl
			? config.normalizeBaseUrl(base)
			: base.replace(/\/+$/, "");
		const resolved: ResolvedCreds = { apiKey: c.apiKey, base: normalizedBase };
		if (c.organization !== undefined) resolved.organization = c.organization;
		if (c.headers !== undefined) resolved.headers = c.headers;
		return resolved;
	}

	function buildHeaders(c: ResolvedCreds): Record<string, string> {
		return {
			"content-type": "application/json",
			...(config.authScheme === "api-key"
				? { "api-key": c.apiKey }
				: { authorization: `Bearer ${c.apiKey}` }),
			...(config.sendOrganization && c.organization
				? { "openai-organization": c.organization }
				: {}),
			...(c.headers ?? {}),
		};
	}

	function buildAuthHeaders(c: ResolvedCreds): Record<string, string> {
		const { "content-type": _omit, ...headers } = buildHeaders(c);
		return headers;
	}

	function mapError(err: unknown): GatewayError {
		return mapUpstreamHttpError(err, {
			label: config.label,
			...(config.refineBadRequest
				? { refineBadRequest: config.refineBadRequest }
				: {}),
		});
	}

	// Stream of the chat_completions transport (OpenAI chunks -> canonical).
	async function* completionsStream(
		stream: ReadableStream<Uint8Array>,
	): AsyncGenerator<ReturnType<typeof parseOpenAIChatChunk>> {
		for await (const event of parseSSE(stream)) {
			if (event.data === "[DONE]") return;
			let json: unknown;
			try {
				json = JSON.parse(event.data);
			} catch {
				continue;
			}
			yield parseOpenAIChatChunk(json);
		}
	}

	// A single chat handler that picks the upstream transport based on ctx.transport.
	const chat: ChatHandler = {
		buildRequest(req, ctx) {
			const c = resolveCreds(ctx);
			const supportedChatTransports = config.supportedChatTransports ?? [
				"chat_completions",
				"responses",
			];
			if (
				(ctx.transport !== "chat_completions" &&
					ctx.transport !== "responses") ||
				!supportedChatTransports.includes(ctx.transport)
			) {
				throw new GatewayError({
					class: "server",
					message: `${config.label}: transport "${ctx.transport}" is not supported`,
				});
			}
			if (ctx.transport === "responses") {
				return {
					method: "POST",
					url: `${c.base}/responses`,
					headers: buildHeaders(c),
					body: JSON.stringify(
						buildResponsesRequestBody(
							req,
							ctx.upstreamModel,
							ctx.meta.reasoning,
						),
					),
				};
			}
			return {
				method: "POST",
				url: `${c.base}/chat/completions`,
				headers: buildHeaders(c),
				body: JSON.stringify(
					buildOpenAIChatBody(req, ctx.upstreamModel, {
						maxTokensField: config.maxTokensField,
						...(ctx.meta.reasoning !== undefined
							? { reasoningSpec: ctx.meta.reasoning }
							: {}),
					}),
				),
			};
		},
		parseResponse(raw, ctx) {
			return ctx.transport === "responses"
				? parseResponsesResponse(raw)
				: parseOpenAIChatResponse(raw);
		},
		parseStream(stream, ctx) {
			return ctx.transport === "responses"
				? responsesEventsToCanonicalChunks(parseSSE(stream))
				: completionsStream(stream);
		},
		mapError(err) {
			return mapError(err);
		},
	};

	function makeImageHandler(operation: ImageOperation): ImageHandler {
		return {
			async buildRequest(req, ctx) {
				const c = resolveCreds(ctx);
				const profile = imageProfileFor(ctx.meta, operation);
				if (ctx.transport === "images") {
					if (operation === "edit") {
						return {
							method: "POST",
							url: `${c.base}/images/edits`,
							headers: buildAuthHeaders(c),
							body: await buildDirectImageEditForm(
								req,
								ctx.upstreamModel,
								profile,
							),
						};
					}
					return {
						method: "POST",
						url: `${c.base}/images/generations`,
						headers: buildHeaders(c),
						body: JSON.stringify(
							buildDirectImageGenerationBody(req, ctx.upstreamModel, profile),
						),
					};
				}
				if (ctx.transport === "chat_completions") {
					return {
						method: "POST",
						url: `${c.base}/chat/completions`,
						headers: buildHeaders(c),
						body: JSON.stringify(
							await buildOmniImageBody(req, ctx.upstreamModel, profile),
						),
					};
				}
				throw new GatewayError({
					class: "server",
					message: `${config.label}: transport "${ctx.transport}" cannot produce images`,
				});
			},
			parseResponse(raw, ctx) {
				return ctx.transport === "images"
					? parseDirectImagesResponse(raw)
					: parseOmniImageResponse(raw);
			},
			parseStream(stream, ctx) {
				if (ctx.transport !== "images") {
					throw new GatewayError({
						class: "server",
						message: `${config.label}: image streaming requires transport images`,
					});
				}
				return parseDirectImageStream(stream, operation);
			},
			mapError(err) {
				return mapError(err);
			},
		};
	}

	const audioTranscription: TranscriptionHandler = {
		async buildRequest(req, ctx) {
			const c = resolveCreds(ctx);
			return {
				method: "POST",
				url: `${c.base}/audio/transcriptions`,
				// No content-type: FormData sets the multipart boundary.
				headers: buildAuthHeaders(c),
				body: await buildTranscriptionForm(req, ctx.upstreamModel),
			};
		},
		parseResponse(raw) {
			return parseTranscriptionResponse(raw);
		},
		parseStream(stream) {
			return parseTranscriptionStream(stream);
		},
		mapError(err) {
			return mapError(err);
		},
	};

	const embeddings: EmbeddingsHandler = {
		buildRequest(req, ctx) {
			const c = resolveCreds(ctx);
			if (ctx.transport !== "embeddings") {
				throw new GatewayError({
					class: "server",
					message: `${config.label}: transport "${ctx.transport}" cannot create embeddings`,
				});
			}
			return {
				method: "POST",
				url: `${c.base}/embeddings`,
				headers: buildHeaders(c),
				body: JSON.stringify(buildEmbeddingsBody(req, ctx.upstreamModel)),
			};
		},
		parseResponse(raw) {
			return parseEmbeddingsResponse(raw);
		},
		mapError(err) {
			return mapError(err);
		},
	};

	const imageTransports = config.imageTransports;
	const chatTransports = config.supportedChatTransports ?? [
		"chat_completions",
		"responses",
	];
	if (!chatTransports.includes(config.defaultTransport)) {
		throw new Error(
			`${config.label}: default transport "${config.defaultTransport}" is not supported`,
		);
	}
	const supportedCallTypes = new Set<import("#core/callType.ts").CallType>([
		"chat",
	]);
	if (imageTransports && imageTransports.length > 0) {
		supportedCallTypes.add("images.generations");
		supportedCallTypes.add("images.edits");
	}
	if (config.audioTranscriptions)
		supportedCallTypes.add("audio.transcriptions");
	if (config.embeddings) supportedCallTypes.add("embeddings");
	const firstImageTransport = imageTransports?.[0];
	const imageTransportConfig =
		imageTransports && firstImageTransport
			? {
					supported: imageTransports,
					default: config.defaultImageTransport ?? firstImageTransport,
				}
			: undefined;

	return {
		key: config.key,
		supportedCallTypes,
		chat,
		// The chat_completions transport emits reasoning_effort (openai_effort), top-level thinking
		// (openai_body), ignores fixed reasoners, and supports chat_template_kwargs.
		reasoningKinds: new Set<ReasoningControlKind>([
			"openai_effort",
			"openai_body",
			"fixed",
			"chat_template_flag",
		]),
		...(imageTransportConfig
			? {
					imageGeneration: makeImageHandler("generation"),
					imageEdit: makeImageHandler("edit"),
				}
			: {}),
		...(config.audioTranscriptions ? { audioTranscription } : {}),
		...(config.embeddings ? { embeddings } : {}),
		transports: {
			chat: { supported: chatTransports, default: config.defaultTransport },
			...(imageTransportConfig
				? {
						"images.generations": imageTransportConfig,
						"images.edits": imageTransportConfig,
					}
				: {}),
			...(config.audioTranscriptions
				? {
						"audio.transcriptions": {
							supported: ["audio_transcriptions"],
							default: "audio_transcriptions",
						},
					}
				: {}),
			...(config.embeddings
				? {
						embeddings: {
							supported: ["embeddings"],
							default: "embeddings",
						},
					}
				: {}),
		},
	};
}
