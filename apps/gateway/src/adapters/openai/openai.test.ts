import type { CanonicalEmbeddingsRequest } from "#core/embeddings.ts";
import type { CanonicalChatRequest } from "#core/canonical.ts";
import type { AdapterContext } from "#adapters/types.ts";
import { openaiAdapter } from "./index.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

const ctx: AdapterContext = {
	upstreamModel: "gpt-5.5",
	credentials: { apiKey: "sk-test", organization: "org_1" },
	meta: {
		capabilities: {
			tools: true,
			vision: true,
			reasoning: false,
			structuredOutputs: true,
		},
	},
	transport: "responses",
	requestId: "t",
};

const reasoningCtx: AdapterContext = {
	...ctx,
	meta: {
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
	},
};

const baseReq: CanonicalChatRequest = {
	callType: "chat",
	model: "gpt",
	messages: [{ role: "user", content: "hello" }],
	stream: false,
	temperature: 0.7,
	maxTokens: 100,
};

const embeddingsCtx: AdapterContext = {
	...ctx,
	upstreamModel: "text-embedding-3-small",
	transport: "embeddings",
	meta: {
		...ctx.meta,
		operations: {
			"embedding.create": {
				dimensions: 1536,
				supportsDimensions: true,
				encodingFormats: ["float", "base64"],
			},
		},
	},
};

const embeddingsReq: CanonicalEmbeddingsRequest = {
	model: "emb",
	input: ["hello", "world"],
	encodingFormat: "float",
	dimensions: 256,
	user: "user-1",
};

test("openai.buildRequest: native /responses transport, auth, and responses body", () => {
	const r = openaiAdapter.chat!.buildRequest(baseReq, ctx);
	assert.equal(r.method, "POST");
	assert.equal(r.url, "https://api.openai.com/v1/responses"); // transport upstream = /responses
	assert.equal(r.headers.authorization, "Bearer sk-test");
	assert.equal(r.headers["openai-organization"], "org_1");
	const body = JSON.parse(r.body!);
	assert.equal(body.model, "gpt-5.5");
	assert.equal(body.max_output_tokens, 100);
	assert.equal(body.input[0].content[0].text, "hello");
});

test("openai.buildRequest: forwards /responses transport options", () => {
	const r = openaiAdapter.chat!.buildRequest(
		{
			...baseReq,
			responsesTransport: {
				include: ["message.output_text.logprobs"],
				metadata: { trace: "abc" },
				text: { format: { type: "text" } },
				reasoning: { effort: "low" },
				streamOptions: { include_usage: true },
				serviceTier: "flex",
				safetyIdentifier: "user-1",
				promptCacheKey: "thread-1",
				topLogprobs: 2,
				maxToolCalls: 4,
			},
		},
		ctx,
	);
	const body = JSON.parse(r.body!);
	assert.deepEqual(body.include, ["message.output_text.logprobs"]);
	assert.deepEqual(body.metadata, { trace: "abc" });
	assert.deepEqual(body.text, { format: { type: "text" } });
	assert.deepEqual(body.reasoning, { effort: "low" });
	assert.deepEqual(body.stream_options, { include_usage: true });
	assert.equal(body.service_tier, "flex");
	assert.equal(body.safety_identifier, "user-1");
	assert.equal(body.prompt_cache_key, "thread-1");
	assert.equal(body.top_logprobs, 2);
	assert.equal(body.max_tool_calls, 4);
});

test("openai.buildRequest: canonical format is emitted as /responses text.format", () => {
	const schema = {
		type: "object",
		properties: { answer: { type: "string" } },
		required: ["answer"],
	};
	const r = openaiAdapter.chat!.buildRequest(
		{
			...baseReq,
			responseFormat: {
				type: "json_schema",
				schema,
				description: "Answer",
				strict: true,
			},
			responsesTransport: { text: { verbosity: "low" } },
		},
		ctx,
	);
	assert.deepEqual(JSON.parse(r.body!).text, {
		verbosity: "low",
		format: {
			type: "json_schema",
			name: "structured_output",
			description: "Answer",
			schema,
			strict: true,
		},
	});
});

test("openai.buildRequest: omitted effort on model that can skip reasoning -> effort none (without summary)", () => {
	// reasoningCtx has canDisable=true: the gateway default is NOT to reason.
	const r = openaiAdapter.chat!.buildRequest(baseReq, reasoningCtx);
	assert.deepEqual(JSON.parse(r.body!).reasoning, { effort: "none" });
});

test("openai.buildRequest: omitted effort on MANDATORY reasoner -> lowest level + auto summary", () => {
	const forcedCtx: AdapterContext = {
		...ctx,
		meta: {
			capabilities: {
				tools: true,
				vision: true,
				reasoning: true,
				structuredOutputs: true,
			},
			reasoning: {
				kind: "openai_effort",
				levels: ["low", "medium", "high"],
				canDisable: false,
			},
		},
	};
	const r = openaiAdapter.chat!.buildRequest(baseReq, forcedCtx);
	assert.deepEqual(JSON.parse(r.body!).reasoning, {
		effort: "low",
		summary: "auto",
	});
});

test("openai.buildRequest: canonical reasoning is clamped and merged with summary", () => {
	const r = openaiAdapter.chat!.buildRequest(
		{
			...baseReq,
			reasoning: { effort: "xhigh" },
			responsesTransport: { reasoning: { summary: "auto" } },
			extraBody: { custom_param: true },
		},
		reasoningCtx,
	);
	const body = JSON.parse(r.body!);
	assert.deepEqual(body.reasoning, { summary: "auto", effort: "high" });
	assert.equal(body.custom_param, true);
});

test("openai.buildRequest: translates canonical effort to upstream vocabulary", () => {
	const mappedCtx: AdapterContext = {
		...reasoningCtx,
		meta: {
			...reasoningCtx.meta,
			reasoning: {
				kind: "openai_effort",
				levels: ["high", "xhigh"],
				canDisable: true,
				upstreamEffortMap: { xhigh: "max" },
			},
		},
	};
	const r = openaiAdapter.chat!.buildRequest(
		{ ...baseReq, reasoning: { effort: "xhigh" } },
		mappedCtx,
	);
	assert.deepEqual(JSON.parse(r.body!).reasoning, {
		effort: "max",
		summary: "auto",
	});
});

test("openai.buildRequest: extraBody does not overwrite managed fields", () => {
	assert.throws(
		() =>
			openaiAdapter.chat!.buildRequest(
				{ ...baseReq, extraBody: { reasoning: { effort: "low" } } },
				reasoningCtx,
			),
		/extra_body.reasoning/,
	);
});

test("openai.parseResponse: /responses output -> canonical", () => {
	const raw = {
		id: "resp_1",
		created_at: 1700000000,
		model: "gpt-5.5",
		status: "completed",
		output: [
			{
				type: "reasoning",
				summary: [{ type: "summary_text", text: "Penbe brief." }],
			},
			{
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: "hello!" }],
			},
		],
		usage: {
			input_tokens: 10,
			output_tokens: 3,
			total_tokens: 13,
			input_tokens_details: { cached_tokens: 2 },
		},
	};
	const u = openaiAdapter.chat!.parseResponse(raw, ctx);
	assert.equal(u.choices[0]!.message.content, "hello!");
	assert.equal(u.choices[0]!.message.reasoning, "Penbe brief.");
	assert.equal(u.choices[0]!.finishReason, "stop");
	assert.equal(u.usage.totalTokens, 13);
	assert.equal(u.usage.cacheReadTokens, 2);
});

test("openai.parseResponse: function_call -> tool_calls", () => {
	const raw = {
		id: "resp_2",
		status: "completed",
		output: [
			{ type: "function_call", call_id: "call_1", name: "f", arguments: "{}" },
		],
		usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
	};
	const u = openaiAdapter.chat!.parseResponse(raw, ctx);
	assert.equal(u.choices[0]!.finishReason, "tool_calls");
	assert.equal(u.choices[0]!.message.toolCalls?.[0]?.name, "f");
});

test("openai.parseStream: response.* events -> canonical deltas", async () => {
	const sse =
		`event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5.5"}}\n\n` +
		`event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hel"}\n\n` +
		`event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"lo"}\n\n` +
		`event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}}}\n\n`;
	const stream = new Response(sse).body!;
	const out: string[] = [];
	let lastFinish: string | null = null;
	let total: number | undefined;
	for await (const chunk of openaiAdapter.chat!.parseStream(stream, ctx)) {
		if (chunk.choices[0]?.delta.content)
			out.push(chunk.choices[0].delta.content);
		if (chunk.choices[0]?.finishReason)
			lastFinish = chunk.choices[0].finishReason;
		if (chunk.usage) total = chunk.usage.totalTokens;
	}
	assert.equal(out.join(""), "Hello");
	assert.equal(lastFinish, "stop");
	assert.equal(total, 3);
});

test("openai.mapError: 429 -> rate_limit; 400 context_length_exceeded -> context_window", () => {
	const rl = openaiAdapter.chat!.mapError(
		{ status: 429, body: { error: { message: "slow" } } },
		ctx,
	);
	assert.equal(rl.class, "rate_limit");
	const ctxErr = openaiAdapter.chat!.mapError(
		{
			status: 400,
			body: { error: { code: "context_length_exceeded", message: "too long" } },
		},
		ctx,
	);
	assert.equal(ctxErr.class, "context_window");
});

test("openai.mapError: 400 without code but with context message -> context_window", () => {
	// The /responses transport does not always fill `code`; it must fall back to the message.
	const ge = openaiAdapter.chat!.mapError(
		{
			status: 400,
			body: {
				error: {
					message:
						"This model's maximum context length is 400000 tokens. However, you requested 500000.",
				},
			},
		},
		ctx,
	);
	assert.equal(ge.class, "context_window");
});

test("openai embeddings handler: POST /embeddings with OpenAI body", () => {
	assert.equal(openaiAdapter.supportedCallTypes.has("embeddings"), true);
	const r = openaiAdapter.embeddings!.buildRequest(
		embeddingsReq,
		embeddingsCtx,
	);
	assert.equal(r.method, "POST");
	assert.equal(r.url, "https://api.openai.com/v1/embeddings");
	assert.equal(r.headers.authorization, "Bearer sk-test");
	const body = JSON.parse(r.body!);
	assert.deepEqual(body, {
		model: "text-embedding-3-small",
		input: ["hello", "world"],
		encoding_format: "float",
		dimensions: 256,
		user: "user-1",
	});
	const parsed = openaiAdapter.embeddings!.parseResponse(
		{
			object: "list",
			model: "text-embedding-3-small",
			data: [{ object: "embedding", embedding: [1, 2], index: 0 }],
			usage: { prompt_tokens: 2, total_tokens: 2 },
		},
		embeddingsCtx,
	);
	assert.deepEqual(parsed.usage, { promptTokens: 2, totalTokens: 2 });
});
