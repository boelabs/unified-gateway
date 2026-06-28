import { and, count, desc, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import type { Page, PageResult } from "./deployments.ts";
import { requestLogs } from "#db/schema.ts";
import { db } from "#db/client.ts";

export type RequestLogRow = typeof requestLogs.$inferSelect;

export interface RequestLogFilter {
	virtualKeyId?: string;
	publicModel?: string;
	deploymentId?: string;
	adapterKey?: string;
	callType?: string;
	status?: string;
	requestId?: string;
	cacheHit?: boolean;
	/** Range over start_time (inclusive). Bounds which partitions are scanned. */
	start?: Date;
	end?: Date;
}

function buildConds(f: RequestLogFilter): SQL[] {
	const conds: SQL[] = [];
	if (f.virtualKeyId) conds.push(eq(requestLogs.virtualKeyId, f.virtualKeyId));
	if (f.publicModel) conds.push(eq(requestLogs.publicModel, f.publicModel));
	if (f.deploymentId) conds.push(eq(requestLogs.deploymentId, f.deploymentId));
	if (f.adapterKey) conds.push(eq(requestLogs.adapterKey, f.adapterKey));
	if (f.callType) conds.push(eq(requestLogs.callType, f.callType));
	if (f.status) conds.push(eq(requestLogs.status, f.status));
	if (f.requestId) conds.push(eq(requestLogs.requestId, f.requestId));
	if (f.cacheHit !== undefined)
		conds.push(eq(requestLogs.cacheHit, f.cacheHit));
	if (f.start) conds.push(gte(requestLogs.startTime, f.start));
	if (f.end) conds.push(lte(requestLogs.startTime, f.end));
	return conds;
}

/** Lists logs with filters + pagination in SQL (most recent first). */
export async function listRequestLogsPage(
	opts: Page & RequestLogFilter,
): Promise<PageResult<RequestLogRow>> {
	const conds = buildConds(opts);
	const where = conds.length > 0 ? and(...conds) : undefined;
	const [rows, totalRow] = await Promise.all([
		db
			.select()
			.from(requestLogs)
			.where(where)
			.orderBy(desc(requestLogs.startTime))
			.limit(opts.limit)
			.offset(opts.offset),
		db.select({ value: count() }).from(requestLogs).where(where),
	]);
	return { rows, total: Number(totalRow[0]?.value ?? 0) };
}

export type UsageGroupBy =
	| "public_model"
	| "virtual_key"
	| "adapter_key"
	| "day"
	| "none";

export interface UsageRow {
	key: string | null;
	requests: number;
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	costCents: number;
}

const GROUP_COLUMN = {
	public_model: requestLogs.publicModel,
	virtual_key: requestLogs.virtualKeyId,
	adapter_key: requestLogs.adapterKey,
} as const;

/**
 * Aggregates usage (requests, tokens, cost) over request_logs, optionally grouped.
 * `day` groups by (UTC) day of start_time; `none` returns a single total.
 */
export async function aggregateUsage(
	opts: RequestLogFilter & { groupBy: UsageGroupBy },
): Promise<UsageRow[]> {
	const conds = buildConds(opts);
	const where = conds.length > 0 ? and(...conds) : undefined;

	const metrics = {
		requests: count(),
		promptTokens: sql<number>`coalesce(sum(${requestLogs.promptTokens}), 0)::int`,
		completionTokens: sql<number>`coalesce(sum(${requestLogs.completionTokens}), 0)::int`,
		totalTokens: sql<number>`coalesce(sum(${requestLogs.totalTokens}), 0)::int`,
		costCents: sql<number>`coalesce(sum(${requestLogs.costCents}), 0)::float8`,
	};

	if (opts.groupBy === "none") {
		const [row] = await db.select(metrics).from(requestLogs).where(where);
		return [{ key: null, ...emptyIfMissing(row) }];
	}

	const keyExpr =
		opts.groupBy === "day"
			? sql<string>`to_char(date_trunc('day', ${requestLogs.startTime} at time zone 'UTC'), 'YYYY-MM-DD')`
			: (GROUP_COLUMN[opts.groupBy] as unknown as SQL<string>);

	const rows = await db
		.select({ key: keyExpr, ...metrics })
		.from(requestLogs)
		.where(where)
		.groupBy(keyExpr)
		.orderBy(desc(metrics.costCents));

	return rows.map((r) => ({
		key: r.key === null || r.key === undefined ? null : String(r.key),
		requests: Number(r.requests),
		promptTokens: Number(r.promptTokens),
		completionTokens: Number(r.completionTokens),
		totalTokens: Number(r.totalTokens),
		costCents: Number(r.costCents),
	}));
}

function emptyIfMissing(
	row:
		| {
				requests: number;
				promptTokens: number;
				completionTokens: number;
				totalTokens: number;
				costCents: number;
		  }
		| undefined,
): Omit<UsageRow, "key"> {
	return {
		requests: Number(row?.requests ?? 0),
		promptTokens: Number(row?.promptTokens ?? 0),
		completionTokens: Number(row?.completionTokens ?? 0),
		totalTokens: Number(row?.totalTokens ?? 0),
		costCents: Number(row?.costCents ?? 0),
	};
}
