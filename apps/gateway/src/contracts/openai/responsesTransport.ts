/**
 * OpenAI Responses API as an UPSTREAM TRANSPORT. Used by the `openai` adapter (whose native transport
 * is /responses) to talk to the provider: translates the canonical request to the /responses body, and
 * parses the /responses response/events back into canonical types.
 *
 * (responsesRender.ts is the EDGE with the client; responsesTransport.ts is the transport with the PROVIDER.)
 *
 * Parameters managed by the gateway (previous_response_id, store, item_reference, background) do NOT
 * exist in the canonical type, so they are never forwarded to the upstream.
 */

import { mergeExtraBody } from "#core/extraBody.ts";
import { GatewayError } from "#core/errors.ts";
import type { SSEEvent } from "#core/sse.ts";
import type { Usage } from "#core/usage.ts";
import { randomUUID } from "node:crypto";

import type {
	CanonicalChatStreamChunk,
	CanonicalResponseFormat,
	CanonicalChatResponse,
	CanonicalFinishReason,
	CanonicalChatRequest,
	CanonicalContentPart,
	CanonicalMessage,
} from "#core/canonical.ts";

import {
	toUpstreamReasoningEffort,
	type ResolvedReasoning,
	type ReasoningSpec,
	resolveReasoning,
	summaryVisible,
} from "#core/reasoning.ts";

const OPENAI_RESPONSES_TRANSPORT_MANAGED_KEYS = [
	"model",
	"input",
	"stream",
	"instructions",
	"max_output_tokens",
	"temperature",
	"top_p",
	"presence_penalty",
	"frequency_penalty",
	"parallel_tool_calls",
	"tools",
	"tool_choice",
	"include",
	"metadata",
	"text",
	"reasoning",
	"stream_options",
	"service_tier",
	"safety_identifier",
	"prompt_cache_key",
	"top_logprobs",
	"max_tool_calls",
] as const;

/* ------------------------------------------------- canonical -> /responses body */

function resolveOpenAIReasoning(
	req: CanonicalChatRequest,
	spec: ReasoningSpec | undefined,
): ResolvedReasoning | undefined {
	const effort = req.reasoning?.effort;
	if (!spec) {
		if (effort === undefined || effort === "none") return undefined;
		throw new GatewayError({
			class: "bad_request",
			message:
				"The selected model does not support OpenAI-style reasoning controls",
			code: "unsupported_model_capability",
			param: "reasoning",
		});
	}
	if (spec.kind !== "openai_effort") {
		throw new GatewayError({
			class: "bad_request",
			message: `Reasoning control "${spec.kind}" cannot be emitted as OpenAI reasoning.effort`,
			code: "unsupported_model_capability",
			param: "reasoning",
		});
	}
	return resolveReasoning(req.reasoning, spec);
}

function toResponsesTextFormat(
	format: CanonicalResponseFormat,
): Record<string, unknown> {
	if (format.type !== "json_schema") return { type: format.type };
	return {
		type: "json_schema",
		name: format.name ?? "structured_output",
		schema: format.schema,
		...(format.description !== undefined
			? { description: format.description }
			: {}),
		...(format.strict !== undefined ? { strict: format.strict } : {}),
	};
}

function partToInput(
	p: CanonicalContentPart,
	role: "user" | "assistant",
): Record<string, unknown> | null {
	switch (p.type) {
		case "text":
			return {
				type: role === "assistant" ? "output_text" : "input_text",
				text: p.text,
			};
		case "image":
			return {
				type: "input_image",
				image_url: p.url,
				...(p.detail !== undefined ? { detail: p.detail } : {}),
			};
		case "file":
			return {
				type: "input_file",
				...(p.fileId !== undefined ? { file_id: p.fileId } : {}),
				...(p.fileData !== undefined ? { file_data: p.fileData } : {}),
				...(p.filename !== undefined ? { filename: p.filename } : {}),
			};
		case "audio":
			return null; // /responses has no standard audio input
	}
}

function contentToInput(
	content: CanonicalMessage["content"],
	role: "user" | "assistant",
): Record<string, unknown>[] {
	if (content === null) return [];
	if (typeof content === "string") {
		return [
			{
				type: role === "assistant" ? "output_text" : "input_text",
				text: content,
			},
		];
	}
	return content
		.map((p) => partToInput(p, role))
		.filter((x): x is Record<string, unknown> => x !== null);
}

export function buildResponsesRequestBody(
	req: CanonicalChatRequest,
	upstreamModel: string,
	reasoningSpec?: ReasoningSpec,
): Record<string, unknown> {
	const input: Record<string, unknown>[] = [];
	const instructions: string[] = [];

	for (const m of req.messages) {
		if (m.role === "system" || m.role === "developer") {
			if (typeof m.content === "string") instructions.push(m.content);
			else if (Array.isArray(m.content)) {
				instructions.push(
					m.content
						.filter((p) => p.type === "text")
						.map((p) => (p as { text: string }).text)
						.join("\n"),
				);
			}
			continue;
		}
		if (m.role === "tool") {
			input.push({
				type: "function_call_output",
				call_id: m.toolCallId ?? "",
				output:
					typeof m.content === "string"
						? m.content
						: JSON.stringify(m.content ?? ""),
			});
			continue;
		}
		if (m.role === "assistant") {
			if (m.content)
				input.push({
					type: "message",
					role: "assistant",
					content: contentToInput(m.content, "assistant"),
				});
			for (const tc of m.toolCalls ?? []) {
				input.push({
					type: "function_call",
					call_id: tc.id,
					name: tc.name,
					arguments: tc.arguments,
				});
			}
			continue;
		}
		input.push({
			type: "message",
			role: "user",
			content: contentToInput(m.content, "user"),
		});
	}

	const body: Record<string, unknown> = {
		model: upstreamModel,
		input,
		stream: req.stream,
	};
	if (instructions.length > 0) body.instructions = instructions.join("\n");
	if (req.maxTokens !== undefined) body.max_output_tokens = req.maxTokens;
	if (req.temperature !== undefined) body.temperature = req.temperature;
	if (req.topP !== undefined) body.top_p = req.topP;
	if (req.presencePenalty !== undefined)
		body.presence_penalty = req.presencePenalty;
	if (req.frequencyPenalty !== undefined)
		body.frequency_penalty = req.frequencyPenalty;
	if (req.parallelToolCalls !== undefined)
		body.parallel_tool_calls = req.parallelToolCalls;
	if (req.tools) {
		body.tools = req.tools.map((t) => ({
			type: "function",
			name: t.name,
			...(t.description !== undefined ? { description: t.description } : {}),
			...(t.parameters !== undefined ? { parameters: t.parameters } : {}),
			...(t.strict !== undefined ? { strict: t.strict } : {}),
		}));
	}
	if (req.toolChoice !== undefined) {
		body.tool_choice =
			typeof req.toolChoice === "string"
				? req.toolChoice
				: { type: "function", name: req.toolChoice.name };
	}
	if (req.responsesTransport?.include !== undefined)
		body.include = req.responsesTransport.include;
	if (req.responsesTransport?.metadata !== undefined)
		body.metadata = req.responsesTransport.metadata;
	const text = { ...(req.responsesTransport?.text ?? {}) };
	if (req.responseFormat !== undefined)
		text.format = toResponsesTextFormat(req.responseFormat);
	if (Object.keys(text).length > 0) body.text = text;
	const resolvedReasoning = resolveOpenAIReasoning(req, reasoningSpec);
	if (
		req.responsesTransport?.reasoning !== undefined ||
		resolvedReasoning !== undefined
	) {
		body.reasoning = {
			...(req.responsesTransport?.reasoning ?? {}),
			...(resolvedReasoning !== undefined
				? {
						effort: toUpstreamReasoningEffort(
							resolvedReasoning.effort,
							reasoningSpec!,
						),
					}
				: {}),
			...(resolvedReasoning && summaryVisible(resolvedReasoning.summary)
				? { summary: resolvedReasoning.summary }
				: {}),
		};
	}
	if (req.responsesTransport?.streamOptions !== undefined)
		body.stream_options = req.responsesTransport.streamOptions;
	if (req.responsesTransport?.serviceTier !== undefined)
		body.service_tier = req.responsesTransport.serviceTier;
	if (req.responsesTransport?.safetyIdentifier !== undefined)
		body.safety_identifier = req.responsesTransport.safetyIdentifier;
	// The /responses contract carries it in responsesTransport; a /chat request routed to this
	// transport (OpenAI uses /responses as its native transport) carries it in the top-level promptCacheKey.
	const promptCacheKey =
		req.responsesTransport?.promptCacheKey ?? req.promptCacheKey;
	if (promptCacheKey !== undefined) body.prompt_cache_key = promptCacheKey;
	if (req.responsesTransport?.topLogprobs !== undefined)
		body.top_logprobs = req.responsesTransport.topLogprobs;
	if (req.responsesTransport?.maxToolCalls !== undefined)
		body.max_tool_calls = req.responsesTransport.maxToolCalls;
	return mergeExtraBody(
		body,
		req.extraBody,
		OPENAI_RESPONSES_TRANSPORT_MANAGED_KEYS,
	);
}

/* ------------------------------------------------- /responses -> canonical */

interface RWUsage {
	input_tokens?: number;
	output_tokens?: number;
	total_tokens?: number;
	input_tokens_details?: { cached_tokens?: number };
	output_tokens_details?: { reasoning_tokens?: number };
}

function mapUsage(u: RWUsage | undefined | null): Usage {
	const usage: Usage = {
		promptTokens: u?.input_tokens ?? 0,
		completionTokens: u?.output_tokens ?? 0,
		totalTokens: u?.total_tokens ?? 0,
	};
	if (u?.input_tokens_details?.cached_tokens !== undefined)
		usage.cacheReadTokens = u.input_tokens_details.cached_tokens;
	if (u?.output_tokens_details?.reasoning_tokens !== undefined)
		usage.reasoningTokens = u.output_tokens_details.reasoning_tokens;
	return usage;
}

interface RWOutputItem {
	type?: string;
	content?: Array<{ type?: string; text?: string }>;
	summary?: Array<{ type?: string; text?: string } | string>;
	call_id?: string;
	id?: string;
	name?: string;
	arguments?: string;
}
interface RWResponse {
	id?: string;
	created_at?: number;
	model?: string;
	status?: string;
	incomplete_details?: { reason?: string };
	output?: RWOutputItem[];
	usage?: RWUsage;
}

function finishFrom(
	r: RWResponse,
	hasToolCalls: boolean,
): CanonicalFinishReason {
	if (hasToolCalls) return "tool_calls";
	if (r.status === "incomplete") {
		return r.incomplete_details?.reason === "max_output_tokens"
			? "length"
			: "content_filter";
	}
	return "stop";
}

export function parseResponsesResponse(raw: unknown): CanonicalChatResponse {
	const r = (raw ?? {}) as RWResponse;
	let content = "";
	const reasoning: string[] = [];
	const toolCalls: NonNullable<
		CanonicalChatResponse["choices"][number]["message"]["toolCalls"]
	> = [];
	for (const item of r.output ?? []) {
		if (item.type === "message") {
			for (const c of item.content ?? [])
				if (c.type === "output_text") content += c.text ?? "";
		} else if (item.type === "reasoning") {
			for (const s of item.summary ?? []) {
				if (typeof s === "string") reasoning.push(s);
				else if (s.text) reasoning.push(s.text);
			}
		} else if (item.type === "function_call") {
			toolCalls.push({
				id: item.call_id ?? item.id ?? "",
				name: item.name ?? "",
				arguments: item.arguments ?? "",
			});
		}
	}
	const message: CanonicalChatResponse["choices"][number]["message"] = {
		role: "assistant",
		content: content.length > 0 ? content : null,
	};
	if (reasoning.length > 0) message.reasoning = reasoning.join("\n\n");
	if (toolCalls.length > 0) message.toolCalls = toolCalls;
	return {
		id: r.id ?? `resp-${randomUUID()}`,
		created: r.created_at ?? Math.floor(Date.now() / 1000),
		model: r.model ?? "",
		choices: [
			{ index: 0, finishReason: finishFrom(r, toolCalls.length > 0), message },
		],
		usage: mapUsage(r.usage),
	};
}

/* ------------------------------------------------- /responses SSE -> canonical chunks */

export async function* responsesEventsToCanonicalChunks(
	events: AsyncIterable<SSEEvent>,
): AsyncGenerator<CanonicalChatStreamChunk> {
	const created = Math.floor(Date.now() / 1000);
	let id = "";
	let model = "";
	let roleSent = false;

	const base = () => ({ id, created, model });

	for await (const ev of events) {
		if (ev.data === "[DONE]") return;
		let d: Record<string, unknown>;
		try {
			d = JSON.parse(ev.data) as Record<string, unknown>;
		} catch {
			continue;
		}
		const type = (ev.event ?? d.type) as string | undefined;

		if (type === "response.created" || type === "response.in_progress") {
			const resp = d.response as { id?: string; model?: string } | undefined;
			if (resp?.id) id = resp.id;
			if (resp?.model) model = resp.model;
			continue;
		}

		if (type === "response.output_text.delta") {
			const delta: CanonicalChatStreamChunk["choices"][number]["delta"] = {};
			if (!roleSent) {
				delta.role = "assistant";
				roleSent = true;
			}
			delta.content = String(d.delta ?? "");
			yield { ...base(), choices: [{ index: 0, delta, finishReason: null }] };
			continue;
		}

		if (
			type === "response.reasoning_summary_text.delta" ||
			type === "response.reasoning_summary.delta" ||
			type === "response.reasoning.delta"
		) {
			const delta: CanonicalChatStreamChunk["choices"][number]["delta"] = {};
			if (!roleSent) {
				delta.role = "assistant";
				roleSent = true;
			}
			delta.reasoning = String(d.delta ?? "");
			yield { ...base(), choices: [{ index: 0, delta, finishReason: null }] };
			continue;
		}

		if (type === "response.output_item.added") {
			const item = d.item as
				| { type?: string; call_id?: string; name?: string }
				| undefined;
			if (item?.type === "function_call") {
				const idx = Number(d.output_index ?? 0);
				yield {
					...base(),
					choices: [
						{
							index: 0,
							delta: {
								toolCalls: [
									{
										index: idx,
										id: item.call_id ?? "",
										name: item.name ?? "",
										arguments: "",
									},
								],
							},
							finishReason: null,
						},
					],
				};
			}
			continue;
		}

		if (type === "response.function_call_arguments.delta") {
			const idx = Number(d.output_index ?? 0);
			yield {
				...base(),
				choices: [
					{
						index: 0,
						delta: {
							toolCalls: [{ index: idx, arguments: String(d.delta ?? "") }],
						},
						finishReason: null,
					},
				],
			};
			continue;
		}

		if (type === "response.completed" || type === "response.incomplete") {
			const r = (d.response ?? {}) as RWResponse;
			const hasTool = (r.output ?? []).some(
				(it) => it.type === "function_call",
			);
			yield {
				...base(),
				choices: [
					{ index: 0, delta: {}, finishReason: finishFrom(r, hasTool) },
				],
				usage: mapUsage(r.usage),
			};
			return;
		}
	}
}
