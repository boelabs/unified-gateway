import assert from "node:assert/strict";
import { test } from "node:test";

import {
	extraContentFromProviderSpecificFields,
	hydrateCanonicalToolCallOpaqueState,
	captureOpaqueToolCallStateFromChunk,
	providerSpecificFieldsFromToolCalls,
	extraContentFromThoughtSignatureId,
	opaqueToolCallItemsFromResponse,
	opaqueToolCallItemsFromState,
	mergeOpaqueExtraContent,
} from "./opaqueToolState.ts";

import type {
	CanonicalChatStreamChunk,
	CanonicalChatResponse,
	CanonicalChatRequest,
} from "./canonical.ts";

test("opaque tool state: hydrates missing provider state by tool call id", async () => {
	const req: CanonicalChatRequest = {
		callType: "chat",
		model: "gpt",
		stream: false,
		messages: [
			{
				role: "assistant",
				content: null,
				toolCalls: [
					{
						id: "call_1",
						name: "load_skill",
						arguments: '{"name":"image-generation"}',
					},
				],
			},
			{ role: "tool", toolCallId: "call_1", content: "ok" },
		],
	};

	const hydrated = await hydrateCanonicalToolCallOpaqueState(req, async (id) =>
		id === "call_1"
			? {
					id: "call_1",
					extra_content: { google: { thought_signature: "sig-a" } },
				}
			: undefined,
	);

	assert.deepEqual(hydrated.messages[0]!.toolCalls?.[0]?.extraContent, {
		google: { thought_signature: "sig-a" },
	});
});

test("opaque tool state: maps LiteLLM provider_specific_fields aliases", () => {
	assert.deepEqual(
		extraContentFromProviderSpecificFields({ thought_signature: "sig-a" }),
		{ google: { thought_signature: "sig-a" } },
	);
	assert.deepEqual(extraContentFromThoughtSignatureId("call__thought__sig-b"), {
		google: { thought_signature: "sig-b" },
	});
	assert.deepEqual(
		providerSpecificFieldsFromToolCalls([
			{ extraContent: { google: { thought_signature: "sig-a" } } },
		]),
		{ thought_signatures: ["sig-a"] },
	);
});

test("opaque tool state: merges provider aliases without dropping sibling metadata", () => {
	assert.deepEqual(
		mergeOpaqueExtraContent(
			{ google: { thought_signature: "sig-a" } },
			{ google: { other: true }, openai: { item_id: "call_1" } },
		),
		{
			google: { thought_signature: "sig-a", other: true },
			openai: { item_id: "call_1" },
		},
	);
});

test("opaque tool state: incoming provider data wins while stored namespaces are restored", async () => {
	const req: CanonicalChatRequest = {
		callType: "chat",
		model: "gpt",
		stream: false,
		messages: [
			{
				role: "assistant",
				content: null,
				toolCalls: [
					{
						id: "call_1",
						name: "load_skill",
						arguments: "{}",
						extraContent: { openai: { item_id: "call_1" } },
					},
				],
			},
		],
	};

	const hydrated = await hydrateCanonicalToolCallOpaqueState(req, async () => ({
		id: "call_1",
		extra_content: { google: { thought_signature: "sig-a" } },
	}));

	assert.deepEqual(hydrated.messages[0]!.toolCalls?.[0]?.extraContent, {
		google: { thought_signature: "sig-a" },
		openai: { item_id: "call_1" },
	});
});

test("opaque tool state: extracts minimal items from a canonical response", () => {
	const response: CanonicalChatResponse = {
		id: "chatcmpl_1",
		created: 1,
		model: "gpt",
		choices: [
			{
				index: 0,
				finishReason: "tool_calls",
				message: {
					role: "assistant",
					content: null,
					toolCalls: [
						{
							id: "call_1",
							name: "load_skill",
							arguments: "{}",
							extraContent: {
								google: { thought_signature: "sig-a" },
							},
						},
						{ id: "call_2", name: "noop", arguments: "{}" },
					],
				},
			},
		],
		usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
	};

	assert.deepEqual(opaqueToolCallItemsFromResponse(response), [
		{
			type: "tool_call",
			id: "call_1",
			extra_content: { google: { thought_signature: "sig-a" } },
			provider_specific_fields: { thought_signature: "sig-a" },
		},
	]);
});

test("opaque tool state: captures stream state across deltas", () => {
	const state = new Map();
	const first: CanonicalChatStreamChunk = {
		id: "chunk_1",
		created: 1,
		model: "gpt",
		choices: [
			{
				index: 0,
				finishReason: null,
				delta: {
					role: "assistant",
					toolCalls: [
						{
							index: 0,
							id: "call_1",
							name: "load_skill",
							extraContent: {
								google: { thought_signature: "sig-a" },
							},
						},
					],
				},
			},
		],
	};
	const second: CanonicalChatStreamChunk = {
		id: "chunk_1",
		created: 1,
		model: "gpt",
		choices: [
			{
				index: 0,
				finishReason: "tool_calls",
				delta: { toolCalls: [{ index: 0, arguments: "{}" }] },
			},
		],
	};

	captureOpaqueToolCallStateFromChunk(state, first);
	captureOpaqueToolCallStateFromChunk(state, second);

	assert.deepEqual(opaqueToolCallItemsFromState(state), [
		{
			type: "tool_call",
			id: "call_1",
			extra_content: { google: { thought_signature: "sig-a" } },
			provider_specific_fields: { thought_signature: "sig-a" },
		},
	]);
});
