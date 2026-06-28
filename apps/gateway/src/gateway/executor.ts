import { assertTextRequestSupported } from "./textRequestValidation.ts";
import { imageProfileFor } from "#catalog/types.ts";
import type { GatewayError } from "#core/errors.ts";

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

import type {
	UpstreamHttpRequest,
	AdapterContext,
	Adapter,
} from "#adapters/types.ts";

export type ChatExecResult =
	| { kind: "json"; response: CanonicalChatResponse }
	| { kind: "stream"; chunks: AsyncIterable<CanonicalChatStreamChunk> };

export type ImageExecResult =
	| { kind: "json"; response: CanonicalImageResponse }
	| { kind: "stream"; events: AsyncIterable<CanonicalImageStreamEvent> };

export type TranscriptionExecResult =
	| { kind: "json"; response: CanonicalTranscriptionResponse }
	| {
			kind: "stream";
			events: AsyncIterable<CanonicalTranscriptionStreamEvent>;
	  };

export type EmbeddingsExecResult = {
	kind: "json";
	response: CanonicalEmbeddingsResponse;
};

async function parseBody(res: Response): Promise<unknown> {
	const text = await res.text();
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

/** A handler's error mapper: turns a network error or a non-2xx upstream response into a GatewayError. */
type MapError = (err: unknown, ctx: AdapterContext) => GatewayError;

/**
 * Performs the upstream fetch shared by every operation: dispatches the request, maps network errors
 * and non-2xx responses to GatewayError via the handler's `mapError`, and returns the raw 2xx
 * Response for the caller to parse (JSON or stream).
 */
async function dispatch(
	httpReq: UpstreamHttpRequest<NonNullable<RequestInit["body"]>>,
	ctx: AdapterContext,
	mapError: MapError,
): Promise<Response> {
	let res: Response;
	try {
		res = await fetch(httpReq.url, {
			method: httpReq.method,
			headers: httpReq.headers,
			...(httpReq.body !== undefined ? { body: httpReq.body } : {}),
			...(ctx.signal ? { signal: ctx.signal } : {}),
		});
	} catch (err) {
		throw mapError(err, ctx);
	}

	if (!res.ok) {
		throw mapError({ status: res.status, body: await parseBody(res) }, ctx);
	}
	return res;
}

/** Asserts a streaming upstream actually returned a body, mapping the empty case to GatewayError. */
function requireStreamBody(
	res: Response,
	ctx: AdapterContext,
	mapError: MapError,
): ReadableStream<Uint8Array> {
	if (!res.body) {
		throw mapError(
			{ status: 502, body: "upstream returned an empty stream" },
			ctx,
		);
	}
	return res.body;
}

/**
 * Executes a chat call against the adapter's upstream: builds the request, performs the fetch and
 * normalizes the response (json or stream). Any failure is translated to GatewayError via
 * adapter.chat.mapError (network, timeout, or non-2xx status).
 */
export async function executeChat(
	adapter: Adapter,
	req: CanonicalChatRequest,
	ctx: AdapterContext,
): Promise<ChatExecResult> {
	const handler = adapter.chat;
	if (!handler) {
		// Should not happen: the resolver already validates the handler.
		throw new Error(`Adapter "${adapter.key}" does not implement chat`);
	}

	// buildRequest can throw GatewayError (missing creds, unsupported content).
	assertTextRequestSupported(req, ctx.meta);
	const res = await dispatch(
		handler.buildRequest(req, ctx),
		ctx,
		handler.mapError,
	);

	if (req.stream) {
		const body = requireStreamBody(res, ctx, handler.mapError);
		return { kind: "stream", chunks: handler.parseStream(body, ctx) };
	}

	return {
		kind: "json",
		response: handler.parseResponse(await parseBody(res), ctx),
	};
}

/** Executes an image generation/edit and normalizes JSON or SSE events. */
export async function executeImage(
	adapter: Adapter,
	req: CanonicalImageRequest,
	ctx: AdapterContext,
): Promise<ImageExecResult> {
	const handler =
		req.operation === "generation"
			? adapter.imageGeneration
			: adapter.imageEdit;
	if (!handler)
		throw new Error(
			`Adapter "${adapter.key}" does not implement images.${req.operation}`,
		);

	const res = await dispatch(
		await handler.buildRequest(req, ctx),
		ctx,
		handler.mapError,
	);

	if (
		req.stream &&
		imageProfileFor(ctx.meta, req.operation)?.supportsNativeStreaming &&
		handler.parseStream
	) {
		const body = requireStreamBody(res, ctx, handler.mapError);
		return { kind: "stream", events: handler.parseStream(body, ctx) };
	}
	return {
		kind: "json",
		response: await handler.parseResponse(await parseBody(res), ctx),
	};
}

/**
 * Executes an audio transcription: builds the multipart, performs the fetch and normalizes the
 * response. For `text`/`srt`/`vtt` formats the upstream returns plain text; `parseBody` leaves it as
 * a string and the handler wraps it in `{ text }`.
 */
export async function executeTranscription(
	adapter: Adapter,
	req: CanonicalTranscriptionRequest,
	ctx: AdapterContext,
): Promise<TranscriptionExecResult> {
	const handler = adapter.audioTranscription;
	if (!handler)
		throw new Error(
			`Adapter "${adapter.key}" does not implement audio.transcriptions`,
		);

	const res = await dispatch(
		await handler.buildRequest(req, ctx),
		ctx,
		handler.mapError,
	);

	if (req.stream && handler.parseStream) {
		const body = requireStreamBody(res, ctx, handler.mapError);
		return { kind: "stream", events: handler.parseStream(body, ctx) };
	}
	return {
		kind: "json",
		response: handler.parseResponse(await parseBody(res), ctx),
	};
}

/** Executes an embeddings call and normalizes the JSON response. */
export async function executeEmbeddings(
	adapter: Adapter,
	req: CanonicalEmbeddingsRequest,
	ctx: AdapterContext,
): Promise<EmbeddingsExecResult> {
	const handler = adapter.embeddings;
	if (!handler)
		throw new Error(`Adapter "${adapter.key}" does not implement embeddings`);

	const res = await dispatch(
		handler.buildRequest(req, ctx),
		ctx,
		handler.mapError,
	);

	return {
		kind: "json",
		response: handler.parseResponse(await parseBody(res), ctx),
	};
}
