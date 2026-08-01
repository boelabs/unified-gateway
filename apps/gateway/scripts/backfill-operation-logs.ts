import { closeDb, db } from "../src/db/client.ts";
import { asc, lte } from "drizzle-orm";

import {
	gatewayOperations,
	upstreamAttempts,
	requestLogs,
} from "../src/db/schema.ts";

const BATCH_SIZE = 500;
let migrated = 0;

function legacyMetadataSummary(value: unknown): Record<string, unknown> {
	return {
		legacy: true,
		originalMetadataKeys:
			value !== null && typeof value === "object" && !Array.isArray(value)
				? Object.keys(value as Record<string, unknown>).sort()
				: [],
	};
}

function legacyErrorSummary(value: unknown): Record<string, unknown> | null {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		return null;
	const record = value as Record<string, unknown>;
	const safe = Object.fromEntries(
		["class", "code", "http_status", "failure_kind"].flatMap((key) =>
			typeof record[key] === "string" || typeof record[key] === "number"
				? [[key, record[key]]]
				: [],
		),
	);
	return Object.keys(safe).length > 0 ? safe : null;
}
const cutoffArg = process.argv.find((arg) => arg.startsWith("--cutoff="));
const cutoff = cutoffArg
	? new Date(cutoffArg.slice("--cutoff=".length))
	: new Date();
if (Number.isNaN(cutoff.getTime()))
	throw new Error("--cutoff must be an ISO-8601 timestamp");

try {
	while (true) {
		const rows = await db
			.select()
			.from(requestLogs)
			.where(lte(requestLogs.startTime, cutoff))
			.orderBy(asc(requestLogs.startTime))
			.limit(BATCH_SIZE)
			.offset(migrated);
		if (rows.length === 0) break;
		for (const row of rows) {
			await db
				.insert(gatewayOperations)
				.values({
					id: row.id,
					requestId: row.requestId,
					virtualKeyId: row.virtualKeyId,
					publicModel: row.publicModel,
					callType: row.callType,
					lifecycleState: "finished",
					outcome: "unknown",
					degraded: row.retries > 0 || row.fallbackUsed,
					terminalVerified: false,
					legacy: true,
					cacheHit: row.cacheHit,
					httpStatus: row.httpStatus,
					promptTokens: row.promptTokens,
					completionTokens: row.completionTokens,
					totalTokens: row.totalTokens,
					searchUnits: row.searchUnits,
					consumerCostCents: row.costCents,
					upstreamCostCents: row.costCents,
					durationMs: row.durationMs,
					firstOutputMs: row.ttftMs,
					startedAt: row.startTime,
					endedAt: row.endTime,
					lastProgressAt: row.endTime ?? row.startTime,
					requestSummary: { legacy: true, payloadDiscarded: true },
					responseSummary: { legacy: true, payloadDiscarded: true },
					metadata: legacyMetadataSummary(row.metadata),
					error: legacyErrorSummary(row.error),
				})
				.onConflictDoNothing();

			const attempts = (row.attempts ?? []) as Array<Record<string, unknown>>;
			if (attempts.length > 0) {
				await db
					.insert(upstreamAttempts)
					.values(
						attempts.map((attempt, index) => {
							const durationMs = Number(attempt.ms ?? 0);
							const endedAt = row.endTime ?? row.startTime;
							return {
								operationId: row.id,
								ordinal: index + 1,
								deploymentId:
									typeof attempt.deploymentId === "string"
										? attempt.deploymentId
										: null,
								deploymentLabel:
									typeof attempt.label === "string" ? attempt.label : null,
								adapterKey:
									typeof attempt.adapterKey === "string"
										? attempt.adapterKey
										: null,
								transport:
									typeof attempt.transport === "string"
										? attempt.transport
										: null,
								outcome: "unknown" as const,
								terminalVerified: false,
								failureOwner: null,
								failureKind: null,
								failurePhase: null,
								healthEffect: "neutral",
								durationMs,
								lastProgressAt: endedAt,
								startedAt: new Date(endedAt.getTime() - durationMs),
								endedAt,
								diagnostics: { legacy: true },
							};
						}),
					)
					.onConflictDoNothing();
			}
			migrated += 1;
		}
		process.stdout.write(
			`Backfilled ${migrated} legacy request logs through ${cutoff.toISOString()}\n`,
		);
	}
} finally {
	await closeDb();
}
