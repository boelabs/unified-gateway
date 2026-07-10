import { decryptJson, encryptJson, type EncEnvelope } from "#db/crypto.ts";

const COMPACTION_PREFIX = "ugcmp_1.";

interface CompactionPayload {
	version: 1;
	summary: string;
}

export function encodeCompactionSummary(summary: string): string {
	const envelope = encryptJson({
		version: 1,
		summary,
	} satisfies CompactionPayload);
	return `${COMPACTION_PREFIX}${Buffer.from(JSON.stringify(envelope)).toString("base64url")}`;
}

export function decodeCompactionSummary(value: unknown): string | undefined {
	if (typeof value !== "string" || !value.startsWith(COMPACTION_PREFIX))
		return undefined;
	try {
		const encoded = value.slice(COMPACTION_PREFIX.length);
		const envelope = JSON.parse(
			Buffer.from(encoded, "base64url").toString("utf8"),
		) as EncEnvelope;
		const payload = decryptJson<CompactionPayload>(envelope);
		return payload.version === 1 && typeof payload.summary === "string"
			? payload.summary
			: undefined;
	} catch {
		return undefined;
	}
}

export function expandLocalCompactionItems(
	items: Record<string, unknown>[],
): Record<string, unknown>[] {
	return items.flatMap((item) => {
		if (item.type !== "compaction") return [item];
		const summary = decodeCompactionSummary(item.encrypted_content);
		if (summary === undefined) return [item];
		return [
			{
				type: "message",
				role: "developer",
				content: [{ type: "input_text", text: summary }],
			},
		];
	});
}
