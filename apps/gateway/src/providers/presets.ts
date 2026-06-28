import type { TransportOverrides } from "#profiles/types.ts";

const PROVIDER_PRESET_IDS = [
	"openai",
	"googleaistudio",
	"anthropic",
	"azureopenai",
	"azurefoundry",
	"openrouter",
	"openaicompatible",
] as const;

type ProviderPresetId = (typeof PROVIDER_PRESET_IDS)[number];

/**
 * Shortcut for creating a model: a `provider` resolves the code adapter, the required credential
 * keys, defaults (e.g. baseUrl), and the per-operation transport.
 */
export interface ProviderPreset {
	id: ProviderPresetId;
	name: string;
	adapterKey: string;
	credentialsDefaults?: Record<string, unknown>;
	requiredCredentialKeys: string[];
	defaultTransportOverrides: TransportOverrides;
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
	{
		id: "openai",
		name: "OpenAI",
		adapterKey: "openai",
		requiredCredentialKeys: ["apiKey"],
		defaultTransportOverrides: {
			"text.generate": "responses",
			"image.generate": "images",
			"image.edit": "images",
			"embedding.create": "embeddings",
		},
	},
	{
		id: "googleaistudio",
		name: "Google AI Studio",
		adapterKey: "googleaistudio",
		requiredCredentialKeys: ["apiKey"],
		defaultTransportOverrides: {
			"text.generate": "generate_content",
			"image.generate": "generate_content",
			"image.edit": "generate_content",
			"embedding.create": "embed_content",
		},
	},
	{
		id: "anthropic",
		name: "Anthropic",
		adapterKey: "anthropic",
		credentialsDefaults: { version: "2023-06-01" },
		requiredCredentialKeys: ["apiKey"],
		defaultTransportOverrides: { "text.generate": "messages" },
	},
	{
		id: "azureopenai",
		name: "Azure OpenAI v1",
		adapterKey: "azureopenai",
		requiredCredentialKeys: ["apiKey", "baseUrl"],
		defaultTransportOverrides: {
			"text.generate": "responses",
			"embedding.create": "embeddings",
		},
	},
	{
		id: "azurefoundry",
		name: "Azure Foundry Models v1",
		adapterKey: "azurefoundry",
		requiredCredentialKeys: ["apiKey", "baseUrl"],
		defaultTransportOverrides: { "text.generate": "chat_completions" },
	},
	{
		id: "openrouter",
		name: "OpenRouter",
		adapterKey: "openaicompatible",
		credentialsDefaults: { baseUrl: "https://openrouter.ai/api/v1" },
		requiredCredentialKeys: ["apiKey"],
		defaultTransportOverrides: {
			"text.generate": "chat_completions",
			"image.generate": "chat_completions",
			"image.edit": "chat_completions",
			"embedding.create": "embeddings",
		},
	},
	{
		id: "openaicompatible",
		name: "Custom OpenAI-compatible",
		adapterKey: "openaicompatible",
		requiredCredentialKeys: ["apiKey", "baseUrl"],
		defaultTransportOverrides: {
			"text.generate": "chat_completions",
			"image.generate": "images",
			"image.edit": "images",
			"embedding.create": "embeddings",
		},
	},
] as const;

const PRESETS = new Map(PROVIDER_PRESETS.map((preset) => [preset.id, preset]));

export function getProviderPreset(id: string): ProviderPreset | undefined {
	const preset = PRESETS.get(id as ProviderPresetId);
	return preset ? structuredClone(preset) : undefined;
}

export function resolvePresetCredentials(
	preset: ProviderPreset,
	credentials: Record<string, unknown>,
): Record<string, unknown> {
	return { ...(preset.credentialsDefaults ?? {}), ...credentials };
}
