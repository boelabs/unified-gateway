import { parseOpenAILiveTranscriptionServerEvent } from "#contracts/openai/liveTranscription.ts";
import { toOpenAILiveTranscriptionClientEvent } from "#contracts/openai/liveTranscription.ts";
import { defaultLiveTranscriptionConfig } from "#contracts/openai/liveTranscription.ts";
import type { CanonicalLiveTranscriptionServerEvent } from "#core/liveTranscription.ts";
import { upstreamWebSocket } from "#gateway/instrumentedTransport.ts";
import { recordUnknownAdapterEvent } from "#adapters/diagnostics.ts";
import { adapterContextDiagnostics } from "#adapters/diagnostics.ts";
import { abortGatewayError } from "#gateway/abortReason.ts";
import { AsyncQueue } from "#core/asyncQueue.ts";
import { GatewayError } from "#core/errors.ts";
import WebSocket, { type RawData } from "ws";

import type {
	LiveTranscriptionSession,
	LiveTranscriptionHandler,
	AdapterContext,
} from "./types.ts";

interface OpenAILiveTranscriptionOptions {
	label: string;
	resolveConnection(ctx: AdapterContext): {
		url: string;
		headers: Record<string, string>;
	};
	mapError(err: unknown, ctx: AdapterContext): GatewayError;
}

export function openAILiveTranscriptionWebSocketUrl(httpUrl: string): string {
	const url = new URL(httpUrl);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	url.pathname = `${url.pathname.replace(/\/+$/, "")}/realtime`;
	url.search = "?intent=transcription";
	url.hash = "";
	return url.toString();
}

export function initialOpenAILiveTranscriptionEvent(
	upstreamModel: string,
): Record<string, unknown> {
	return toOpenAILiveTranscriptionClientEvent(
		{
			kind: "session.update",
			config: defaultLiveTranscriptionConfig(upstreamModel),
		},
		upstreamModel,
	);
}

function textData(data: RawData): string {
	if (typeof data === "string") return data;
	if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
	if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
	return data.toString("utf8");
}

export function makeOpenAILiveTranscriptionHandler(
	options: OpenAILiveTranscriptionOptions,
): LiveTranscriptionHandler {
	return {
		async connect(ctx): Promise<LiveTranscriptionSession> {
			const connection = options.resolveConnection(ctx);
			const socket = upstreamWebSocket(
				ctx,
				openAILiveTranscriptionWebSocketUrl(connection.url),
				{
					headers: connection.headers,
				},
			);
			const queue = new AsyncQueue<CanonicalLiveTranscriptionServerEvent>();
			let current = defaultLiveTranscriptionConfig(ctx.upstreamModel);
			let closed = false;
			const isClosed = () => closed || socket.readyState !== WebSocket.OPEN;
			const mapMessage = (data: RawData, isBinary: boolean) => {
				if (isBinary) {
					queue.fail(
						new GatewayError({
							class: "server",
							code: "upstream_websocket_binary_message",
							message: `${options.label}: Realtime transcription emitted a binary message`,
						}),
					);
					return;
				}
				let raw: Record<string, unknown>;
				try {
					raw = JSON.parse(textData(data)) as Record<string, unknown>;
				} catch (cause) {
					queue.fail(
						new GatewayError({
							class: "server",
							code: "upstream_websocket_invalid_json",
							message: `${options.label}: Realtime transcription emitted invalid JSON`,
							cause,
						}),
					);
					return;
				}
				let event: CanonicalLiveTranscriptionServerEvent | null;
				try {
					event = parseOpenAILiveTranscriptionServerEvent(raw, current);
				} catch (cause) {
					queue.fail(
						new GatewayError({
							class: "server",
							code: "upstream_protocol_error",
							message: `${options.label}: Realtime transcription emitted an invalid event`,
							provider: { body: raw },
							cause,
						}),
					);
					return;
				}
				if (!event) {
					recordUnknownAdapterEvent(
						adapterContextDiagnostics(ctx),
						typeof raw.type === "string" ? raw.type : "missing_type",
					);
					return;
				}
				if (
					event.kind === "session.created" ||
					event.kind === "session.updated"
				)
					current = event.config;
				queue.push(event);
			};
			socket.on("message", mapMessage);
			socket.on("error", (error) => queue.fail(options.mapError(error, ctx)));
			socket.on("close", (code, reason) => {
				closed = true;
				if (code === 1000) queue.end();
				else
					queue.fail(
						new GatewayError({
							class: "server",
							code: "upstream_websocket_closed",
							message: `${options.label}: Realtime transcription closed (${code}: ${reason.toString()})`,
						}),
					);
			});

			await new Promise<void>((resolve, reject) => {
				const cleanup = () => {
					socket.off("open", onOpen);
					socket.off("error", onError);
					ctx.signal?.removeEventListener("abort", onAbort);
				};
				const onOpen = () => {
					cleanup();
					resolve();
				};
				const onError = (error: Error) => {
					cleanup();
					reject(options.mapError(error, ctx));
				};
				const onAbort = () => {
					cleanup();
					socket.terminate();
					reject(abortGatewayError(ctx.signal!, "connect"));
				};
				socket.once("open", onOpen);
				socket.once("error", onError);
				if (ctx.signal?.aborted) onAbort();
				else ctx.signal?.addEventListener("abort", onAbort, { once: true });
			});

			// Pin the upstream deployment before accepting client audio. Providers create
			// a default session on connect, but transcription is not selected until this
			// explicit update. The public client may still replace every other setting.
			try {
				await new Promise<void>((resolve, reject) =>
					socket.send(
						JSON.stringify(
							initialOpenAILiveTranscriptionEvent(ctx.upstreamModel),
						),
						(error) =>
							error ? reject(options.mapError(error, ctx)) : resolve(),
					),
				);
			} catch (error) {
				socket.terminate();
				throw error;
			}

			return {
				get closed() {
					return isClosed();
				},
				events: queue,
				async send(event) {
					if (isClosed())
						throw new GatewayError({
							class: "server",
							code: "upstream_websocket_closed",
							message: `${options.label}: Realtime transcription is closed`,
						});
					if (event.kind === "session.update") current = event.config;
					await new Promise<void>((resolve, reject) =>
						socket.send(
							JSON.stringify(
								toOpenAILiveTranscriptionClientEvent(event, ctx.upstreamModel),
							),
							(error) =>
								error ? reject(options.mapError(error, ctx)) : resolve(),
						),
					);
				},
				close(code = 1000, reason = "gateway session closed") {
					if (socket.readyState === WebSocket.OPEN) socket.close(code, reason);
					else socket.terminate();
				},
			};
		},
		mapError: options.mapError,
	};
}
