import { assertImageRequestSupported } from "#gateway/imageRequestValidation.ts";
import { executeImage, type ImageExecResult } from "#gateway/executor.ts";
import { candidateMetadata } from "#gateway/candidateMetadata.ts";
import { parseImageEditMultipart } from "#images/multipart.ts";
import { route, type RouteResult } from "#router/index.ts";
import { RequestLogDraft } from "./runtime/requestLog.ts";
import { imageResponseLog } from "#images/logging.ts";
import { imageProfileFor } from "#catalog/types.ts";
import { imageUsageToCore } from "#core/images.ts";
import { GatewayError } from "#core/errors.ts";
import type { AppEnv } from "#auth/types.ts";
import { streamSSE } from "hono/streaming";
import type { Context } from "hono";

import {
	applyCanonicalResponseExtensions,
	applyCanonicalRequestExtensions,
	applyStreamEventExtensions,
	applyImageOutputExtensions,
	notifyExtensionError,
	toGatewayError,
	extensionScope,
	accountUsage,
	readJsonBody,
	parseBody,
	preflight,
} from "./runtime/pipeline.ts";

import {
	imageGenerationRequestSchema,
	toOpenAIImagesResponse,
	generationToCanonical,
	toOpenAIImageEvent,
	editToCanonical,
} from "#contracts/openai/images.ts";

import type {
	CanonicalImageStreamEvent,
	CanonicalImageRequest,
} from "#core/images.ts";

import {
	transformImageResponse,
	transformImageEvent,
} from "#images/transform.ts";

type Cleanup = () => Promise<void>;

async function handleImageRequest(
	c: Context<AppEnv>,
	inputReq: CanonicalImageRequest,
	requestBody: unknown,
	cleanup?: Cleanup,
): Promise<Response> {
	let req = inputReq;
	const callType =
		req.operation === "generation"
			? ("images.generations" as const)
			: ("images.edits" as const);
	const log = new RequestLogDraft(c, callType, { publicModel: req.model });
	log.requestBody = requestBody;

	let routing: RouteResult<ImageExecResult> | null = null;
	let finished = false;
	let cleanupDeferred = false;

	const finish = async (
		usage: ReturnType<typeof imageUsageToCore>,
	): Promise<void> => {
		if (!routing || finished) return;
		finished = true;
		await routing.finish(usage);
	};

	try {
		req = await applyCanonicalRequestExtensions(c, callType, req);
		log.publicModel = req.model;
		await preflight(c, req.model);

		routing = await route(
			req.model,
			callType,
			{
				clientSignal: c.req.raw.signal,
				requestId: log.requestId,
				candidateEligibility: (candidate) =>
					assertImageRequestSupported(req, candidate.meta),
			},
			(candidate, ctx) => executeImage(candidate.adapter, req, ctx),
		);
		log.applyRouting(routing);
		const metadata = candidateMetadata(routing.candidate);
		const imageScope = extensionScope(c, callType, req.model);
		const imageHooks = {
			applyImageOutput: (
				output: Parameters<typeof applyImageOutputExtensions>[1],
			) => applyImageOutputExtensions(imageScope, output),
		};

		if (routing.value.kind === "json") {
			log.upstreamTtftMs = Date.now() - routing.upstreamStartedAt;
			const transformedResponse = await transformImageResponse(
				await applyCanonicalResponseExtensions(
					c,
					callType,
					req.model,
					routing.value.response,
				),
				req,
				imageProfileFor(routing.candidate.meta, req.operation),
				imageHooks,
			);
			const response = transformedResponse;
			const usage = imageUsageToCore(response.usage);
			await finish(usage);
			const cost = accountUsage(c, routing.candidate.meta, usage);

			if (!req.stream) {
				await cleanup?.();
				log.write({
					status: "success",
					httpStatus: 200,
					usage,
					cost,
					ttftMs: log.elapsedMs(),
					responseBody: imageResponseLog(response),
					metadata,
					error: null,
				});
				return c.json(toOpenAIImagesResponse(response));
			}

			if (response.data.length !== 1) {
				throw new GatewayError({
					class: "server",
					message: `Non-streaming image upstream returned ${response.data.length} outputs for a streaming request; expected exactly one`,
				});
			}
			const completedImage = response.data[0];
			if (!completedImage) {
				throw new GatewayError({
					class: "server",
					message: "Image upstream returned no output",
				});
			}
			cleanupDeferred = true;
			return streamSSE(c, async (stream) => {
				let streamError: GatewayError | null = null;
				try {
					const event: CanonicalImageStreamEvent = {
						kind: "completed",
						operation: req.operation,
						image: completedImage,
						createdAt: response.created,
						...(response.background ? { background: response.background } : {}),
						...(response.outputFormat
							? { outputFormat: response.outputFormat }
							: {}),
						...(response.quality ? { quality: response.quality } : {}),
						...(response.size ? { size: response.size } : {}),
						...(response.usage ? { usage: response.usage } : {}),
					};
					const transformed = await applyStreamEventExtensions(
						c,
						callType,
						req.model,
						event,
					);
					await stream.writeSSE({
						data: JSON.stringify(toOpenAIImageEvent(transformed)),
					});
				} catch (error) {
					streamError = GatewayError.is(error)
						? error
						: new GatewayError({
								class: "server",
								message: "Image stream failed",
								cause: error,
							});
					await notifyExtensionError(c, callType, req.model, streamError);
					await stream.writeSSE({
						data: JSON.stringify(streamError.toOpenAI()),
					});
				} finally {
					await cleanup?.();
					log.write({
						status: streamError ? "error" : "success",
						httpStatus: 200,
						usage,
						cost,
						ttftMs: log.elapsedMs(),
						responseBody: imageResponseLog(response),
						metadata,
						error: streamError?.toLog() ?? null,
					});
				}
			});
		}

		const streamRouting = routing;
		const nativeValue = streamRouting.value;
		if (nativeValue.kind !== "stream") {
			throw new GatewayError({
				class: "server",
				message: "Invalid native image stream result",
			});
		}
		const nativeEvents = nativeValue.events;
		cleanupDeferred = true;
		return streamSSE(c, async (stream) => {
			let usage: ReturnType<typeof imageUsageToCore> = null;
			let count = 0;
			let firstAt: number | null = null;
			let streamError: GatewayError | null = null;
			try {
				for await (const rawEvent of nativeEvents) {
					const canonicalEvent = await applyStreamEventExtensions(
						c,
						callType,
						req.model,
						rawEvent,
					);
					const event = await transformImageEvent(
						canonicalEvent,
						req,
						imageProfileFor(streamRouting.candidate.meta, req.operation),
						imageHooks,
					);
					if (firstAt === null) {
						firstAt = Date.now();
						log.upstreamTtftMs = firstAt - streamRouting.upstreamStartedAt;
					}
					if (event.kind === "completed" && event.usage)
						usage = imageUsageToCore(event.usage);
					count += 1;
					await stream.writeSSE({
						data: JSON.stringify(toOpenAIImageEvent(event)),
					});
				}
			} catch (error) {
				streamError = GatewayError.is(error)
					? error
					: new GatewayError({
							class: "server",
							message: "Image stream failed",
							cause: error,
						});
				await notifyExtensionError(c, callType, req.model, streamError);
				await stream.writeSSE({ data: JSON.stringify(streamError.toOpenAI()) });
			} finally {
				await finish(usage);
				const cost = accountUsage(c, streamRouting.candidate.meta, usage);
				await cleanup?.();
				log.write({
					status: streamError ? "error" : "success",
					httpStatus: 200,
					usage,
					cost,
					ttftMs: firstAt ? firstAt - log.startedAt : null,
					responseBody: { streamed: true, events: count },
					metadata,
					error: streamError?.toLog() ?? null,
				});
			}
		});
	} catch (error) {
		const ge = toGatewayError(error);
		log.applyFailedAttempts(ge.attempts);
		await finish(null);
		await notifyExtensionError(c, callType, log.publicModel, ge);
		if (!cleanupDeferred) await cleanup?.();
		log.writeError(ge);
		throw ge;
	}
}

export async function imageGenerationsHandler(
	c: Context<AppEnv>,
): Promise<Response> {
	const json = await readJsonBody(c);
	const data = parseBody(imageGenerationRequestSchema, json);
	return handleImageRequest(c, generationToCanonical(data), data);
}

export async function imageEditsHandler(c: Context<AppEnv>): Promise<Response> {
	const multipart = await parseImageEditMultipart(c.req.raw);
	return handleImageRequest(
		c,
		editToCanonical(multipart.fields, multipart.images, multipart.mask),
		multipart.logBody,
		multipart.cleanup,
	);
}
