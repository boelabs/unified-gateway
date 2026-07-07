import type {
	CanonicalChatStreamChunk,
	CanonicalChatResponse,
	CanonicalChatRequest,
} from "./canonical.ts";

type ToolCall = NonNullable<
	CanonicalChatResponse["choices"][number]["message"]["toolCalls"]
>[number];

interface OpaqueToolCallState {
	id?: string;
	extraContent?: Record<string, unknown>;
}

export type OpaqueToolCallStateMap = Map<string, OpaqueToolCallState>;

const LITELLM_THOUGHT_SEPARATOR = "__thought__";

function recordValue(value: unknown): Record<string, unknown> | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		return undefined;
	return value as Record<string, unknown>;
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
	return structuredClone(value);
}

function mergeRecords(
	base: Record<string, unknown>,
	override: Record<string, unknown>,
): Record<string, unknown> {
	const merged = cloneRecord(base);
	for (const [key, value] of Object.entries(override)) {
		const current = recordValue(merged[key]);
		const next = recordValue(value);
		merged[key] =
			current !== undefined && next !== undefined
				? mergeRecords(current, next)
				: structuredClone(value);
	}
	return merged;
}

export function mergeOpaqueExtraContent(
	...values: Array<Record<string, unknown> | undefined>
): Record<string, unknown> | undefined {
	let merged: Record<string, unknown> | undefined;
	for (const value of values) {
		if (value === undefined) continue;
		merged =
			merged === undefined ? cloneRecord(value) : mergeRecords(merged, value);
	}
	return merged;
}

export function providerSpecificFieldsFromExtraContent(
	extraContent: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	const google = recordValue(extraContent?.google);
	const signature = google?.thought_signature ?? google?.thoughtSignature;
	if (typeof signature !== "string" || signature.length === 0) return undefined;
	return { thought_signature: signature };
}

export function extraContentFromProviderSpecificFields(
	value: unknown,
): Record<string, unknown> | undefined {
	const fields = recordValue(value);
	const signature = fields?.thought_signature ?? fields?.thoughtSignature;
	if (typeof signature !== "string" || signature.length === 0) return undefined;
	return { google: { thought_signature: signature } };
}

export function extraContentFromThoughtSignatureId(
	id: unknown,
): Record<string, unknown> | undefined {
	if (typeof id !== "string") return undefined;
	const index = id.indexOf(LITELLM_THOUGHT_SEPARATOR);
	if (index < 0) return undefined;
	const signature = id.slice(index + LITELLM_THOUGHT_SEPARATOR.length);
	return signature.length > 0
		? { google: { thought_signature: signature } }
		: undefined;
}

export function thoughtSignaturesFromToolCalls(
	toolCalls: Array<{ extraContent?: Record<string, unknown> }> | undefined,
): string[] {
	const signatures: string[] = [];
	for (const tc of toolCalls ?? []) {
		const fields = providerSpecificFieldsFromExtraContent(tc.extraContent);
		const signature = fields?.thought_signature;
		if (typeof signature === "string" && signature.length > 0)
			signatures.push(signature);
	}
	return signatures;
}

export function providerSpecificFieldsFromToolCalls(
	toolCalls: Array<{ extraContent?: Record<string, unknown> }> | undefined,
): Record<string, unknown> | undefined {
	const thoughtSignatures = thoughtSignaturesFromToolCalls(toolCalls);
	return thoughtSignatures.length > 0
		? { thought_signatures: thoughtSignatures }
		: undefined;
}

export function mergeStoredOpaqueExtraContent(
	incoming: Record<string, unknown> | undefined,
	stored: unknown,
): Record<string, unknown> | undefined {
	const storedExtra = recordValue(stored);
	if (storedExtra === undefined) return incoming;
	if (incoming === undefined) return cloneRecord(storedExtra);
	return mergeRecords(storedExtra, incoming);
}

function opaqueToolCallItem(tc: {
	id: string;
	extraContent?: Record<string, unknown>;
}): Record<string, unknown>[] {
	if (tc.id.length === 0 || tc.extraContent === undefined) return [];
	if (Object.keys(tc.extraContent).length === 0) return [];
	return [
		{
			type: "tool_call",
			id: tc.id,
			extra_content: cloneRecord(tc.extraContent),
			...(providerSpecificFieldsFromExtraContent(tc.extraContent) !== undefined
				? {
						provider_specific_fields: providerSpecificFieldsFromExtraContent(
							tc.extraContent,
						),
					}
				: {}),
		},
	];
}

export async function hydrateCanonicalToolCallOpaqueState(
	req: CanonicalChatRequest,
	lookup: (id: string) => Promise<Record<string, unknown> | undefined>,
): Promise<CanonicalChatRequest> {
	let changed = false;
	const messages = [];

	for (const message of req.messages) {
		if (!message.toolCalls?.length) {
			messages.push(message);
			continue;
		}

		const toolCalls: ToolCall[] = [];
		for (const tc of message.toolCalls) {
			const stored = tc.id.length > 0 ? await lookup(tc.id) : undefined;
			const merged = mergeStoredOpaqueExtraContent(
				tc.extraContent,
				stored?.extra_content,
			);
			if (merged === tc.extraContent) {
				toolCalls.push(tc);
				continue;
			}
			changed = true;
			toolCalls.push(
				merged === undefined ? { ...tc } : { ...tc, extraContent: merged },
			);
		}
		messages.push({ ...message, toolCalls });
	}

	return changed ? { ...req, messages } : req;
}

export function opaqueToolCallItemsFromResponse(
	resp: CanonicalChatResponse,
): Record<string, unknown>[] {
	return resp.choices.flatMap((choice) =>
		(choice.message.toolCalls ?? []).flatMap(opaqueToolCallItem),
	);
}

export function captureOpaqueToolCallStateFromChunk(
	state: OpaqueToolCallStateMap,
	chunk: CanonicalChatStreamChunk,
): void {
	for (const choice of chunk.choices) {
		for (const tc of choice.delta.toolCalls ?? []) {
			const key = `${choice.index}:${tc.index}`;
			const current = state.get(key) ?? {};
			if (tc.id !== undefined) current.id = tc.id;
			if (tc.extraContent !== undefined)
				current.extraContent = cloneRecord(tc.extraContent);
			state.set(key, current);
		}
	}
}

export function opaqueToolCallItemsFromState(
	state: OpaqueToolCallStateMap,
): Record<string, unknown>[] {
	return [...state.values()].flatMap((tc) => {
		if (tc.id === undefined) return [];
		return tc.extraContent === undefined
			? opaqueToolCallItem({ id: tc.id })
			: opaqueToolCallItem({ id: tc.id, extraContent: tc.extraContent });
	});
}
