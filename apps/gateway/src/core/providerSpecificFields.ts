/**
 * Provider-specific opaque state that must round-trip through clients.
 *
 * Two carriers exist, both stateless:
 *
 * - Tool-call-bound state (Gemini thought signatures): embedded in the public tool call id as
 *   `<id>__thought__<signature>` (LiteLLM-compatible), so any client that echoes tool call ids
 *   verbatim round-trips it without understanding any extra field. Also mirrored as
 *   `provider_specific_fields` / `extra_content` on the rendered tool call for rich clients.
 * - Message-bound state (OpenAI encrypted reasoning items): carried as a provider-namespaced
 *   record on the canonical assistant message (`providerFields.openai.reasoning`), rendered as
 *   native `reasoning` output items on /v1/responses and as message-level
 *   `provider_specific_fields` on /v1/chat/completions.
 *
 * Encoding/decoding happens exclusively in the contracts layer; canonical ids are always clean
 * and adapters stay signature-agnostic.
 */

/**
 * Separator used by LiteLLM to embed a Gemini thought signature in a tool call id.
 * Signatures are standard base64 (`A-Za-z0-9+/=`), which cannot contain `_`, so the separator
 * can never occur inside a signature and splitting on its first occurrence is unambiguous.
 */
export const LITELLM_THOUGHT_SEPARATOR = "__thought__";
const MAX_PUBLIC_TOOL_CALL_ID_LENGTH = 64;

function recordValue(value: unknown): Record<string, unknown> | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		return undefined;
	return value as Record<string, unknown>;
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
	return structuredClone(value);
}

function mergeRecords(
	base: Record<string, unknown>,
	override: Record<string, unknown>,
): Record<string, unknown> {
	const merged = cloneRecord(base);
	for (const [key, value] of Object.entries(override)) {
		const current = recordValue(merged[key]);
		const next = recordValue(value);
		merged[key] =
			current !== undefined && next !== undefined
				? mergeRecords(current, next)
				: structuredClone(value);
	}
	return merged;
}

/** Deep merge of provider-namespaced records; later values win per key. */
export function mergeProviderExtraContent(
	...values: Array<Record<string, unknown> | undefined>
): Record<string, unknown> | undefined {
	let merged: Record<string, unknown> | undefined;
	for (const value of values) {
		if (value === undefined) continue;
		merged =
			merged === undefined ? cloneRecord(value) : mergeRecords(merged, value);
	}
	return merged;
}

/** Alias: message/choice-level providerFields records merge with the same semantics. */
export const mergeProviderFields = mergeProviderExtraContent;

/** Native Responses output items retained when the canonical subset cannot represent them. */
export function responsesOutputFromProviderFields(
	fields: Record<string, unknown> | undefined,
): Record<string, unknown>[] | undefined {
	const openai = recordValue(fields?.openai);
	const output = openai?.response_output;
	return Array.isArray(output)
		? output
				.filter(
					(item): item is Record<string, unknown> =>
						item !== null && typeof item === "object" && !Array.isArray(item),
				)
				.map((item) => structuredClone(item))
		: undefined;
}

export function providerFieldsWithResponsesOutput(
	output: Record<string, unknown>[],
): Record<string, unknown> {
	return { openai: { response_output: structuredClone(output) } };
}

export type AnthropicThinkingBlock =
	| { type: "thinking"; thinking: string; signature: string }
	| { type: "redacted_thinking"; data: string };

function isAnthropicThinkingBlock(
	value: unknown,
): value is AnthropicThinkingBlock {
	const block = recordValue(value);
	if (block?.type === "thinking")
		return (
			typeof block.thinking === "string" && typeof block.signature === "string"
		);
	return block?.type === "redacted_thinking" && typeof block.data === "string";
}

export function anthropicThinkingFromProviderFields(
	fields: Record<string, unknown> | undefined,
): AnthropicThinkingBlock[] | undefined {
	const anthropic = recordValue(fields?.anthropic);
	const blocks = anthropic?.thinking_blocks;
	return Array.isArray(blocks)
		? blocks
				.filter(isAnthropicThinkingBlock)
				.map((block) => structuredClone(block))
		: undefined;
}

export function providerFieldsWithAnthropicThinking(
	blocks: AnthropicThinkingBlock[],
): Record<string, unknown> {
	return { anthropic: { thinking_blocks: structuredClone(blocks) } };
}

export function googleContentPartsFromProviderFields(
	fields: Record<string, unknown> | undefined,
): Record<string, unknown>[] | undefined {
	const google = recordValue(fields?.google);
	const parts = google?.content_parts;
	return Array.isArray(parts)
		? parts
				.filter(
					(part): part is Record<string, unknown> =>
						part !== null && typeof part === "object" && !Array.isArray(part),
				)
				.map((part) => structuredClone(part))
		: undefined;
}

export function providerFieldsWithGoogleContentParts(
	parts: Record<string, unknown>[],
): Record<string, unknown> {
	return { google: { content_parts: structuredClone(parts) } };
}

/* ===================================================== THOUGHT SIGNATURES ===
 * Gemini per-tool-call signatures, canonical form `extraContent.google.thought_signature`.
 */

/** Signature from canonical tool-call extraContent (google namespace), if any. */
export function thoughtSignatureFromExtraContent(
	extraContent: Record<string, unknown> | undefined,
): string | undefined {
	const google = recordValue(extraContent?.google);
	const signature = google?.thought_signature ?? google?.thoughtSignature;
	return typeof signature === "string" && signature.length > 0
		? signature
		: undefined;
}

export function providerSpecificFieldsFromExtraContent(
	extraContent: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	const signature = thoughtSignatureFromExtraContent(extraContent);
	if (signature === undefined) return undefined;
	return { thought_signature: signature };
}

export function extraContentFromProviderSpecificFields(
	value: unknown,
): Record<string, unknown> | undefined {
	const fields = recordValue(value);
	const signature = fields?.thought_signature ?? fields?.thoughtSignature;
	if (typeof signature !== "string" || signature.length === 0) return undefined;
	return { google: { thought_signature: signature } };
}

/**
 * Appends `__thought__<signature>` to a tool call id for the public wire format. No-op when the
 * id is empty, no signature is present, or the id already carries a separator (idempotent).
 */
export function encodeThoughtSignatureId(
	id: string,
	extraContent: Record<string, unknown> | undefined,
): string {
	if (id.length === 0 || id.includes(LITELLM_THOUGHT_SEPARATOR)) return id;
	const signature = thoughtSignatureFromExtraContent(extraContent);
	if (signature === undefined) return id;
	const encoded = `${id}${LITELLM_THOUGHT_SEPARATOR}${signature}`;
	// Preserve the extension carriers instead of emitting an invalid public id.
	return encoded.length <= MAX_PUBLIC_TOOL_CALL_ID_LENGTH ? encoded : id;
}

/**
 * Splits a public tool call id on the first `__thought__` occurrence. The suffix is always
 * removed from the id, even when the embedded signature is empty; `extraContent` is only
 * returned for a non-empty signature.
 */
export function decodeThoughtSignatureId(id: unknown): {
	id: string;
	extraContent?: Record<string, unknown>;
} {
	if (typeof id !== "string") return { id: "" };
	const index = id.indexOf(LITELLM_THOUGHT_SEPARATOR);
	if (index < 0) return { id };
	const signature = id.slice(index + LITELLM_THOUGHT_SEPARATOR.length);
	const clean = id.slice(0, index);
	return signature.length > 0
		? { id: clean, extraContent: { google: { thought_signature: signature } } }
		: { id: clean };
}

/** Strips an embedded signature from tool-result references (tool_call_id / call_id / tool_use_id). */
export function stripThoughtSignatureId(id: string): string {
	const index = id.indexOf(LITELLM_THOUGHT_SEPARATOR);
	return index < 0 ? id : id.slice(0, index);
}

export function thoughtSignaturesFromToolCalls(
	toolCalls: Array<{ extraContent?: Record<string, unknown> }> | undefined,
): string[] {
	const signatures: string[] = [];
	for (const tc of toolCalls ?? []) {
		const signature = thoughtSignatureFromExtraContent(tc.extraContent);
		if (signature !== undefined) signatures.push(signature);
	}
	return signatures;
}

export function providerSpecificFieldsFromToolCalls(
	toolCalls: Array<{ extraContent?: Record<string, unknown> }> | undefined,
): Record<string, unknown> | undefined {
	const thoughtSignatures = thoughtSignaturesFromToolCalls(toolCalls);
	return thoughtSignatures.length > 0
		? { thought_signatures: thoughtSignatures }
		: undefined;
}

/* ============================================== OPENAI REASONING STATE ===
 * OpenAI /responses per-item reasoning state (`reasoning` items with `encrypted_content`),
 * canonical form `message.providerFields.openai.reasoning`.
 */

export interface OpenAIReasoningStateItem {
	id?: string;
	encrypted_content: string;
	summary?: unknown[];
}

/** Builds the provider-namespaced record `{ openai: { reasoning: [...] } }`. */
export function providerFieldsWithOpenAIReasoning(
	items: OpenAIReasoningStateItem[],
): Record<string, unknown> {
	return { openai: { reasoning: structuredClone(items) } };
}

/** Reads and validates OpenAI reasoning state items out of a providerFields record. */
export function openaiReasoningFromProviderFields(
	fields: Record<string, unknown> | undefined,
): OpenAIReasoningStateItem[] | undefined {
	const openai = recordValue(fields?.openai);
	const reasoning = openai?.reasoning;
	if (!Array.isArray(reasoning)) return undefined;
	const items: OpenAIReasoningStateItem[] = [];
	for (const raw of reasoning) {
		const item = recordValue(raw);
		if (item === undefined) continue;
		if (
			typeof item.encrypted_content !== "string" ||
			item.encrypted_content.length === 0
		)
			continue;
		items.push({
			encrypted_content: item.encrypted_content,
			...(typeof item.id === "string" && item.id.length > 0
				? { id: item.id }
				: {}),
			...(Array.isArray(item.summary)
				? { summary: structuredClone(item.summary) }
				: {}),
		});
	}
	return items.length > 0 ? items : undefined;
}
