import { buildOpenAIChatBody } from "./chatTransport.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

import {
	toCanonicalChatRequest,
	toOpenAIChatResponse,
	chatResponseSchema,
	chatRequestSchema,
	toOpenAIChatChunk,
	chatChunkSchema,
} from "./chat.ts";

import type {
	CanonicalChatStreamChunk,
	CanonicalChatResponse,
} from "#core/canonical.ts";

test("prompt_cache_key: from chat contract to canonical request and OpenAI transport", () => {
	const u = toCanonicalChatRequest(
		chatRequestSchema.parse({
			model: "gpt",
			messages: [{ role: "user", content: "hi" }],
			prompt_cache_key: "thread-42",
		}),
	);
	assert.equal(u.promptCacheKey, "thread-42");
	const body = buildOpenAIChatBody(u, "gpt-x");
	assert.equal(body.prompt_cache_key, "thread-42");
});

test("OpenAI transport strips provider-specific tool-call extra_content", () => {
	const body = buildOpenAIChatBody(
		{
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
							name: "f",
							arguments: "{}",
							extraContent: {
								google: { thought_signature: "sig-a" },
							},
						},
					],
				},
			],
		},
		"gpt-x",
	);
	const messages = body.messages as Array<Record<string, unknown>>;
	const toolCalls = messages[0]!.tool_calls as Array<Record<string, unknown>>;
	assert.equal(toolCalls[0]!.extra_content, undefined);
});

test("request: parses a basic chat and applies stream=false by default", () => {
	const parsed = chatRequestSchema.parse({
		model: "gpt",
		messages: [{ role: "user", content: "hello" }],
	});
	assert.equal(parsed.stream, false);
	assert.equal(parsed.messages.length, 1);
});

test("request: rejects empty messages and invalid role", () => {
	assert.throws(() => chatRequestSchema.parse({ model: "g", messages: [] }));
	assert.throws(() =>
		chatRequestSchema.parse({
			model: "g",
			messages: [{ role: "robot", content: "x" }],
		}),
	);
});

test("request: max is upstream vocabulary; the maximum public effort is xhigh", () => {
	const base = { model: "g", messages: [{ role: "user", content: "x" }] };
	assert.equal(
		chatRequestSchema.safeParse({ ...base, reasoning_effort: "xhigh" }).success,
		true,
	);
	assert.equal(
		chatRequestSchema.safeParse({ ...base, reasoning_effort: "max" }).success,
		false,
	);
});

test("request: tolerates unknown fields (passthrough)", () => {
	const parsed = chatRequestSchema.parse({
		model: "gpt",
		messages: [{ role: "user", content: "hi" }],
		future_param: 123,
	});
	assert.equal((parsed as Record<string, unknown>).future_param, 123);
});

test("toCanonical: normalizes max_completion_tokens, stop string, and stream_options", () => {
	const u = toCanonicalChatRequest(
		chatRequestSchema.parse({
			model: "claude",
			messages: [{ role: "user", content: "hi" }],
			max_completion_tokens: 256,
			max_tokens: 999,
			stop: "STOP",
			stream: true,
			stream_options: { include_usage: true },
			temperature: 0.5,
		}),
	);
	assert.equal(u.maxTokens, 256); // gana max_completion_tokens
	assert.deepEqual(u.stop, ["STOP"]);
	assert.equal(u.includeUsage, true);
	assert.equal(u.temperature, 0.5);
	assert.equal(u.callType, "chat");
});

test("toCanonical: normalizes reasoning_effort and extra_body", () => {
	const u = toCanonicalChatRequest(
		chatRequestSchema.parse({
			model: "gpt",
			messages: [{ role: "user", content: "hi" }],
			reasoning_effort: "high",
			extra_body: { top_k: 40 },
		}),
	);
	assert.deepEqual(u.reasoning, { effort: "high", summary: "auto" });
	assert.deepEqual(u.extraBody, { top_k: 40 });
});

test("toCanonical: response_format json_schema becomes canonical format", () => {
	const schema = {
		type: "object",
		properties: { answer: { type: "string" } },
		required: ["answer"],
	};
	const u = toCanonicalChatRequest(
		chatRequestSchema.parse({
			model: "gpt",
			messages: [{ role: "user", content: "hi" }],
			response_format: {
				type: "json_schema",
				json_schema: {
					name: "answer",
					description: "A short answer",
					schema,
					strict: true,
				},
			},
		}),
	);
	assert.deepEqual(u.responseFormat, {
		type: "json_schema",
		name: "answer",
		description: "A short answer",
		schema,
		strict: true,
	});
});

test("toCanonical: reasoning.summary none disables visible summaries", () => {
	const u = toCanonicalChatRequest(
		chatRequestSchema.parse({
			model: "gpt",
			messages: [{ role: "user", content: "hi" }],
			reasoning_effort: "high",
			reasoning: { summary: "none" },
		}),
	);
	assert.deepEqual(u.reasoning, { effort: "high", summary: "none" });
});

test("toCanonical: extra_body cannot overwrite chat managed parameters", () => {
	assert.throws(
		() =>
			toCanonicalChatRequest(
				chatRequestSchema.parse({
					model: "gpt",
					messages: [{ role: "user", content: "hi" }],
					extra_body: { temperature: 0.2 },
				}),
			),
		/extra_body.temperature/,
	);
});

test("toCanonical: maps multimodal content and tool_calls", () => {
	const u = toCanonicalChatRequest(
		chatRequestSchema.parse({
			model: "gpt",
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "describe" },
						{
							type: "image_url",
							image_url: { url: "https://x/y.png", detail: "high" },
						},
					],
				},
				{
					role: "assistant",
					content: null,
					tool_calls: [
						{
							id: "call_1",
							type: "function",
							function: { name: "f", arguments: "{}" },
							extra_content: { google: { thought_signature: "sig-a" } },
						},
					],
				},
			],
		}),
	);
	const parts = u.messages[0]!.content;
	assert.ok(Array.isArray(parts));
	assert.deepEqual(parts[1], {
		type: "image",
		url: "https://x/y.png",
		detail: "high",
	});
	assert.equal(u.messages[1]!.toolCalls?.[0]?.name, "f");
	assert.deepEqual(u.messages[1]!.toolCalls?.[0]?.extraContent, {
		google: { thought_signature: "sig-a" },
	});
});

test("toCanonical: maps LiteLLM provider_specific_fields thought signatures", () => {
	const u = toCanonicalChatRequest(
		chatRequestSchema.parse({
			model: "gpt",
			messages: [
				{
					role: "assistant",
					content: null,
					tool_calls: [
						{
							id: "call_1",
							type: "function",
							function: { name: "get_weather", arguments: "{}" },
							provider_specific_fields: { thought_signature: "sig-a" },
						},
						{
							id: "call_2__thought__sig-b",
							type: "function",
							function: { name: "get_weather", arguments: "{}" },
						},
					],
				},
			],
		}),
	);
	assert.deepEqual(u.messages[0]!.toolCalls?.[0]?.extraContent, {
		google: { thought_signature: "sig-a" },
	});
	assert.deepEqual(u.messages[0]!.toolCalls?.[1]?.extraContent, {
		google: { thought_signature: "sig-b" },
	});
});

test("toCanonical: maps content part file (file_id and file_data)", () => {
	const u = toCanonicalChatRequest(
		chatRequestSchema.parse({
			model: "gpt",
			messages: [
				{
					role: "user",
					content: [
						{ type: "file", file: { file_id: "file-abc" } },
						{
							type: "file",
							file: {
								file_data: "data:application/pdf;base64,AAAA",
								filename: "x.pdf",
							},
						},
					],
				},
			],
		}),
	);
	const parts = u.messages[0]!.content;
	assert.ok(Array.isArray(parts));
	assert.deepEqual(parts[0], { type: "file", fileId: "file-abc" });
	assert.deepEqual(parts[1], {
		type: "file",
		fileData: "data:application/pdf;base64,AAAA",
		filename: "x.pdf",
	});
});

test("toOpenAIResponse: produces a schema-valid chat.completion", () => {
	const canonical: CanonicalChatResponse = {
		id: "resp_1",
		created: 1700000000,
		model: "gpt",
		choices: [
			{
				index: 0,
				finishReason: "stop",
				message: {
					role: "assistant",
					content: "hello!",
					reasoning: "Resumen de reasoning",
					toolCalls: [
						{
							id: "call_1",
							name: "f",
							arguments: "{}",
							extraContent: {
								google: { thought_signature: "sig-a" },
							},
						},
					],
				},
			},
		],
		usage: {
			promptTokens: 10,
			completionTokens: 5,
			totalTokens: 15,
			cacheReadTokens: 4,
		},
	};
	const out = toOpenAIChatResponse(canonical);
	chatResponseSchema.parse(out);
	assert.equal(out.object, "chat.completion");
	assert.equal(out.choices[0]!.message.content, "hello!");
	// OpenAI always includes refusal (null when there was no refusal).
	assert.equal(
		(out.choices[0]!.message as Record<string, unknown>).refusal,
		null,
	);
	assert.equal(
		(out.choices[0]!.message as Record<string, unknown>).reasoning,
		"Resumen de reasoning",
	);
	assert.deepEqual(
		(
			out.choices[0]!.message.tool_calls?.[0] as
				| Record<string, unknown>
				| undefined
		)?.extra_content,
		{ google: { thought_signature: "sig-a" } },
	);
	assert.deepEqual(
		(
			out.choices[0]!.message.tool_calls?.[0] as
				| Record<string, unknown>
				| undefined
		)?.provider_specific_fields,
		{ thought_signature: "sig-a" },
	);
	assert.deepEqual(
		(out.choices[0]!.message as Record<string, unknown>)
			.provider_specific_fields,
		{ thought_signatures: ["sig-a"] },
	);
	assert.equal(out.usage.prompt_tokens_details?.cached_tokens, 4);
});

test('toOpenAIChunk: first delta (role) carries content:"" and refusal:null like OpenAI', () => {
	const first = toOpenAIChatChunk({
		id: "gen-abc",
		created: 1,
		model: "gpt",
		choices: [{ index: 0, delta: { role: "assistant" }, finishReason: null }],
	});
	chatChunkSchema.parse(first);
	assert.ok(first.id.startsWith("chatcmpl-")); // id estilo OpenAI
	assert.equal(first.choices[0]!.delta.role, "assistant");
	assert.equal(first.choices[0]!.delta.content, "");
	assert.equal(
		(first.choices[0]!.delta as Record<string, unknown>).refusal,
		null,
	);
});

test("toOpenAIChunk: produces a valid chat.completion.chunk with final usage", () => {
	const chunk: CanonicalChatStreamChunk = {
		id: "resp_1",
		created: 1700000000,
		model: "gpt",
		choices: [
			{
				index: 0,
				delta: {
					reasoning: "pienso",
					content: "ho",
					toolCalls: [
						{
							index: 0,
							id: "call_1",
							name: "get_weather",
							arguments: "{}",
							extraContent: {
								google: { thought_signature: "sig-a" },
							},
						},
					],
				},
				finishReason: null,
			},
		],
		usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
	};
	const out = toOpenAIChatChunk(chunk);
	chatChunkSchema.parse(out);
	assert.equal(out.object, "chat.completion.chunk");
	assert.equal(
		(out.choices[0]!.delta as Record<string, unknown>).reasoning,
		"pienso",
	);
	assert.equal(out.choices[0]!.delta.content, "ho");
	assert.deepEqual(
		(
			out.choices[0]!.delta.tool_calls?.[0] as
				| Record<string, unknown>
				| undefined
		)?.provider_specific_fields,
		{ thought_signature: "sig-a" },
	);
	assert.equal(out.usage?.total_tokens, 3);
});
