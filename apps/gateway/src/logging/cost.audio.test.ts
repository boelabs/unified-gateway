import { estimateMaximumCostCents, computeCost } from "./cost.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

test("duration-priced transcription is charged independently from tokens", () => {
	const cost = computeCost(
		{ pricing: { audioInputCentsPerMinute: 1.7 } },
		{
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
			inputAudioSeconds: 90,
		},
	);
	assert.equal(cost.audioInputCents, 2.55);
	assert.equal(cost.totalCents, 2.55);
});

test("live transcription budget admission reserves the configured session duration", () => {
	assert.equal(
		estimateMaximumCostCents(
			{ pricing: { audioInputCentsPerMinute: 1.7 } },
			0,
			0,
			3600,
		),
		102,
	);
});
