import { authMiddleware, requireMaster, getAuth } from "#auth/middleware.ts";
import { invalidateResponseCache } from "#cache/responseCache.ts";
import { invalidateVirtualKey } from "#auth/virtualKeyCache.ts";
import { clearVirtualKeyBudget } from "#ratelimit/index.ts";
import { configureFallback } from "#fallbacks/service.ts";
import { probeArtifact } from "#extensions/source.ts";
import { ok, paginated } from "#http/respond.ts";
import { platformAdminApp } from "./platform.ts";
import { GatewayError } from "#core/errors.ts";
import type { AppEnv } from "#auth/types.ts";
import { env } from "#config/env.ts";
import { Hono } from "hono";
import * as z from "zod/v4";

import {
	listArtifactVersionsForKey,
	activateArtifactVersion,
	listArtifactSummaries,
	insertActiveArtifact,
	bumpRegistryVersion,
	deleteArtifactKey,
	getInstanceById,
	updateInstance,
	deleteInstance,
	insertInstance,
	listInstances,
} from "#db/repos/extensions.ts";

import {
	resetVirtualKeySpend,
	listVirtualKeysPage,
	type VirtualKeyRow,
	getVirtualKeyById,
	createVirtualKey,
	deleteVirtualKey,
	updateVirtualKey,
} from "#db/repos/virtualKeys.ts";

import {
	deleteFallbackPolicy,
	listFallbackPolicies,
	updateRouterSettings,
	getRouterSettings,
} from "#db/repos/router.ts";

import {
	type RequestLogFilter,
	listRequestLogsPage,
	type UsageGroupBy,
	aggregateUsage,
} from "#db/repos/requestLogs.ts";

import {
	resetExtensionInstance,
	reloadExtensions,
	extensionStatus,
} from "#extensions/runtime.ts";

/** Strips the hash before returning a virtual key. */
function publicKey(row: VirtualKeyRow) {
	const { keyHash: _omit, ...rest } = row;
	return rest;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function parseBoolQuery(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	const normalized = value.trim().toLowerCase();
	if (["true", "1", "yes"].includes(normalized)) return true;
	if (["false", "0", "no"].includes(normalized)) return false;
	throw new GatewayError({
		class: "bad_request",
		message: `Invalid boolean query value "${value}"`,
	});
}

function parseDateQuery(
	c: import("hono").Context,
	name: string,
): Date | undefined {
	const raw = c.req.query(name);
	if (raw === undefined) return undefined;
	const d = new Date(raw);
	if (Number.isNaN(d.getTime())) {
		throw new GatewayError({
			class: "bad_request",
			message: `Invalid date for "${name}": ${raw}`,
			param: name,
		});
	}
	return d;
}

/** Builds the common request_logs filter from the query string. */
function parseLogFilter(c: import("hono").Context): RequestLogFilter {
	const cacheHit = parseBoolQuery(c.req.query("cacheHit"));
	const start = parseDateQuery(c, "start");
	const end = parseDateQuery(c, "end");
	return {
		...(c.req.query("virtualKeyId")
			? { virtualKeyId: c.req.query("virtualKeyId")! }
			: {}),
		...(c.req.query("publicModel")
			? { publicModel: c.req.query("publicModel")! }
			: {}),
		...(c.req.query("deploymentId")
			? { deploymentId: c.req.query("deploymentId")! }
			: {}),
		...(c.req.query("adapterKey")
			? { adapterKey: c.req.query("adapterKey")! }
			: {}),
		...(c.req.query("callType") ? { callType: c.req.query("callType")! } : {}),
		...(c.req.query("status") ? { status: c.req.query("status")! } : {}),
		...(c.req.query("requestId")
			? { requestId: c.req.query("requestId")! }
			: {}),
		...(cacheHit !== undefined ? { cacheHit } : {}),
		...(start ? { start } : {}),
		...(end ? { end } : {}),
	};
}

function parsePage(c: import("hono").Context): {
	limit: number;
	offset: number;
} {
	const rawLimit = Number(c.req.query("limit") ?? DEFAULT_LIMIT);
	const rawOffset = Number(c.req.query("offset") ?? 0);
	const limit =
		Number.isFinite(rawLimit) && rawLimit > 0
			? Math.min(Math.trunc(rawLimit), MAX_LIMIT)
			: DEFAULT_LIMIT;
	const offset =
		Number.isFinite(rawOffset) && rawOffset >= 0 ? Math.trunc(rawOffset) : 0;
	return { limit, offset };
}

async function parseJson<T>(
	c: import("hono").Context,
	schema: z.ZodType<T>,
): Promise<T> {
	const json = await c.req.json().catch(() => undefined);
	if (json === undefined) {
		throw new GatewayError({
			class: "bad_request",
			message: "Invalid or missing JSON body",
		});
	}
	const parsed = schema.safeParse(json);
	if (!parsed.success) {
		const first = parsed.error.issues[0];
		throw new GatewayError({
			class: "bad_request",
			message: parsed.error.issues
				.map((i) => `${i.path.join(".")}: ${i.message}`)
				.join("; "),
			param: first ? first.path.join(".") : null,
		});
	}
	return parsed.data;
}

const createKeySchema = z.object({
	name: z.string().min(1),
	allowedModels: z.array(z.string()).optional(),
	maxBudgetCents: z.int().min(0).nullable().optional(),
	budgetReset: z
		.enum(["hourly", "daily", "weekly", "monthly"])
		.nullable()
		.optional(),
	tpm: z.int().min(0).nullable().optional(),
	rpm: z.int().min(0).nullable().optional(),
	expiresAt: z.iso.datetime().nullable().optional(),
});

const updateKeySchema = z.object({
	name: z.string().min(1).optional(),
	allowedModels: z.array(z.string()).optional(),
	maxBudgetCents: z.int().min(0).nullable().optional(),
	budgetReset: z
		.enum(["hourly", "daily", "weekly", "monthly"])
		.nullable()
		.optional(),
	tpm: z.int().min(0).nullable().optional(),
	rpm: z.int().min(0).nullable().optional(),
	enabled: z.boolean().optional(),
	expiresAt: z.iso.datetime().nullable().optional(),
	resetSpend: z.boolean().optional(),
});

export const adminApp = new Hono<AppEnv>();

// Every /admin route requires the master key.
adminApp.use("*", authMiddleware(), requireMaster());
// Model CRUD (with inline CatalogEntry for custom models) and provider presets.
adminApp.route("/", platformAdminApp);

/* --------------------------------------------------------- virtual keys */

adminApp.get("/keys", async (c) => {
	const { limit, offset } = parsePage(c);
	const enabled = parseBoolQuery(c.req.query("enabled"));
	const publicModel = c.req.query("publicModel");
	const q = c.req.query("q");
	const { rows, total } = await listVirtualKeysPage({
		limit,
		offset,
		...(enabled !== undefined ? { enabled } : {}),
		...(publicModel ? { publicModel } : {}),
		...(q ? { q } : {}),
	});
	return paginated(c, rows.map(publicKey), {
		limit,
		offset,
		total,
		nextOffset: offset + limit < total ? offset + limit : null,
	});
});

adminApp.post("/keys", async (c) => {
	const input = await parseJson(c, createKeySchema);
	const { row, rawKey } = await createVirtualKey({
		name: input.name,
		...(input.allowedModels !== undefined
			? { allowedModels: input.allowedModels }
			: {}),
		...(input.maxBudgetCents !== undefined
			? { maxBudgetCents: input.maxBudgetCents }
			: {}),
		...(input.budgetReset !== undefined
			? { budgetReset: input.budgetReset }
			: {}),
		...(input.tpm !== undefined ? { tpm: input.tpm } : {}),
		...(input.rpm !== undefined ? { rpm: input.rpm } : {}),
		...(input.expiresAt !== undefined && input.expiresAt !== null
			? { expiresAt: new Date(input.expiresAt) }
			: {}),
	});
	// The plaintext key is returned ONLY once.
	return ok(c, { ...publicKey(row), key: rawKey }, 201);
});

adminApp.patch("/keys/:id", async (c) => {
	const existing = await getVirtualKeyById(c.req.param("id"));
	if (!existing) {
		throw new GatewayError({
			class: "not_found",
			message: `Virtual key "${c.req.param("id")}" does not exist`,
		});
	}
	const input = await parseJson(c, updateKeySchema);
	let row = await updateVirtualKey(existing.id, {
		...(input.name !== undefined ? { name: input.name } : {}),
		...(input.allowedModels !== undefined
			? { allowedModels: input.allowedModels }
			: {}),
		...(input.maxBudgetCents !== undefined
			? { maxBudgetCents: input.maxBudgetCents }
			: {}),
		...(input.budgetReset !== undefined
			? { budgetReset: input.budgetReset }
			: {}),
		...(input.tpm !== undefined ? { tpm: input.tpm } : {}),
		...(input.rpm !== undefined ? { rpm: input.rpm } : {}),
		...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
		...(input.expiresAt !== undefined
			? {
					expiresAt:
						input.expiresAt === null ? null : new Date(input.expiresAt),
				}
			: {}),
	});
	await invalidateVirtualKey(existing.keyHash);
	if (input.resetSpend) {
		await resetVirtualKeySpend(
			existing.id,
			row?.budgetReset ?? existing.budgetReset,
		);
		await clearVirtualKeyBudget(existing.id);
		row = await getVirtualKeyById(existing.id);
	}
	return ok(c, publicKey(row!));
});

adminApp.delete("/keys/:id", async (c) => {
	const row = await getVirtualKeyById(c.req.param("id"));
	if (row) {
		await deleteVirtualKey(row.id);
		await invalidateVirtualKey(row.keyHash);
	}
	return c.body(null, 204);
});

/* --------------------------------------------------------------- cache */

adminApp.delete("/cache", async (c) => {
	const callType = c.req.query("callType");
	const namespace = c.req.query("namespace");
	const deleted = await invalidateResponseCache({
		...(callType !== undefined ? { callType } : {}),
		...(namespace !== undefined ? { namespace } : {}),
	});
	return ok(c, { deleted });
});

/* ----------------------------------------------------------- extensions */

const EXTENSION_KEY = /^[a-z0-9]+$/;
const INSTANCE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

const uploadArtifactSchema = z.object({
	key: z.string().regex(EXTENSION_KEY, "key must match ^[a-z0-9]+$"),
	code: z.string().min(1),
});

const activateArtifactSchema = z.object({ version: z.int().positive() });

const createInstanceSchema = z.object({
	id: z.string().regex(INSTANCE_ID),
	definition: z.string().regex(EXTENSION_KEY),
	enabled: z.boolean().optional(),
	critical: z.boolean().nullable().optional(),
	priority: z.int().optional(),
	match: z.record(z.string(), z.unknown()).optional(),
	config: z.unknown().optional(),
});

const updateInstanceSchema = z.object({
	definition: z.string().regex(EXTENSION_KEY).optional(),
	enabled: z.boolean().optional(),
	critical: z.boolean().nullable().optional(),
	priority: z.int().optional(),
	match: z.record(z.string(), z.unknown()).optional(),
	config: z.unknown().optional(),
});

/** Bumps the registry (so other replicas reload) and reloads this process immediately. */
async function refreshExtensions(): Promise<void> {
	await bumpRegistryVersion();
	await reloadExtensions();
}

// Live runtime status of THIS process (loaded definitions, instances, breaker state).
adminApp.get("/extensions", (c) => ok(c, extensionStatus()));

/* ---- artifacts (versioned extension code) ---- */

adminApp.get("/extensions/artifacts", async (c) =>
	ok(c, await listArtifactSummaries()),
);

adminApp.get("/extensions/artifacts/:key/versions", async (c) =>
	ok(c, await listArtifactVersionsForKey(c.req.param("key"))),
);

adminApp.post("/extensions/artifacts", async (c) => {
	const input = await parseJson(c, uploadArtifactSchema);
	const size = Buffer.byteLength(input.code, "utf8");
	if (size > env.UNIFIED_GATEWAY_EXTENSIONS_MAX_CODE_BYTES) {
		throw new GatewayError({
			class: "bad_request",
			message: `Extension code is ${size} bytes; limit is ${env.UNIFIED_GATEWAY_EXTENSIONS_MAX_CODE_BYTES}`,
		});
	}
	let probe: Awaited<ReturnType<typeof probeArtifact>>;
	try {
		probe = await probeArtifact(input.key, input.code);
	} catch (err) {
		throw new GatewayError({
			class: "bad_request",
			message: `Invalid extension module: ${err instanceof Error ? err.message : String(err)}`,
			cause: err,
		});
	}
	const summary = await insertActiveArtifact({
		key: input.key,
		code: input.code,
		contentHash: probe.contentHash,
		sizeBytes: probe.sizeBytes,
		uploadedBy: getAuth(c).type,
	});
	await refreshExtensions();
	return ok(c, summary, 201);
});

adminApp.post("/extensions/artifacts/:key/activate", async (c) => {
	const key = c.req.param("key");
	const { version } = await parseJson(c, activateArtifactSchema);
	const activated = await activateArtifactVersion(key, version);
	if (!activated) {
		throw new GatewayError({
			class: "not_found",
			message: `Extension artifact "${key}" v${version} does not exist`,
		});
	}
	await refreshExtensions();
	return ok(c, await listArtifactVersionsForKey(key));
});

adminApp.delete("/extensions/artifacts/:key", async (c) => {
	const removed = await deleteArtifactKey(c.req.param("key"));
	if (removed > 0) await refreshExtensions();
	return c.body(null, 204);
});

/* ---- instances (definition bindings) ---- */

adminApp.get("/extensions/instances", async (c) =>
	ok(c, await listInstances()),
);

adminApp.post("/extensions/instances", async (c) => {
	const input = await parseJson(c, createInstanceSchema);
	if (await getInstanceById(input.id)) {
		throw new GatewayError({
			class: "bad_request",
			message: `Extension instance "${input.id}" already exists`,
		});
	}
	const row = await insertInstance({
		id: input.id,
		definitionKey: input.definition,
		...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
		...(input.critical !== undefined ? { critical: input.critical } : {}),
		...(input.priority !== undefined ? { priority: input.priority } : {}),
		...(input.match !== undefined ? { match: input.match } : {}),
		...(input.config !== undefined ? { config: input.config } : {}),
	});
	await refreshExtensions();
	return ok(c, row, 201);
});

adminApp.patch("/extensions/instances/:id", async (c) => {
	const id = c.req.param("id");
	if (!(await getInstanceById(id))) {
		throw new GatewayError({
			class: "not_found",
			message: `Extension instance "${id}" does not exist`,
		});
	}
	const input = await parseJson(c, updateInstanceSchema);
	const row = await updateInstance(id, {
		...(input.definition !== undefined
			? { definitionKey: input.definition }
			: {}),
		...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
		...(input.critical !== undefined ? { critical: input.critical } : {}),
		...(input.priority !== undefined ? { priority: input.priority } : {}),
		...(input.match !== undefined ? { match: input.match } : {}),
		...(input.config !== undefined ? { config: input.config } : {}),
	});
	await refreshExtensions();
	return ok(c, row!);
});

adminApp.delete("/extensions/instances/:id", async (c) => {
	const deleted = await deleteInstance(c.req.param("id"));
	if (deleted) await refreshExtensions();
	return c.body(null, 204);
});

// Clears a circuit-breaker trip and re-activates the instance for this process.
adminApp.post("/extensions/:id/reset", (c) => {
	const id = c.req.param("id");
	const result = resetExtensionInstance(id);
	if (!result.found) {
		throw new GatewayError({
			class: "not_found",
			message: `Extension instance "${id}" does not exist`,
		});
	}
	if (!result.reset) {
		throw new GatewayError({
			class: "bad_request",
			message: `Extension instance "${id}" cannot be reset: ${result.reason ?? "not eligible"}`,
		});
	}
	return ok(c, extensionStatus());
});

/* --------------------------------------------------------- logs / usage */

const USAGE_GROUP_BY: UsageGroupBy[] = [
	"public_model",
	"virtual_key",
	"adapter_key",
	"day",
	"none",
];

adminApp.get("/logs", async (c) => {
	const { limit, offset } = parsePage(c);
	const filter = parseLogFilter(c);
	const { rows, total } = await listRequestLogsPage({
		limit,
		offset,
		...filter,
	});
	return paginated(c, rows, {
		limit,
		offset,
		total,
		nextOffset: offset + limit < total ? offset + limit : null,
	});
});

adminApp.get("/usage", async (c) => {
	const groupByRaw = c.req.query("groupBy") ?? "none";
	if (!USAGE_GROUP_BY.includes(groupByRaw as UsageGroupBy)) {
		throw new GatewayError({
			class: "bad_request",
			message: `Invalid groupBy "${groupByRaw}". Allowed: ${USAGE_GROUP_BY.join(", ")}`,
			param: "groupBy",
		});
	}
	const rows = await aggregateUsage({
		groupBy: groupByRaw as UsageGroupBy,
		...parseLogFilter(c),
	});
	return ok(c, rows);
});

/* --------------------------------------------------------- router settings */

const routerSettingsSchema = z
	.object({
		routingStrategy: z.enum([
			"simple-shuffle",
			"least-busy",
			"usage-based-tpm",
			"usage-based-rpm",
		]),
		allowedFails: z.int().min(0),
		cooldownSeconds: z.int().min(0),
		numRetries: z.int().min(0),
		timeoutSeconds: z.int().min(1),
		retryAfterSeconds: z.int().min(0),
	})
	.partial();

adminApp.get("/router-settings", async (c) => {
	return ok(c, (await getRouterSettings()) ?? null);
});

adminApp.put("/router-settings", async (c) => {
	const patch = await parseJson(c, routerSettingsSchema);
	return ok(c, await updateRouterSettings(patch));
});

/* --------------------------------------------------------------- fallbacks */

const fallbackSchema = z.object({
	primaryModel: z.string().min(1),
	fallbackModels: z.array(z.string().min(1)).min(1).max(5),
	reason: z.enum(["general", "context_window", "content_policy"]).optional(),
});

adminApp.get("/fallbacks", async (c) => {
	return ok(c, await listFallbackPolicies());
});

adminApp.put("/fallbacks", async (c) => {
	const input = await parseJson(c, fallbackSchema);
	return ok(
		c,
		await configureFallback({
			primaryModel: input.primaryModel,
			fallbackModels: input.fallbackModels,
			...(input.reason !== undefined ? { reason: input.reason } : {}),
		}),
		201,
	);
});

adminApp.delete("/fallbacks/:primaryModel/:reason", async (c) => {
	const reason = c.req.param("reason");
	if (
		reason !== "general" &&
		reason !== "context_window" &&
		reason !== "content_policy"
	) {
		throw new GatewayError({
			class: "bad_request",
			message: "Invalid fallback reason",
		});
	}
	await deleteFallbackPolicy(c.req.param("primaryModel"), reason);
	return c.body(null, 204);
});
