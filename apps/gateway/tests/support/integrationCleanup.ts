import { invalidateResponseCache } from "#cache/responseCache.ts";
import { redis } from "#cache/redis.ts";
import { sql } from "#db/client.ts";

const UUID_PATTERN =
	"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

const PUBLIC_MODEL_PREFIXES = [
	"custom-img",
	"embed-e2e",
	"fallback-image",
	"fallback-primary",
	"fallback-text",
	"gpt-image",
	"images-fallback",
	"images-mixed",
	"images-primary",
	"itest",
	"lifecycle-primary",
	"lifecycle-secondary",
	"lifecycle-target",
	"mixed-context",
	"mixed-general",
	"mixed-primary",
	"nano-banana",
	"reason-context",
	"reason-general",
	"reason-primary",
	"retry-fallback-1",
	"retry-fallback-2",
	"retry-primary",
] as const;

const PUBLIC_MODEL_PATTERN = `^(${PUBLIC_MODEL_PREFIXES.join("|")})-${UUID_PATTERN}$`;
const RESPONSE_STATE_PATTERN = `^resp_itest_${UUID_PATTERN}$`;
const VIRTUAL_KEY_NAME_PATTERN = `^embeddings-e2e-${UUID_PATTERN}$`;

interface IdRow {
	id: string;
}

export interface IntegrationCleanupSummary {
	deployments: number;
	fallbackPolicies: number;
	requestLogs: number;
	responseStates: number;
	virtualKeys: number;
	redisKeys: number;
}

function emptySummary(): IntegrationCleanupSummary {
	return {
		deployments: 0,
		fallbackPolicies: 0,
		requestLogs: 0,
		responseStates: 0,
		virtualKeys: 0,
		redisKeys: 0,
	};
}

async function deleteRedisPatterns(patterns: string[]): Promise<number> {
	let deleted = 0;
	for (const pattern of patterns) {
		let cursor = "0";
		do {
			const [next, keys] = await redis.scan(
				cursor,
				"MATCH",
				pattern,
				"COUNT",
				500,
			);
			cursor = next;
			if (keys.length > 0) deleted += await redis.del(...keys);
		} while (cursor !== "0");
	}
	return deleted;
}

async function cleanupRedis(
	deploymentIds: string[],
	virtualKeyIds: string[],
): Promise<number> {
	try {
		let deleted = 0;
		if (virtualKeyIds.length > 0) {
			for (const id of virtualKeyIds) {
				deleted += await invalidateResponseCache({ namespace: id });
			}
		}
		const patterns = deploymentIds.flatMap((id) => [
			`rt:inflight:${id}`,
			`rt:fails:${id}`,
			`rt:cooldown:${id}`,
			`rt:cooldown:cause:${id}`,
			`rt:rpm:${id}:*`,
			`rt:tpm:${id}:*`,
		]);
		if (patterns.length > 0) deleted += await deleteRedisPatterns(patterns);
		return deleted;
	} catch {
		return 0;
	}
}

export async function cleanupIntegrationArtifacts(): Promise<IntegrationCleanupSummary> {
	const deploymentRows = await sql<IdRow[]>`
		select id::text as id
		from model_deployments
		where public_model ~ ${PUBLIC_MODEL_PATTERN}
	`;
	const virtualKeyRows = await sql<IdRow[]>`
		select id::text as id
		from virtual_keys
		where name ~ ${VIRTUAL_KEY_NAME_PATTERN}
			or exists (
				select 1
				from unnest(allowed_models) as allowed_model
				where allowed_model ~ ${PUBLIC_MODEL_PATTERN}
			)
	`;

	const summary = emptySummary();
	summary.redisKeys = await cleanupRedis(
		deploymentRows.map((row) => row.id),
		virtualKeyRows.map((row) => row.id),
	);

	const requestLogRows = await sql<IdRow[]>`
		delete from request_logs
		where public_model ~ ${PUBLIC_MODEL_PATTERN}
			or deployment_id in (
				select id from model_deployments where public_model ~ ${PUBLIC_MODEL_PATTERN}
			)
			or virtual_key_id in (
				select id from virtual_keys
				where name ~ ${VIRTUAL_KEY_NAME_PATTERN}
					or exists (
						select 1
						from unnest(allowed_models) as allowed_model
						where allowed_model ~ ${PUBLIC_MODEL_PATTERN}
					)
			)
		returning id::text as id
	`;
	summary.requestLogs = requestLogRows.length;

	const responseStateRows = await sql<IdRow[]>`
		delete from response_states
		where id ~ ${RESPONSE_STATE_PATTERN}
			or public_model ~ ${PUBLIC_MODEL_PATTERN}
			or deployment_id in (
				select id from model_deployments where public_model ~ ${PUBLIC_MODEL_PATTERN}
			)
			or virtual_key_id in (
				select id from virtual_keys
				where name ~ ${VIRTUAL_KEY_NAME_PATTERN}
					or exists (
						select 1
						from unnest(allowed_models) as allowed_model
						where allowed_model ~ ${PUBLIC_MODEL_PATTERN}
					)
			)
		returning id
	`;
	summary.responseStates = responseStateRows.length;

	const fallbackRows = await sql<IdRow[]>`
		delete from fallback_policies
		where primary_model ~ ${PUBLIC_MODEL_PATTERN}
			or exists (
				select 1
				from unnest(fallback_models) as fallback_model
				where fallback_model ~ ${PUBLIC_MODEL_PATTERN}
			)
		returning id::text as id
	`;
	summary.fallbackPolicies = fallbackRows.length;

	const virtualKeyDeleteRows = await sql<IdRow[]>`
		delete from virtual_keys
		where name ~ ${VIRTUAL_KEY_NAME_PATTERN}
			or exists (
				select 1
				from unnest(allowed_models) as allowed_model
				where allowed_model ~ ${PUBLIC_MODEL_PATTERN}
			)
		returning id::text as id
	`;
	summary.virtualKeys = virtualKeyDeleteRows.length;

	const deploymentDeleteRows = await sql<IdRow[]>`
		delete from model_deployments
		where public_model ~ ${PUBLIC_MODEL_PATTERN}
		returning id::text as id
	`;
	summary.deployments = deploymentDeleteRows.length;

	return summary;
}

export function hasIntegrationCleanupWork(
	summary: IntegrationCleanupSummary,
): boolean {
	return Object.values(summary).some((count) => count > 0);
}
