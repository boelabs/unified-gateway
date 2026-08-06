import { assertLiveTranscriptionSupported } from "#gateway/liveTranscriptionValidation.ts";
import type { CanonicalLiveTranscriptionConfig } from "#core/liveTranscription.ts";
import { estimateLiveAudioSeconds } from "#core/liveTranscription.ts";
import type { LiveTranscriptionSession } from "#adapters/types.ts";
import { OperationLogDraft } from "./runtime/operationLog.ts";
import { route, type RouteResult } from "#router/index.ts";
import { upgradeWebSocket } from "@hono/node-server";
import { GatewayError } from "#core/errors.ts";
import { getAuth } from "#auth/middleware.ts";
import type { AppEnv } from "#auth/types.ts";
import type { WSContext } from "hono/ws";
import { env } from "#config/env.ts";
import type { Context } from "hono";

import {
	parseOpenAILiveTranscriptionClientEvent,
	toOpenAILiveTranscriptionServerEvent,
	defaultLiveTranscriptionConfig,
} from "#contracts/openai/liveTranscription.ts";

import {
	applyCanonicalRequestExtensions,
	assertFinalModelAllowed,
	usageQuotaForRequest,
	computeUsageCost,
	toGatewayError,
	preflight,
} from "./runtime/pipeline.ts";

interface LiveRouteValue {
	session: LiveTranscriptionSession;
}

interface ActiveLiveTranscription {
	scopeKey: string;
	publicModel: string;
	config: CanonicalLiveTranscriptionConfig;
	socket: WSContext | null;
	abort: AbortController;
	routing: RouteResult<LiveRouteValue> | null;
	connect: Promise<void>;
	queue: Promise<void>;
	queuedClientBytes: number;
	audioSeconds: number;
	firstEventAt: number | null;
	closed: boolean;
	timer: ReturnType<typeof setTimeout>;
	log: OperationLogDraft;
	error: GatewayError | null;
}

const activeLiveTranscriptions = new Set<ActiveLiveTranscription>();

function eventText(value: unknown): string {
	if (typeof value === "string") return value;
	if (value instanceof ArrayBuffer) return Buffer.from(value).toString("utf8");
	if (ArrayBuffer.isView(value))
		return Buffer.from(
			value.buffer,
			value.byteOffset,
			value.byteLength,
		).toString("utf8");
	throw new GatewayError({
		class: "bad_request",
		code: "invalid_websocket_message",
		message: "Realtime transcription messages must be UTF-8 JSON text",
	});
}

function parseJson(value: unknown): unknown {
	const text = eventText(value);
	if (Buffer.byteLength(text) > env.LIVE_TRANSCRIPTION_MAX_EVENT_BYTES)
		throw new GatewayError({
			class: "bad_request",
			code: "websocket_message_too_large",
			message: "Realtime transcription event exceeds the configured size limit",
		});
	try {
		return JSON.parse(text);
	} catch (cause) {
		throw new GatewayError({
			class: "bad_request",
			code: "invalid_websocket_message",
			message: "Realtime transcription message must be valid JSON",
			cause,
		});
	}
}

async function sendJson(ws: WSContext, value: unknown): Promise<void> {
	if (ws.readyState !== 1) return;
	const serialized = JSON.stringify(value);
	ws.send(serialized);
	const raw = ws.raw as { bufferedAmount?: number } | undefined;
	const startedAt = Date.now();
	while (
		(raw?.bufferedAmount ?? 0) > env.LIVE_TRANSCRIPTION_MAX_BUFFERED_BYTES
	) {
		if (Date.now() - startedAt >= 30_000)
			throw new GatewayError({
				class: "server",
				code: "downstream_backpressure",
				message:
					"Realtime transcription client did not drain its receive buffer",
				failureKind: "gateway",
				deploymentHealth: "neutral",
				retryable: false,
			});
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
}

function errorEvent(error: GatewayError): Record<string, unknown> {
	return {
		type: "error",
		error: {
			type: error.class,
			code: error.code ?? error.class,
			message: error.publicMessage,
			param: error.param,
		},
	};
}

async function finishSession(session: ActiveLiveTranscription): Promise<void> {
	if (session.closed) return;
	session.closed = true;
	clearTimeout(session.timer);
	activeLiveTranscriptions.delete(session);
	const usage = {
		promptTokens: 0,
		completionTokens: 0,
		totalTokens: 0,
		inputAudioSeconds: session.audioSeconds,
	};
	const routing = session.routing;
	if (routing) {
		await routing.finish(usage, undefined, session.error, {
			outcome: session.error ? "incomplete" : "completed",
			reason: session.error ? "other" : "stop",
			usage,
		});
		const cost = computeUsageCost(routing.candidate.meta, usage);
		session.log.write({
			status: session.error ? "error" : "success",
			httpStatus: 101,
			usage,
			cost,
			ttftMs:
				session.firstEventAt === null
					? null
					: session.firstEventAt - session.log.startedAt,
			responseBody: { streamed: true, audio_seconds: session.audioSeconds },
			metadata: {
				transport: "websocket",
				terminal: {
					outcome: session.error ? "incomplete" : "completed",
					reason: session.error ? "other" : "stop",
				},
			},
			error: session.error?.toLog() ?? null,
		});
	} else if (session.error) session.log.writeError(session.error);
	else
		session.log.write({
			status: "success",
			httpStatus: 101,
			usage,
			cost: null,
			ttftMs: null,
			responseBody: { streamed: true, audio_seconds: session.audioSeconds },
			metadata: {
				transport: "websocket",
				terminal: { outcome: "completed", reason: "stop" },
			},
			error: null,
		});
}

async function receiveUpstream(
	session: ActiveLiveTranscription,
): Promise<void> {
	const routing = session.routing;
	const ws = session.socket;
	if (!routing || !ws) return;
	try {
		for await (const event of routing.value.session.events) {
			if (session.firstEventAt === null) session.firstEventAt = Date.now();
			session.log.progress();
			if (event.kind === "session.created" || event.kind === "session.updated")
				session.config = { ...event.config, model: session.publicModel };
			await sendJson(
				ws,
				toOpenAILiveTranscriptionServerEvent(event, session.publicModel),
			);
		}
		if (!session.closed) ws.close(1000, "upstream transcription closed");
	} catch (error) {
		const gatewayError = toGatewayError(error);
		session.error = gatewayError;
		await sendJson(ws, errorEvent(gatewayError)).catch(() => undefined);
		ws.close(1011, "upstream transcription closed");
	}
}

async function connectUpstream(
	c: Context<AppEnv>,
	session: ActiveLiveTranscription,
): Promise<void> {
	try {
		await preflight(c, session.publicModel);
		assertFinalModelAllowed(c, session.publicModel);
		session.routing = await route(
			session.publicModel,
			"audio.transcriptions.live",
			{
				clientSignal: session.abort.signal,
				requestId: session.log.requestId,
				operationId: session.log.operationId,
				executionMode: "stream",
				candidateEligibility: (candidate) =>
					assertLiveTranscriptionSupported(session.config, candidate.meta),
				tokenReservation: () => 0,
				usageQuota: usageQuotaForRequest(c, {
					inputAudioSeconds: env.LIVE_TRANSCRIPTION_MAX_SESSION_MS / 1000,
				}),
			},
			async (candidate, ctx) => {
				const handler = candidate.adapter.liveTranscription;
				if (!handler)
					throw new Error(
						`Adapter "${candidate.adapter.key}" does not implement live transcription`,
					);
				return { session: await handler.connect(ctx) };
			},
		);
		session.log.applyRouting(session.routing);
		void receiveUpstream(session);
	} catch (error) {
		const gatewayError = toGatewayError(error);
		session.error = gatewayError;
		if (session.socket) {
			await sendJson(session.socket, errorEvent(gatewayError)).catch(
				() => undefined,
			);
			session.socket.close(1011, "transcription connection failed");
		}
		throw gatewayError;
	}
}

async function handleClientEvent(
	c: Context<AppEnv>,
	session: ActiveLiveTranscription,
	raw: unknown,
): Promise<void> {
	await session.connect;
	const routing = session.routing;
	if (!routing) return;
	let event = parseOpenAILiveTranscriptionClientEvent(
		parseJson(raw),
		session.config,
	);
	if (event.kind === "session.update") {
		if (event.config.model !== session.publicModel)
			throw new GatewayError({
				class: "bad_request",
				code: "model_change_not_allowed",
				message:
					"A live transcription session cannot switch models after routing",
				param: "session.audio.input.transcription.model",
			});
		const transformed = await applyCanonicalRequestExtensions(
			c,
			"audio.transcriptions.live",
			event.config,
		);
		if (transformed.model !== session.publicModel)
			throw new GatewayError({
				class: "bad_request",
				code: "model_change_not_allowed",
				message: "Extensions cannot switch a routed live transcription model",
			});
		assertLiveTranscriptionSupported(transformed, routing.candidate.meta);
		session.config = transformed;
		event = { ...event, config: transformed };
	}
	await routing.value.session.send(event);
	if (event.kind === "audio.append")
		session.audioSeconds += estimateLiveAudioSeconds(
			session.config.format,
			event.audio,
		);
}

export const liveTranscriptionWebSocketHandler = upgradeWebSocket(
	(c) => {
		const publicModel = c.req.query("model")?.trim();
		if (!publicModel)
			throw new GatewayError({
				class: "bad_request",
				code: "missing_model",
				message: "Realtime transcription requires a model query parameter",
				param: "model",
			});
		const intent = c.req.query("intent");
		if (intent !== undefined && intent !== "transcription")
			throw new GatewayError({
				class: "bad_request",
				code: "unsupported_realtime_intent",
				message: 'This endpoint currently supports intent="transcription" only',
				param: "intent",
			});
		const auth = getAuth(c);
		const scopeKey = auth.type === "virtual" ? auth.key.id : "master";
		const scoped = [...activeLiveTranscriptions].filter(
			(active) => active.scopeKey === scopeKey,
		).length;
		if (
			activeLiveTranscriptions.size >= env.LIVE_TRANSCRIPTION_MAX_CONNECTIONS ||
			scoped >= env.LIVE_TRANSCRIPTION_MAX_CONNECTIONS_PER_KEY
		)
			throw new GatewayError({
				class: "rate_limit",
				code: "websocket_connection_limit_exceeded",
				message: "Live transcription connection concurrency limit exceeded",
			});

		const abort = new AbortController();
		const log = new OperationLogDraft(c, "audio.transcriptions.live", {
			publicModel,
		});
		log.requestBody = { model: publicModel, intent: "transcription" };
		const session = {} as ActiveLiveTranscription;
		Object.assign(session, {
			scopeKey,
			publicModel,
			config: defaultLiveTranscriptionConfig(publicModel),
			socket: null,
			abort,
			routing: null,
			queue: Promise.resolve(),
			queuedClientBytes: 0,
			audioSeconds: 0,
			firstEventAt: null,
			closed: false,
			log,
			error: null,
			timer: setTimeout(() => undefined, env.LIVE_TRANSCRIPTION_MAX_SESSION_MS),
		});
		clearTimeout(session.timer);
		session.connect = Promise.resolve();
		session.timer = setTimeout(() => {
			session.error = new GatewayError({
				class: "bad_request",
				code: "websocket_connection_limit_reached",
				message: "Live transcription session reached its duration limit",
			});
			session.socket?.close(1000, "session duration limit");
		}, env.LIVE_TRANSCRIPTION_MAX_SESSION_MS);
		activeLiveTranscriptions.add(session);

		return {
			onOpen(_event, ws) {
				session.socket = ws;
				session.connect = connectUpstream(c, session);
				session.connect.catch(() => undefined);
			},
			onMessage(event) {
				const ws = session.socket;
				if (!ws) return;
				let bytes: number;
				try {
					bytes = Buffer.byteLength(eventText(event.data));
				} catch (error) {
					const gatewayError = toGatewayError(error);
					void sendJson(ws, errorEvent(gatewayError));
					return;
				}
				if (bytes > env.LIVE_TRANSCRIPTION_MAX_EVENT_BYTES) {
					const gatewayError = new GatewayError({
						class: "bad_request",
						code: "websocket_message_too_large",
						message:
							"Realtime transcription event exceeds the configured size limit",
					});
					session.error = gatewayError;
					void sendJson(ws, errorEvent(gatewayError)).finally(() =>
						ws.close(1009, "transcription event too large"),
					);
					return;
				}
				session.queuedClientBytes += bytes;
				if (
					session.queuedClientBytes > env.LIVE_TRANSCRIPTION_MAX_QUEUED_BYTES
				) {
					const gatewayError = new GatewayError({
						class: "rate_limit",
						code: "websocket_queue_limit_exceeded",
						message: "Realtime transcription client event queue is full",
					});
					session.error = gatewayError;
					void sendJson(ws, errorEvent(gatewayError)).finally(() =>
						ws.close(1009, "transcription event queue full"),
					);
					return;
				}
				session.queue = session.queue
					.then(() => handleClientEvent(c, session, event.data))
					.catch(async (error) => {
						const gatewayError = toGatewayError(error);
						if (session.socket)
							await sendJson(session.socket, errorEvent(gatewayError)).catch(
								() => undefined,
							);
						if (gatewayError.class !== "bad_request") {
							session.error = gatewayError;
							session.routing?.value.session.close(
								1011,
								"transcription event forwarding failed",
							);
							session.socket?.close(
								1011,
								"transcription event forwarding failed",
							);
						}
					})
					.finally(() => {
						session.queuedClientBytes = Math.max(
							0,
							session.queuedClientBytes - bytes,
						);
					});
			},
			onClose() {
				abort.abort({ owner: "client", type: "cancelled" });
				session.routing?.value.session.close();
				void session.connect
					.catch(() => undefined)
					.finally(() => finishSession(session));
			},
			onError() {
				abort.abort({ owner: "client", type: "cancelled" });
				session.routing?.value.session.close();
				void session.connect
					.catch(() => undefined)
					.finally(() => finishSession(session));
			},
		};
	},
	{
		onError(error) {
			throw error;
		},
	},
);

export function closeLiveTranscriptionWebSockets(): void {
	for (const session of activeLiveTranscriptions) {
		session.error = new GatewayError({
			class: "server",
			code: "service_restarting",
			message: "Service is restarting",
		});
		session.abort.abort({ owner: "gateway", type: "shutdown" });
		session.routing?.value.session.close(1012, "service restarting");
		session.socket?.close(1012, "service restarting");
		void finishSession(session);
	}
}
