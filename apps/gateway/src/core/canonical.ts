import type { CanonicalReasoning } from "./reasoning.ts";
import type { Usage } from "./usage.ts";

/**
 * CANONICAL internal types, provider-agnostic. The endpoint translates OpenAI->canonical;
 * the adapter translates canonical->upstream and upstream->canonical. No concrete provider surfaces
 * here. For now they cover `chat`; the other CallTypes are added in their phase.
 */

export type CanonicalRole =
	| "system"
	| "developer"
	| "user"
	| "assistant"
	| "tool";

/**
 * Passthrough of `cache_control` (Anthropic-style prompt-caching breakpoint). It is opaque to the
 * core: filled in by the contract that understands it (Anthropic /messages) and emitted by the adapter
 * that supports it (Anthropic). Transports that do not support it (OpenAI, Google) simply ignore it.
 */
interface CanonicalCacheControlled {
	cacheControl?: Record<string, unknown>;
}
interface CanonicalTextPart extends CanonicalCacheControlled {
	type: "text";
	text: string;
}
interface CanonicalImagePart extends CanonicalCacheControlled {
	type: "image";
	/** http(s) URL or data URL (base64). */
	url: string;
	detail?: "auto" | "low" | "high";
}
interface CanonicalAudioPart extends CanonicalCacheControlled {
	type: "audio";
	/** Base64 audio. */
	data: string;
	format: "wav" | "mp3";
}
interface CanonicalFilePart extends CanonicalCacheControlled {
	type: "file";
	/** Reference to a previously uploaded file (Files API). */
	fileId?: string;
	/** Inline content as a base64 data URL (e.g. "data:application/pdf;base64,..."). */
	fileData?: string;
	filename?: string;
}
export type CanonicalContentPart =
	| CanonicalTextPart
	| CanonicalImagePart
	| CanonicalAudioPart
	| CanonicalFilePart;

interface CanonicalToolCall {
	id: string;
	name: string;
	/** Arguments as a JSON string (same as OpenAI). */
	arguments: string;
}

export interface CanonicalMessage {
	role: CanonicalRole;
	content: string | CanonicalContentPart[] | null;
	name?: string;
	/** Only on assistant messages. */
	toolCalls?: CanonicalToolCall[];
	/** Only on role=tool messages: which tool_call it answers. */
	toolCallId?: string;
}

interface CanonicalTool extends CanonicalCacheControlled {
	name: string;
	description?: string;
	/** JSON Schema of the parameters. */
	parameters?: Record<string, unknown>;
	strict?: boolean;
}

export type CanonicalToolChoice =
	| "auto"
	| "none"
	| "required"
	| { name: string };

export type CanonicalResponseFormat =
	| { type: "text" }
	| { type: "json_object" }
	| {
			type: "json_schema";
			schema: Record<string, unknown>;
			/** Required by OpenAI; other providers do not expose it. */
			name?: string;
			description?: string;
			strict?: boolean;
	  };

export type CanonicalFinishReason =
	| "stop"
	| "length"
	| "tool_calls"
	| "content_filter";

interface CanonicalResponsesTransportOptions {
	include?: string[];
	metadata?: Record<string, unknown>;
	text?: Record<string, unknown>;
	reasoning?: Record<string, unknown>;
	streamOptions?: Record<string, unknown>;
	serviceTier?: string;
	safetyIdentifier?: string;
	promptCacheKey?: string;
	topLogprobs?: number;
	maxToolCalls?: number;
}

export interface CanonicalChatRequest {
	callType: "chat";
	/** Public model requested by the client. */
	model: string;
	messages: CanonicalMessage[];
	stream: boolean;
	/** Emit usage in the final stream chunk (stream_options.include_usage). */
	includeUsage?: boolean;
	temperature?: number;
	topP?: number;
	/** Normalized from max_tokens / max_completion_tokens. */
	maxTokens?: number;
	stop?: string[];
	n?: number;
	presencePenalty?: number;
	frequencyPenalty?: number;
	seed?: number;
	user?: string;
	tools?: CanonicalTool[];
	toolChoice?: CanonicalToolChoice;
	parallelToolCalls?: boolean;
	responseFormat?: CanonicalResponseFormat;
	/** Normalized reasoning effort (each adapter translates it to its native form). */
	reasoning?: CanonicalReasoning;
	/**
	 * Prompt-caching hint (OpenAI `prompt_cache_key`): groups requests that share a prefix to improve
	 * the hit ratio of the upstream's automatic prompt cache. Only emitted by transports that support
	 * it (OpenAI chat/responses); the rest ignore it.
	 */
	promptCacheKey?: string;
	/**
	 * Passthrough of "extra" keys to the upstream body that the gateway does NOT manage (e.g. top_k,
	 * repetition_penalty, guided_json in vLLM). Each adapter merges them at the end WITHOUT overwriting
	 * managed fields (see mergeExtraBody). Provider-shaped content, the client's responsibility.
	 */
	extraBody?: Record<string, unknown>;
	/** Options of the /responses contract consumed only by the upstream /responses transport. */
	responsesTransport?: CanonicalResponsesTransportOptions;
}

interface CanonicalChatResponseChoice {
	index: number;
	finishReason: CanonicalFinishReason | null;
	message: {
		role: "assistant";
		content: string | null;
		/** Visible reasoning/thinking summary, never the raw chain of thought. */
		reasoning?: string | null;
		toolCalls?: CanonicalToolCall[];
		refusal?: string | null;
	};
}

export interface CanonicalChatResponse {
	id: string;
	/** Epoch in seconds. */
	created: number;
	model: string;
	choices: CanonicalChatResponseChoice[];
	usage: Usage;
}

export interface CanonicalChatStreamChunk {
	id: string;
	created: number;
	model: string;
	choices: Array<{
		index: number;
		delta: {
			role?: "assistant";
			content?: string;
			/** Visible reasoning/thinking summary delta. */
			reasoning?: string;
			toolCalls?: Array<{ index: number } & Partial<CanonicalToolCall>>;
			refusal?: string;
		};
		finishReason: CanonicalFinishReason | null;
	}>;
	/** Only present in the final chunk if includeUsage. */
	usage?: Usage | null;
}
