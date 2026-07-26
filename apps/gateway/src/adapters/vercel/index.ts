import { parseOpenAIChatChunk } from "#contracts/openai/chatTransport.ts";
import type { AdapterContext, ProviderModule } from "#adapters/types.ts";
import { mergeProviderFields } from "#core/providerSpecificFields.ts";
import { makeOpenAIStyleAdapter } from "#adapters/openaiStyle.ts";
import { looksLikeContextWindowError } from "#core/httpError.ts";
import type { ReasoningControlKind } from "#core/reasoning.ts";
import type { ErrorClass } from "#core/errors.ts";
import { parseSSE } from "#core/sse.ts";

import type {
	CanonicalChatStreamChunk,
	CanonicalChatResponse,
	CanonicalChatRequest,
} from "#core/canonical.ts";

import {
	applyVercelNativeReasoning,
	vercelRestReasoningSpec,
} from "./reasoning.ts";

const DEFAULT_BASE_URL = "https://ai-gateway.vercel.sh/v1";
const VERCEL_REASONING_KINDS = new Set<ReasoningControlKind>([
	"openai_effort",
	"openai_body",
	"anthropic_adaptive",
	"anthropic_budget",
	"gemini_level",
	"gemini_budget",
	"chat_template_flag",
	"fixed",
]);

function recordValue(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function reasoningDetails(
	value: unknown,
): Record<string, unknown>[] | undefined {
	return Array.isArray(value)
		? value
				.filter(
					(item): item is Record<string, unknown> =>
						recordValue(item) !== undefined,
				)
				.map((item) => structuredClone(item))
		: undefined;
}

function providerFieldsWithVercelReasoningDetails(
	value: unknown,
): Record<string, unknown> | undefined {
	const details = reasoningDetails(value);
	return details && details.length > 0
		? { vercel: { reasoning_details: details } }
		: undefined;
}

function vercelReasoningDetailsFromProviderFields(
	fields: Record<string, unknown> | undefined,
): Record<string, unknown>[] | undefined {
	const vercel = recordValue(fields?.vercel);
	return reasoningDetails(vercel?.reasoning_details);
}

function vercelContext(ctx: AdapterContext): AdapterContext {
	const reasoning = vercelRestReasoningSpec(ctx.meta.reasoning);
	return {
		...ctx,
		meta: {
			...ctx.meta,
			...(reasoning !== undefined ? { reasoning } : {}),
		},
	};
}

function addReasoningDetailsToRequest(
	body: Record<string, unknown>,
	req: CanonicalChatRequest,
): void {
	if (!Array.isArray(body.messages)) return;
	for (const [index, canonical] of req.messages.entries()) {
		const details = vercelReasoningDetailsFromProviderFields(
			canonical.providerFields,
		);
		const message = recordValue(body.messages[index]);
		if (details !== undefined && message !== undefined)
			message.reasoning_details = details;
	}
}

function useVercelChatReasoning(
	body: Record<string, unknown>,
	req: CanonicalChatRequest,
): void {
	const effort = body.reasoning_effort;
	delete body.reasoning_effort;
	if (typeof effort !== "string") return;
	body.reasoning = {
		enabled: effort !== "none",
		...(effort !== "none" ? { effort } : {}),
		...(req.reasoning?.display === "omitted" ||
		req.reasoning?.summary === "none"
			? { exclude: true }
			: {}),
	};
}

function addResponseReasoningDetails(
	response: CanonicalChatResponse,
	raw: unknown,
): CanonicalChatResponse {
	const rawChoices = recordValue(raw)?.choices;
	if (!Array.isArray(rawChoices)) return response;
	for (const choice of response.choices) {
		const rawChoice = rawChoices
			.map(recordValue)
			.find((candidate) => candidate?.index === choice.index);
		const fields = providerFieldsWithVercelReasoningDetails(
			recordValue(rawChoice?.message)?.reasoning_details,
		);
		const merged = mergeProviderFields(choice.message.providerFields, fields);
		if (merged !== undefined) choice.message.providerFields = merged;
	}
	return response;
}

function addChunkReasoningDetails(
	chunk: CanonicalChatStreamChunk,
	raw: unknown,
): CanonicalChatStreamChunk {
	const rawChoices = recordValue(raw)?.choices;
	if (!Array.isArray(rawChoices)) return chunk;
	for (const choice of chunk.choices) {
		const rawChoice = rawChoices
			.map(recordValue)
			.find((candidate) => candidate?.index === choice.index);
		const fields = providerFieldsWithVercelReasoningDetails(
			recordValue(rawChoice?.delta)?.reasoning_details,
		);
		const merged = mergeProviderFields(choice.delta.providerFields, fields);
		if (merged !== undefined) choice.delta.providerFields = merged;
	}
	return chunk;
}

function refineBadRequest(message: string): ErrorClass | null {
	return looksLikeContextWindowError(message) ? "context_window" : null;
}

const openAIStyle = makeOpenAIStyleAdapter({
	key: "vercel",
	label: "Vercel AI Gateway",
	defaultBaseUrl: DEFAULT_BASE_URL,
	defaultTransport: "responses",
	supportedChatTransports: ["responses", "chat_completions"],
	contentInputs: {
		responses: {
			file: {
				sources: ["provider_file_id", "url", "data_url"],
				maxBytes: 50_000_000,
			},
		},
		chat_completions: {
			file: {
				sources: ["provider_file_id", "data_url"],
				maxBytes: 50_000_000,
			},
		},
	},
	maxTokensField: "max_completion_tokens",
	refineBadRequest,
	imageTransports: ["images", "chat_completions"],
	defaultImageTransport: "images",
	embeddings: true,
});

const openAIStyleChat = openAIStyle.chat!;

export const vercelAdapter = {
	...openAIStyle,
	reasoningKinds: VERCEL_REASONING_KINDS,
	chat: {
		...openAIStyleChat,
		buildRequest(req, ctx) {
			const request = openAIStyleChat.buildRequest(req, vercelContext(ctx));
			if (typeof request.body !== "string") return request;
			const body = JSON.parse(request.body) as Record<string, unknown>;
			if (ctx.transport === "chat_completions") {
				useVercelChatReasoning(body, req);
				addReasoningDetailsToRequest(body, req);
			}
			applyVercelNativeReasoning(body, req, ctx);
			return { ...request, body: JSON.stringify(body) };
		},
		parseResponse(raw, ctx) {
			const parsed = openAIStyleChat.parseResponse(raw, ctx);
			return ctx.transport === "chat_completions"
				? addResponseReasoningDetails(parsed, raw)
				: parsed;
		},
		async *parseStream(stream, ctx) {
			if (ctx.transport !== "chat_completions") {
				yield* openAIStyleChat.parseStream(stream, ctx);
				return;
			}
			for await (const event of parseSSE(stream)) {
				if (event.data === "[DONE]") return;
				let raw: unknown;
				try {
					raw = JSON.parse(event.data);
				} catch {
					continue;
				}
				if (recordValue(raw)?.error !== undefined) {
					throw openAIStyleChat.mapError({ status: 502, body: raw }, ctx);
				}
				yield addChunkReasoningDetails(parseOpenAIChatChunk(raw), raw);
			}
		},
	},
} satisfies typeof openAIStyle;

export const vercelProvider: ProviderModule = { adapter: vercelAdapter };

export {
	vercelReasoningDetailsFromProviderFields,
	providerFieldsWithVercelReasoningDetails,
};
