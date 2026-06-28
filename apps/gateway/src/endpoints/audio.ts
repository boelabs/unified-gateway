import { assertTranscriptionRequestSupported } from "#gateway/transcriptionRequestValidation.ts";
import { parseTranscriptionMultipart } from "#audio/multipart.ts";
import { candidateMetadata } from "#gateway/candidateMetadata.ts";
import { route, type RouteResult } from "#router/index.ts";
import { RequestLogDraft } from "./runtime/requestLog.ts";
import { GatewayError } from "#core/errors.ts";
import type { AppEnv } from "#auth/types.ts";
import { streamSSE } from "hono/streaming";
import type { Context } from "hono";

import {
	applyCanonicalResponseExtensions,
	applyCanonicalRequestExtensions,
	applyStreamEventExtensions,
	notifyExtensionError,
	toGatewayError,
	accountUsage,
	preflight,
} from "./runtime/pipeline.ts";

import {
	type CanonicalTranscriptionRequest,
	TEXT_TRANSCRIPTION_FORMATS,
	transcriptionUsageToCore,
	type TranscriptionUsage,
} from "#core/audio.ts";

import {
	toOpenAITranscriptionResponse,
	toOpenAITranscriptionEvent,
	transcriptionToCanonical,
} from "#contracts/openai/audio.ts";

import {
	type TranscriptionExecResult,
	executeTranscription,
} from "#gateway/executor.ts";

type Cleanup = () => Promise<void>;

function responseLog(
	format: CanonicalTranscriptionRequest["responseFormat"],
	text: string,
): Record<string, unknown> {
	return TEXT_TRANSCRIPTION_FORMATS.includes(format)
		? { format, chars: text.length }
		: { format, text };
}

async function handleTranscription(
	c: Context<AppEnv>,
	inputReq: CanonicalTranscriptionRequest,
	requestBody: unknown,
	cleanup: Cleanup,
): Promise<Response> {
	let req = inputReq;
	const log = new RequestLogDraft(c, "audio.transcriptions", {
		publicModel: req.model,
	});
	log.requestBody = requestBody;

	let routing: RouteResult<TranscriptionExecResult> | null = null;
	let finished = false;
	let cleanupDeferred = false;

	const finish = async (
		usage: ReturnType<typeof transcriptionUsageToCore>,
	): Promise<void> => {
		if (!routing || finished) return;
		finished = true;
		await routing.finish(usage);
	};

	try {
		req = await applyCanonicalRequestExtensions(c, "audio.transcriptions", req);
		log.publicModel = req.model;
		await preflight(c, req.model);

		routing = await route(
			req.model,
			"audio.transcriptions",
			{
				clientSignal: c.req.raw.signal,
				requestId: log.requestId,
				candidateEligibility: (candidate) =>
					assertTranscriptionRequestSupported(req, candidate.meta),
			},
			(candidate, ctx) => executeTranscription(candidate.adapter, req, ctx),
		);
		log.applyRouting(routing);
		const meta = routing.candidate.meta;
		const metadata = candidateMetadata(routing.candidate);

		if (routing.value.kind === "json") {
			log.upstreamTtftMs = Date.now() - routing.upstreamStartedAt;
			const response = await applyCanonicalResponseExtensions(
				c,
				"audio.transcriptions",
				req.model,
				routing.value.response,
			);
			const core = transcriptionUsageToCore(response.usage);
			const cost = accountUsage(c, meta, core);
			await finish(core);
			await cleanup();
			log.write({
				status: "success",
				httpStatus: 200,
				usage: core,
				cost,
				ttftMs: log.elapsedMs(),
				responseBody: responseLog(req.responseFormat, response.text),
				metadata,
				error: null,
			});
			const rendered = toOpenAITranscriptionResponse(
				response,
				req.responseFormat,
			);
			return typeof rendered === "string" ? c.text(rendered) : c.json(rendered);
		}

		const streamRouting = routing;
		const events = routing.value.events;
		cleanupDeferred = true;
		return streamSSE(c, async (stream) => {
			let usage: TranscriptionUsage | undefined;
			let firstAt: number | null = null;
			let streamError: GatewayError | null = null;
			try {
				for await (const event of events) {
					const transformed = await applyStreamEventExtensions(
						c,
						"audio.transcriptions",
						req.model,
						event,
					);
					if (firstAt === null) {
						firstAt = Date.now();
						log.upstreamTtftMs = firstAt - streamRouting.upstreamStartedAt;
					}
					if (transformed.kind === "done" && transformed.usage)
						usage = transformed.usage;
					await stream.writeSSE({
						data: JSON.stringify(toOpenAITranscriptionEvent(transformed)),
					});
				}
			} catch (error) {
				streamError = GatewayError.is(error)
					? error
					: new GatewayError({
							class: "server",
							message: "Transcription stream failed",
							cause: error,
						});
				await notifyExtensionError(
					c,
					"audio.transcriptions",
					req.model,
					streamError,
				);
				await stream.writeSSE({ data: JSON.stringify(streamError.toOpenAI()) });
			} finally {
				const core = transcriptionUsageToCore(usage);
				const cost = accountUsage(c, streamRouting.candidate.meta, core);
				await finish(core);
				await cleanup();
				log.write({
					status: streamError ? "error" : "success",
					httpStatus: 200,
					usage: core,
					cost,
					ttftMs: firstAt ? firstAt - log.startedAt : null,
					responseBody: { streamed: true },
					metadata,
					error: streamError?.toLog() ?? null,
				});
			}
		});
	} catch (error) {
		const ge = toGatewayError(error);
		log.applyFailedAttempts(ge.attempts);
		await finish(null);
		await notifyExtensionError(c, "audio.transcriptions", log.publicModel, ge);
		if (!cleanupDeferred) await cleanup();
		log.writeError(ge);
		throw ge;
	}
}

export async function transcriptionsHandler(
	c: Context<AppEnv>,
): Promise<Response> {
	const multipart = await parseTranscriptionMultipart(c.req.raw);
	return handleTranscription(
		c,
		transcriptionToCanonical(multipart.fields, multipart.file),
		multipart.logBody,
		multipart.cleanup,
	);
}
