import { summaryVisible, toUpstreamReasoningEffort } from "#core/reasoning.ts";
import { mergeExtraBody, mergeExtraBodyDeep } from "#core/extraBody.ts";
import { type BaseCreds, requireApiKeyCreds } from "#adapters/creds.ts";
import { mapUpstreamHttpError } from "#adapters/upstreamError.ts";
import { looksLikeContextWindowError } from "#core/httpError.ts";
import { resolveAdapterReasoning } from "#adapters/reasoning.ts";
import type { ReasoningControlKind } from "#core/reasoning.ts";
import { imageProfileFor } from "#catalog/types.ts";
import { GatewayError } from "#core/errors.ts";
import { toGeminiSchema } from "./schema.ts";
import { readFile } from "node:fs/promises";
import type { Usage } from "#core/usage.ts";
import { randomUUID } from "node:crypto";
import { parseSSE } from "#core/sse.ts";

import type {
	CanonicalChatStreamChunk,
	CanonicalChatResponse,
	CanonicalFinishReason,
	CanonicalChatRequest,
	CanonicalContentPart,
	CanonicalMessage,
} from "#core/canonical.ts";

import type {
	EmbeddingsHandler,
	AdapterContext,
	ProviderModule,
	ImageHandler,
	ChatHandler,
	Adapter,
} from "#adapters/types.ts";

import type {
	CanonicalEmbeddingsResponse,
	CanonicalEmbeddingsRequest,
	EmbeddingInput,
} from "#core/embeddings.ts";

import type {
	CanonicalImageResponse,
	CanonicalImageRequest,
} from "#core/images.ts";

/**
 * Adapter for Google AI Studio (Gemini, generateContent API). A protocol quite different from
 * OpenAI: contents/parts/role 'model', systemInstruction, generationConfig, functionCall.
 * Demonstrates that the public OpenAI contract is independent of the upstream.
 */

type GoogleCreds = BaseCreds;

const DEFAULT_BASE = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_BODY_MANAGED_KEYS = [
	"model",
	"contents",
	"systemInstruction",
	"generationConfig",
	"tools",
	"toolConfig",
] as const;
const DEFAULT_GEMINI_BUDGETS = {
	minimal: 512,
	low: 1_024,
	medium: 4_096,
	high: 8_192,
	xhigh: 24_576,
} as const;

function creds(ctx: AdapterContext): GoogleCreds & { apiKey: string } {
	return requireApiKeyCreds<GoogleCreds>(ctx.credentials, "Google adapter");
}

/* --------------------------------------------------- canonical -> Gemini body */

function dataUrlToInline(
	url: string,
): { mimeType: string; data: string } | null {
	const m = /^data:([^;]+);base64,(.*)$/s.exec(url);
	if (!m) return null;
	return { mimeType: m[1]!, data: m[2]! };
}

function partToGemini(p: CanonicalContentPart): Record<string, unknown> {
	switch (p.type) {
		case "text":
			return { text: p.text };
		case "image": {
			const inline = dataUrlToInline(p.url);
			if (!inline) {
				throw new GatewayError({
					class: "bad_request",
					message:
						"Google adapter: images are only supported as base64 data URLs (not http URLs)",
					param: "messages",
				});
			}
			return { inlineData: inline };
		}
		case "audio":
			return {
				inlineData: {
					mimeType: p.format === "mp3" ? "audio/mpeg" : "audio/wav",
					data: p.data,
				},
			};
		case "file": {
			if (p.fileData) {
				const inline = dataUrlToInline(p.fileData);
				if (inline) return { inlineData: inline };
			}
			throw new GatewayError({
				class: "bad_request",
				message:
					"Google adapter: 'file' is only supported as a file_data base64 data URL",
				param: "messages",
			});
		}
	}
}

function contentToParts(
	content: CanonicalMessage["content"],
): Record<string, unknown>[] {
	if (content === null) return [];
	if (typeof content === "string") return [{ text: content }];
	return content.map(partToGemini);
}

interface GeminiBody extends Record<string, unknown> {
	contents: Array<{ role: "user" | "model"; parts: Record<string, unknown>[] }>;
	systemInstruction?: { parts: Record<string, unknown>[] };
	generationConfig?: Record<string, unknown>;
	tools?: Array<{ functionDeclarations: Record<string, unknown>[] }>;
	toolConfig?: Record<string, unknown>;
}

function geminiThinkingConfig(
	req: CanonicalChatRequest,
	ctx: AdapterContext,
): Record<string, unknown> | undefined {
	const resolved = resolveAdapterReasoning(req, ctx, [
		"gemini_level",
		"gemini_budget",
	]);
	if (resolved === undefined) return undefined;
	const { effort } = resolved;
	const spec = ctx.meta.reasoning!;
	const includeThoughts = summaryVisible(resolved.summary);
	if (spec.kind === "gemini_level") {
		const level =
			effort === "none" ? "minimal" : toUpstreamReasoningEffort(effort, spec);
		return {
			thinkingLevel: level === "xhigh" ? "high" : level,
			...(includeThoughts ? { includeThoughts: true } : {}),
		};
	}
	if (effort === "none") return { thinkingBudget: 0 };
	const budget = spec.budgets?.[effort] ?? DEFAULT_GEMINI_BUDGETS[effort];
	return {
		thinkingBudget: budget,
		...(includeThoughts ? { includeThoughts: true } : {}),
	};
}

function applyResponseFormat(
	gen: Record<string, unknown>,
	req: CanonicalChatRequest,
): void {
	const format = req.responseFormat;
	if (format === undefined || format.type === "text") return;

	// JSON output in Gemini = generationConfig.responseMimeType (+ responseJsonSchema for the schema).
	// There is no `responseFormat` in the generateContent API. `responseJsonSchema` accepts standard
	// JSON Schema (lowercase types, additionalProperties, $ref), unlike `responseSchema` (an OpenAPI
	// `responseSchema` (subset with UPPERCASE types). Works for Gemini 2.5 and 3.
	gen.responseMimeType = "application/json";
	if (format.type === "json_schema") gen.responseJsonSchema = format.schema;
}

function buildGeminiBody(
	req: CanonicalChatRequest,
	ctx: AdapterContext,
): GeminiBody {
	const body: GeminiBody = { contents: [] };
	const systemParts: Record<string, unknown>[] = [];
	// Map toolCallId -> function name (to map tool results).
	const toolNameById = new Map<string, string>();

	for (const m of req.messages) {
		if (m.role === "system" || m.role === "developer") {
			systemParts.push(...contentToParts(m.content));
			continue;
		}
		if (m.role === "assistant") {
			const parts: Record<string, unknown>[] = [];
			if (m.content) parts.push(...contentToParts(m.content));
			for (const tc of m.toolCalls ?? []) {
				toolNameById.set(tc.id, tc.name);
				let args: unknown = {};
				try {
					args = tc.arguments ? JSON.parse(tc.arguments) : {};
				} catch {
					args = {};
				}
				parts.push({ functionCall: { name: tc.name, args } });
			}
			body.contents.push({ role: "model", parts });
			continue;
		}
		if (m.role === "tool") {
			const name = m.toolCallId
				? (toolNameById.get(m.toolCallId) ?? "tool")
				: "tool";
			const text =
				typeof m.content === "string"
					? m.content
					: JSON.stringify(m.content ?? "");
			let response: unknown;
			try {
				response = JSON.parse(text);
			} catch {
				response = { result: text };
			}
			body.contents.push({
				role: "user",
				parts: [{ functionResponse: { name, response } }],
			});
			continue;
		}
		// user
		body.contents.push({ role: "user", parts: contentToParts(m.content) });
	}

	if (systemParts.length > 0) body.systemInstruction = { parts: systemParts };

	const gen: Record<string, unknown> = {};
	if (req.temperature !== undefined) gen.temperature = req.temperature;
	if (req.topP !== undefined) gen.topP = req.topP;
	if (req.maxTokens !== undefined) gen.maxOutputTokens = req.maxTokens;
	if (req.stop !== undefined) gen.stopSequences = req.stop;
	if (req.n !== undefined) gen.candidateCount = req.n;
	const thinkingConfig = geminiThinkingConfig(req, ctx);
	if (thinkingConfig !== undefined) gen.thinkingConfig = thinkingConfig;
	applyResponseFormat(gen, req);
	if (Object.keys(gen).length > 0) body.generationConfig = gen;

	if (req.tools && req.tools.length > 0) {
		body.tools = [
			{
				functionDeclarations: req.tools.map((t) => ({
					name: t.name,
					...(t.description !== undefined
						? { description: t.description }
						: {}),
					...(t.parameters !== undefined
						? { parameters: toGeminiSchema(t.parameters) }
						: {}),
				})),
			},
		];
	}
	if (req.toolChoice !== undefined) {
		const fc: Record<string, unknown> = {};
		if (req.toolChoice === "auto") fc.mode = "AUTO";
		else if (req.toolChoice === "none") fc.mode = "NONE";
		else if (req.toolChoice === "required") fc.mode = "ANY";
		else {
			fc.mode = "ANY";
			fc.allowedFunctionNames = [req.toolChoice.name];
		}
		body.toolConfig = { functionCallingConfig: fc };
	}

	return mergeExtraBody(body, req.extraBody, GEMINI_BODY_MANAGED_KEYS);
}

/* --------------------------------------------------- Gemini -> canonical parse */

function mapGeminiFinish(
	reason: unknown,
	hasToolCalls: boolean,
): CanonicalFinishReason | null {
	if (hasToolCalls) return "tool_calls";
	switch (reason) {
		case "STOP":
			return "stop";
		case "MAX_TOKENS":
			return "length";
		case "SAFETY":
		case "RECITATION":
		case "PROHIBITED_CONTENT":
		case "BLOCKLIST":
			return "content_filter";
		case undefined:
		case null:
			return null;
		default:
			return "stop";
	}
}

interface GeminiPart {
	text?: string;
	/** Reasoning (thinking) part. NOT visible content: excluded from output. */
	thought?: boolean;
	functionCall?: { name?: string; args?: unknown };
	inlineData?: { mimeType?: string; data?: string };
}
interface GeminiCandidate {
	content?: { parts?: GeminiPart[] };
	finishReason?: string;
	index?: number;
}
interface GeminiUsage {
	promptTokenCount?: number;
	candidatesTokenCount?: number;
	totalTokenCount?: number;
	cachedContentTokenCount?: number;
	thoughtsTokenCount?: number;
}
interface GeminiResponse {
	candidates?: GeminiCandidate[];
	usageMetadata?: GeminiUsage;
	responseId?: string;
	modelVersion?: string;
}
interface GeminiEmbeddingUsage {
	promptTokenCount?: number;
}
interface GeminiEmbedding {
	values?: unknown;
}
interface GeminiEmbeddingResponse {
	embedding?: GeminiEmbedding;
	embeddings?: GeminiEmbedding[];
	usageMetadata?: GeminiEmbeddingUsage;
}

async function buildGeminiImageBody(
	req: CanonicalImageRequest,
	ctx: AdapterContext,
): Promise<Record<string, unknown>> {
	const parts: Record<string, unknown>[] = [{ text: req.prompt }];
	for (const image of req.images ?? []) {
		parts.push({
			inlineData: {
				mimeType: image.mimeType,
				data: (await readFile(image.path)).toString("base64"),
			},
		});
	}
	const imageConfig: Record<string, unknown> = {};
	const profile = imageProfileFor(ctx.meta, req.operation);
	const mapping =
		req.size && req.size !== "auto" ? profile?.sizes?.[req.size] : undefined;
	const qualityMapping = profile?.qualityMappings?.[req.quality ?? "auto"];
	if (mapping?.aspectRatio) imageConfig.aspectRatio = mapping.aspectRatio;
	if (mapping?.imageSize) imageConfig.imageSize = mapping.imageSize;
	const body: Record<string, unknown> = {
		contents: [{ role: "user", parts }],
		generationConfig: {
			responseModalities: ["IMAGE"],
			...(Object.keys(imageConfig).length > 0 ? { imageConfig } : {}),
			...(qualityMapping?.thinkingLevel
				? { thinkingConfig: { thinkingLevel: qualityMapping.thinkingLevel } }
				: {}),
		},
	};
	return mergeExtraBodyDeep(body, req.extraBody, [
		"contents",
		"generationConfig.responseModalities",
		...(mapping?.aspectRatio
			? ["generationConfig.imageConfig.aspectRatio"]
			: []),
		...(mapping?.imageSize ? ["generationConfig.imageConfig.imageSize"] : []),
		...(qualityMapping?.thinkingLevel
			? ["generationConfig.thinkingConfig.thinkingLevel"]
			: []),
	]);
}

function googleModelResource(upstreamModel: string): string {
	return upstreamModel.startsWith("models/")
		? upstreamModel
		: `models/${upstreamModel}`;
}

function googleModelPathId(upstreamModel: string): string {
	return upstreamModel.startsWith("models/")
		? upstreamModel.slice("models/".length)
		: upstreamModel;
}

function googleEmbeddingTexts(input: EmbeddingInput): string[] {
	if (typeof input === "string") return [input];
	if (input.every((item) => typeof item === "string")) return input as string[];
	throw new GatewayError({
		class: "bad_request",
		message:
			"Google embeddings only support string inputs through the OpenAI-compatible contract.",
		code: "unsupported_parameter",
		param: "input",
		publicMessage:
			"Google embeddings only support string inputs through the OpenAI-compatible contract.",
	});
}

function textEmbeddingContent(text: string): Record<string, unknown> {
	return { parts: [{ text }] };
}

function plainRecord(value: unknown): Record<string, unknown> | null {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		return null;
	return value as Record<string, unknown>;
}

function splitGoogleEmbeddingExtraBody(req: CanonicalEmbeddingsRequest): {
	embedContentConfig?: Record<string, unknown>;
	extraBody?: Record<string, unknown>;
} {
	const extra = req.extraBody;
	const config: Record<string, unknown> = {};
	const rest: Record<string, unknown> = {};
	if (extra !== undefined) {
		for (const [key, value] of Object.entries(extra)) {
			if (key !== "embedContentConfig") {
				rest[key] = value;
				continue;
			}
			const incomingConfig = plainRecord(value);
			if (!incomingConfig) {
				throw new GatewayError({
					class: "bad_request",
					message: "extra_body.embedContentConfig must be an object",
					code: "invalid_extra_body",
					param: "extra_body.embedContentConfig",
				});
			}
			Object.assign(config, incomingConfig);
		}
	}
	if (
		req.dimensions !== undefined &&
		config.outputDimensionality !== undefined
	) {
		throw new GatewayError({
			class: "bad_request",
			message:
				'extra_body.embedContentConfig.outputDimensionality collides with managed request parameter "dimensions"',
			code: "invalid_extra_body",
			param: "extra_body.embedContentConfig.outputDimensionality",
		});
	}
	if (req.dimensions !== undefined)
		config.outputDimensionality = req.dimensions;

	return {
		...(Object.keys(config).length > 0 ? { embedContentConfig: config } : {}),
		...(Object.keys(rest).length > 0 ? { extraBody: rest } : {}),
	};
}

function googleEmbeddingRequestBody(
	req: CanonicalEmbeddingsRequest,
	ctx: AdapterContext,
): {
	body: Record<string, unknown>;
	method: "embedContent" | "batchEmbedContents";
} {
	const texts = googleEmbeddingTexts(req.input);
	const model = googleModelResource(ctx.upstreamModel);
	const { embedContentConfig, extraBody } = splitGoogleEmbeddingExtraBody(req);
	const requestFor = (text: string): Record<string, unknown> => ({
		model,
		content: textEmbeddingContent(text),
		...(embedContentConfig ? { embedContentConfig } : {}),
	});

	if (texts.length === 1) {
		return {
			method: "embedContent",
			body: mergeExtraBodyDeep(requestFor(texts[0]!), extraBody, [
				"model",
				"content",
				"outputDimensionality",
				"taskType",
				"title",
			]),
		};
	}

	return {
		method: "batchEmbedContents",
		body: mergeExtraBodyDeep({ requests: texts.map(requestFor) }, extraBody, [
			"requests",
			"model",
			"content",
			"outputDimensionality",
			"taskType",
			"title",
		]),
	};
}

function parseGeminiImageResponse(raw: unknown): CanonicalImageResponse {
	const response = (raw ?? {}) as GeminiResponse;
	const data = (response.candidates ?? [])
		.flatMap((candidate) => candidate.content?.parts ?? [])
		.flatMap((part) => {
			const inlineData = part.inlineData;
			if (typeof inlineData?.data !== "string") return [];
			return [
				{
					b64Json: inlineData.data,
					...(typeof inlineData.mimeType === "string"
						? { mimeType: inlineData.mimeType }
						: {}),
				},
			];
		});
	if (data.length === 0)
		throw new GatewayError({
			class: "server",
			message: "Google returned no image parts",
		});
	const u = response.usageMetadata;
	const usage =
		u?.totalTokenCount !== undefined
			? {
					inputTokens: u.promptTokenCount ?? 0,
					outputTokens:
						(u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
					totalTokens: u.totalTokenCount,
				}
			: undefined;
	return {
		created: Math.floor(Date.now() / 1000),
		data,
		...(usage ? { usage } : {}),
	};
}

function parseEmbeddingValues(value: unknown): number[] {
	if (
		!Array.isArray(value) ||
		value.some((item) => typeof item !== "number" || !Number.isFinite(item))
	) {
		throw new GatewayError({
			class: "server",
			message: "Google returned an invalid embedding vector",
		});
	}
	return value as number[];
}

function parseGeminiEmbeddingsResponse(
	raw: unknown,
	ctx: AdapterContext,
): CanonicalEmbeddingsResponse {
	const response = (raw ?? {}) as GeminiEmbeddingResponse;
	const embeddings =
		response.embeddings ??
		(response.embedding !== undefined ? [response.embedding] : []);
	if (embeddings.length === 0) {
		throw new GatewayError({
			class: "server",
			message: "Google returned no embeddings",
		});
	}
	const promptTokens = response.usageMetadata?.promptTokenCount;
	return {
		model: ctx.upstreamModel,
		data: embeddings.map((embedding, index) => ({
			index,
			embedding: parseEmbeddingValues(embedding.values),
		})),
		...(promptTokens !== undefined
			? { usage: { promptTokens, totalTokens: promptTokens } }
			: {}),
	};
}

function mapGoogleError(err: unknown): GatewayError {
	return mapUpstreamHttpError(err, {
		label: "Google",
		refineBadRequest: (message) =>
			looksLikeContextWindowError(message) ? "context_window" : null,
	});
}

function mapGeminiUsage(u: GeminiUsage | undefined): Usage {
	const thoughts = u?.thoughtsTokenCount ?? 0;
	// OpenAI semantics: completion_tokens includes the reasoning tokens. Gemini reports
	// candidatesTokenCount (visible output) and thoughtsTokenCount separately, so we add them.
	const completion = (u?.candidatesTokenCount ?? 0) + thoughts;
	const usage: Usage = {
		promptTokens: u?.promptTokenCount ?? 0,
		completionTokens: completion,
		totalTokens: u?.totalTokenCount ?? (u?.promptTokenCount ?? 0) + completion,
	};
	if (u?.cachedContentTokenCount !== undefined)
		usage.cacheReadTokens = u.cachedContentTokenCount;
	if (thoughts > 0) usage.reasoningTokens = thoughts;
	return usage;
}

function candidateToChoice(
	c: GeminiCandidate,
	index: number,
): CanonicalChatResponse["choices"][number] {
	const parts = c.content?.parts ?? [];
	const texts: string[] = [];
	const reasoning: string[] = [];
	const toolCalls: NonNullable<
		CanonicalChatResponse["choices"][number]["message"]["toolCalls"]
	> = [];
	for (const [i, p] of parts.entries()) {
		if (p.text !== undefined && !p.thought) texts.push(p.text);
		if (p.text !== undefined && p.thought) reasoning.push(p.text);
		if (p.functionCall) {
			toolCalls.push({
				id: `call_${index}_${i}`,
				name: p.functionCall.name ?? "",
				arguments: JSON.stringify(p.functionCall.args ?? {}),
			});
		}
	}
	const message: CanonicalChatResponse["choices"][number]["message"] = {
		role: "assistant",
		content: texts.length > 0 ? texts.join("") : null,
	};
	if (reasoning.length > 0) message.reasoning = reasoning.join("");
	if (toolCalls.length > 0) message.toolCalls = toolCalls;
	return {
		index: c.index ?? index,
		finishReason: mapGeminiFinish(c.finishReason, toolCalls.length > 0),
		message,
	};
}

function parseGeminiResponse(
	raw: unknown,
	ctx: AdapterContext,
): CanonicalChatResponse {
	const r = (raw ?? {}) as GeminiResponse;
	return {
		id: r.responseId ?? `gen-${randomUUID()}`,
		created: Math.floor(Date.now() / 1000),
		model: r.modelVersion ?? ctx.upstreamModel,
		choices: (r.candidates ?? []).map(candidateToChoice),
		usage: mapGeminiUsage(r.usageMetadata),
	};
}

const chat: ChatHandler = {
	buildRequest(req, ctx) {
		const c = creds(ctx);
		const base = (c.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
		const method = req.stream
			? "streamGenerateContent?alt=sse"
			: "generateContent";
		return {
			method: "POST",
			url: `${base}/models/${encodeURIComponent(ctx.upstreamModel)}:${method}`,
			headers: {
				"content-type": "application/json",
				"x-goog-api-key": c.apiKey,
				...(c.headers ?? {}),
			},
			body: JSON.stringify(buildGeminiBody(req, ctx)),
		};
	},

	parseResponse(raw, ctx) {
		return parseGeminiResponse(raw, ctx);
	},

	async *parseStream(stream, ctx) {
		const id = `gen-${randomUUID()}`;
		const created = Math.floor(Date.now() / 1000);
		let roleSent = false;
		for await (const event of parseSSE(stream)) {
			if (event.data === "[DONE]") return;
			let json: GeminiResponse;
			try {
				json = JSON.parse(event.data) as GeminiResponse;
			} catch {
				continue;
			}
			const candidate = json.candidates?.[0];
			const parts = candidate?.content?.parts ?? [];
			// Exclude reasoning (thought) parts: they are not visible content and do not count as the first token.
			const text = parts
				.filter((p) => !p.thought)
				.map((p) => p.text ?? "")
				.join("");
			const reasoning = parts
				.filter((p) => p.thought)
				.map((p) => p.text ?? "")
				.join("");
			const hasToolCall = parts.some((p) => p.functionCall);
			const delta: CanonicalChatStreamChunk["choices"][number]["delta"] = {};
			if (!roleSent) {
				delta.role = "assistant";
				roleSent = true;
			}
			if (text) delta.content = text;
			if (reasoning) delta.reasoning = reasoning;
			if (hasToolCall) {
				delta.toolCalls = parts
					.filter((p) => p.functionCall)
					.map((p, i) => ({
						index: i,
						id: `call_0_${i}`,
						name: p.functionCall!.name ?? "",
						arguments: JSON.stringify(p.functionCall!.args ?? {}),
					}));
			}
			const chunk: CanonicalChatStreamChunk = {
				id,
				created,
				model: json.modelVersion ?? ctx.upstreamModel,
				choices: [
					{
						index: 0,
						delta,
						finishReason: mapGeminiFinish(candidate?.finishReason, hasToolCall),
					},
				],
			};
			if (json.usageMetadata) chunk.usage = mapGeminiUsage(json.usageMetadata);
			yield chunk;
		}
	},

	mapError(err) {
		return mapGoogleError(err);
	},
};

const imageHandler: ImageHandler = {
	async buildRequest(req, ctx) {
		const c = creds(ctx);
		const base = (c.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
		return {
			method: "POST",
			url: `${base}/models/${encodeURIComponent(ctx.upstreamModel)}:generateContent`,
			headers: {
				"content-type": "application/json",
				"x-goog-api-key": c.apiKey,
				...(c.headers ?? {}),
			},
			body: JSON.stringify(await buildGeminiImageBody(req, ctx)),
		};
	},
	parseResponse(raw) {
		return parseGeminiImageResponse(raw);
	},
	mapError(err) {
		return mapGoogleError(err);
	},
};

const embeddings: EmbeddingsHandler = {
	buildRequest(req, ctx) {
		if (ctx.transport !== "embed_content") {
			throw new GatewayError({
				class: "bad_request",
				message: `Google: transport "${ctx.transport}" cannot create embeddings`,
			});
		}
		const c = creds(ctx);
		const base = (c.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
		const { body, method } = googleEmbeddingRequestBody(req, ctx);
		return {
			method: "POST",
			url: `${base}/models/${encodeURIComponent(
				googleModelPathId(ctx.upstreamModel),
			)}:${method}`,
			headers: {
				"content-type": "application/json",
				"x-goog-api-key": c.apiKey,
				...(c.headers ?? {}),
			},
			body: JSON.stringify(body),
		};
	},
	parseResponse(raw, ctx) {
		return parseGeminiEmbeddingsResponse(raw, ctx);
	},
	mapError(err) {
		return mapGoogleError(err);
	},
};

export const googleAdapter: Adapter = {
	key: "googleaistudio",
	supportedCallTypes: new Set([
		"chat",
		"images.generations",
		"images.edits",
		"embeddings",
	]),
	chat,
	imageGeneration: imageHandler,
	imageEdit: imageHandler,
	embeddings,
	reasoningKinds: new Set<ReasoningControlKind>([
		"gemini_level",
		"gemini_budget",
	]),
	transports: {
		chat: { supported: ["generate_content"], default: "generate_content" },
		"images.generations": {
			supported: ["generate_content"],
			default: "generate_content",
		},
		"images.edits": {
			supported: ["generate_content"],
			default: "generate_content",
		},
		embeddings: {
			supported: ["embed_content"],
			default: "embed_content",
		},
	},
};

export const googleProvider: ProviderModule = { adapter: googleAdapter };
