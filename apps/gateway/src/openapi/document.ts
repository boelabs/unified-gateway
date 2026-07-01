/**
 * Builds the OpenAPI 3.1 document from the Zod component schemas. The result is serialized to
 * `openapi.yaml` by scripts/openapi-generate.ts and guarded against drift by openapi.test.ts, so the
 * spec is always generated from the same schemas the API speaks — never hand-maintained.
 */

import { createDocument, type ZodOpenApiRequestBodyObject } from "zod-openapi";
import * as c from "./components.ts";
import * as z from "zod/v4";

const errorResponse = { $ref: "#/components/responses/Error" } as const;
const cacheParams = [
	{ $ref: "#/components/parameters/CacheHeader" },
	{ $ref: "#/components/parameters/CacheTtlHeader" },
];

/** `{ data: [...], pagination }` envelope used by the paginated admin list endpoints. */
function paginated(item: z.ZodType) {
	return z.object({ data: z.array(item), pagination: c.Pagination });
}

const jsonBody = (
	schema: z.ZodType,
	examples?: Record<string, { value: unknown }>,
): ZodOpenApiRequestBodyObject => ({
	required: true,
	content: {
		"application/json": { schema, ...(examples ? { examples } : {}) },
	},
});

export function buildOpenApiDocument() {
	return createDocument({
		openapi: "3.1.0",
		info: {
			title: "Unified Gateway API",
			version: "1.0.0",
			description:
				"Provider-agnostic AI gateway with exact OpenAI/OpenResponses public contracts. " +
				"Importable in Postman, Insomnia, Bruno, and similar tools.\n\n" +
				"AUTHENTICATION: Bearer token (Authorization: Bearer <key>), x-api-key header, or " +
				"?api_key=<key> query parameter (for browser EventSource clients). The master key is " +
				"required for /admin/*.\n\n" +
				"RESPONSE CONVENTIONS:\n" +
				"- Inference (/v1/chat/completions, /v1/responses, /v1/images/*, /v1/embeddings, " +
				"/v1/models): exact OpenAI/OpenResponses contracts.\n" +
				'- Management (/admin/*): envelope { "data": <object|array> }; lists: { "data": [...], ' +
				'"pagination": {...} }; delete: 204 with no body; error: { "error": {...} }.\n\n' +
				"RESPONSE HEADERS: x-request-id (all responses; echoed if sent on the request). " +
				"Virtual-key inference responses can also include " +
				"x-ratelimit-{limit,remaining,reset}-{requests,tokens,budget}.",
		},
		servers: [
			{
				url: "{baseUrl}",
				variables: { baseUrl: { default: "http://localhost:4000" } },
			},
		],
		security: [{ bearerAuth: [] }],
		tags: [{ name: "Inference" }, { name: "Admin" }, { name: "Health" }],
		components: {
			securitySchemes: {
				bearerAuth: {
					type: "http",
					scheme: "bearer",
					description:
						"Master key or virtual key. Admin requires the master key. Alternative: x-api-key header or ?api_key=.",
				},
			},
			parameters: {
				IdPath: {
					name: "id",
					in: "path",
					required: true,
					schema: { type: "string", format: "uuid" },
				},
				ResponseIdPath: {
					name: "id",
					in: "path",
					required: true,
					schema: { type: "string" },
					description: "OpenResponses response id (resp_...)",
				},
				Limit: {
					name: "limit",
					in: "query",
					required: false,
					schema: { type: "integer", default: 50 },
				},
				Offset: {
					name: "offset",
					in: "query",
					required: false,
					schema: { type: "integer", default: 0 },
				},
				CacheHeader: {
					name: "x-unified-cache",
					in: "header",
					required: false,
					schema: { type: "string", enum: ["true", "1"] },
					description: "Opt-in response cache (non-stream, no tools).",
				},
				CacheTtlHeader: {
					name: "x-unified-cache-ttl",
					in: "header",
					required: false,
					schema: { type: "integer" },
					description: "Cache TTL in seconds (default 300).",
				},
			},
			responses: {
				Error: {
					description: "OpenAI-shaped error",
					content: { "application/json": { schema: c.ErrorSchema } },
				},
			},
		},
		paths: {
			/* ------------------------------------------------------------ health */
			"/health/live": {
				get: {
					tags: ["Health"],
					summary: "Liveness (process only, no dependencies)",
					description:
						"Always 200 while the process is responsive. Does NOT check Postgres/Redis, so a dependency outage never triggers a restart. Wire this to the orchestrator's liveness probe.",
					security: [],
					responses: { "200": { description: "Process is alive" } },
				},
			},
			"/health/ready": {
				get: {
					tags: ["Health"],
					summary: "Readiness (DB + Redis + extensions)",
					description:
						"200 when Postgres, Redis and the extension runtime are healthy; otherwise 503 with a Retry-After header. Wire this to the readiness probe so a dependency outage pulls the instance from the load balancer without restarting it.",
					security: [],
					responses: {
						"200": { description: "Ready to serve traffic" },
						"503": { description: "Not ready (a dependency is down)" },
					},
				},
			},
			"/health": {
				get: {
					tags: ["Health"],
					summary: "Readiness alias (backward compatible)",
					description:
						"Alias of /health/ready, kept for backward compatibility.",
					security: [],
					responses: {
						"200": { description: "OK" },
						"503": { description: "Degraded" },
					},
				},
			},
			/* --------------------------------------------------------- inference */
			"/v1/chat/completions": {
				post: {
					tags: ["Inference"],
					summary:
						"Chat Completions (exact OpenAI contract, stream + no-stream)",
					parameters: cacheParams,
					requestBody: jsonBody(c.ChatCompletionRequest, {
						simple: {
							value: {
								model: "gemini",
								messages: [{ role: "user", content: "Hello, how are you?" }],
							},
						},
						streaming: {
							value: {
								model: "gemini",
								stream: true,
								stream_options: { include_usage: true },
								messages: [{ role: "user", content: "Count from 1 to 5" }],
							},
						},
					}),
					responses: {
						"200": {
							description:
								"chat.completion (or SSE stream of chat.completion.chunk)",
						},
						"400": errorResponse,
						"401": errorResponse,
						"403": errorResponse,
						"429": errorResponse,
					},
				},
			},
			"/v1/responses": {
				post: {
					tags: ["Inference"],
					summary:
						"Responses (OpenResponses, provider-agnostic, stream + no-stream)",
					parameters: cacheParams,
					requestBody: jsonBody(c.ResponsesRequest, {
						simple: {
							value: {
								model: "gemini",
								input: "Say hello in 3 words",
								instructions: "Be concise.",
							},
						},
						streaming: {
							value: {
								model: "gemini",
								stream: true,
								input: "Count from 1 to 5",
							},
						},
					}),
					responses: {
						"200": {
							description: "response (or SSE stream of response.* events)",
						},
						"400": errorResponse,
					},
				},
			},
			"/v1/responses/{id}": {
				get: {
					tags: ["Inference"],
					summary: "Retrieve a stored response (server-side store)",
					description:
						"Returns the stored canonical `response` object when store=true. Scope is per key: a virtual key only sees its own responses; the master key sees responses created with the master key.",
					parameters: [{ $ref: "#/components/parameters/ResponseIdPath" }],
					responses: {
						"200": { description: "response object (OpenResponses contract)" },
						"404": errorResponse,
					},
				},
				delete: {
					tags: ["Inference"],
					summary: "Delete a stored response",
					parameters: [{ $ref: "#/components/parameters/ResponseIdPath" }],
					responses: {
						"200": {
							description: "{ id, object: 'response.deleted', deleted: true }",
						},
						"404": errorResponse,
					},
				},
			},
			"/v1/responses/{id}/input_items": {
				get: {
					tags: ["Inference"],
					summary: "List input items for a stored response",
					parameters: [{ $ref: "#/components/parameters/ResponseIdPath" }],
					responses: {
						"200": {
							description:
								"{ object: 'list', data: [...], first_id, last_id, has_more }",
						},
						"404": errorResponse,
					},
				},
			},
			"/v1/messages": {
				post: {
					tags: ["Inference"],
					summary:
						"Anthropic Messages API (provider-agnostic, stream + no-stream)",
					description:
						"Exact Anthropic Messages contract, serviceable by any provider through the canonical hub. Errors and SSE events are rendered in Anthropic format.",
					requestBody: jsonBody(c.MessagesRequest, {
						simple: {
							value: {
								model: "claude",
								max_tokens: 1024,
								system: "Be concise.",
								messages: [{ role: "user", content: "Hello" }],
							},
						},
						streaming: {
							value: {
								model: "claude",
								max_tokens: 1024,
								stream: true,
								messages: [{ role: "user", content: "Count from 1 to 5" }],
							},
						},
					}),
					responses: {
						"200": {
							description:
								"message (or SSE stream: message_start, content_block_*, message_delta, message_stop)",
						},
						"400": {
							description: "{ type: 'error', error: {...} } (Anthropic shape)",
						},
					},
				},
			},
			"/v1/embeddings": {
				post: {
					operationId: "createEmbedding",
					tags: ["Inference"],
					summary: "Create embeddings (OpenAI contract, no-stream)",
					description:
						"Accepts a string input, a string batch, tokens, or a tokenized batch. Routes the embeddings operation to OpenAI/OpenAI-compatible providers or Google AI Studio, with opt-in response caching through x-unified-cache. Each model validates its own profile: for example, Google AI Studio accepts text + float only, without tokenized input or base64.",
					parameters: cacheParams,
					requestBody: jsonBody(c.EmbeddingsRequest, {
						simple: {
							value: {
								model: "text-embedding-3-small",
								input: "The food was delicious",
								encoding_format: "float",
							},
						},
						batch: {
							value: {
								model: "text-embedding-3-small",
								input: ["red fox", "blue whale"],
								dimensions: 512,
							},
						},
					}),
					responses: {
						"200": {
							description: "CreateEmbeddingResponse",
							content: { "application/json": { schema: c.EmbeddingsResponse } },
						},
						"400": errorResponse,
						"401": errorResponse,
						"403": errorResponse,
						"429": errorResponse,
					},
				},
			},
			"/v1/images/generations": {
				post: {
					operationId: "createImageGeneration",
					tags: ["Inference"],
					summary: "Generate images (OpenAI Images contract, JSON or SSE)",
					description:
						"Routes images.generations to OpenAI Images, compatible APIs, Gemini generateContent, or multimodal chat_completions models. Parameters are validated against the model profile.",
					requestBody: jsonBody(c.ImageGenerationRequest, {
						gptImage: {
							value: {
								model: "gpt-image",
								prompt: "A tiny astronaut in a botanical garden",
								size: "1024x1024",
								quality: "high",
							},
						},
					}),
					responses: {
						"200": {
							description:
								"ImagesResponse JSON, or SSE events image_generation.partial_image/completed",
							content: { "application/json": { schema: c.ImagesResponse } },
						},
						"400": errorResponse,
						"401": errorResponse,
						"403": errorResponse,
						"429": errorResponse,
					},
				},
			},
			"/v1/images/edits": {
				post: {
					operationId: "createImageEdit",
					tags: ["Inference"],
					summary: "Edit images (multipart; OpenAI Images contract)",
					description:
						"Accepts up to 16 `image`/`image[]` parts, an optional PNG mask, and `extra_body` as a JSON string. Uploads are validated and stored temporarily during the request.",
					requestBody: {
						required: true,
						content: {
							"multipart/form-data": {
								schema: c.ImageEditRequest,
								encoding: {
									image: { contentType: "image/png, image/jpeg, image/webp" },
									mask: { contentType: "image/png" },
								},
							},
						},
					},
					responses: {
						"200": {
							description:
								"ImagesResponse JSON, or SSE events image_edit.partial_image/completed",
							content: { "application/json": { schema: c.ImagesResponse } },
						},
						"400": errorResponse,
						"401": errorResponse,
						"403": errorResponse,
						"429": errorResponse,
					},
				},
			},
			"/v1/models": {
				get: {
					tags: ["Inference"],
					summary: "List public models visible to the key (OpenAI contract)",
					responses: {
						"200": {
							description:
								"{ object: 'list', data: [{ id, object, created, owned_by }] }",
						},
					},
				},
			},
			"/v1/models/{model}": {
				get: {
					tags: ["Inference"],
					summary: "Retrieve a public model (OpenAI contract)",
					parameters: [
						{
							name: "model",
							in: "path",
							required: true,
							schema: { type: "string" },
						},
					],
					responses: {
						"200": {
							description: "{ id, object: 'model', created, owned_by }",
						},
						"404": errorResponse,
					},
				},
			},
			/* ------------------------------------------------------------- admin */
			"/admin/operations": {
				get: {
					tags: ["Admin"],
					operationId: "listOperations",
					summary:
						"Discover available operations, endpoints, and transports by adapter",
					responses: {
						"200": { description: "Operation and adapter registry" },
						"401": errorResponse,
					},
				},
			},
			"/admin/provider-presets": {
				get: {
					tags: ["Admin"],
					operationId: "listProviderPresets",
					summary:
						"List provider presets (OpenAI, Azure OpenAI/Foundry, Google, Anthropic, OpenRouter, compatibles)",
					description:
						"Each preset resolves the code adapter, required credential keys, defaults (for example baseUrl), and the per-operation transport. They are used when creating a deployment with `provider`.",
					responses: {
						"200": { description: "Provider presets without credentials" },
						"401": errorResponse,
					},
				},
			},
			"/admin/deployments/resolve": {
				post: {
					tags: ["Admin"],
					operationId: "resolveDeployment",
					summary: "Resolve profile, operations, and transports without saving",
					description:
						"Same body as POST /admin/deployments (credentials are accepted and ignored).",
					requestBody: jsonBody(c.CreateDeployment),
					responses: {
						"200": { description: "Effective deployment configuration" },
						"400": errorResponse,
					},
				},
			},
			"/admin/deployments": {
				get: {
					tags: ["Admin"],
					operationId: "listDeployments",
					summary: "List deployments (master key, paginated)",
					parameters: [
						{ $ref: "#/components/parameters/Limit" },
						{ $ref: "#/components/parameters/Offset" },
					],
					responses: {
						"200": {
							description: "Paginated deployments (without credentials)",
							content: {
								"application/json": { schema: paginated(z.unknown()) },
							},
						},
						"401": errorResponse,
					},
				},
				post: {
					tags: ["Admin"],
					operationId: "createDeployment",
					summary: "Create a deployment with the API key inline",
					description:
						"Creates a deployment: public name (`publicModel`) + exact upstream model + inline credentials. `provider` (preset) resolves the adapter, required keys, and default transports; an explicit `adapterKey` can be provided instead. Multiple deployments with the same `publicModel` form a balanced pool.",
					requestBody: jsonBody(c.CreateDeployment, {
						gptImage: {
							value: {
								publicModel: "gpt-image",
								provider: "openai",
								upstreamModel: "gpt-image-2",
								credentials: { apiKey: "sk-..." },
							},
						},
						customCompatible: {
							value: {
								publicModel: "grok",
								adapterKey: "openaicompatible",
								upstreamModel: "grok-4",
								credentials: {
									apiKey: "xai-...",
									baseUrl: "https://api.x.ai/v1",
								},
							},
						},
					}),
					responses: {
						"201": {
							description:
								"Deployment created and resolved; credentials are never returned",
						},
						"400": errorResponse,
					},
				},
			},
			"/admin/deployments/{id}": {
				parameters: [{ $ref: "#/components/parameters/IdPath" }],
				get: {
					tags: ["Admin"],
					operationId: "retrieveDeployment",
					summary: "Retrieve a deployment (without credentials)",
					responses: {
						"200": { description: "Deployment" },
						"404": errorResponse,
					},
				},
				patch: {
					tags: ["Admin"],
					operationId: "updateDeployment",
					summary:
						"Update upstreamModel, credentials, catalogEntry, pricing, transportOverrides, or routing",
					requestBody: jsonBody(c.UpdateDeployment),
					responses: {
						"200": { description: "Deployment updated and resolved" },
						"404": errorResponse,
					},
				},
				delete: {
					tags: ["Admin"],
					operationId: "deleteDeployment",
					summary: "Delete a deployment",
					responses: {
						"204": { description: "No Content" },
						"404": errorResponse,
					},
				},
			},
			"/admin/keys": {
				get: {
					tags: ["Admin"],
					summary: "List virtual keys (master key, paginated)",
					parameters: [
						{ $ref: "#/components/parameters/Limit" },
						{ $ref: "#/components/parameters/Offset" },
						{ name: "enabled", in: "query", schema: { type: "boolean" } },
						{
							name: "publicModel",
							in: "query",
							schema: { type: "string" },
							description: "Keys with access to this Public Model",
						},
						{
							name: "q",
							in: "query",
							schema: { type: "string" },
							description: "Search in name/prefix",
						},
					],
					responses: {
						"200": {
							description: "Paginated virtual keys",
							content: {
								"application/json": { schema: paginated(z.unknown()) },
							},
						},
					},
				},
				post: {
					tags: ["Admin"],
					summary: "Create virtual key (returns the plaintext key ONCE)",
					requestBody: jsonBody(c.CreateKey, {
						scoped: {
							value: {
								name: "app-frontend",
								allowedModels: ["gemini", "gpt"],
								maxBudgetCents: 500,
								budgetReset: "monthly",
								rpm: 60,
							},
						},
						unlimited: { value: { name: "full-access", allowedModels: [] } },
					}),
					responses: {
						"201": { description: "{ data: { ...key, key: '<rawKey>' } }" },
					},
				},
			},
			"/admin/keys/{id}": {
				patch: {
					tags: ["Admin"],
					summary: "Edit virtual key (master key)",
					parameters: [{ $ref: "#/components/parameters/IdPath" }],
					requestBody: jsonBody(c.UpdateKey, {
						disable: { value: { enabled: false } },
						raiseBudget: { value: { maxBudgetCents: 2000 } },
						resetSpend: { value: { resetSpend: true } },
					}),
					responses: {
						"200": { description: "{ data: <key> }" },
						"404": errorResponse,
					},
				},
				delete: {
					tags: ["Admin"],
					summary: "Delete virtual key (master key)",
					parameters: [{ $ref: "#/components/parameters/IdPath" }],
					responses: { "204": { description: "No Content" } },
				},
			},
			"/admin/cache": {
				delete: {
					tags: ["Admin"],
					summary: "Invalidate response cache (master key)",
					parameters: [
						{
							name: "callType",
							in: "query",
							schema: { type: "string" },
							description: "e.g. chat | responses (default: all)",
						},
						{
							name: "namespace",
							in: "query",
							schema: { type: "string" },
							description: "virtual key id or 'master' (default: all)",
						},
					],
					responses: { "200": { description: "{ data: { deleted: <n> } }" } },
				},
			},
			"/admin/extensions": {
				get: {
					tags: ["Admin"],
					summary:
						"Inspect the runtime extension state of this process (master key, read-only)",
					responses: {
						"200": {
							description:
								"{ data: { loaded, status, healthy, definitions, instances } }",
						},
					},
				},
			},
			"/admin/extensions/artifacts": {
				get: {
					tags: ["Admin"],
					summary:
						"List uploaded extension artifacts (all keys and versions, no code)",
					responses: {
						"200": {
							description:
								"{ data: [{ id, key, version, contentHash, sizeBytes, status, uploadedBy, createdAt }] }",
						},
					},
				},
				post: {
					tags: ["Admin"],
					summary:
						"Upload a new extension version and make it active (master key)",
					description:
						"The module source is validated (imported and checked for a valid definition whose key matches) before it is stored, so an invalid upload is rejected with 400 and never reaches the fleet.",
					requestBody: jsonBody(
						z.object({
							key: z.string().regex(/^[a-z0-9]+$/),
							code: z.string().meta({ description: "ESM module source" }),
						}),
					),
					responses: {
						"201": { description: "{ data: <artifact summary> }" },
						"400": errorResponse,
					},
				},
			},
			"/admin/extensions/artifacts/{key}/versions": {
				get: {
					tags: ["Admin"],
					summary: "Version history for one definition (master key)",
					parameters: [
						{
							name: "key",
							in: "path",
							required: true,
							schema: { type: "string" },
						},
					],
					responses: {
						"200": { description: "{ data: [<artifact summary>] }" },
					},
				},
			},
			"/admin/extensions/artifacts/{key}/activate": {
				post: {
					tags: ["Admin"],
					summary:
						"Activate a specific version, archiving the rest (rollback, master key)",
					parameters: [
						{
							name: "key",
							in: "path",
							required: true,
							schema: { type: "string" },
						},
					],
					requestBody: jsonBody(z.object({ version: z.int().min(1) })),
					responses: {
						"200": { description: "{ data: [<artifact summary>] }" },
						"404": errorResponse,
					},
				},
			},
			"/admin/extensions/artifacts/{key}": {
				delete: {
					tags: ["Admin"],
					summary: "Remove every version of a definition (master key)",
					parameters: [
						{
							name: "key",
							in: "path",
							required: true,
							schema: { type: "string" },
						},
					],
					responses: { "204": { description: "Deleted (idempotent)" } },
				},
			},
			"/admin/extensions/instances": {
				get: {
					tags: ["Admin"],
					summary: "List extension instances (master key)",
					responses: { "200": { description: "{ data: [<instance>] }" } },
				},
				post: {
					tags: ["Admin"],
					summary: "Create an extension instance (master key)",
					requestBody: jsonBody(
						z.object({
							id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/),
							definition: z.string().regex(/^[a-z0-9]+$/),
							enabled: z.boolean().optional(),
							critical: z.union([z.boolean(), z.null()]).optional(),
							priority: z.int().optional(),
							match: z.record(z.string(), z.unknown()).optional(),
							config: z.unknown().optional(),
						}),
					),
					responses: {
						"201": { description: "{ data: <instance> }" },
						"400": errorResponse,
					},
				},
			},
			"/admin/extensions/instances/{id}": {
				patch: {
					tags: ["Admin"],
					summary: "Update an extension instance (master key)",
					parameters: [
						{
							name: "id",
							in: "path",
							required: true,
							schema: { type: "string" },
						},
					],
					requestBody: jsonBody(
						z.object({
							definition: z
								.string()
								.regex(/^[a-z0-9]+$/)
								.optional(),
							enabled: z.boolean().optional(),
							critical: z.union([z.boolean(), z.null()]).optional(),
							priority: z.int().optional(),
							match: z.record(z.string(), z.unknown()).optional(),
							config: z.unknown().optional(),
						}),
					),
					responses: {
						"200": { description: "{ data: <instance> }" },
						"404": errorResponse,
					},
				},
				delete: {
					tags: ["Admin"],
					summary: "Delete an extension instance (master key)",
					parameters: [
						{
							name: "id",
							in: "path",
							required: true,
							schema: { type: "string" },
						},
					],
					responses: { "204": { description: "Deleted (idempotent)" } },
				},
			},
			"/admin/extensions/{id}/reset": {
				post: {
					tags: ["Admin"],
					summary:
						"Clear a circuit-breaker trip and re-activate an instance (master key)",
					parameters: [
						{
							name: "id",
							in: "path",
							required: true,
							schema: { type: "string" },
						},
					],
					responses: {
						"200": { description: "{ data: <extension status> }" },
						"400": errorResponse,
						"404": errorResponse,
					},
				},
			},
			"/admin/logs": {
				get: {
					tags: ["Admin"],
					summary: "List request logs (master key, paginated, newest first)",
					parameters: [
						{ $ref: "#/components/parameters/Limit" },
						{ $ref: "#/components/parameters/Offset" },
						{
							name: "virtualKeyId",
							in: "query",
							schema: { type: "string", format: "uuid" },
						},
						{ name: "publicModel", in: "query", schema: { type: "string" } },
						{
							name: "deploymentId",
							in: "query",
							schema: { type: "string", format: "uuid" },
						},
						{ name: "adapterKey", in: "query", schema: { type: "string" } },
						{
							name: "callType",
							in: "query",
							schema: { type: "string" },
							description: "chat | responses | messages",
						},
						{
							name: "status",
							in: "query",
							schema: { type: "string", enum: ["success", "error"] },
						},
						{ name: "requestId", in: "query", schema: { type: "string" } },
						{ name: "cacheHit", in: "query", schema: { type: "boolean" } },
						{
							name: "start",
							in: "query",
							schema: { type: "string", format: "date-time" },
							description: "start_time >= (narrows partitions)",
						},
						{
							name: "end",
							in: "query",
							schema: { type: "string", format: "date-time" },
							description: "start_time <=",
						},
					],
					responses: {
						"200": {
							description: "{ data: [<requestLog>], pagination: {...} }",
						},
						"400": errorResponse,
					},
				},
			},
			"/admin/usage": {
				get: {
					tags: ["Admin"],
					summary:
						"Aggregate usage (requests, tokens, cost), optionally grouped (master key)",
					description:
						"Sums requests/tokens/cost over request_logs. Accepts the same filters as /admin/logs (virtualKeyId, publicModel, status, start, end, ...). groupBy=none returns a single total.",
					parameters: [
						{
							name: "groupBy",
							in: "query",
							required: false,
							schema: {
								type: "string",
								enum: [
									"public_model",
									"virtual_key",
									"adapter_key",
									"day",
									"none",
								],
								default: "none",
							},
						},
						{
							name: "virtualKeyId",
							in: "query",
							schema: { type: "string", format: "uuid" },
						},
						{ name: "publicModel", in: "query", schema: { type: "string" } },
						{ name: "adapterKey", in: "query", schema: { type: "string" } },
						{ name: "callType", in: "query", schema: { type: "string" } },
						{
							name: "status",
							in: "query",
							schema: { type: "string", enum: ["success", "error"] },
						},
						{ name: "cacheHit", in: "query", schema: { type: "boolean" } },
						{
							name: "start",
							in: "query",
							schema: { type: "string", format: "date-time" },
						},
						{
							name: "end",
							in: "query",
							schema: { type: "string", format: "date-time" },
						},
					],
					responses: {
						"200": {
							description:
								"{ data: [{ key, requests, promptTokens, completionTokens, totalTokens, costCents }] }",
						},
						"400": errorResponse,
					},
				},
			},
			"/admin/router-settings": {
				get: {
					tags: ["Admin"],
					summary: "View router config (master key)",
					responses: { "200": { description: "{ data: <settings|null> }" } },
				},
				put: {
					tags: ["Admin"],
					summary: "Update router config (master key)",
					requestBody: jsonBody(c.RouterSettings, {
						default: {
							value: {
								routingStrategy: "simple-shuffle",
								allowedFails: 3,
								cooldownSeconds: 5,
								numRetries: 3,
								timeoutSeconds: 600,
								retryAfterSeconds: 0,
							},
						},
					}),
					responses: { "200": { description: "{ data: <settings> }" } },
				},
			},
			"/admin/fallbacks": {
				get: {
					tags: ["Admin"],
					summary: "List fallbacks (master key)",
					responses: { "200": { description: "{ data: [...] }" } },
				},
				put: {
					tags: ["Admin"],
					summary: "Create/update dedicated fallback (master key)",
					description:
						"Configures an exact chain by (primaryModel, reason). Public Models must exist and each target must share at least one executable operation with the primary. The router exhausts the primary deployments before traversing the chain.",
					requestBody: jsonBody(c.Fallback, {
						general: {
							value: {
								primaryModel: "gpt",
								fallbackModels: ["gemini"],
								reason: "general",
							},
						},
					}),
					responses: {
						"201": { description: "{ data: <fallback> }" },
						"400": errorResponse,
					},
				},
			},
			"/admin/fallbacks/{primaryModel}/{reason}": {
				delete: {
					tags: ["Admin"],
					summary: "Delete fallback (master key)",
					parameters: [
						{
							name: "primaryModel",
							in: "path",
							required: true,
							schema: { type: "string" },
						},
						{
							name: "reason",
							in: "path",
							required: true,
							schema: {
								type: "string",
								enum: ["general", "context_window", "content_policy"],
							},
						},
					],
					responses: { "204": { description: "No Content" } },
				},
			},
		},
	});
}
