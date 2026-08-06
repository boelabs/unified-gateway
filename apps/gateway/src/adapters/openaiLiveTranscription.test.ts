import { openaicompatibleAdapter } from "./openaicompatible/index.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

import {
	openAILiveTranscriptionWebSocketUrl,
	initialOpenAILiveTranscriptionEvent,
} from "./openaiLiveTranscription.ts";

test("live transcription builds OpenAI and Azure GA v1 WebSocket URLs", () => {
	assert.equal(
		openAILiveTranscriptionWebSocketUrl("https://api.openai.com/v1"),
		"wss://api.openai.com/v1/realtime?intent=transcription",
	);
	assert.equal(
		openAILiveTranscriptionWebSocketUrl(
			"https://resource.openai.azure.com/openai/v1/",
		),
		"wss://resource.openai.azure.com/openai/v1/realtime?intent=transcription",
	);
});

test("live transcription pins the upstream deployment in its initial session update", () => {
	const event = initialOpenAILiveTranscriptionEvent("deployment-live");
	const session = event.session as Record<string, unknown>;
	const audio = session.audio as Record<string, unknown>;
	const input = audio.input as Record<string, unknown>;
	const transcription = input.transcription as Record<string, unknown>;
	assert.equal(event.type, "session.update");
	assert.equal(session.type, "transcription");
	assert.equal(transcription.model, "deployment-live");
	assert.deepEqual(input.format, { type: "audio/pcm", rate: 24000 });
	assert.equal(input.turn_detection, null);
});

test("the generic OpenAI-compatible adapter exposes live transcription for custom catalogs", () => {
	assert.ok(openaicompatibleAdapter.liveTranscription);
	assert.ok(
		openaicompatibleAdapter.supportedCallTypes.has("audio.transcriptions.live"),
	);
	assert.deepEqual(
		openaicompatibleAdapter.transports?.["audio.transcriptions.live"],
		{
			supported: ["realtime_websocket"],
			default: "realtime_websocket",
		},
	);
});
