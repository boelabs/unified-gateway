/**
 * UPSTREAM TRANSPORT: the interface an adapter uses to talk to the provider. Resolved by CallType,
 * independent of the public endpoint that renders the canonical result.
 *   - chat_completions: POST /chat/completions (OpenAI and compatibles)
 *   - responses:        POST /responses (OpenAI native)
 *   - generate_content: Google AI Studio (Gemini)
 *   - messages:         Anthropic
 *   - images:           OpenAI Images API (/images/generations and /images/edits)
 *   - audio_transcriptions: OpenAI Audio API (/audio/transcriptions, multipart)
 *   - embeddings:       OpenAI-compatible Embeddings API (/embeddings)
 *   - embed_content:    Google Gemini Embeddings API (:embedContent/:batchEmbedContents)
 */
export type UpstreamTransport =
	| "chat_completions"
	| "responses"
	| "generate_content"
	| "messages"
	| "images"
	| "audio_transcriptions"
	| "embeddings"
	| "embed_content";

const UPSTREAM_TRANSPORTS: readonly UpstreamTransport[] = [
	"chat_completions",
	"responses",
	"generate_content",
	"messages",
	"images",
	"audio_transcriptions",
	"embeddings",
	"embed_content",
] as const;

export function isUpstreamTransport(
	value: unknown,
): value is UpstreamTransport {
	return (
		typeof value === "string" &&
		(UPSTREAM_TRANSPORTS as readonly string[]).includes(value)
	);
}

/** Transports supported by an adapter and which one it uses by default. */
export interface AdapterTransports {
	supported: readonly UpstreamTransport[];
	default: UpstreamTransport;
}
