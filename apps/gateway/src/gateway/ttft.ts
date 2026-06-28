import type { CanonicalChatStreamChunk } from "#core/canonical.ts";

/**
 * Wraps a stream of CANONICAL chunks and records (only once) the instant of the first real token
 * - visible reasoning, text content, or tool call - via `onFirstToken(epochMs)`. Measuring at the canonical layer
 * (not in each contract's public render) makes TTFT identical and provider-agnostic for
 * /v1/chat/completions, /v1/responses, and /v1/messages, regardless of how each render reorders events.
 */
export async function* tapFirstToken(
	chunks: AsyncIterable<CanonicalChatStreamChunk>,
	onFirstToken: (epochMs: number) => void,
): AsyncGenerator<CanonicalChatStreamChunk> {
	let seen = false;
	for await (const chunk of chunks) {
		if (!seen) {
			const delta = chunk.choices[0]?.delta;
			if (
				delta?.reasoning ||
				delta?.content ||
				(delta?.toolCalls && delta.toolCalls.length > 0)
			) {
				seen = true;
				onFirstToken(Date.now());
			}
		}
		yield chunk;
	}
}
