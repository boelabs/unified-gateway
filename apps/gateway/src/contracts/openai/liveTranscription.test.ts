import { GatewayError } from "#core/errors.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

import {
	parseOpenAILiveTranscriptionServerEvent,
	parseOpenAILiveTranscriptionClientEvent,
	toOpenAILiveTranscriptionServerEvent,
	toOpenAILiveTranscriptionClientEvent,
	defaultLiveTranscriptionConfig,
} from "./liveTranscription.ts";

test("live client contract maps GA session.update and substitutes only the upstream model", () => {
	const previous = defaultLiveTranscriptionConfig("public-live");
	const event = parseOpenAILiveTranscriptionClientEvent(
		{
			type: "session.update",
			event_id: "evt_1",
			session: {
				type: "transcription",
				include: ["item.input_audio_transcription.logprobs"],
				audio: {
					input: {
						format: { type: "audio/pcm", rate: 24000 },
						noise_reduction: { type: "near_field" },
						transcription: {
							model: "public-live",
							prompt: "Support call",
							languages: ["es", "en"],
							keywords: ["BoeLabs", "AC-42"],
							delay: "low",
						},
						turn_detection: null,
					},
				},
			},
		},
		previous,
	);
	assert.equal(event.kind, "session.update");
	if (event.kind !== "session.update") return;
	assert.deepEqual(event.config.languages, ["es", "en"]);
	assert.deepEqual(event.config.noiseReduction, { type: "near_field" });
	const upstream = toOpenAILiveTranscriptionClientEvent(
		event,
		"deployment-live",
	);
	assert.equal(
		(
			(
				(upstream.session as Record<string, unknown>).audio as Record<
					string,
					unknown
				>
			).input as Record<string, unknown>
		).transcription instanceof Object,
		true,
	);
	const transcription = (
		(
			(upstream.session as Record<string, unknown>).audio as Record<
				string,
				unknown
			>
		).input as Record<string, unknown>
	).transcription as Record<string, unknown>;
	assert.equal(transcription.model, "deployment-live");
	assert.deepEqual(transcription.languages, ["es", "en"]);
});

test("live client contract rejects malformed base64 before it reaches a provider", () => {
	assert.throws(
		() =>
			parseOpenAILiveTranscriptionClientEvent(
				{ type: "input_audio_buffer.append", audio: "not base64" },
				defaultLiveTranscriptionConfig("m"),
			),
		(error) => GatewayError.is(error) && error.param === "audio",
	);
});

test("live client contract rejects invalid VAD bounds before routing", () => {
	assert.throws(
		() =>
			parseOpenAILiveTranscriptionClientEvent(
				{
					type: "session.update",
					session: {
						type: "transcription",
						audio: {
							input: {
								turn_detection: {
									type: "server_vad",
									threshold: 1.5,
								},
							},
						},
					},
				},
				defaultLiveTranscriptionConfig("m"),
			),
		(error) =>
			GatewayError.is(error) &&
			error.param === "session.audio.input.turn_detection.threshold",
	);
});

test("live server contract preserves session identity and provider event order fields", () => {
	const current = defaultLiveTranscriptionConfig("deployment-live");
	const created = parseOpenAILiveTranscriptionServerEvent(
		{
			type: "session.created",
			event_id: "evt_created",
			session: {
				id: "sess_123",
				expires_at: 123456,
				type: "transcription",
				audio: {
					input: {
						format: { type: "audio/pcm", rate: 24000 },
						transcription: { model: "deployment-live" },
						turn_detection: null,
					},
				},
			},
		},
		current,
	);
	assert.ok(created);
	if (!created) return;
	assert.deepEqual(
		toOpenAILiveTranscriptionServerEvent(created, "public-live"),
		{
			type: "session.created",
			event_id: "evt_created",
			session: {
				id: "sess_123",
				object: "realtime.transcription_session",
				expires_at: 123456,
				type: "transcription",
				audio: {
					input: {
						format: { type: "audio/pcm", rate: 24000 },
						transcription: { model: "public-live" },
						turn_detection: null,
					},
				},
			},
		},
	);

	const completed = parseOpenAILiveTranscriptionServerEvent(
		{
			type: "conversation.item.input_audio_transcription.completed",
			item_id: "item_2",
			content_index: 0,
			transcript: "Bonjour",
			languages: [{ code: "fr" }],
		},
		current,
	);
	assert.ok(completed);
	if (!completed) return;
	assert.deepEqual(
		toOpenAILiveTranscriptionServerEvent(completed, "public-live"),
		{
			type: "conversation.item.input_audio_transcription.completed",
			item_id: "item_2",
			content_index: 0,
			transcript: "Bonjour",
			languages: [{ code: "fr" }],
		},
	);
});

test("live server contract preserves per-item transcription failures", () => {
	const event = parseOpenAILiveTranscriptionServerEvent(
		{
			type: "conversation.item.input_audio_transcription.failed",
			item_id: "item_7",
			content_index: 0,
			error: {
				type: "invalid_request_error",
				code: "audio_invalid",
				message: "Bad audio",
			},
		},
		defaultLiveTranscriptionConfig("m"),
	);
	assert.ok(event);
	if (!event) return;
	assert.deepEqual(toOpenAILiveTranscriptionServerEvent(event, "m"), {
		type: "conversation.item.input_audio_transcription.failed",
		item_id: "item_7",
		content_index: 0,
		error: {
			type: "invalid_request_error",
			code: "audio_invalid",
			message: "Bad audio",
		},
	});
});
