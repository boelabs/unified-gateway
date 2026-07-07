import { assertNoManagedExtraBodyKeys } from "#core/extraBody.ts";
import type { MessagesRequest } from "./messages.ts";
import { GatewayError } from "#core/errors.ts";
import type { SSEEvent } from "#core/sse.ts";
import type { Usage } from "#core/usage.ts";
import { randomUUID } from "node:crypto";

import {
	providerSpecificFieldsFromExtraContent,
	extraContentFromProviderSpecificFields,
	mergeProviderExtraContent,
	decodeThoughtSignatureId,
	encodeThoughtSignatureId,
	stripThoughtSignatureId,
} from "#core/providerSpecificFields.ts";

import type {
	CanonicalChatStreamChunk,
	CanonicalChatResponse,
	CanonicalFinishReason,
	CanonicalChatRequest,
	CanonicalContentPart,
	CanonicalToolChoice,
	CanonicalMessage,
} from "#core/canonical.ts";

import {
	effortFromBudgetTokens,
	type ReasoningEffort,
	isReasoningEffort,
	summaryForEffort,
} from "#core/reasoning.ts";

/* ====================================================================
 * Anthropic Messages ⟷ canonical types (provider-agnostic render).
 * ==================================================================== */

export interface MessagesRenderOptions {
	upstreamModel: string;
}

const MESSAGES_EXTRA_BODY_MANAGED_KEYS = [
	"model",
	"max_tokens",
	"messages",
	"system",
	"stream",
	"temperature",
	"top_p",
	"stop_sequences",
	"tools",
	"tool_choice",
	"thinking",
	"output_config",
	"extra_body",
] as const;

/* ---------------------------------------------- request -> canonical */

interface Block {
	type?: string;
	text?: string;
	source?: { type?: string; media_type?: string; data?: string; url?: string };
	id?: string;
	name?: string;
	input?: unknown;
	tool_use_id?: string;
	content?: unknown;
	provider_specific_fields?: Record<string, unknown>;
	cache_control?: Record<string, unknown>;
}

/** Attaches the prompt-caching breakpoint to the canonical part if the block carries it. */
function withCacheControl(
	part: CanonicalContentPart,
	block: { cache_control?: Record<string, unknown> },
): CanonicalContentPart {
	if (block.cache_control !== undefined)
		part.cacheControl = block.cache_control;
	return part;
}

function blockToPart(block: Block): CanonicalContentPart | null {
	switch (block.type) {
		case "text":
			return withCacheControl({ type: "text", text: block.text ?? "" }, block);
		case "image": {
			const s = block.source;
			if (s?.type === "base64" && s.media_type && s.data) {
				return withCacheControl(
					{ type: "image", url: `data:${s.media_type};base64,${s.data}` },
					block,
				);
			}
			if (s?.type === "url" && s.url)
				return withCacheControl({ type: "image", url: s.url }, block);
			return null;
		}
		default:
			return null;
	}
}

/**
 * System -> canonical content. If any block carries `cache_control` it is preserved as parts (so the
 * adapter can place the breakpoint on the system); otherwise it is flattened to a string (back-compat).
 */
function systemToCanonicalContent(
	system: MessagesRequest["system"],
): string | CanonicalContentPart[] | null {
	if (typeof system === "string") return system || null;
	if (Array.isArray(system)) {
		const parts: CanonicalContentPart[] = [];
		let hasCacheControl = false;
		for (const raw of system) {
			const b = raw as Block;
			if (b.type !== undefined && b.type !== "text") continue;
			if (b.cache_control !== undefined) hasCacheControl = true;
			parts.push(withCacheControl({ type: "text", text: b.text ?? "" }, b));
		}
		if (parts.length === 0) return null;
		if (hasCacheControl) return parts;
		return (
			parts
				.map((p) => (p as { text: string }).text)
				.filter(Boolean)
				.join("\n") || null
		);
	}
	return null;
}

function toolResultToString(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((b) =>
				typeof b === "string" ? b : ((b as Block).text ?? JSON.stringify(b)),
			)
			.join("");
	}
	return JSON.stringify(content ?? "");
}

function mapToolChoice(
	tc: MessagesRequest["tool_choice"],
): CanonicalToolChoice | undefined {
	if (!tc) return undefined;
	const type = (tc as { type?: string }).type;
	if (type === "auto") return "auto";
	if (type === "any") return "required";
	if (type === "none") return "none";
	if (type === "tool") {
		const name = (tc as { name?: string }).name;
		return name ? { name } : "auto";
	}
	return "auto";
}

function displayFromThinking(
	thinking: MessagesRequest["thinking"],
): "omitted" | "summarized" | undefined {
	const display = thinking?.display;
	return display === "omitted" || display === "summarized"
		? display
		: undefined;
}

function reasoningEffortFromMessages(
	req: MessagesRequest,
): ReasoningEffort | undefined {
	const outputEffort = req.output_config?.effort;
	if (outputEffort !== undefined) {
		if (!isReasoningEffort(outputEffort)) {
			throw new GatewayError({
				class: "bad_request",
				message: `Unsupported output_config.effort: ${String(outputEffort)}`,
				param: "output_config.effort",
			});
		}
		return outputEffort;
	}

	if (req.thinking === undefined) return undefined;
	if (req.thinking.type === "disabled") return "none";
	const budget = req.thinking.budget_tokens;
	if (typeof budget === "number") return effortFromBudgetTokens(budget);
	if (req.thinking.type === "enabled" || req.thinking.type === "adaptive")
		return "high";
	return undefined;
}

export function messagesRequestToCanonical(
	req: MessagesRequest,
): CanonicalChatRequest {
	const messages: CanonicalMessage[] = [];
	if (req.system) {
		const sys = systemToCanonicalContent(req.system);
		if (sys) messages.push({ role: "system", content: sys });
	}

	for (const m of req.messages) {
		if (typeof m.content === "string") {
			messages.push({ role: m.role, content: m.content });
			continue;
		}
		const blocks = m.content as Block[];

		if (m.role === "assistant") {
			const parts: CanonicalContentPart[] = [];
			const toolCalls: NonNullable<CanonicalMessage["toolCalls"]> = [];
			for (const b of blocks) {
				if (b.type === "tool_use") {
					const decoded = decodeThoughtSignatureId(b.id ?? "");
					const extraContent = mergeProviderExtraContent(
						decoded.extraContent,
						extraContentFromProviderSpecificFields(b.provider_specific_fields),
					);
					toolCalls.push({
						id: decoded.id,
						name: b.name ?? "",
						arguments: JSON.stringify(b.input ?? {}),
						...(extraContent !== undefined ? { extraContent } : {}),
					});
				} else {
					const p = blockToPart(b);
					if (p) parts.push(p);
				}
			}
			const msg: CanonicalMessage = {
				role: "assistant",
				content: parts.length > 0 ? parts : null,
			};
			if (toolCalls.length > 0) msg.toolCalls = toolCalls;
			messages.push(msg);
			continue;
		}

		// user: tool_result -> canonical tool message; the rest -> user content (preserving order).
		let pending: CanonicalContentPart[] = [];
		const flush = (): void => {
			if (pending.length > 0) {
				messages.push({ role: "user", content: pending });
				pending = [];
			}
		};
		for (const b of blocks) {
			if (b.type === "tool_result") {
				flush();
				messages.push({
					role: "tool",
					toolCallId: stripThoughtSignatureId(b.tool_use_id ?? ""),
					content: toolResultToString(b.content),
				});
			} else {
				const p = blockToPart(b);
				if (p) pending.push(p);
			}
		}
		flush();
	}

	const u: CanonicalChatRequest = {
		callType: "chat",
		model: req.model,
		messages,
		stream: req.stream,
	};
	u.maxTokens = req.max_tokens;
	if (req.temperature !== undefined) u.temperature = req.temperature;
	if (req.top_p !== undefined) u.topP = req.top_p;
	if (req.stop_sequences !== undefined) u.stop = req.stop_sequences;
	const effort = reasoningEffortFromMessages(req);
	const display = displayFromThinking(req.thinking);
	const summary =
		display === "omitted" ? "none" : summaryForEffort(effort, undefined);
	if (effort !== undefined || display !== undefined) {
		u.reasoning = {
			...(effort !== undefined ? { effort } : {}),
			...(summary !== undefined ? { summary } : {}),
			...(display !== undefined ? { display } : {}),
		};
	}
	const outputFormat = req.output_config?.format;
	if (outputFormat != null) {
		u.responseFormat = { type: "json_schema", schema: outputFormat.schema };
	}
	if (req.extra_body !== undefined) {
		assertNoManagedExtraBodyKeys(
			req.extra_body,
			MESSAGES_EXTRA_BODY_MANAGED_KEYS,
		);
		u.extraBody = req.extra_body;
	}
	if (Array.isArray(req.tools)) {
		const tools = [];
		for (const t of req.tools) {
			const tool = t as {
				name?: string;
				description?: string;
				input_schema?: Record<string, unknown>;
				cache_control?: Record<string, unknown>;
			};
			if (typeof tool.name === "string") {
				const entry: NonNullable<CanonicalChatRequest["tools"]>[number] = {
					name: tool.name,
				};
				if (tool.description !== undefined)
					entry.description = tool.description;
				if (tool.input_schema !== undefined)
					entry.parameters = tool.input_schema;
				if (tool.cache_control !== undefined)
					entry.cacheControl = tool.cache_control;
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

function mapStopReason(finish: CanonicalFinishReason | null): string {
	switch (finish) {
		case "length":
			return "max_tokens";
		case "tool_calls":
			return "tool_use";
		case "content_filter":
			return "refusal";
		default:
			return "end_turn";
	}
}

/**
 * Full Anthropic usage (final response). Always includes the cache fields (0 if not applicable).
 * In the Anthropic transport the three input buckets are DISJOINT, so we reconstruct the non-cached
 * `input_tokens` by subtracting read+write from the canonical promptTokens (which does include them).
 */
function usageToAnthropic(usage: Usage): Record<string, unknown> {
	const cacheRead = usage.cacheReadTokens ?? 0;
	const cacheWrite = usage.cacheWriteTokens ?? 0;
	return {
		input_tokens: Math.max(0, usage.promptTokens - cacheRead - cacheWrite),
		cache_creation_input_tokens: cacheWrite,
		cache_read_input_tokens: cacheRead,
		output_tokens: usage.completionTokens,
	};
}

function parseArgs(args: string): unknown {
	try {
		return args ? JSON.parse(args) : {};
	} catch {
		return {};
	}
}

export function canonicalToMessagesResponse(
	resp: CanonicalChatResponse,
	opts: MessagesRenderOptions,
): Record<string, unknown> {
	const choice = resp.choices[0];
	const content = choice?.message.content;
	const blocks: Record<string, unknown>[] = [];
	if (choice?.message.reasoning) {
		blocks.push({
			type: "thinking",
			thinking: choice.message.reasoning,
			signature: "",
		});
	}
	if (content) blocks.push({ type: "text", text: content });
	for (const tc of choice?.message.toolCalls ?? []) {
		const providerSpecificFields = providerSpecificFieldsFromExtraContent(
			tc.extraContent,
		);
		blocks.push({
			type: "tool_use",
			// Thought signature embedded in the public id (LiteLLM-compatible round trip).
			id: encodeThoughtSignatureId(tc.id, tc.extraContent),
			name: tc.name,
			input: parseArgs(tc.arguments),
			...(providerSpecificFields !== undefined
				? { provider_specific_fields: providerSpecificFields }
				: {}),
		});
	}
	return {
		id: resp.id || `msg_${randomUUID()}`,
		type: "message",
		role: "assistant",
		model: resp.model || opts.upstreamModel,
		content: blocks,
		stop_reason: mapStopReason(choice?.finishReason ?? null),
		stop_sequence: null,
		usage: usageToAnthropic(resp.usage),
	};
}

/* ---------------------------------------------- canonical stream -> SSE events */

function sse(type: string, payload: Record<string, unknown>): SSEEvent {
	return { event: type, data: JSON.stringify({ type, ...payload }) };
}

export async function* canonicalChunksToMessagesEvents(
	chunks: AsyncIterable<CanonicalChatStreamChunk>,
	opts: MessagesRenderOptions,
): AsyncGenerator<SSEEvent> {
	const id = `msg_${randomUUID()}`;
	let model = opts.upstreamModel;
	let finalUsage: Usage | null = null;
	let finish: CanonicalFinishReason | null = null;

	let nextIndex = 0;
	let textOpen = false;
	let thinkingOpen = false;
	let textIndex = 0;
	let thinkingIndex = 0;
	const toolBlock = new Map<number, number>(); // canonical toolCall index -> anthropic block index

	yield sse("message_start", {
		message: {
			id,
			type: "message",
			role: "assistant",
			model,
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: {
				input_tokens: 0,
				cache_creation_input_tokens: 0,
				cache_read_input_tokens: 0,
				output_tokens: 0,
			},
		},
	});
	// Anthropic emits a keep-alive ping after opening the stream.
	yield sse("ping", {});

	for await (const chunk of chunks) {
		if (chunk.model) model = chunk.model;
		if (chunk.usage) finalUsage = chunk.usage;
		const choice = chunk.choices[0];
		if (!choice) continue;
		if (choice.finishReason) finish = choice.finishReason;
		const delta = choice.delta;

		if (delta.reasoning) {
			if (!thinkingOpen) {
				thinkingIndex = nextIndex++;
				thinkingOpen = true;
				yield sse("content_block_start", {
					index: thinkingIndex,
					content_block: { type: "thinking", thinking: "", signature: "" },
				});
			}
			yield sse("content_block_delta", {
				index: thinkingIndex,
				delta: { type: "thinking_delta", thinking: delta.reasoning },
			});
		}

		if (delta.content) {
			if (thinkingOpen) {
				yield sse("content_block_stop", { index: thinkingIndex });
				thinkingOpen = false;
			}
			if (!textOpen) {
				textIndex = nextIndex++;
				textOpen = true;
				yield sse("content_block_start", {
					index: textIndex,
					content_block: { type: "text", text: "" },
				});
			}
			yield sse("content_block_delta", {
				index: textIndex,
				delta: { type: "text_delta", text: delta.content },
			});
		}

		for (const tc of delta.toolCalls ?? []) {
			let blockIndex = toolBlock.get(tc.index);
			if (blockIndex === undefined) {
				if (textOpen) {
					yield sse("content_block_stop", { index: textIndex });
					textOpen = false;
				}
				if (thinkingOpen) {
					yield sse("content_block_stop", { index: thinkingIndex });
					thinkingOpen = false;
				}
				blockIndex = nextIndex++;
				toolBlock.set(tc.index, blockIndex);
				yield sse("content_block_start", {
					index: blockIndex,
					content_block: {
						type: "tool_use",
						id: encodeThoughtSignatureId(tc.id ?? "", tc.extraContent),
						name: tc.name ?? "",
						input: {},
						...(providerSpecificFieldsFromExtraContent(tc.extraContent) !==
						undefined
							? {
									provider_specific_fields:
										providerSpecificFieldsFromExtraContent(tc.extraContent),
								}
							: {}),
					},
				});
			}
			if (tc.arguments) {
				yield sse("content_block_delta", {
					index: blockIndex,
					delta: { type: "input_json_delta", partial_json: tc.arguments },
				});
			}
		}
	}

	if (thinkingOpen) yield sse("content_block_stop", { index: thinkingIndex });
	if (textOpen) yield sse("content_block_stop", { index: textIndex });
	for (const blockIndex of toolBlock.values())
		yield sse("content_block_stop", { index: blockIndex });

	yield sse("message_delta", {
		delta: { stop_reason: mapStopReason(finish), stop_sequence: null },
		// In message_delta Anthropic reports only the accumulated output_tokens.
		usage: { output_tokens: finalUsage?.completionTokens ?? 0 },
	});
	yield sse("message_stop", {});
}
