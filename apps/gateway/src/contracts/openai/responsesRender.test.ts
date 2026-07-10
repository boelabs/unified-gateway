import { responsesRequestSchema } from "./responses.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

import {
	canonicalChunksToResponsesEvents,
	resolveResponseInputReferences,
	canonicalToResponsesResponse,
	responsesRequestToCanonical,
	responseEventForClient,
	normalizeResponseInput,
	expandInputReferences,
	type RenderOptions,
	responseForClient,
} from "./responsesRender.ts";

import type {
	CanonicalChatStreamChunk,
	CanonicalChatResponse,
} from "#core/canonical.ts";

function parse(body: unknown) {
	return responsesRequestSchema.parse(body);
}

test("request->canonical: instructions->system, input string->user", () => {
	const u = responsesRequestToCanonical(
		parse({
			model: "gpt",
			input: "hello",
			instructions: "be brief",
			max_output_tokens: 100,
		}),
	);
	assert.equal(u.messages[0]!.role, "system");
	assert.equal(u.messages[0]!.content, "be brief");
	assert.equal(u.messages[1]!.role, "user");
	assert.equal(u.messages[1]!.content, "hello");
	assert.equal(u.maxTokens, 100);
});

test("request->canonical: items message/function_call/function_call_output", () => {
	const u = responsesRequestToCanonical(
		parse({
			model: "gpt",
			input: [
				{
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "hi" }],
				},
				{
					type: "function_call",
					call_id: "c1",
					name: "f",
					arguments: "{}",
					extra_content: { google: { thought_signature: "sig-a" } },
				},
				{ type: "function_call_output", call_id: "c1", output: "42" },
			],
		}),
	);
	assert.deepEqual(u.messages[0]!.content, [{ type: "text", text: "hi" }]);
	assert.equal(u.messages[1]!.toolCalls?.[0]?.name, "f");
	assert.deepEqual(u.messages[1]!.toolCalls?.[0]?.extraContent, {
		google: { thought_signature: "sig-a" },
	});
	assert.equal(u.messages[2]!.role, "tool");
	assert.equal(u.messages[2]!.toolCallId, "c1");
});

test("request->canonical: LiteLLM provider_specific_fields restore function_call state", () => {
	const u = responsesRequestToCanonical(
		parse({
			model: "gpt",
			input: [
				{
					type: "function_call",
					id: "fc_123",
					call_id: "call_123",
					name: "get_weather",
					arguments: "{}",
					provider_specific_fields: { thought_signature: "sig-a" },
				},
				{
					type: "function_call",
					id: "fc_456__thought__sig-b",
					call_id: "call_456",
					name: "get_weather",
					arguments: "{}",
				},
			],
		}),
	);
	assert.deepEqual(u.messages[0]!.toolCalls?.[0]?.extraContent, {
		google: { thought_signature: "sig-a" },
	});
	assert.deepEqual(u.messages[1]!.toolCalls?.[0]?.extraContent, {
		google: { thought_signature: "sig-b" },
	});
});

test("contract: rejects background:true, prompt, and conversation+previous_response_id", () => {
	assert.equal(
		responsesRequestSchema.safeParse({
			model: "gpt",
			input: "hi",
			background: true,
		}).success,
		false,
	);
	assert.equal(
		responsesRequestSchema.safeParse({
			model: "gpt",
			input: "hi",
			prompt: { id: "p_1" },
		}).success,
		false,
	);
	assert.equal(
		responsesRequestSchema.safeParse({
			model: "gpt",
			input: "hi",
			conversation: "conv_1",
			previous_response_id: "resp_1",
		}).success,
		false,
	);
	// Standalone conversation is rejected explicitly; background:false remains valid.
	assert.equal(
		responsesRequestSchema.safeParse({
			model: "gpt",
			input: "hi",
			conversation: "conv_1",
		}).success,
		false,
	);
	assert.equal(
		responsesRequestSchema.safeParse({
			model: "gpt",
			input: "hi",
			background: false,
		}).success,
		true,
	);
});

test("request->canonical: previous_response_id is not forwarded as context by itself", () => {
	const u = responsesRequestToCanonical(
		parse({ model: "gpt", previous_response_id: "resp_1" }),
	);
	assert.deepEqual(u.messages, []);
});

test("request->canonical: extra OpenResponses parameters map to responses transport", () => {
	const u = responsesRequestToCanonical(
		parse({
			model: "gpt",
			input: "hi",
			include: "message.output_text.logprobs",
			presence_penalty: 0.2,
			frequency_penalty: 0.3,
			metadata: { trace: "abc" },
			top_logprobs: 2,
			safety_identifier: "user-1",
			prompt_cache_key: "thread-1",
			max_tool_calls: 4,
		}),
	);
	assert.equal(u.presencePenalty, 0.2);
	assert.equal(u.frequencyPenalty, 0.3);
	assert.deepEqual(u.responsesTransport?.include, [
		"message.output_text.logprobs",
	]);
	assert.deepEqual(u.responsesTransport?.metadata, { trace: "abc" });
	assert.equal(u.responsesTransport?.topLogprobs, 2);
	assert.equal(u.responsesTransport?.safetyIdentifier, "user-1");
	assert.equal(u.responsesTransport?.promptCacheKey, "thread-1");
	assert.equal(u.responsesTransport?.maxToolCalls, 4);
});

test("request->canonical: text.format is normalized and preserves the rest of text", () => {
	const schema = {
		type: "object",
		properties: { answer: { type: "number" } },
		required: ["answer"],
	};
	const u = responsesRequestToCanonical(
		parse({
			model: "gpt",
			input: "hi",
			text: {
				verbosity: "low",
				format: {
					type: "json_schema",
					name: "answer",
					description: "Numeric answer",
					schema,
					strict: true,
				},
			},
		}),
	);
	assert.deepEqual(u.responseFormat, {
		type: "json_schema",
		name: "answer",
		description: "Numeric answer",
		schema,
		strict: true,
	});
	assert.deepEqual(u.responsesTransport?.text, { verbosity: "low" });
});

test("contract: text.format json_schema requires name and schema", () => {
	assert.equal(
		responsesRequestSchema.safeParse({
			model: "gpt",
			input: "hi",
			text: { format: { type: "json_schema" } },
		}).success,
		false,
	);
});

test("request->canonical: reasoning.effort goes to core and summary auto is normalized", () => {
	const u = responsesRequestToCanonical(
		parse({
			model: "gpt",
			input: "hi",
			reasoning: { effort: "xhigh", summary: "auto" },
			extra_body: { top_k: 20 },
		}),
	);
	assert.deepEqual(u.reasoning, { effort: "xhigh", summary: "auto" });
	assert.equal(u.responsesTransport?.reasoning, undefined);
	assert.deepEqual(u.extraBody, { top_k: 20 });
});

test("request->canonical: reasoning.effort does not expose the upstream max label", () => {
	assert.throws(
		() =>
			responsesRequestToCanonical(
				parse({ model: "gpt", input: "hi", reasoning: { effort: "max" } }),
			),
		/Unsupported reasoning effort/,
	);
});

test("request->canonical: extra_body cannot overwrite responses managed parameters", () => {
	assert.throws(
		() =>
			responsesRequestToCanonical(
				parse({
					model: "gpt",
					input: "hi",
					extra_body: { reasoning: { effort: "low" } },
				}),
			),
		/extra_body.reasoning/,
	);
});

test("request state: item_reference expands from previous items", () => {
	const previous = [
		{
			type: "message",
			id: "msg_1",
			role: "assistant",
			content: [{ type: "output_text", text: "done" }],
		},
	];
	const input = normalizeResponseInput([
		{ type: "item_reference", id: "msg_1" },
	]);
	const out = resolveResponseInputReferences(input, previous);
	assert.deepEqual(out, previous);
});

test("expandInputReferences: resolves a reference from the store when not in the seed", async () => {
	const stored = {
		type: "message",
		id: "msg_42",
		role: "assistant",
		content: [{ type: "output_text", text: "earlier reply" }],
	};
	const lookups: string[] = [];
	const input = normalizeResponseInput([
		{ role: "user", content: [{ type: "input_text", text: "Propón un tema" }] },
		{ type: "item_reference", id: "msg_42" },
		{ role: "user", content: [{ type: "input_text", text: "ah" }] },
	]);
	const out = await expandInputReferences(input, [], async (id) => {
		lookups.push(id);
		return id === "msg_42" ? stored : undefined;
	});
	assert.deepEqual(lookups, ["msg_42"]);
	assert.deepEqual(out[1], stored);
	assert.equal(out.length, 3);
});

test("expandInputReferences: does not hit the store when the seed already has the item", async () => {
	const seed = [
		{
			type: "message",
			id: "msg_1",
			role: "assistant",
			content: [{ type: "output_text", text: "done" }],
		},
	];
	const input = normalizeResponseInput([
		{ type: "item_reference", id: "msg_1" },
	]);
	let lookupCalls = 0;
	const out = await expandInputReferences(input, seed, async () => {
		lookupCalls += 1;
		return undefined;
	});
	assert.equal(lookupCalls, 0);
	assert.deepEqual(out, seed);
});

test("expandInputReferences: unresolved reference raises an OpenAI-faithful error", async () => {
	const input = normalizeResponseInput([
		{ type: "item_reference", id: "msg_missing" },
	]);
	await assert.rejects(
		() => expandInputReferences(input, [], async () => undefined),
		(err: unknown) => {
			const e = err as {
				publicMessage?: string;
				code?: string;
				param?: string;
				class?: string;
			};
			assert.equal(e.code, "item_reference_not_found");
			assert.equal(e.param, "input");
			assert.equal(e.class, "bad_request");
			assert.equal(e.publicMessage, "Item with id 'msg_missing' not found.");
			return true;
		},
	);
});

test("request->canonical: signature embedded in call_id is decoded and stripped", () => {
	const u = responsesRequestToCanonical(
		parse({
			model: "gpt",
			input: [
				{
					type: "function_call",
					id: "fc_123",
					call_id: "call_123__thought__sig-a",
					name: "load_skill",
					arguments: '{"name":"image-generation"}',
				},
				{
					type: "function_call_output",
					call_id: "call_123__thought__sig-a",
					output: "ok",
				},
			],
		}),
	);
	assert.equal(u.messages[0]!.toolCalls?.[0]?.id, "call_123");
	assert.deepEqual(u.messages[0]!.toolCalls?.[0]?.extraContent, {
		google: { thought_signature: "sig-a" },
	});
	assert.equal(u.messages[1]!.role, "tool");
	assert.equal(u.messages[1]!.toolCallId, "call_123");
});

test("request->canonical: reasoning items with encrypted_content attach to the next assistant item", () => {
	const u = responsesRequestToCanonical(
		parse({
			model: "gpt",
			input: [
				{
					type: "reasoning",
					id: "rs_1",
					summary: [],
					encrypted_content: "enc-1",
				},
				{
					type: "function_call",
					call_id: "call_1",
					name: "f",
					arguments: "{}",
				},
				{ type: "function_call_output", call_id: "call_1", output: "ok" },
			],
		}),
	);
	assert.deepEqual(u.messages[0]!.providerFields, {
		openai: {
			reasoning: [{ encrypted_content: "enc-1", id: "rs_1", summary: [] }],
		},
	});
	assert.equal(u.messages[1]!.role, "tool");
});

const renderOpts = (): RenderOptions => ({
	req: parse({ model: "gpt", input: "hi" }),
	upstreamModel: "gpt-x",
});

test("canonical->response: message item, usage, and output_text", () => {
	const resp: CanonicalChatResponse = {
		id: "x",
		created: 1700000000,
		model: "gpt-x",
		choices: [
			{
				index: 0,
				finishReason: "stop",
				message: {
					role: "assistant",
					content: "hello!",
					reasoning: "Analyzed the question.",
				},
			},
		],
		usage: {
			promptTokens: 5,
			completionTokens: 3,
			totalTokens: 8,
			reasoningTokens: 1,
		},
	};
	const out = canonicalToResponsesResponse(resp, renderOpts()) as Record<
		string,
		any
	>;
	assert.equal(out.object, "response");
	assert.equal(out.status, "completed");
	assert.equal(out.output[0].type, "reasoning");
	assert.equal(out.output[0].summary[0].text, "Analyzed the question.");
	assert.equal(out.output[1].type, "message");
	assert.equal(out.output[1].content[0].type, "output_text");
	assert.equal(out.output[1].content[0].text, "hello!");
	assert.equal(out.output_text, "hello!");
	assert.equal(out.usage.input_tokens, 5);
	assert.equal(out.usage.output_tokens, 3);
	assert.equal(out.usage.output_tokens_details.reasoning_tokens, 1);
});

test("canonical->response: echoes previous_response_id and store", () => {
	const resp: CanonicalChatResponse = {
		id: "x",
		created: 1,
		model: "gpt-x",
		choices: [
			{
				index: 0,
				finishReason: "stop",
				message: { role: "assistant", content: "ok" },
			},
		],
		usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
	};
	const out = canonicalToResponsesResponse(resp, {
		req: parse({
			model: "gpt",
			input: "hi",
			previous_response_id: "resp_prev",
			store: true,
		}),
		upstreamModel: "gpt-x",
	}) as Record<string, any>;
	assert.equal(out.previous_response_id, "resp_prev");
	assert.equal(out.store, true);
});

test("canonical->response: tool calls -> function_call items", () => {
	const resp: CanonicalChatResponse = {
		id: "x",
		created: 1,
		model: "gpt-x",
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
							name: "get_weather",
							arguments: '{"city":"CCS"}',
							extraContent: {
								google: { thought_signature: "sig-a" },
							},
						},
					],
				},
			},
		],
		usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
	};
	const out = canonicalToResponsesResponse(resp, renderOpts()) as Record<
		string,
		any
	>;
	const fc = out.output.find((o: any) => o.type === "function_call");
	assert.ok(fc);
	assert.equal(fc.name, "get_weather");
	assert.equal(fc.call_id, "call_1__thought__sig-a");
	assert.deepEqual(fc.extra_content, {
		google: { thought_signature: "sig-a" },
	});
	assert.deepEqual(fc.provider_specific_fields, {
		thought_signature: "sig-a",
	});
	assert.deepEqual(out.provider_specific_fields, {
		thought_signatures: ["sig-a"],
	});
});

test("stream->events: function_call items include opaque extra_content in the completed response", async () => {
	async function* chunks(): AsyncGenerator<CanonicalChatStreamChunk> {
		yield {
			id: "c",
			created: 1,
			model: "gpt-x",
			choices: [
				{
					index: 0,
					delta: {
						role: "assistant",
						toolCalls: [
							{
								index: 0,
								id: "call_123",
								name: "load_skill",
								arguments: '{"name"',
								extraContent: {
									google: { thought_signature: "sig-a" },
								},
							},
						],
					},
					finishReason: null,
				},
			],
		};
		yield {
			id: "c",
			created: 1,
			model: "gpt-x",
			choices: [
				{
					index: 0,
					delta: { toolCalls: [{ index: 0, arguments: ':"image"}' }] },
					finishReason: "tool_calls",
				},
			],
			usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
		};
	}
	let completed: any;
	for await (const ev of canonicalChunksToResponsesEvents(
		chunks(),
		renderOpts(),
	)) {
		if (ev.event === "response.completed")
			completed = JSON.parse(ev.data).response;
	}
	const fc = completed.output.find(
		(item: any) => item.type === "function_call",
	);
	assert.ok(fc.id.startsWith("fc_"));
	assert.equal(fc.call_id, "call_123__thought__sig-a");
	assert.deepEqual(fc.extra_content, {
		google: { thought_signature: "sig-a" },
	});
	assert.deepEqual(fc.provider_specific_fields, {
		thought_signature: "sig-a",
	});
	assert.deepEqual(completed.provider_specific_fields, {
		thought_signatures: ["sig-a"],
	});
});

test("stream->events: OpenResponses sequence for text", async () => {
	async function* chunks(): AsyncGenerator<CanonicalChatStreamChunk> {
		yield {
			id: "c",
			created: 1,
			model: "gpt-x",
			choices: [
				{
					index: 0,
					delta: { role: "assistant", content: "Hel" },
					finishReason: null,
				},
			],
		};
		yield {
			id: "c",
			created: 1,
			model: "gpt-x",
			choices: [{ index: 0, delta: { content: "lo" }, finishReason: "stop" }],
			usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
		};
	}
	const types: string[] = [];
	let completedUsage: any;
	for await (const ev of canonicalChunksToResponsesEvents(
		chunks(),
		renderOpts(),
	)) {
		types.push(ev.event!);
		if (ev.event === "response.completed")
			completedUsage = JSON.parse(ev.data).response.usage;
	}
	assert.deepEqual(types, [
		"response.created",
		"response.in_progress",
		"response.output_item.added",
		"response.content_part.added",
		"response.output_text.delta",
		"response.output_text.delta",
		"response.output_text.done",
		"response.content_part.done",
		"response.output_item.done",
		"response.completed",
	]);
	assert.equal(completedUsage.total_tokens, 3);
});

test("stream->events: reasoning summary streams as its own item before the message", async () => {
	async function* chunks(): AsyncGenerator<CanonicalChatStreamChunk> {
		yield {
			id: "c",
			created: 1,
			model: "gpt-x",
			choices: [
				{
					index: 0,
					delta: { role: "assistant", reasoning: "Think" },
					finishReason: null,
				},
			],
		};
		yield {
			id: "c",
			created: 1,
			model: "gpt-x",
			choices: [{ index: 0, delta: { reasoning: "ing." }, finishReason: null }],
		};
		yield {
			id: "c",
			created: 1,
			model: "gpt-x",
			choices: [{ index: 0, delta: { content: "Hi" }, finishReason: "stop" }],
			usage: {
				promptTokens: 1,
				completionTokens: 2,
				totalTokens: 3,
				reasoningTokens: 2,
			},
		};
	}
	const events: { type: string; data: any }[] = [];
	for await (const ev of canonicalChunksToResponsesEvents(
		chunks(),
		renderOpts(),
	)) {
		events.push({ type: ev.event!, data: JSON.parse(ev.data) });
	}
	assert.deepEqual(
		events.map((e) => e.type),
		[
			"response.created",
			"response.in_progress",
			"response.output_item.added",
			"response.reasoning_summary_part.added",
			"response.reasoning_summary_text.delta",
			"response.reasoning_summary_text.delta",
			"response.reasoning_summary_text.done",
			"response.reasoning_summary_part.done",
			"response.output_item.done",
			"response.output_item.added",
			"response.content_part.added",
			"response.output_text.delta",
			"response.output_text.done",
			"response.content_part.done",
			"response.output_item.done",
			"response.completed",
		],
	);

	const rsAdded = events[2]!.data;
	assert.equal(rsAdded.item.type, "reasoning");
	assert.equal(rsAdded.output_index, 0);
	const textDone = events.find(
		(e) => e.type === "response.reasoning_summary_text.done",
	)!.data;
	assert.equal(textDone.text, "Thinking.");
	const rsDone = events[8]!.data;
	assert.equal(rsDone.item.type, "reasoning");
	assert.deepEqual(rsDone.item.summary, [
		{ type: "summary_text", text: "Thinking." },
	]);
	const msgAdded = events[9]!.data;
	assert.equal(msgAdded.item.type, "message");
	assert.equal(msgAdded.output_index, 1);

	const completed = events.at(-1)!.data.response;
	assert.equal(completed.output[0].type, "reasoning");
	assert.equal(completed.output[0].summary[0].text, "Thinking.");
	assert.equal(completed.output[1].type, "message");
	assert.equal(completed.usage.output_tokens_details.reasoning_tokens, 2);
});

test("stream->events: output_item.added/done share the same suffixed call_id", async () => {
	async function* chunks(): AsyncGenerator<CanonicalChatStreamChunk> {
		yield {
			id: "c",
			created: 1,
			model: "gpt-x",
			choices: [
				{
					index: 0,
					delta: {
						role: "assistant",
						toolCalls: [
							{
								index: 0,
								id: "call_1",
								name: "f",
								arguments: "{}",
								extraContent: { google: { thought_signature: "sig-a" } },
							},
						],
					},
					finishReason: "tool_calls",
				},
			],
		};
	}
	const callIds: string[] = [];
	for await (const ev of canonicalChunksToResponsesEvents(
		chunks(),
		renderOpts(),
	)) {
		if (
			ev.event === "response.output_item.added" ||
			ev.event === "response.output_item.done"
		) {
			const item = JSON.parse(ev.data).item;
			if (item.type === "function_call") callIds.push(item.call_id);
		}
	}
	assert.deepEqual(callIds, [
		"call_1__thought__sig-a",
		"call_1__thought__sig-a",
	]);
});

test("canonical->response: encrypted reasoning state renders as native reasoning items", () => {
	const resp: CanonicalChatResponse = {
		id: "x",
		created: 1,
		model: "gpt-x",
		choices: [
			{
				index: 0,
				finishReason: "tool_calls",
				message: {
					role: "assistant",
					content: null,
					reasoning: "visible summary",
					providerFields: {
						openai: { reasoning: [{ id: "rs_1", encrypted_content: "enc-1" }] },
					},
					toolCalls: [{ id: "call_1", name: "f", arguments: "{}" }],
				},
			},
		],
		usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
	};
	const out = canonicalToResponsesResponse(resp, renderOpts()) as Record<
		string,
		any
	>;
	const rs = out.output.filter((o: any) => o.type === "reasoning");
	assert.equal(rs.length, 1);
	assert.equal(rs[0].id, "rs_1");
	assert.equal(rs[0].encrypted_content, "enc-1");
	// The visible summary folds into the state item instead of a second reasoning item.
	assert.deepEqual(rs[0].summary, [
		{ type: "summary_text", text: "visible summary" },
	]);
	// State precedes the function_call item.
	assert.ok(
		out.output.findIndex((o: any) => o.type === "reasoning") <
			out.output.findIndex((o: any) => o.type === "function_call"),
	);
});

test("responses surface: encrypted reasoning round trip (render -> replay -> canonical)", () => {
	const resp: CanonicalChatResponse = {
		id: "x",
		created: 1,
		model: "gpt-x",
		choices: [
			{
				index: 0,
				finishReason: "tool_calls",
				message: {
					role: "assistant",
					content: null,
					providerFields: {
						openai: { reasoning: [{ id: "rs_1", encrypted_content: "enc-1" }] },
					},
					toolCalls: [{ id: "call_1", name: "f", arguments: "{}" }],
				},
			},
		],
		usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
	};
	const rendered = canonicalToResponsesResponse(resp, renderOpts()) as Record<
		string,
		any
	>;
	// A replay client echoes the output items and appends the tool result.
	const u = responsesRequestToCanonical(
		parse({
			model: "gpt",
			input: [
				...rendered.output,
				{
					type: "function_call_output",
					call_id: rendered.output.find((o: any) => o.type === "function_call")
						.call_id,
					output: "ok",
				},
			],
		}),
	);
	const assistant = u.messages.find((m) => m.role === "assistant");
	assert.deepEqual(assistant?.providerFields, {
		openai: {
			reasoning: [{ encrypted_content: "enc-1", id: "rs_1", summary: [] }],
		},
	});
});

test("stream->events: accumulated encrypted reasoning emits trailing items before tool calls", async () => {
	async function* chunks(): AsyncGenerator<CanonicalChatStreamChunk> {
		yield {
			id: "c",
			created: 1,
			model: "gpt-x",
			choices: [
				{
					index: 0,
					delta: {
						role: "assistant",
						providerFields: {
							openai: {
								reasoning: [{ id: "rs_1", encrypted_content: "enc-1" }],
							},
						},
					},
					finishReason: null,
				},
			],
		};
		yield {
			id: "c",
			created: 1,
			model: "gpt-x",
			choices: [
				{
					index: 0,
					delta: {
						toolCalls: [{ index: 0, id: "call_1", name: "f", arguments: "{}" }],
					},
					finishReason: "tool_calls",
				},
			],
		};
	}
	let completed: any;
	const order: string[] = [];
	for await (const ev of canonicalChunksToResponsesEvents(
		chunks(),
		renderOpts(),
	)) {
		if (ev.event === "response.output_item.done")
			order.push(JSON.parse(ev.data).item.type);
		if (ev.event === "response.completed")
			completed = JSON.parse(ev.data).response;
	}
	assert.deepEqual(order, ["reasoning", "function_call"]);
	const rs = completed.output.find((o: any) => o.type === "reasoning");
	assert.equal(rs.encrypted_content, "enc-1");
	assert.equal(rs.id, "rs_1");
});

test("response object: every OpenResponses 2.3 required field is present", () => {
	const response = canonicalToResponsesResponse(
		{
			id: "response-1",
			created: 1,
			model: "response-model",
			choices: [
				{
					index: 0,
					finishReason: "stop",
					message: { role: "assistant", content: "ok" },
				},
			],
			usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
		},
		{
			req: parse({ model: "response-model", input: "hi" }),
			upstreamModel: "response-model",
		},
	);
	for (const field of [
		"completed_at",
		"presence_penalty",
		"frequency_penalty",
		"top_logprobs",
		"max_tool_calls",
		"service_tier",
		"safety_identifier",
		"prompt_cache_key",
	])
		assert.equal(Object.hasOwn(response, field), true, field);
});

test("response include: encrypted reasoning is exposed only when requested", () => {
	const internal = {
		id: "response-1",
		output: [
			{
				type: "reasoning",
				id: "reasoning-1",
				summary: [],
				encrypted_content: "opaque",
			},
		],
	};
	const hidden = responseForClient(internal, undefined);
	assert.equal("encrypted_content" in (hidden.output as any[])[0], false);
	assert.equal(
		(
			responseForClient(internal, ["reasoning.encrypted_content"])
				.output as any[]
		)[0].encrypted_content,
		"opaque",
	);
	const event = responseEventForClient(
		{
			event: "response.output_item.done",
			data: JSON.stringify({
				type: "response.output_item.done",
				item: internal.output[0],
			}),
		},
		undefined,
	);
	assert.equal("encrypted_content" in JSON.parse(event.data).item, false);
});

test("request fidelity: file URLs, phases, multimodal outputs, and allowed tools survive", () => {
	const canonical = responsesRequestToCanonical(
		parse({
			model: "response-model",
			input: [
				{
					type: "message",
					role: "assistant",
					phase: "commentary",
					content: [
						{ type: "input_file", file_url: "https://example.com/a.pdf" },
					],
				},
				{
					type: "function_call_output",
					call_id: "call-1",
					output: [{ type: "input_text", text: "done" }],
				},
			],
			tool_choice: {
				type: "allowed_tools",
				mode: "required",
				tools: [{ type: "function", name: "lookup" }],
			},
		}),
	);
	assert.equal(canonical.messages[0]?.phase, "commentary");
	assert.equal(
		(canonical.messages[0]?.content as any[])[0]?.fileUrl,
		"https://example.com/a.pdf",
	);
	assert.deepEqual(canonical.messages[1]?.content, [
		{ type: "text", text: "done" },
	]);
	assert.deepEqual(canonical.toolChoice, {
		allowedTools: ["lookup"],
		mode: "required",
	});
});

test("request fidelity: native-only items are retained instead of silently dropped", () => {
	const input = [
		{
			type: "computer_call_output",
			call_id: "call-1",
			output: {
				type: "computer_screenshot",
				image_url: "data:image/png;base64,AA==",
			},
		},
	];
	const canonical = responsesRequestToCanonical(
		parse({ model: "response-model", input }),
	);
	assert.equal(canonical.requiresNativeWire, true);
	assert.deepEqual(canonical.responsesTransport?.rawInput, input);
});
