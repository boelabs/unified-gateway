import type { Adapter, ProviderModule } from "#adapters/types.ts";
import { makeAzureTranscriptionHandler } from "./audio.ts";
import { makeAzurev1Adapter } from "#adapters/azurev1.ts";

const LABEL = "Azure OpenAI v1";

/** Azure OpenAI GA v1 adapter, before composing its separate file-audio data plane. */
const base = makeAzurev1Adapter({
	key: "azureopenai",
	label: LABEL,
	defaultTransport: "responses",
	supportedChatTransports: ["responses", "chat_completions"],
	contentInputs: {
		responses: {
			file: {
				sources: ["provider_file_id", "data_url"],
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
	embeddings: true,
	liveTranscriptions: true,
});

/**
 * Text, embeddings, and Realtime use `/openai/v1`; file transcription uses Azure's documented,
 * versioned deployment endpoint. Both transports still share one canonical audio contract.
 */
export const azureopenaiAdapter: Adapter = {
	...base,
	supportedCallTypes: new Set([
		...base.supportedCallTypes,
		"audio.transcriptions",
	]),
	audioTranscription: makeAzureTranscriptionHandler(LABEL),
	transports: {
		...base.transports,
		"audio.transcriptions": {
			supported: ["audio_transcriptions"],
			default: "audio_transcriptions",
		},
	},
};

export const azureopenaiProvider: ProviderModule = {
	adapter: azureopenaiAdapter,
};
