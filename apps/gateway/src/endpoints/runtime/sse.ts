import { GatewayError } from "#core/errors.ts";

import {
	type OperationChildTelemetrySpan,
	finishOperationChildTelemetry,
	startOperationChildTelemetry,
} from "#telemetry/index.ts";

interface SSEMessage {
	data: string;
	event?: string;
	id?: string;
	retry?: number;
}

interface SSEWriter {
	write(value: string): Promise<unknown>;
	writeSSE(message: SSEMessage): Promise<unknown>;
}

export interface DownstreamWriteObservation {
	totalBlockedMs: number;
	maxBlockedMs: number;
	bytes: number;
}

const renderSpans = new WeakMap<
	DownstreamWriteObservation,
	OperationChildTelemetrySpan
>();

export function newDownstreamWriteObservation(
	operationId?: string,
): DownstreamWriteObservation {
	const observation = { totalBlockedMs: 0, maxBlockedMs: 0, bytes: 0 };
	if (operationId)
		renderSpans.set(
			observation,
			startOperationChildTelemetry(operationId, "render"),
		);
	return observation;
}

export function finishDownstreamWriteObservation(
	observation: DownstreamWriteObservation,
	errorCode?: string | null,
): void {
	const span = renderSpans.get(observation);
	if (!span) return;
	finishOperationChildTelemetry(span, errorCode);
	renderSpans.delete(observation);
}

const WRITE_DEADLINE_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 10_000;

function backpressureError(): GatewayError {
	return new GatewayError({
		class: "server",
		code: "downstream_backpressure",
		message: "Client response write exceeded the downstream deadline",
		failureKind: "gateway",
		deploymentHealth: "neutral",
		retryable: false,
	});
}

async function beforeDeadline(
	write: Promise<unknown>,
	observation?: DownstreamWriteObservation,
	bytes = 0,
): Promise<void> {
	const startedAt = Date.now();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			write,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(backpressureError()),
					WRITE_DEADLINE_MS,
				);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
		if (observation) {
			observation.bytes += bytes;
			const blockedMs = Date.now() - startedAt;
			observation.totalBlockedMs += blockedMs;
			observation.maxBlockedMs = Math.max(observation.maxBlockedMs, blockedMs);
		}
	}
}

export function writeSSE(
	stream: SSEWriter,
	message: SSEMessage,
	observation?: DownstreamWriteObservation,
): Promise<void> {
	const bytes = Buffer.byteLength(
		`${message.event ? `event: ${message.event}\n` : ""}${message.id ? `id: ${message.id}\n` : ""}${message.retry !== undefined ? `retry: ${message.retry}\n` : ""}${message.data
			.split("\n")
			.map((line) => `data: ${line}\n`)
			.join("")}\n`,
	);
	return beforeDeadline(stream.writeSSE(message), observation, bytes);
}

export function writeSSEHeartbeat(
	stream: SSEWriter,
	observation?: DownstreamWriteObservation,
): Promise<void> {
	return beforeDeadline(stream.write(": keepalive\n\n"), observation, 13);
}

/** Adds transport heartbeats without treating them as upstream/model progress. */
export async function* withSSEHeartbeats<T>(
	items: AsyncIterable<T>,
	heartbeat: () => Promise<void>,
): AsyncIterable<T> {
	const iterator = items[Symbol.asyncIterator]();
	let pending = iterator.next();
	try {
		while (true) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const result = await Promise.race([
				pending.then((item) => ({ kind: "item" as const, item })),
				new Promise<{ kind: "heartbeat" }>((resolve) => {
					timer = setTimeout(
						() => resolve({ kind: "heartbeat" }),
						HEARTBEAT_INTERVAL_MS,
					);
				}),
			]);
			if (timer) clearTimeout(timer);
			if (result.kind === "heartbeat") {
				await heartbeat();
				continue;
			}
			if (result.item.done) return;
			pending = iterator.next();
			yield result.item.value;
		}
	} finally {
		await iterator.return?.();
	}
}
