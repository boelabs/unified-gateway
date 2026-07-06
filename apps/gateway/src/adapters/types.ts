import type { UpstreamTransport, AdapterTransports } from "#core/transport.ts";
import type { ReasoningControlKind } from "#core/reasoning.ts";
import type { ResolvedModelMetadata } from "#catalog/types.ts";
import type { GatewayError } from "#core/errors.ts";
import type { CallType } from "#core/callType.ts";

import type {
	CanonicalTranscriptionStreamEvent,
	CanonicalTranscriptionResponse,
	CanonicalTranscriptionRequest,
} from "#core/audio.ts";

import type {
	CanonicalChatStreamChunk,
	CanonicalChatResponse,
	CanonicalChatRequest,
} from "#core/canonical.ts";

import type {
	CanonicalImageStreamEvent,
	CanonicalImageResponse,
	CanonicalImageRequest,
} from "#core/images.ts";

import type {
	CanonicalEmbeddingsResponse,
	CanonicalEmbeddingsRequest,
} from "#core/embeddings.ts";

/** Upstream error the executor passes to `mapError` when the response is not 2xx. */
export interface UpstreamError {
	status: number;
	/** Already-parsed error body (JSON) or raw text. */
	body: unknown;
}

/** HTTP request built toward the upstream. The executor runs it with fetch. */
type UpstreamBody = NonNullable<RequestInit["body"]>;

export interface UpstreamHttpRequest<TBody extends UpstreamBody = string> {
	method: string;
	url: string;
	headers: Record<string, string>;
	/** Serialized body: a JSON string or FormData on binary endpoints. */
	body?: TBody;
}

/** Context the router/executor passes to the adapter for a specific call. */
export interface AdapterContext {
	/** The model at the upstream (upstream_model of the chosen deployment). */
	upstreamModel: string;
	/** Already-decrypted credentials (api key, base url, org id, headers...). */
	credentials: Record<string, unknown>;
	/** Effective model metadata (catalog + override): capabilities, pricing, limits, reasoning. */
	meta: ResolvedModelMetadata;
	/** Upstream transport resolved for this call. */
	transport: UpstreamTransport;
	requestId: string;
	/** To cancel/timeout the upstream call. */
	signal?: AbortSignal;
}

/** An adapter's canonical text handler. */
export interface ChatHandler {
	buildRequest(
		req: CanonicalChatRequest,
		ctx: AdapterContext,
	): UpstreamHttpRequest;
	parseResponse(raw: unknown, ctx: AdapterContext): CanonicalChatResponse;
	parseStream(
		stream: ReadableStream<Uint8Array>,
		ctx: AdapterContext,
	): AsyncIterable<CanonicalChatStreamChunk>;
	/** Maps an upstream error (non-2xx HTTP, error body, exception) to a GatewayError. */
	mapError(err: unknown, ctx: AdapterContext): GatewayError;
}

export interface ImageHandler {
	buildRequest(
		req: CanonicalImageRequest,
		ctx: AdapterContext,
	):
		| UpstreamHttpRequest<UpstreamBody>
		| Promise<UpstreamHttpRequest<UpstreamBody>>;
	parseResponse(
		raw: unknown,
		ctx: AdapterContext,
	): CanonicalImageResponse | Promise<CanonicalImageResponse>;
	parseStream?(
		stream: ReadableStream<Uint8Array>,
		ctx: AdapterContext,
	): AsyncIterable<CanonicalImageStreamEvent>;
	mapError(err: unknown, ctx: AdapterContext): GatewayError;
}

/** An adapter's canonical audio-transcription handler. */
export interface TranscriptionHandler {
	buildRequest(
		req: CanonicalTranscriptionRequest,
		ctx: AdapterContext,
	):
		| UpstreamHttpRequest<UpstreamBody>
		| Promise<UpstreamHttpRequest<UpstreamBody>>;
	/** `raw` is a JSON object (json/verbose_json) or a raw string (text/srt/vtt). */
	parseResponse(
		raw: unknown,
		ctx: AdapterContext,
	): CanonicalTranscriptionResponse;
	parseStream?(
		stream: ReadableStream<Uint8Array>,
		ctx: AdapterContext,
	): AsyncIterable<CanonicalTranscriptionStreamEvent>;
	mapError(err: unknown, ctx: AdapterContext): GatewayError;
}

/** An adapter's canonical embeddings handler. No streaming. */
export interface EmbeddingsHandler {
	buildRequest(
		req: CanonicalEmbeddingsRequest,
		ctx: AdapterContext,
	): UpstreamHttpRequest;
	parseResponse(raw: unknown, ctx: AdapterContext): CanonicalEmbeddingsResponse;
	mapError(err: unknown, ctx: AdapterContext): GatewayError;
}

/**
 * An adapter implements one or more upstream protocols. It is registered in code.
 *
 * Public endpoints render canonical types per family. Chat feeds Chat, Responses, and Messages;
 * Images has its own binary/event contracts and can travel over OpenAI Images, multimodal
 * chat_completions, or generateContent.
 */
export interface Adapter {
	key: string;
	credentials: {
		required: readonly string[];
	};
	supportedCallTypes: ReadonlySet<CallType>;
	chat?: ChatHandler;
	imageGeneration?: ImageHandler;
	imageEdit?: ImageHandler;
	audioTranscription?: TranscriptionHandler;
	embeddings?: EmbeddingsHandler;
	/** Upstream transports per CallType. */
	transports?: Partial<Record<CallType, AdapterTransports>>;
	/**
	 * Reasoning-control families this adapter can emit to the upstream. Validated at boot against the
	 * catalog: a model with a `reasoning.kind` outside this set fails at startup (it used to fail at
	 * request time). Absent = not validated.
	 */
	reasoningKinds?: ReadonlySet<ReasoningControlKind>;
}

/** A provider as a self-contained upstream-protocol unit. The JSON catalog is mounted in the central registry. */
export interface ProviderModule {
	adapter: Adapter;
}
