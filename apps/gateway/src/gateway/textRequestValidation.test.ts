import { assertTextRequestSupported } from "./textRequestValidation.ts";
import type { CanonicalChatRequest } from "#core/canonical.ts";
import type { ResolvedModelMetadata } from "#catalog/types.ts";
import { GatewayError } from "#core/errors.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

const baseReq: CanonicalChatRequest = {
	callType: "chat",
	model: "m",
	messages: [{ role: "user", content: "hi" }],
	stream: false,
};

const noCaps: ResolvedModelMetadata = {
	capabilities: {
		tools: false,
		vision: false,
		reasoning: false,
		structuredOutputs: false,
	},
};

test("capabilities: rejects tools if the model does not support them", () => {
	assert.throws(
		() =>
			assertTextRequestSupported(
				{ ...baseReq, tools: [{ name: "f" }] },
				noCaps,
			),
		(err) => GatewayError.is(err) && err.param === "tools",
	);
});

test("capabilities: rejects images if the model does not support vision", () => {
	assert.throws(
		() =>
			assertTextRequestSupported(
				{
					...baseReq,
					messages: [
						{
							role: "user",
							content: [{ type: "image", url: "data:image/png;base64,AAAA" }],
						},
					],
				},
				noCaps,
			),
		(err) => GatewayError.is(err) && err.param === "messages",
	);
});

test("capabilities: requires structuredOutputs for json_schema, not for json_object", () => {
	assert.throws(
		() =>
			assertTextRequestSupported(
				{
					...baseReq,
					responseFormat: { type: "json_schema", schema: { type: "object" } },
				},
				noCaps,
			),
		(err) =>
			GatewayError.is(err) &&
			err.param === "response_format" &&
			err.code === "unsupported_model_capability",
	);
	assert.doesNotThrow(() =>
		assertTextRequestSupported(
			{ ...baseReq, responseFormat: { type: "json_object" } },
			noCaps,
		),
	);
	assert.doesNotThrow(() =>
		assertTextRequestSupported(
			{
				...baseReq,
				responseFormat: { type: "json_schema", schema: { type: "object" } },
			},
			optionalReasoner,
		),
	);
});

test("capabilities: rejects real effort without reasoning support, but allows none", () => {
	assert.throws(
		() =>
			assertTextRequestSupported(
				{ ...baseReq, reasoning: { effort: "high" } },
				noCaps,
			),
		(err) => GatewayError.is(err) && err.param === "reasoning",
	);
	assert.doesNotThrow(() =>
		assertTextRequestSupported(
			{ ...baseReq, reasoning: { effort: "none" } },
			noCaps,
		),
	);
});

const mandatoryReasoner: ResolvedModelMetadata = {
	capabilities: {
		tools: true,
		vision: true,
		reasoning: true,
		structuredOutputs: true,
	},
	reasoning: {
		kind: "gemini_level",
		levels: ["low", "medium", "high"],
		canDisable: false,
	},
};

const optionalReasoner: ResolvedModelMetadata = {
	capabilities: {
		tools: true,
		vision: true,
		reasoning: true,
		structuredOutputs: true,
	},
	reasoning: {
		kind: "openai_effort",
		levels: ["low", "medium", "high"],
		canDisable: true,
	},
};

const fixedReasoner: ResolvedModelMetadata = {
	capabilities: {
		tools: true,
		vision: true,
		reasoning: true,
		structuredOutputs: false,
	},
	reasoning: { kind: "fixed", levels: ["high"], canDisable: false },
};

test("capabilities: effort none on a mandatory reasoner (canDisable=false) is invalid", () => {
	assert.throws(
		() =>
			assertTextRequestSupported(
				{ ...baseReq, reasoning: { effort: "none" } },
				mandatoryReasoner,
			),
		(err) =>
			GatewayError.is(err) &&
			err.param === "reasoning.effort" &&
			err.class === "bad_request",
	);
});

test("capabilities: effort none is allowed if the model can disable reasoning", () => {
	assert.doesNotThrow(() =>
		assertTextRequestSupported(
			{ ...baseReq, reasoning: { effort: "none" } },
			optionalReasoner,
		),
	);
});

test("capabilities: a mandatory reasoner accepts real effort", () => {
	assert.doesNotThrow(() =>
		assertTextRequestSupported(
			{ ...baseReq, reasoning: { effort: "medium" } },
			mandatoryReasoner,
		),
	);
});

test("capabilities: a fixed reasoner only accepts high", () => {
	assert.doesNotThrow(() =>
		assertTextRequestSupported(
			{ ...baseReq, reasoning: { effort: "high" } },
			fixedReasoner,
		),
	);
	for (const effort of ["none", "low", "medium", "xhigh"] as const) {
		assert.throws(
			() =>
				assertTextRequestSupported(
					{ ...baseReq, reasoning: { effort } },
					fixedReasoner,
				),
			(err) => GatewayError.is(err) && err.param === "reasoning.effort",
		);
	}
});
