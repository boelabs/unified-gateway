import { assertNoManagedExtraBodyKeys } from "#core/extraBody.ts";
import type { ResponsesRequest } from "./responses.ts";
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
	CanonicalToolChoice,
	CanonicalMessage,
	CanonicalRole,
} from "#core/canonical.ts";

import {
	type ReasoningSummary,
	isReasoningEffort,
	summaryForEffort,
} from "#core/reasoning.ts";

/* =====================================================================
 * OpenResponses ⟷ canonical types (provider-agnostic render).
 * /v1/responses translates the request to canonical, calls the adapter (chat), and
 * renders the canonical result back to the OpenResponses contract.
 * ===================================================================== */

const RESPONSES_EXTRA_BODY_MANAGED_KEYS = [
	"model",
	"input",
	"instructions",
	"previous_response_id",
	"stream",
	"store",
	"background",
	"tools",
	"tool_choice",
	"parallel_tool_calls",
	"reasoning",
	"text",
	"include",
	"truncation",
	"max_output_tokens",
	"max_tool_calls",
	"temperature",
	"top_p",
	"presence_penalty",
	"frequency_penalty",
	"metadata",
	"service_tier",
	"stream_options",
	"safety_identifier",
	"prompt_cache_key",
	"top_logprobs",
	"user",
	"conversation",
	"prompt",
	"extra_body",
] as const;

/* ---------------------------------------------- request -> canonical */

function mapInputPart(
	part: Record<string, unknown>,
): CanonicalContentPart | null {
	const type = part.type as string | undefined;
	switch (type) {
		case "input_text":
		case "output_text":
		case "text":
			return { type: "text", text: String(part.text ?? "") };
		case "input_image": {
			const url = part.image_url;
			if (typeof url === "string") {
				return part.detail !== undefined
					? {
							type: "image",
							url,
							detail: part.detail as "auto" | "low" | "high",
						}
					: { type: "image", url };
			}
			if (typeof part.file_id === "string")
				return { type: "file", fileId: part.file_id };
			return null;
		}
		case "input_file": {
			const f: CanonicalContentPart = { type: "file" };
			if (typeof part.file_id === "string") f.fileId = part.file_id;
			if (typeof part.file_data === "string") f.fileData = part.file_data;
			if (typeof part.filename === "string") f.filename = part.filename;
			return f;
		}
		default:
			return null;
	}
}

function mapMessageContent(
	content: unknown,
): string | CanonicalContentPart[] | null {
	if (content === null || content === undefined) return null;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const parts: CanonicalContentPart[] = [];
		for (const p of content) {
			const mapped = mapInputPart(p as Record<string, unknown>);
			if (mapped) parts.push(mapped);
		}
		return parts;
	}
	return null;
}

function mapToolChoice(
	tc: ResponsesRequest["tool_choice"],
): CanonicalToolChoice | undefined {
	if (tc === undefined) return undefined;
	if (typeof tc === "string") {
		return tc === "auto" || tc === "none" || tc === "required" ? tc : "auto";
	}
	const name = (tc as { name?: string }).name;
	return name ? { name } : "auto";
}

export type ResponseInputItem = Record<string, unknown>;

function cloneItem<T>(value: T): T {
	return structuredClone(value);
}

function itemId(item: ResponseInputItem): string | null {
	return typeof item.id === "string" && item.id.length > 0 ? item.id : null;
}

export function normalizeResponseInput(
	input: ResponsesRequest["input"],
): ResponseInputItem[] {
	if (input === undefined) return [];
	if (typeof input === "string") {
		return [
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: input }],
			},
		];
	}
	return input.map((item) => cloneItem(item as ResponseInputItem));
}

export function resolveResponseInputReferences(
	input: ResponseInputItem[],
	referenceItems: ResponseInputItem[] = [],
): ResponseInputItem[] {
	const byId = new Map<string, ResponseInputItem>();
	for (const item of referenceItems) {
		const id = itemId(item);
		if (id) byId.set(id, item);
	}

	const resolved: ResponseInputItem[] = [];
	for (const raw of input) {
		const type = (raw.type as string | undefined) ?? "message";
		if (type === "item_reference") {
			const id = typeof raw.id === "string" ? raw.id : "";
			const found = byId.get(id);
			if (!found) {
				throw new GatewayError({
					class: "bad_request",
					message: `item_reference target not found: ${id}`,
					publicMessage: `Item with id '${id}' not found.`,
					code: "item_reference_not_found",
					param: "input",
				});
			}
			resolved.push(cloneItem(found));
			continue;
		}

		const item = cloneItem(raw);
		resolved.push(item);
		const id = itemId(item);
		if (id) byId.set(id, item);
	}
	return resolved;
}

/**
 * Resolve `item_reference`s in the input, faithful to OpenAI: a reference may point to ANY stored
 * item (when store=true), not only items brought in via `previous_response_id`. `seedReferenceItems`
 * are the already-known items (e.g. from `previous_response_id`); any referenced id not among them is
 * looked up via `lookup` (the state store). Unresolved references still raise `item_reference_not_found`.
 */
export async function expandInputReferences(
	input: ResponseInputItem[],
	seedReferenceItems: ResponseInputItem[],
	lookup: (id: string) => Promise<ResponseInputItem | undefined>,
): Promise<ResponseInputItem[]> {
	const referenceItems = [...seedReferenceItems];
	const known = new Set<string>();
	for (const item of referenceItems) {
		const id = itemId(item);
		if (id) known.add(id);
	}

	const missing = new Set<string>();
	for (const raw of input) {
		if (raw.type !== "item_reference") continue;
		const id = typeof raw.id === "string" ? raw.id : "";
		if (id && !known.has(id)) missing.add(id);
	}

	for (const id of missing) {
		const found = await lookup(id);
		if (found) referenceItems.push(found);
	}
	return resolveResponseInputReferences(input, referenceItems);
}

/** Translates an OpenResponses request to the canonical chat request. */
export function responsesRequestToCanonical(
	req: ResponsesRequest,
): CanonicalChatRequest {
	const messages: CanonicalMessage[] = [];
	if (req.instructions)
		messages.push({ role: "system", content: req.instructions });

	if (typeof req.input === "string") {
		messages.push({ role: "user", content: req.input });
	} else if (Array.isArray(req.input)) {
		for (const raw of req.input) {
			const item = raw as Record<string, unknown>;
			const type = (item.type as string | undefined) ?? "message";
			switch (type) {
				case "message": {
					const role = (item.role as CanonicalRole) ?? "user";
					messages.push({ role, content: mapMessageContent(item.content) });
					break;
				}
				case "function_call": {
					messages.push({
						role: "assistant",
						content: null,
						toolCalls: [
							{
								id: String(item.call_id ?? item.id ?? ""),
								name: String(item.name ?? ""),
								arguments: String(item.arguments ?? ""),
							},
						],
					});
					break;
				}
				case "function_call_output": {
					const out = item.output;
					messages.push({
						role: "tool",
						toolCallId: String(item.call_id ?? ""),
						content: typeof out === "string" ? out : JSON.stringify(out ?? ""),
					});
					break;
				}
				case "reasoning":
					break; // input reasoning state: ignored
				case "item_reference":
					throw new GatewayError({
						class: "bad_request",
						message: "item_reference is not supported yet",
						param: "input",
					});
				default:
					break;
			}
		}
	}

	const u: CanonicalChatRequest = {
		callType: "chat",
		model: req.model,
		messages,
		stream: req.stream,
	};
	if (req.max_output_tokens !== undefined) u.maxTokens = req.max_output_tokens;
	if (req.temperature !== undefined) u.temperature = req.temperature;
	if (req.top_p !== undefined) u.topP = req.top_p;
	if (req.presence_penalty !== undefined)
		u.presencePenalty = req.presence_penalty;
	if (req.frequency_penalty !== undefined)
		u.frequencyPenalty = req.frequency_penalty;
	if (req.user !== undefined) u.user = req.user;
	if (req.parallel_tool_calls !== undefined)
		u.parallelToolCalls = req.parallel_tool_calls;
	const responseFormat = req.text?.format;
	if (responseFormat !== undefined) {
		if (responseFormat.type === "json_schema") {
			const format: CanonicalResponseFormat = {
				type: "json_schema",
				name: responseFormat.name,
				schema: responseFormat.schema,
			};
			if (responseFormat.description !== undefined)
				format.description = responseFormat.description;
			if (responseFormat.strict != null) format.strict = responseFormat.strict;
			u.responseFormat = format;
		} else {
			u.responseFormat = { type: responseFormat.type };
		}
	}
	if (req.reasoning !== undefined) {
		const effort = req.reasoning.effort;
		const summary = req.reasoning.summary;
		if (effort !== undefined) {
			if (!isReasoningEffort(effort)) {
				throw new GatewayError({
					class: "bad_request",
					message: `Unsupported reasoning effort: ${String(effort)}`,
					param: "reasoning.effort",
				});
			}
		}
		if (
			summary !== undefined &&
			!["auto", "none", "concise", "detailed"].includes(String(summary))
		) {
			throw new GatewayError({
				class: "bad_request",
				message: `Unsupported reasoning summary: ${String(summary)}`,
				param: "reasoning.summary",
			});
		}
		const reasoningSummary = summaryForEffort(
			isReasoningEffort(effort) ? effort : undefined,
			summary as ReasoningSummary | undefined,
		);
		if (effort !== undefined || reasoningSummary !== undefined) {
			u.reasoning = {
				...(isReasoningEffort(effort) ? { effort } : {}),
				...(reasoningSummary !== undefined
					? { summary: reasoningSummary }
					: {}),
			};
		}
	}
	if (req.extra_body !== undefined) {
		assertNoManagedExtraBodyKeys(
			req.extra_body,
			RESPONSES_EXTRA_BODY_MANAGED_KEYS,
		);
		u.extraBody = req.extra_body;
	}
	const textTransport =
		req.text === undefined
			? undefined
			: Object.fromEntries(
					Object.entries(req.text).filter(([key]) => key !== "format"),
				);
	if (
		req.include !== undefined ||
		req.metadata !== undefined ||
		(textTransport !== undefined && Object.keys(textTransport).length > 0) ||
		req.reasoning !== undefined ||
		req.stream_options !== undefined ||
		req.service_tier !== undefined ||
		req.safety_identifier !== undefined ||
		req.prompt_cache_key !== undefined ||
		req.top_logprobs !== undefined ||
		req.max_tool_calls !== undefined
	) {
		const reasoningTransport =
			req.reasoning === undefined
				? undefined
				: Object.fromEntries(
						Object.entries(req.reasoning).filter(
							([key]) => key !== "effort" && key !== "summary",
						),
					);
		u.responsesTransport = {
			...(req.include !== undefined ? { include: req.include } : {}),
			...(req.metadata !== undefined ? { metadata: req.metadata } : {}),
			...(textTransport !== undefined && Object.keys(textTransport).length > 0
				? { text: textTransport }
				: {}),
			...(reasoningTransport !== undefined &&
			Object.keys(reasoningTransport).length > 0
				? { reasoning: reasoningTransport }
				: {}),
			...(req.stream_options !== undefined
				? { streamOptions: req.stream_options }
				: {}),
			...(req.service_tier !== undefined
				? { serviceTier: req.service_tier }
				: {}),
			...(req.safety_identifier !== undefined
				? { safetyIdentifier: req.safety_identifier }
				: {}),
			...(req.prompt_cache_key !== undefined
				? { promptCacheKey: req.prompt_cache_key }
				: {}),
			...(req.top_logprobs !== undefined
				? { topLogprobs: req.top_logprobs }
				: {}),
			...(req.max_tool_calls !== undefined
				? { maxToolCalls: req.max_tool_calls }
				: {}),
		};
	}

	if (Array.isArray(req.tools)) {
		const tools = [];
		for (const t of req.tools) {
			const tool = t as Record<string, unknown>;
			if (tool.type === "function" && typeof tool.name === "string") {
				const entry: NonNullable<CanonicalChatRequest["tools"]>[number] = {
					name: tool.name,
				};
				if (typeof tool.description === "string")
					entry.description = tool.description;
				if (tool.parameters && typeof tool.parameters === "object") {
					entry.parameters = tool.parameters as Record<string, unknown>;
				}
				if (typeof tool.strict === "boolean") entry.strict = tool.strict;
				tools.push(entry);
			}
		}
		if (tools.length > 0) u.tools = tools;
	}
	const tc = mapToolChoice(req.tool_choice);
	if (tc !== undefined) u.toolChoice = tc;

	return u;
}

/* ---------------------------------------------- canonical -> response */

export interface RenderOptions {
	/** Original request (for echoing fields: instructions, tools, etc.). */
	req: ResponsesRequest;
	/** Upstream model (fallback if the response carries no model). */
	upstreamModel: string;
}

function toResponsesUsage(usage: Usage): Record<string, unknown> {
	return {
		input_tokens: usage.promptTokens,
		input_tokens_details: { cached_tokens: usage.cacheReadTokens ?? 0 },
		output_tokens: usage.completionTokens,
		output_tokens_details: { reasoning_tokens: usage.reasoningTokens ?? 0 },
		total_tokens: usage.totalTokens,
	};
}

function statusFor(finish: CanonicalFinishReason | null): {
	status: string;
	incomplete: Record<string, unknown> | null;
} {
	if (finish === "length")
		return {
			status: "incomplete",
			incomplete: { reason: "max_output_tokens" },
		};
	if (finish === "content_filter")
		return { status: "incomplete", incomplete: { reason: "content_filter" } };
	return { status: "completed", incomplete: null };
}

function messageItem(content: string, id: string): Record<string, unknown> {
	return {
		type: "message",
		id,
		status: "completed",
		role: "assistant",
		content: [{ type: "output_text", text: content, annotations: [] }],
	};
}

function reasoningItem(summary: string, id: string): Record<string, unknown> {
	return {
		type: "reasoning",
		id,
		summary: [{ type: "summary_text", text: summary }],
	};
}

function functionCallItem(
	tc: { id: string; name: string; arguments: string },
	id: string,
): Record<string, unknown> {
	return {
		type: "function_call",
		id,
		call_id: tc.id,
		name: tc.name,
		arguments: tc.arguments,
		status: "completed",
	};
}

/** Builds the OpenResponses `response` object. */
function buildResponse(
	opts: RenderOptions,
	parts: {
		id: string;
		createdAt: number;
		model: string;
		status: string;
		incomplete: Record<string, unknown> | null;
		output: Record<string, unknown>[];
		usage: Usage | null;
		outputText: string;
	},
): Record<string, unknown> {
	const { req } = opts;
	return {
		id: parts.id,
		object: "response",
		created_at: parts.createdAt,
		status: parts.status,
		background: req.background ?? false,
		error: null,
		incomplete_details: parts.incomplete,
		instructions: req.instructions ?? null,
		max_output_tokens: req.max_output_tokens ?? null,
		model: parts.model,
		output: parts.output,
		output_text: parts.outputText,
		parallel_tool_calls: req.parallel_tool_calls ?? true,
		previous_response_id: req.previous_response_id ?? null,
		reasoning: reasoningEcho(req),
		store: req.store === true,
		temperature: req.temperature ?? null,
		text: req.text ?? { format: { type: "text" } },
		tool_choice: req.tool_choice ?? "auto",
		tools: req.tools ?? [],
		top_p: req.top_p ?? null,
		truncation: req.truncation ?? "disabled",
		usage: parts.usage ? toResponsesUsage(parts.usage) : null,
		metadata: req.metadata ?? {},
	};
}

function reasoningEcho(req: ResponsesRequest): Record<string, unknown> {
	const effort = req.reasoning?.effort;
	const summary = summaryForEffort(
		isReasoningEffort(effort) ? effort : undefined,
		req.reasoning?.summary as ReasoningSummary | undefined,
	);
	return {
		effort: effort ?? null,
		summary: summary ?? null,
	};
}

/** Canonical result (non-stream) -> OpenResponses `response` object. */
export function canonicalToResponsesResponse(
	resp: CanonicalChatResponse,
	opts: RenderOptions,
): Record<string, unknown> {
	const choice = resp.choices[0];
	const content = choice?.message.content ?? "";
	const { status, incomplete } = statusFor(choice?.finishReason ?? null);

	const output: Record<string, unknown>[] = [];
	if (choice?.message.reasoning)
		output.push(reasoningItem(choice.message.reasoning, `rs_${randomUUID()}`));
	if (content) output.push(messageItem(content, `msg_${randomUUID()}`));
	for (const tc of choice?.message.toolCalls ?? []) {
		output.push(functionCallItem(tc, `fc_${randomUUID()}`));
	}

	return buildResponse(opts, {
		id: `resp_${randomUUID()}`,
		createdAt: resp.created,
		model: resp.model || opts.upstreamModel,
		status,
		incomplete,
		output,
		usage: resp.usage,
		outputText: content,
	});
}

/* ---------------------------------------------- canonical stream -> SSE events */

function sse(
	type: string,
	seq: number,
	extra: Record<string, unknown>,
): SSEEvent {
	return {
		event: type,
		data: JSON.stringify({ type, sequence_number: seq, ...extra }),
	};
}

/**
 * Converts the canonical chunk stream into the OpenResponses SSE event sequence.
 * Handles streaming text (the essential case) and emits function_calls as complete items.
 */
export async function* canonicalChunksToResponsesEvents(
	chunks: AsyncIterable<CanonicalChatStreamChunk>,
	opts: RenderOptions,
): AsyncGenerator<SSEEvent> {
	const responseId = `resp_${randomUUID()}`;
	const createdAt = Math.floor(Date.now() / 1000);
	let seq = 0;
	const next = () => seq++;

	let model = opts.upstreamModel;
	let content = "";
	let reasoning = "";
	let usage: Usage | null = null;
	let finish: CanonicalFinishReason | null = null;
	const toolCalls = new Map<
		number,
		{ id: string; name: string; arguments: string }
	>();

	let messageStarted = false;
	const msgId = `msg_${randomUUID()}`;

	const baseResponse = (status: string) =>
		buildResponse(opts, {
			id: responseId,
			createdAt,
			model,
			status,
			incomplete: null,
			output: [],
			usage: null,
			outputText: "",
		});

	yield sse("response.created", next(), {
		response: baseResponse("in_progress"),
	});
	yield sse("response.in_progress", next(), {
		response: baseResponse("in_progress"),
	});

	for await (const chunk of chunks) {
		if (chunk.model) model = chunk.model;
		if (chunk.usage) usage = chunk.usage;
		const choice = chunk.choices[0];
		if (!choice) continue;
		if (choice.finishReason) finish = choice.finishReason;

		const delta = choice.delta;
		if (delta.reasoning) reasoning += delta.reasoning;
		if (delta.content) {
			if (!messageStarted) {
				messageStarted = true;
				yield sse("response.output_item.added", next(), {
					output_index: 0,
					item: {
						type: "message",
						id: msgId,
						status: "in_progress",
						role: "assistant",
						content: [],
					},
				});
				yield sse("response.content_part.added", next(), {
					item_id: msgId,
					output_index: 0,
					content_index: 0,
					part: { type: "output_text", text: "", annotations: [] },
				});
			}
			content += delta.content;
			yield sse("response.output_text.delta", next(), {
				item_id: msgId,
				output_index: 0,
				content_index: 0,
				delta: delta.content,
			});
		}

		for (const tc of delta.toolCalls ?? []) {
			const cur = toolCalls.get(tc.index) ?? {
				id: "",
				name: "",
				arguments: "",
			};
			if (tc.id) cur.id = tc.id;
			if (tc.name) cur.name = tc.name;
			if (tc.arguments) cur.arguments += tc.arguments;
			toolCalls.set(tc.index, cur);
		}
	}

	const output: Record<string, unknown>[] = [];

	if (messageStarted) {
		yield sse("response.output_text.done", next(), {
			item_id: msgId,
			output_index: 0,
			content_index: 0,
			text: content,
		});
		yield sse("response.content_part.done", next(), {
			item_id: msgId,
			output_index: 0,
			content_index: 0,
			part: { type: "output_text", text: content, annotations: [] },
		});
		const item = messageItem(content, msgId);
		output.push(item);
		yield sse("response.output_item.done", next(), { output_index: 0, item });
	}

	let outputIndex = messageStarted ? 1 : 0;
	if (reasoning) {
		output.push(reasoningItem(reasoning, `rs_${randomUUID()}`));
		outputIndex += 1;
	}
	for (const tc of toolCalls.values()) {
		const fcId = `fc_${randomUUID()}`;
		const item = functionCallItem(tc, fcId);
		yield sse("response.output_item.added", next(), {
			output_index: outputIndex,
			item: { ...item, status: "in_progress", arguments: "" },
		});
		yield sse("response.function_call_arguments.delta", next(), {
			item_id: fcId,
			output_index: outputIndex,
			delta: tc.arguments,
		});
		yield sse("response.function_call_arguments.done", next(), {
			item_id: fcId,
			output_index: outputIndex,
			arguments: tc.arguments,
		});
		yield sse("response.output_item.done", next(), {
			output_index: outputIndex,
			item,
		});
		output.push(item);
		outputIndex += 1;
	}

	const { status, incomplete } = statusFor(finish);
	const finalResponse = buildResponse(opts, {
		id: responseId,
		createdAt,
		model,
		status,
		incomplete,
		output,
		usage,
		outputText: content,
	});
	yield sse(
		status === "incomplete" ? "response.incomplete" : "response.completed",
		next(),
		{
			response: finalResponse,
		},
	);
}
