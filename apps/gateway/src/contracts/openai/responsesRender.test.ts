import { responsesRequestSchema } from "./responses.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

import {
	canonicalChunksToResponsesEvents,
	resolveResponseInputReferences,
	canonicalToResponsesResponse,
	responsesRequestToCanonical,
	normalizeResponseInput,
	expandInputReferences,
	type RenderOptions,
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
				{ type: "function_call", call_id: "c1", name: "f", arguments: "{}" },
				{ type: "function_call_output", call_id: "c1", output: "42" },
			],
		}),
	);
	assert.deepEqual(u.messages[0]!.content, [{ type: "text", text: "hi" }]);
	assert.equal(u.messages[1]!.toolCalls?.[0]?.name, "f");
	assert.equal(u.messages[2]!.role, "tool");
	assert.equal(u.messages[2]!.toolCallId, "c1");
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
	// standalone conversation is accepted; background:false too.
	assert.equal(
		responsesRequestSchema.safeParse({
			model: "gpt",
			input: "hi",
			conversation: "conv_1",
		}).success,
		true,
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
						{ id: "call_1", name: "get_weather", arguments: '{"city":"CCS"}' },
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
	assert.equal(fc.call_id, "call_1");
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
