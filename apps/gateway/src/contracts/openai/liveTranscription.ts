import { GatewayError } from "#core/errors.ts";

import type {
	CanonicalLiveTranscriptionServerEvent,
	CanonicalLiveTranscriptionClientEvent,
	CanonicalLiveTranscriptionConfig,
	LiveTranscriptionDelay,
	LiveAudioFormat,
} from "#core/liveTranscription.ts";

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function invalid(message: string, param: string | null = null): never {
	throw new GatewayError({
		class: "bad_request",
		code: "invalid_realtime_event",
		message,
		param,
	});
}

function parseFormat(raw: unknown, fallback: LiveAudioFormat): LiveAudioFormat {
	const value = record(raw);
	if (value.type === "audio/pcm") {
		if (!Number.isSafeInteger(value.rate) || (value.rate as number) <= 0)
			invalid(
				"audio.input.format.rate must be a positive integer",
				"session.audio.input.format.rate",
			);
		return { type: "audio/pcm", rate: value.rate as number };
	}
	if (value.type === "audio/pcmu") return { type: "audio/pcmu" };
	if (value.type === "audio/pcma") return { type: "audio/pcma" };
	return Object.keys(value).length === 0
		? fallback
		: invalid(
				"Unsupported input audio format",
				"session.audio.input.format.type",
			);
}

function stringArray(value: unknown, param: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (
		!Array.isArray(value) ||
		value.some((item) => typeof item !== "string" || item.length === 0)
	)
		invalid(`${param} must be an array of non-empty strings`, param);
	return value as string[];
}

function optionalVadNumber(
	value: unknown,
	param: string,
	options: { maximum?: number; integer?: boolean } = {},
): number | undefined {
	if (value === undefined) return undefined;
	if (
		typeof value !== "number" ||
		!Number.isFinite(value) ||
		value < 0 ||
		(options.maximum !== undefined && value > options.maximum) ||
		(options.integer === true && !Number.isInteger(value))
	)
		invalid(`Invalid ${param}`, param);
	return value;
}

function parseNoiseReduction(
	raw: unknown,
	previous: CanonicalLiveTranscriptionConfig["noiseReduction"],
): CanonicalLiveTranscriptionConfig["noiseReduction"] {
	if (raw === undefined) return previous;
	if (raw === null) return null;
	const value = record(raw);
	if (value.type === "near_field" || value.type === "far_field")
		return { type: value.type };
	return invalid(
		'noise_reduction.type must be "near_field" or "far_field"',
		"session.audio.input.noise_reduction.type",
	);
}

function parseConfig(
	raw: unknown,
	previous: CanonicalLiveTranscriptionConfig,
): CanonicalLiveTranscriptionConfig {
	const session = record(raw);
	if (session.type !== undefined && session.type !== "transcription")
		invalid('session.type must be "transcription"', "session.type");
	const input = record(record(session.audio).input);
	const transcription = record(input.transcription);
	const languages = stringArray(
		transcription.languages,
		"session.audio.input.transcription.languages",
	);
	const keywords = stringArray(
		transcription.keywords,
		"session.audio.input.transcription.keywords",
	);
	const include = stringArray(session.include, "session.include");
	const turn = input.turn_detection;
	let turnDetection = previous.turnDetection;
	if (turn === null) turnDetection = null;
	else if (turn !== undefined) {
		const value = record(turn);
		if (value.type !== "server_vad")
			invalid(
				'turn_detection.type must be "server_vad"',
				"session.audio.input.turn_detection.type",
			);
		const threshold = optionalVadNumber(
			value.threshold,
			"session.audio.input.turn_detection.threshold",
			{ maximum: 1 },
		);
		const prefixPaddingMs = optionalVadNumber(
			value.prefix_padding_ms,
			"session.audio.input.turn_detection.prefix_padding_ms",
			{ integer: true },
		);
		const silenceDurationMs = optionalVadNumber(
			value.silence_duration_ms,
			"session.audio.input.turn_detection.silence_duration_ms",
			{ integer: true },
		);
		turnDetection = {
			type: "server_vad",
			...(threshold !== undefined ? { threshold } : {}),
			...(prefixPaddingMs !== undefined ? { prefixPaddingMs } : {}),
			...(silenceDurationMs !== undefined ? { silenceDurationMs } : {}),
		};
	}
	const delay = transcription.delay;
	const allowedDelays: LiveTranscriptionDelay[] = [
		"minimal",
		"low",
		"medium",
		"high",
		"xhigh",
	];
	if (
		delay !== undefined &&
		!allowedDelays.includes(delay as LiveTranscriptionDelay)
	)
		invalid(
			"Unsupported transcription delay",
			"session.audio.input.transcription.delay",
		);
	const noiseReduction = parseNoiseReduction(
		input.noise_reduction,
		previous.noiseReduction,
	);
	return {
		model:
			typeof transcription.model === "string"
				? transcription.model
				: previous.model,
		format: parseFormat(input.format, previous.format),
		...(noiseReduction !== undefined ? { noiseReduction } : {}),
		turnDetection,
		...(typeof transcription.prompt === "string"
			? { prompt: transcription.prompt }
			: previous.prompt !== undefined
				? { prompt: previous.prompt }
				: {}),
		...(typeof transcription.language === "string"
			? { language: transcription.language }
			: previous.language !== undefined
				? { language: previous.language }
				: {}),
		...((languages ?? previous.languages)
			? {
					languages: languages ?? previous.languages,
				}
			: {}),
		...((keywords ?? previous.keywords)
			? {
					keywords: keywords ?? previous.keywords,
				}
			: {}),
		...(delay !== undefined
			? { delay: delay as LiveTranscriptionDelay }
			: previous.delay !== undefined
				? { delay: previous.delay }
				: {}),
		...((include ?? previous.include)
			? {
					include: include ?? previous.include,
				}
			: {}),
	};
}

export function defaultLiveTranscriptionConfig(
	model: string,
): CanonicalLiveTranscriptionConfig {
	return {
		model,
		format: { type: "audio/pcm", rate: 24_000 },
		turnDetection: null,
	};
}

export function parseOpenAILiveTranscriptionClientEvent(
	raw: unknown,
	previous: CanonicalLiveTranscriptionConfig,
): CanonicalLiveTranscriptionClientEvent {
	const value = record(raw);
	const type = value.type;
	const eventId =
		typeof value.event_id === "string" ? value.event_id : undefined;
	if (type === "session.update")
		return {
			kind: "session.update",
			...(eventId ? { eventId } : {}),
			config: parseConfig(value.session, previous),
		};
	if (type === "input_audio_buffer.append") {
		if (typeof value.audio !== "string" || value.audio.length === 0)
			invalid("audio must be a non-empty base64 string", "audio");
		if (
			value.audio.length % 4 !== 0 ||
			!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
				value.audio,
			)
		)
			invalid("audio must be valid base64", "audio");
		return {
			kind: "audio.append",
			...(eventId ? { eventId } : {}),
			audio: value.audio,
		};
	}
	if (type === "input_audio_buffer.commit")
		return { kind: "audio.commit", ...(eventId ? { eventId } : {}) };
	if (type === "input_audio_buffer.clear")
		return { kind: "audio.clear", ...(eventId ? { eventId } : {}) };
	invalid(`Unsupported Realtime transcription event: ${String(type)}`, "type");
}

function renderConfig(
	config: CanonicalLiveTranscriptionConfig,
	model: string,
): Record<string, unknown> {
	return {
		type: "transcription",
		...(config.include ? { include: config.include } : {}),
		audio: {
			input: {
				format: config.format,
				...(config.noiseReduction !== undefined
					? { noise_reduction: config.noiseReduction }
					: {}),
				transcription: {
					model,
					...(config.prompt !== undefined ? { prompt: config.prompt } : {}),
					...(config.language !== undefined
						? { language: config.language }
						: {}),
					...(config.languages !== undefined
						? { languages: config.languages }
						: {}),
					...(config.keywords !== undefined
						? { keywords: config.keywords }
						: {}),
					...(config.delay !== undefined ? { delay: config.delay } : {}),
				},
				turn_detection:
					config.turnDetection === null
						? null
						: {
								type: "server_vad",
								...(config.turnDetection.threshold !== undefined
									? { threshold: config.turnDetection.threshold }
									: {}),
								...(config.turnDetection.prefixPaddingMs !== undefined
									? { prefix_padding_ms: config.turnDetection.prefixPaddingMs }
									: {}),
								...(config.turnDetection.silenceDurationMs !== undefined
									? {
											silence_duration_ms:
												config.turnDetection.silenceDurationMs,
										}
									: {}),
							},
			},
		},
	};
}

export function toOpenAILiveTranscriptionClientEvent(
	event: CanonicalLiveTranscriptionClientEvent,
	upstreamModel: string,
): Record<string, unknown> {
	const eventId = event.eventId ? { event_id: event.eventId } : {};
	if (event.kind === "session.update")
		return {
			type: "session.update",
			...eventId,
			session: renderConfig(event.config, upstreamModel),
		};
	if (event.kind === "audio.append")
		return {
			type: "input_audio_buffer.append",
			...eventId,
			audio: event.audio,
		};
	if (event.kind === "audio.commit")
		return { type: "input_audio_buffer.commit", ...eventId };
	return { type: "input_audio_buffer.clear", ...eventId };
}

function parseDetectedLanguages(value: unknown) {
	return Array.isArray(value)
		? value.flatMap((item) => {
				const language = record(item);
				return typeof language.code === "string"
					? [{ code: language.code }]
					: [];
			})
		: undefined;
}

export function parseOpenAILiveTranscriptionServerEvent(
	raw: unknown,
	current: CanonicalLiveTranscriptionConfig,
): CanonicalLiveTranscriptionServerEvent | null {
	const value = record(raw);
	const type = value.type;
	const eventId =
		typeof value.event_id === "string" ? value.event_id : undefined;
	const common = eventId ? { eventId } : {};
	if (type === "session.created" || type === "session.updated")
		return {
			kind: type,
			...common,
			...(typeof record(value.session).id === "string"
				? { sessionId: record(value.session).id as string }
				: {}),
			...(typeof record(value.session).expires_at === "number"
				? { expiresAt: record(value.session).expires_at as number }
				: {}),
			config: parseConfig(value.session, current),
		};
	if (type === "conversation.item.input_audio_transcription.delta") {
		if (typeof value.item_id !== "string") return null;
		return {
			kind: "transcript.delta",
			...common,
			itemId: value.item_id,
			contentIndex:
				typeof value.content_index === "number" ? value.content_index : 0,
			delta: typeof value.delta === "string" ? value.delta : "",
			...(value.logprobs !== undefined ? { logprobs: value.logprobs } : {}),
		};
	}
	if (type === "conversation.item.input_audio_transcription.completed") {
		if (typeof value.item_id !== "string") return null;
		const languages = parseDetectedLanguages(value.languages);
		return {
			kind: "transcript.completed",
			...common,
			itemId: value.item_id,
			contentIndex:
				typeof value.content_index === "number" ? value.content_index : 0,
			transcript: typeof value.transcript === "string" ? value.transcript : "",
			...(languages !== undefined ? { languages } : {}),
			...(value.logprobs !== undefined ? { logprobs: value.logprobs } : {}),
		};
	}
	if (type === "conversation.item.input_audio_transcription.failed") {
		if (typeof value.item_id !== "string") return null;
		const error = record(value.error);
		return {
			kind: "transcript.failed",
			...common,
			itemId: value.item_id,
			contentIndex:
				typeof value.content_index === "number" ? value.content_index : 0,
			error: {
				message:
					typeof error.message === "string"
						? error.message
						: "Input audio transcription failed",
				...(typeof error.type === "string" ? { type: error.type } : {}),
				...(typeof error.code === "string" ? { code: error.code } : {}),
				...(typeof error.param === "string" || error.param === null
					? { param: error.param as string | null }
					: {}),
			},
		};
	}
	const simple: Record<string, CanonicalLiveTranscriptionServerEvent["kind"]> =
		{
			"input_audio_buffer.committed": "audio.committed",
			"input_audio_buffer.cleared": "audio.cleared",
			"input_audio_buffer.speech_started": "speech.started",
			"input_audio_buffer.speech_stopped": "speech.stopped",
		};
	const kind = typeof type === "string" ? simple[type] : undefined;
	if (kind)
		return {
			kind: kind as
				| "audio.committed"
				| "audio.cleared"
				| "speech.started"
				| "speech.stopped",
			...common,
			...(typeof value.item_id === "string" ? { itemId: value.item_id } : {}),
			...(typeof value.previous_item_id === "string"
				? { previousItemId: value.previous_item_id }
				: {}),
			...(typeof value.audio_start_ms === "number"
				? { audioStartMs: value.audio_start_ms }
				: {}),
			...(typeof value.audio_end_ms === "number"
				? { audioEndMs: value.audio_end_ms }
				: {}),
		};
	if (type === "error") {
		const error = record(value.error);
		return {
			kind: "error",
			...common,
			error: {
				message:
					typeof error.message === "string"
						? error.message
						: "Realtime transcription failed",
				...(typeof error.type === "string" ? { type: error.type } : {}),
				...(typeof error.code === "string" ? { code: error.code } : {}),
				...(typeof error.param === "string" || error.param === null
					? { param: error.param as string | null }
					: {}),
				...(typeof error.event_id === "string" || error.event_id === null
					? { eventId: error.event_id as string | null }
					: {}),
			},
		};
	}
	return null;
}

export function toOpenAILiveTranscriptionServerEvent(
	event: CanonicalLiveTranscriptionServerEvent,
	publicModel: string,
): Record<string, unknown> {
	const eventId = event.eventId ? { event_id: event.eventId } : {};
	if (event.kind === "session.created" || event.kind === "session.updated")
		return {
			type: event.kind,
			...eventId,
			session: {
				...(event.sessionId !== undefined ? { id: event.sessionId } : {}),
				object: "realtime.transcription_session",
				...(event.expiresAt !== undefined
					? { expires_at: event.expiresAt }
					: {}),
				...renderConfig(event.config, publicModel),
			},
		};
	if (event.kind === "transcript.delta")
		return {
			type: "conversation.item.input_audio_transcription.delta",
			...eventId,
			item_id: event.itemId,
			content_index: event.contentIndex,
			delta: event.delta,
			...(event.logprobs !== undefined ? { logprobs: event.logprobs } : {}),
		};
	if (event.kind === "transcript.completed")
		return {
			type: "conversation.item.input_audio_transcription.completed",
			...eventId,
			item_id: event.itemId,
			content_index: event.contentIndex,
			transcript: event.transcript,
			...(event.languages !== undefined ? { languages: event.languages } : {}),
			...(event.logprobs !== undefined ? { logprobs: event.logprobs } : {}),
		};
	if (event.kind === "transcript.failed")
		return {
			type: "conversation.item.input_audio_transcription.failed",
			...eventId,
			item_id: event.itemId,
			content_index: event.contentIndex,
			error: event.error,
		};
	if (event.kind === "error")
		return {
			type: "error",
			...eventId,
			error: {
				...event.error,
				...(event.error.eventId !== undefined
					? { event_id: event.error.eventId }
					: {}),
			},
		};
	const types = {
		"audio.committed": "input_audio_buffer.committed",
		"audio.cleared": "input_audio_buffer.cleared",
		"speech.started": "input_audio_buffer.speech_started",
		"speech.stopped": "input_audio_buffer.speech_stopped",
	} as const;
	return {
		type: types[event.kind],
		...eventId,
		...(event.itemId !== undefined ? { item_id: event.itemId } : {}),
		...(event.previousItemId !== undefined
			? { previous_item_id: event.previousItemId }
			: {}),
		...(event.audioStartMs !== undefined
			? { audio_start_ms: event.audioStartMs }
			: {}),
		...(event.audioEndMs !== undefined
			? { audio_end_ms: event.audioEndMs }
			: {}),
	};
}
