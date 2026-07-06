import { ADAPTER_KEY_RULE, isAdapterKey } from "./key.ts";
import type { CallType } from "#core/callType.ts";
import type { Adapter } from "./types.ts";

/**
 * In-memory registry of adapters (defined in code). `model_deployments.adapter_key` references one of
 * these keys. It is the source of truth for which upstream protocols exist.
 */
const registry = new Map<string, Adapter>();

/** Maps each internal CallType to the handler that must exist on the adapter. */
const HANDLER_KEY: Partial<Record<CallType, keyof Adapter>> = {
	chat: "chat",
	"images.generations": "imageGeneration",
	"images.edits": "imageEdit",
	"videos.generations": "videoGeneration",
	"audio.transcriptions": "audioTranscription",
	embeddings: "embeddings",
};

export function registerAdapter(adapter: Adapter): void {
	if (!isAdapterKey(adapter.key)) {
		throw new Error(
			`Invalid adapter key "${adapter.key}": ${ADAPTER_KEY_RULE}.`,
		);
	}
	if (registry.has(adapter.key)) {
		throw new Error(`Duplicate adapter: "${adapter.key}"`);
	}
	// Consistency: every declared CallType must have its handler implemented.
	for (const ct of adapter.supportedCallTypes) {
		const capKey = HANDLER_KEY[ct];
		if (capKey && adapter[capKey] === undefined) {
			throw new Error(
				`Adapter "${adapter.key}" declares support for "${ct}" but does not implement its handler.`,
			);
		}
	}
	registry.set(adapter.key, adapter);
}

export function getAdapter(key: string): Adapter | undefined {
	return registry.get(key);
}

export function listAdapters(): Adapter[] {
	return [...registry.values()];
}

export function adapterSupportsCallType(
	key: string,
	callType: CallType,
): boolean {
	return registry.get(key)?.supportedCallTypes.has(callType) ?? false;
}

/** Test-only: clears the registry. */
export function __resetRegistry(): void {
	registry.clear();
}
