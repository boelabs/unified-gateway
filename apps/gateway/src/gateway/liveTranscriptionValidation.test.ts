import { defaultLiveTranscriptionConfig } from "#contracts/openai/liveTranscription.ts";
import { assertLiveTranscriptionSupported } from "./liveTranscriptionValidation.ts";
import { resolveModelMetadata } from "#catalog/index.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

const live = resolveModelMetadata("openai", "gpt-live-transcribe");
const committed = resolveModelMetadata("openai", "gpt-transcribe");

test("live validation uses catalog profiles rather than provider names", () => {
	assert.doesNotThrow(() =>
		assertLiveTranscriptionSupported(
			{
				...defaultLiveTranscriptionConfig("public-live"),
				languages: ["es", "en"],
				keywords: ["BoeLabs"],
				delay: "low",
				noiseReduction: { type: "far_field" },
			},
			live,
		),
	);
	assert.throws(
		() =>
			assertLiveTranscriptionSupported(
				{
					...defaultLiveTranscriptionConfig("public-live"),
					language: "es",
				},
				live,
			),
		/does not support language/,
	);
});

test("committed gpt-transcribe profile exposes detected languages without delay", () => {
	assert.doesNotThrow(() =>
		assertLiveTranscriptionSupported(
			{
				...defaultLiveTranscriptionConfig("public-committed"),
				languages: ["fr"],
			},
			committed,
		),
	);
	assert.throws(
		() =>
			assertLiveTranscriptionSupported(
				{
					...defaultLiveTranscriptionConfig("public-committed"),
					delay: "low",
				},
				committed,
			),
		/does not support this delay/,
	);
});
