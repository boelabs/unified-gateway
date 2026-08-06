import type { CanonicalTranscriptionRequest } from "#core/audio.ts";
import { resolveModelMetadata } from "#catalog/index.ts";
import type { AdapterContext } from "#adapters/types.ts";
import { writeFileSync, rmSync } from "node:fs";
import { azureopenaiAdapter } from "./index.ts";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

function audioFile(): {
	req: CanonicalTranscriptionRequest;
	cleanup: () => void;
} {
	const path = join(tmpdir(), `${randomUUID()}.wav`);
	writeFileSync(path, Buffer.from([0x52, 0x49, 0x46, 0x46]));
	return {
		req: {
			model: "gpt-transcribe",
			file: {
				path,
				filename: "audio.wav",
				mimeType: "audio/wav",
				sizeBytes: 4,
			},
			responseFormat: "json",
			stream: false,
		},
		cleanup: () => rmSync(path, { force: true }),
	};
}

function ctx(credentials: Record<string, unknown>): AdapterContext {
	return {
		upstreamModel: "gpt-transcribe",
		credentials,
		meta: {
			capabilities: {
				tools: false,
				vision: false,
				reasoning: false,
				structuredOutputs: false,
			},
		},
		transport: "audio_transcriptions",
		requestId: "t",
	};
}

test("azureopenai composes deployment-addressed file audio with v1 Realtime", () => {
	assert.ok(azureopenaiAdapter.supportedCallTypes.has("audio.transcriptions"));
	assert.ok(
		azureopenaiAdapter.supportedCallTypes.has("audio.transcriptions.live"),
	);
	assert.ok(azureopenaiAdapter.audioTranscription);
	assert.ok(azureopenaiAdapter.liveTranscription);
	assert.ok(
		resolveModelMetadata(
			"azureopenai",
			"gpt-transcribe",
		).supportedCallTypes?.includes("audio.transcriptions"),
	);
});

test("azure audio.buildRequest: uses the documented versioned deployment URL", async () => {
	const { req, cleanup } = audioFile();
	try {
		const r = await azureopenaiAdapter.audioTranscription!.buildRequest(
			req,
			ctx({ apiKey: "k", baseUrl: "https://r.openai.azure.com/openai/v1" }),
		);
		assert.equal(
			r.url,
			"https://r.openai.azure.com/openai/deployments/gpt-transcribe/audio/transcriptions?api-version=2025-04-01-preview",
		);
		assert.equal(r.headers["api-key"], "k");
		assert.equal(r.headers.authorization, undefined);
		assert.equal(r.headers["content-type"], undefined);
		const form = r.body as FormData;
		assert.equal(form.get("model"), null);
		assert.equal(form.get("response_format"), "json");
		assert.equal((form.get("file") as File).name, "audio.wav");
	} finally {
		cleanup();
	}
});

test("azure audio.buildRequest: derives the resource origin and accepts an apiVersion override", async () => {
	const { req, cleanup } = audioFile();
	try {
		const r = await azureopenaiAdapter.audioTranscription!.buildRequest(
			req,
			ctx({
				apiKey: "k",
				baseUrl: "https://r.openai.azure.com",
				apiVersion: "2024-06-01",
			}),
		);
		assert.equal(
			r.url,
			"https://r.openai.azure.com/openai/deployments/gpt-transcribe/audio/transcriptions?api-version=2024-06-01",
		);
	} finally {
		cleanup();
	}
});
