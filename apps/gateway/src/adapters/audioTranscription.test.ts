import { openaicompatibleAdapter } from "./openaicompatible/index.ts";
import type { CanonicalTranscriptionRequest } from "#core/audio.ts";
import { openaiAdapter } from "./openai/index.ts";
import type { AdapterContext } from "./types.ts";
import { writeFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

function ctx(): AdapterContext {
	return {
		upstreamModel: "gpt-4o-transcribe",
		credentials: { apiKey: "k", baseUrl: "https://api.example.com/v1" },
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

function withAudioFile(): {
	req: CanonicalTranscriptionRequest;
	cleanup: () => void;
} {
	const path = join(tmpdir(), `${randomUUID()}.mp3`);
	writeFileSync(path, Buffer.from([0x49, 0x44, 0x33])); // "ID3"
	const req: CanonicalTranscriptionRequest = {
		model: "gpt-4o-transcribe",
		file: {
			path,
			filename: "speech.mp3",
			mimeType: "audio/mpeg",
			sizeBytes: 3,
		},
		responseFormat: "json",
		stream: false,
	};
	return { req, cleanup: () => rmSync(path, { force: true }) };
}

test("audio: both OpenAI adapters expose the handler", () => {
	assert.ok(openaiAdapter.supportedCallTypes.has("audio.transcriptions"));
	assert.ok(
		openaicompatibleAdapter.supportedCallTypes.has("audio.transcriptions"),
	);
	assert.ok(openaicompatibleAdapter.audioTranscription);
});

test("audio.buildRequest: multipart to /audio/transcriptions with file/model/response_format", async () => {
	const { req, cleanup } = withAudioFile();
	try {
		const r = await openaicompatibleAdapter.audioTranscription!.buildRequest(
			{
				...req,
				languages: ["es", "en"],
				keywords: ["BoeLabs", "AC-42"],
				timestampGranularities: ["segment"],
				responseFormat: "verbose_json",
			},
			ctx(),
		);
		assert.equal(r.method, "POST");
		assert.equal(r.url, "https://api.example.com/v1/audio/transcriptions");
		assert.equal(r.headers.authorization, "Bearer k");
		assert.equal(r.headers["content-type"], undefined); // FormData sets the boundary
		const form = r.body as FormData;
		assert.equal(form.get("model"), "gpt-4o-transcribe");
		assert.equal(form.get("response_format"), "verbose_json");
		assert.deepEqual(form.getAll("languages[]"), ["es", "en"]);
		assert.deepEqual(form.getAll("keywords[]"), ["BoeLabs", "AC-42"]);
		assert.equal(form.get("timestamp_granularities[]"), "segment");
		const file = form.get("file") as File;
		assert.equal(file.name, "speech.mp3");
		assert.equal(file.type, "audio/mpeg");
	} finally {
		cleanup();
	}
});

test("audio.buildRequest: extra_body cannot overwrite managed fields", async () => {
	const { req, cleanup } = withAudioFile();
	try {
		await assert.rejects(async () => {
			await openaicompatibleAdapter.audioTranscription!.buildRequest(
				{ ...req, extraBody: { model: "x" } },
				ctx(),
			);
		}, /extra_body\.model/);
	} finally {
		cleanup();
	}
});

test("audio.parseResponse: preserves detected languages and duration usage", () => {
	const cap = openaicompatibleAdapter.audioTranscription!;
	assert.deepEqual(cap.parseResponse("hello world", ctx()), {
		text: "hello world",
	});

	const json = cap.parseResponse(
		{
			text: "hi",
			usage: {
				type: "duration",
				seconds: 2.5,
			},
			languages: [{ code: "es" }],
		},
		ctx(),
	);
	assert.equal(json.text, "hi");
	assert.deepEqual(json.usage, { type: "duration", seconds: 2.5 });
	assert.deepEqual(json.languages, [{ code: "es" }]);

	const verbose = cap.parseResponse(
		{
			text: "hi",
			language: "english",
			duration: 1.2,
			segments: [{ id: 0, text: "hi" }],
		},
		ctx(),
	);
	assert.equal(verbose.language, "english");
	assert.equal(verbose.duration, 1.2);
	assert.equal(verbose.segments?.length, 1);
});

test("audio.parseStream: preserves native event order, languages, and duration usage", async () => {
	const sse =
		`data: {"type":"transcript.text.delta","delta":"Hel"}\n\n` +
		`data: {"type":"transcript.text.delta","delta":"lo"}\n\n` +
		`data: {"type":"transcript.text.done","text":"Hello","languages":[{"code":"en"}],"usage":{"type":"duration","seconds":1.25}}\n\n`;
	const deltas: string[] = [];
	let doneText: string | undefined;
	let seconds: number | undefined;
	let languages: Array<{ code: string }> | undefined;
	for await (const event of openaicompatibleAdapter.audioTranscription!
		.parseStream!(new Response(sse).body!, ctx())) {
		if (event.kind === "delta") deltas.push(event.delta);
		else {
			doneText = event.text;
			seconds =
				event.usage?.type === "duration" ? event.usage.seconds : undefined;
			languages = event.languages;
		}
	}
	assert.equal(deltas.join(""), "Hello");
	assert.equal(doneText, "Hello");
	assert.equal(seconds, 1.25);
	assert.deepEqual(languages, [{ code: "en" }]);
});
