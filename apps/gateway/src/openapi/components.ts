/**
 * OpenAPI component schemas, defined as Zod so the spec is generated — never hand-maintained.
 *
 * These mirror the public HTTP contracts. The inference bodies (chat/responses/messages/embeddings/
 * images) are intentionally loose (`additionalProperties: true`) because the gateway forwards
 * provider-specific extras; the admin bodies are strict and kept in lock-step with the runtime Zod
 * validators by a conformance test (see openapi.test.ts). `.meta({ id })` registers a schema as a
 * reusable `#/components/schemas/<id>` entry.
 */

import "zod-openapi"; // ambient types for `.meta({ id, ... })`

import * as z from "zod/v4";

/** An object that accepts arbitrary extra keys (`additionalProperties: true`). */
function loose(shape: z.ZodRawShape, meta: Record<string, unknown>): z.ZodType {
	return z
		.object(shape)
		.meta({ override: { additionalProperties: true }, ...meta });
}

const nullableString = z.union([z.string(), z.null()]);
const nullableInteger = z.union([z.int(), z.null()]);

/* ------------------------------------------------------------------ shared */

export const ErrorSchema = z
	.object({
		error: z.object({
			message: z.string(),
			type: z.string(),
			param: nullableString.optional(),
			code: nullableString.optional(),
		}),
	})
	.meta({ id: "Error" });

export const Pagination = z
	.object({
		limit: z.int(),
		offset: z.int(),
		total: z.int(),
		nextOffset: nullableInteger,
	})
	.meta({ id: "Pagination" });

export const JsonSchemaDefinition = z.record(z.string(), z.unknown()).meta({
	id: "JsonSchemaDefinition",
	description: "JSON Schema the model output must satisfy.",
});

/* ------------------------------------------------- inference: response format */

const textFormat = z.object({ type: z.literal("text") });
const jsonObjectFormat = z.object({ type: z.literal("json_object") });

export const ChatResponseFormat = z
	.union([
		textFormat,
		jsonObjectFormat,
		z.object({
			type: z.literal("json_schema"),
			json_schema: z.object({
				name: z.string(),
				description: z.string().optional(),
				schema: JsonSchemaDefinition.optional(),
				strict: z.union([z.boolean(), z.null()]).optional(),
			}),
		}),
	])
	.meta({ id: "ChatResponseFormat" });

export const ResponsesTextFormat = z
	.union([
		textFormat,
		jsonObjectFormat,
		z.object({
			type: z.literal("json_schema"),
			name: z.string(),
			description: z.string().optional(),
			schema: JsonSchemaDefinition,
			strict: z.union([z.boolean(), z.null()]).optional(),
		}),
	])
	.meta({ id: "ResponsesTextFormat" });

export const ResponsesTextConfig = loose(
	{ format: ResponsesTextFormat.optional() },
	{ id: "ResponsesTextConfig" },
);

export const MessagesOutputConfig = loose(
	{
		effort: z
			.union([z.enum(["low", "medium", "high", "xhigh", "max"]), z.null()])
			.optional(),
		format: z
			.object({
				type: z.literal("json_schema"),
				schema: JsonSchemaDefinition,
			})
			.optional(),
	},
	{ id: "MessagesOutputConfig" },
);

/* ------------------------------------------------------ inference: requests */

export const ChatCompletionRequest = loose(
	{
		model: z.string().meta({ description: "public model (public_model)" }),
		messages: z.array(
			loose(
				{
					role: z.enum(["system", "developer", "user", "assistant", "tool"]),
					content: z.unknown().optional(),
				},
				{},
			),
		),
		stream: z.boolean().default(false),
		stream_options: z
			.object({ include_usage: z.boolean().optional() })
			.optional(),
		temperature: z.number().optional(),
		top_p: z.number().optional(),
		max_tokens: z.int().optional(),
		max_completion_tokens: z.int().optional(),
		tools: z.array(loose({}, {})).optional(),
		tool_choice: z.unknown().optional(),
		response_format: ChatResponseFormat.optional(),
	},
	{ id: "ChatCompletionRequest" },
);

export const MessagesRequest = loose(
	{
		model: z.string(),
		max_tokens: z.int(),
		messages: z.array(
			loose(
				{
					role: z.enum(["user", "assistant"]),
					content: z.unknown().optional(),
				},
				{},
			),
		),
		system: z
			.unknown()
			.meta({ description: "string or array of text blocks" })
			.optional(),
		stream: z.boolean().default(false),
		temperature: z.number().optional(),
		top_p: z.number().optional(),
		top_k: z.int().optional(),
		stop_sequences: z.array(z.string()).optional(),
		tools: z.array(loose({}, {})).optional(),
		tool_choice: loose({}, {}).optional(),
		output_config: MessagesOutputConfig.optional(),
	},
	{ id: "MessagesRequest" },
);

export const ResponsesRequest = loose(
	{
		model: z.string(),
		input: z
			.unknown()
			.meta({
				description: "string or array of items (message/function_call/...)",
			})
			.optional(),
		instructions: nullableString.optional(),
		stream: z.boolean().default(false),
		max_output_tokens: z.int().optional(),
		temperature: z.number().optional(),
		top_p: z.number().optional(),
		tools: z.array(loose({}, {})).optional(),
		tool_choice: z.unknown().optional(),
		text: ResponsesTextConfig.optional(),
		store: z.boolean().optional().meta({
			description:
				"Persist server-side state for chaining with previous_response_id. Default follows RESPONSES_STORE_DEFAULT (true = OpenAI-compatible). Managed by the gateway; not forwarded upstream.",
		}),
		previous_response_id: z.string().optional().meta({
			description:
				"Chains with a stored response (store): the gateway concatenates its input+output with the new input. Local pointer, not forwarded upstream. Cannot be combined with conversation.",
		}),
		background: z.boolean().optional().meta({
			description: "Unsupported: background:true is rejected with 400.",
		}),
		conversation: z.unknown().optional().meta({
			description: "Cannot be combined with previous_response_id (400).",
		}),
		prompt: z.unknown().optional().meta({
			description: "Prompt templates are unsupported (400).",
		}),
	},
	{ id: "ResponsesRequest" },
);

/* ---------------------------------------------------------------- embeddings */

export const EmbeddingsRequest = z
	.object({
		model: z.string().meta({ description: "public model" }),
		input: z.union([
			z.string().min(1),
			z.array(z.string().min(1)).min(1),
			z.array(z.int().min(0)).min(1),
			z.array(z.array(z.int().min(0)).min(1)).min(1),
		]),
		encoding_format: z.enum(["float", "base64"]).default("float").optional(),
		dimensions: z.int().min(1).optional(),
		user: z.string().optional(),
		extra_body: z.record(z.string(), z.unknown()).optional().meta({
			description:
				"Provider-specific JSON parameters without collisions with managed fields.",
		}),
	})
	.meta({ id: "EmbeddingsRequest" });

export const Embedding = z
	.object({
		object: z.literal("embedding"),
		embedding: z.union([
			z.array(z.number()),
			z.string().meta({ description: "Base64 when encoding_format=base64." }),
		]),
		index: z.int(),
	})
	.meta({ id: "Embedding" });

export const EmbeddingsResponse = z
	.object({
		object: z.literal("list"),
		data: z.array(Embedding),
		model: z.string(),
		usage: z
			.object({
				prompt_tokens: z.int().optional(),
				total_tokens: z.int().optional(),
			})
			.optional(),
	})
	.meta({ id: "EmbeddingsResponse" });

/* -------------------------------------------------------------------- images */

const nullableEnum = (values: [string, ...string[]]) =>
	z.union([z.enum(values), z.null()]);
const sizePattern = z.string().regex(/^(auto|[1-9][0-9]*x[1-9][0-9]*)$/);

export const ImageGenerationRequest = z
	.object({
		model: z.string().meta({ description: "public model" }),
		prompt: z.string().min(1).max(32000),
		background: nullableEnum(["transparent", "opaque", "auto"]).optional(),
		moderation: nullableEnum(["low", "auto"]).optional(),
		n: nullableInteger.optional(),
		output_compression: nullableInteger.optional(),
		output_format: nullableEnum(["png", "jpeg", "webp"]).optional(),
		partial_images: nullableInteger.optional(),
		quality: nullableEnum([
			"standard",
			"hd",
			"low",
			"medium",
			"high",
			"auto",
		]).optional(),
		response_format: nullableEnum(["b64_json"]).default("b64_json").optional(),
		size: z.union([sizePattern, z.null()]).optional(),
		stream: z.union([z.boolean(), z.null()]).default(false).optional(),
		style: nullableEnum(["vivid", "natural"]).optional(),
		user: nullableString.optional(),
		extra_body: z.record(z.string(), z.unknown()).optional().meta({
			description:
				"Provider-specific JSON parameters; max 64 KiB and no collisions with managed fields.",
		}),
	})
	.meta({ id: "ImageGenerationRequest" });

export const ImageEditRequest = z
	.object({
		model: z.string(),
		prompt: z.string().min(1).max(32000),
		image: z
			.array(z.string().meta({ format: "binary" }))
			.min(1)
			.max(16)
			.meta({ description: "Send one or more parts named image or image[]." }),
		mask: z
			.string()
			.meta({
				format: "binary",
				description: "PNG <=4 MB; same dimensions as the first image.",
			})
			.optional(),
		background: nullableEnum(["transparent", "opaque", "auto"]).optional(),
		input_fidelity: nullableEnum(["high", "low"]).optional(),
		n: nullableInteger.optional(),
		output_compression: nullableInteger.optional(),
		output_format: nullableEnum(["png", "jpeg", "webp"]).optional(),
		partial_images: nullableInteger.optional(),
		quality: nullableEnum([
			"standard",
			"low",
			"medium",
			"high",
			"auto",
		]).optional(),
		response_format: nullableEnum(["b64_json"]).default("b64_json").optional(),
		size: z.union([sizePattern, z.null()]).optional(),
		stream: z.union([z.boolean(), z.null()]).default(false).optional(),
		user: nullableString.optional(),
		extra_body: z
			.string()
			.meta({ description: "Serialized JSON object; max 64 KiB." })
			.optional(),
	})
	.meta({ id: "ImageEditRequest" });

export const ImageData = z
	.object({
		b64_json: z.string(),
		revised_prompt: z.string().optional(),
	})
	.meta({ id: "ImageData" });

const imageTokenDetails = z
	.object({
		image_tokens: z.int().optional(),
		text_tokens: z.int().optional(),
	})
	.optional();

export const ImageUsage = z
	.object({
		input_tokens: z.int(),
		output_tokens: z.int(),
		total_tokens: z.int(),
		input_tokens_details: imageTokenDetails,
		output_tokens_details: imageTokenDetails,
	})
	.meta({ id: "ImageUsage" });

export const ImagesResponse = z
	.object({
		created: z.int(),
		data: z.array(ImageData),
		background: z.enum(["transparent", "opaque"]).optional(),
		output_format: z.enum(["png", "jpeg", "webp"]).optional(),
		quality: z.enum(["low", "medium", "high"]).optional(),
		size: z.string().optional(),
		usage: ImageUsage.optional(),
	})
	.meta({ id: "ImagesResponse" });

/* --------------------------------------------------------- deployments/config */

const operationNames = [
	"text.generate",
	"image.generate",
	"image.edit",
	"audio.transcribe",
	"embedding.create",
] as const;

export const TransportOverrides = z
	.record(z.enum(operationNames), z.string())
	.meta({
		id: "TransportOverrides",
		description:
			"Advanced operation-to-transport override. Defaults normally come from the connection.",
	});

export const OperationProfiles = z
	.record(z.enum(operationNames), z.record(z.string(), z.unknown()))
	.meta({ id: "OperationProfiles" });

export const CatalogEntry = loose(
	{
		operations: OperationProfiles,
	},
	{ id: "CatalogEntry" },
);

const pricing = z.record(z.string(), z.number());

export const CreateDeployment = z
	.object({
		publicModel: z
			.string()
			.meta({ description: "Public alias sent as model in /v1." }),
		provider: z.string().optional().meta({
			description:
				"Known preset (openai, googleaistudio, anthropic, openrouter, openaicompatible).",
		}),
		adapterKey: z
			.string()
			.optional()
			.meta({ description: "Explicit adapter; alternative to provider." }),
		upstreamModel: z
			.string()
			.meta({ description: "Exact ID; preserves slash namespaces." }),
		credentials: z.record(z.string(), z.unknown()).meta({
			description:
				"Inline API key (e.g. { apiKey }). Encrypted; never returned.",
		}),
		label: nullableString.optional().meta({
			description:
				"Human identifier to tell deployments of the same publicModel apart (e.g. which API key). Snapshotted into request logs (metadata.deploymentLabel, attempts[].label).",
		}),
		metadata: z.record(z.string(), z.unknown()).optional().meta({
			description:
				"Free-form operator annotations (team, environment, key alias, rotation date, notes...). Up to 16 KiB; stored and returned verbatim.",
		}),
		catalogEntry: CatalogEntry.optional().meta({
			description:
				"REQUIRED if the model is not in the catalog (custom); FORBIDDEN if it is. 1:1 entry with catalog.json.",
		}),
		pricing: pricing.optional().meta({
			description: "Operator pricing for cost calculation (optional).",
		}),
		transportOverrides: TransportOverrides.optional().meta({
			description:
				"Per-operation transport override. Usually inferred from the adapter; rarely needed.",
		}),
		enabled: z.boolean().optional(),
		weight: z.int().min(0).optional(),
		tpmLimit: nullableInteger.optional(),
		rpmLimit: nullableInteger.optional(),
	})
	.meta({ id: "CreateDeployment" });

export const UpdateDeployment = z
	.object({
		publicModel: z.string().optional(),
		upstreamModel: z.string().optional(),
		credentials: z.record(z.string(), z.unknown()).optional().meta({
			description: "Credential patch; re-encrypted, never returned.",
		}),
		label: nullableString.optional().meta({
			description: "Human identifier; null clears it.",
		}),
		metadata: z.record(z.string(), z.unknown()).optional().meta({
			description: "Replaces the stored metadata object.",
		}),
		catalogEntry: z.union([CatalogEntry, z.null()]).optional(),
		pricing: z.union([pricing, z.null()]).optional(),
		transportOverrides: TransportOverrides.optional(),
		enabled: z.boolean().optional(),
		weight: z.int().min(0).optional(),
		tpmLimit: nullableInteger.optional(),
		rpmLimit: nullableInteger.optional(),
	})
	.meta({ id: "UpdateDeployment" });

/* ---------------------------------------------------------------- virtual keys */

const budgetReset = z.union([
	z.enum(["hourly", "daily", "weekly", "monthly"]),
	z.null(),
]);

export const CreateKey = z
	.object({
		name: z.string(),
		allowedModels: z
			.array(z.string())
			.optional()
			.meta({ description: "Allowed Public Models; [] = all" }),
		maxBudgetCents: nullableInteger.optional(),
		budgetReset: budgetReset.optional(),
		tpm: nullableInteger.optional(),
		rpm: nullableInteger.optional(),
		expiresAt: z.union([z.iso.datetime(), z.null()]).optional(),
	})
	.meta({ id: "CreateKey" });

export const UpdateKey = z
	.object({
		name: z.string().optional(),
		allowedModels: z.array(z.string()).optional(),
		maxBudgetCents: nullableInteger.optional(),
		budgetReset: budgetReset.optional(),
		tpm: nullableInteger.optional(),
		rpm: nullableInteger.optional(),
		enabled: z.boolean().optional(),
		expiresAt: z.union([z.iso.datetime(), z.null()]).optional(),
		resetSpend: z
			.boolean()
			.optional()
			.meta({ description: "true resets spend for the current period" }),
	})
	.meta({ id: "UpdateKey" });

/* ------------------------------------------------------------ router/fallbacks */

export const RouterSettings = z
	.object({
		routingStrategy: z
			.enum([
				"simple-shuffle",
				"least-busy",
				"usage-based-tpm",
				"usage-based-rpm",
				"latency-based",
				"throughput-based",
				"price-based",
				"health-aware",
			])
			.optional(),
		unsupportedParameterStrategy: z
			.enum(["drop", "error", "allow"])
			.optional()
			.meta({
				description:
					"How the router handles parameters explicitly marked unsupported by the selected deployment profile.",
			}),
		allowedFails: z.int().min(0).optional().meta({
			description:
				"Accumulated failures that trigger cooldown for a deployment.",
		}),
		cooldownSeconds: z.int().min(0).optional(),
		numRetries: z.int().min(0).optional().meta({
			description:
				"Maximum retries per deployment, in addition to the initial attempt. Resets for each deployment in each fallback pool.",
		}),
		timeoutSeconds: z
			.int()
			.min(1)
			.optional()
			.meta({ description: "Timeout per upstream attempt." }),
		retryAfterSeconds: z.int().min(0).optional(),
	})
	.meta({ id: "RouterSettings" });

export const Fallback = z
	.object({
		primaryModel: z.string().meta({
			description:
				"Primary public name; must have at least one persisted deployment.",
		}),
		fallbackModels: z.array(z.string()).min(1).max(5).meta({
			uniqueItems: true,
			description:
				"Fallback public names in order. Each one must exist and share an executable operation with the primary.",
		}),
		reason: z
			.enum(["general", "context_window", "content_policy"])
			.default("general")
			.optional()
			.meta({
				description:
					"Aggregated cause of the primary failure; not an operation. Chain lookup is exact by reason.",
			}),
	})
	.meta({ id: "Fallback" });
