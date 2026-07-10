import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";

import "#adapters/index.ts";

import { redisAvailable, pgAvailable } from "#test-support/infra.ts";
import { GatewayError, type ErrorClass } from "#core/errors.ts";
import { configureFallback } from "#fallbacks/service.ts";
import { route } from "#router/index.ts";
import { redis } from "#cache/redis.ts";

import {
	type RouterSettingsRow,
	updateRouterSettings,
	getRouterSettings,
} from "#db/repos/router.ts";

import {
	type DeploymentRow,
	createDeployment,
	deleteDeployment,
} from "#db/repos/deployments.ts";

const skip = (await Promise.all([pgAvailable(), redisAvailable()])).every(
	Boolean,
)
	? false
	: "Postgres/Redis unavailables";
let originalSettings: RouterSettingsRow | undefined;

before(async () => {
	if (skip) return;
	originalSettings = await getRouterSettings();
	await updateRouterSettings({
		routingStrategy: "least-busy",
		allowedFails: 100,
		cooldownSeconds: 1,
		numRetries: 2,
		timeoutSeconds: 10,
		retryAfterSeconds: 0,
	});
});

after(async () => {
	if (originalSettings) {
		await updateRouterSettings({
			routingStrategy: originalSettings.routingStrategy,
			allowedFails: originalSettings.allowedFails,
			cooldownSeconds: originalSettings.cooldownSeconds,
			numRetries: originalSettings.numRetries,
			timeoutSeconds: originalSettings.timeoutSeconds,
			retryAfterSeconds: originalSettings.retryAfterSeconds,
		}).catch(() => {});
	}
});

function modelName(prefix: string): string {
	return `${prefix}-${randomUUID()}`;
}

async function deployment(publicModel: string): Promise<DeploymentRow> {
	return createDeployment({
		publicModel,
		adapterKey: "openaicompatible",
		upstreamModel: `text-${randomUUID()}`,
		credentials: { apiKey: "test", baseUrl: "https://example.test/v1" },
		catalogEntry: {
			operations: {
				"text.generate": {
					capabilities: {
						tools: true,
						vision: false,
						reasoning: false,
						structuredOutputs: true,
					},
				},
			},
		},
	});
}

async function cleanupState(deployments: DeploymentRow[]): Promise<void> {
	const bucket = Math.floor(Date.now() / 60_000);
	const keys = deployments.flatMap((item) => [
		`rt:inflight:${item.id}`,
		`rt:fails:${item.id}`,
		`rt:failures:${item.id}`,
		`rt:successes:${item.id}`,
		`rt:cooldown:${item.id}`,
		`rt:cooldown:cause:${item.id}`,
		`rt:rpm:${item.id}:${bucket}`,
		`rt:tpm:${item.id}:${bucket}`,
	]);
	if (keys.length > 0) await redis.del(...keys);
}

async function cleanupDeployments(deployments: DeploymentRow[]): Promise<void> {
	await cleanupState(deployments);
	await Promise.all(deployments.map((item) => deleteDeployment(item.id)));
}

function fail(errorClass: ErrorClass): never {
	throw new GatewayError({
		class: errorClass,
		message: `synthetic ${errorClass}`,
	});
}

test("router: numRetries belongs to each primary and fallback deployment", {
	skip,
}, async () => {
	const primaryModel = modelName("retry-primary");
	const firstFallbackModel = modelName("retry-fallback-1");
	const finalFallbackModel = modelName("retry-fallback-2");
	const deployments = [
		await deployment(primaryModel),
		await deployment(primaryModel),
		await deployment(firstFallbackModel),
		await deployment(finalFallbackModel),
	];
	const counts = new Map<string, number>();
	try {
		await configureFallback({
			primaryModel,
			fallbackModels: [firstFallbackModel, finalFallbackModel],
		});
		const result = await route(
			primaryModel,
			"chat",
			{ clientSignal: new AbortController().signal, requestId: randomUUID() },
			async (candidate) => {
				counts.set(candidate.row.id, (counts.get(candidate.row.id) ?? 0) + 1);
				if (candidate.row.publicModel === finalFallbackModel)
					return candidate.row.id;
				return fail("server");
			},
		);
		assert.equal(counts.get(deployments[0]!.id), 3);
		assert.equal(counts.get(deployments[1]!.id), 3);
		assert.equal(counts.get(deployments[2]!.id), 3);
		assert.equal(counts.get(deployments[3]!.id), 1);
		assert.equal(result.attempts, 10);
		assert.equal(result.fallbackUsed, true);
		await result.finish(null);
	} finally {
		await cleanupDeployments(deployments);
	}
});

test("router: request-scoped failures stop before retries and fallbacks", {
	skip,
}, async () => {
	const primaryModel = modelName("request-error-primary");
	const fallbackModel = modelName("request-error-fallback");
	const deployments = [
		await deployment(primaryModel),
		await deployment(primaryModel),
		await deployment(fallbackModel),
	];
	let attempts = 0;
	try {
		await configureFallback({
			primaryModel,
			fallbackModels: [fallbackModel],
		});
		await assert.rejects(
			() =>
				route(
					primaryModel,
					"chat",
					{
						clientSignal: new AbortController().signal,
						requestId: randomUUID(),
					},
					async () => {
						attempts += 1;
						throw new GatewayError({
							class: "bad_request",
							message: "synthetic request failure",
							routingScope: "request",
						});
					},
				),
			(error: unknown) => {
				const failure = error as GatewayError;
				return (
					failure.class === "bad_request" && failure.attempts?.length === 1
				);
			},
		);
		assert.equal(attempts, 1);
	} finally {
		await cleanupDeployments(deployments);
	}
});

test("router: candidate input incompatibilities do not affect deployment health", {
	skip,
}, async () => {
	const publicModel = modelName("neutral-input-error");
	const deployed = await deployment(publicModel);
	try {
		await assert.rejects(
			() =>
				route(
					publicModel,
					"chat",
					{
						clientSignal: new AbortController().signal,
						requestId: randomUUID(),
					},
					async () => {
						throw new GatewayError({
							class: "bad_request",
							message: "synthetic candidate input incompatibility",
							deploymentHealth: "neutral",
						});
					},
				),
			(error: unknown) => {
				const failure = error as GatewayError;
				return (
					failure.class === "bad_request" && failure.attempts?.length === 1
				);
			},
		);
		const [inflight, recentFails, healthFailures, cooldown] = await redis.mget(
			`rt:inflight:${deployed.id}`,
			`rt:fails:${deployed.id}`,
			`rt:failures:${deployed.id}`,
			`rt:cooldown:${deployed.id}`,
		);
		assert.ok(inflight === null || inflight === "0");
		assert.equal(recentFails, null);
		assert.equal(healthFailures, null);
		assert.equal(cooldown, null);
	} finally {
		await cleanupDeployments([deployed]);
	}
});

test("router: context_window exhausts all primaries once and selects its reason", {
	skip,
}, async () => {
	const primaryModel = modelName("reason-primary");
	const generalModel = modelName("reason-general");
	const contextModel = modelName("reason-context");
	const deployments = [
		await deployment(primaryModel),
		await deployment(primaryModel),
		await deployment(generalModel),
		await deployment(contextModel),
	];
	const counts = new Map<string, number>();
	try {
		await configureFallback({
			primaryModel,
			fallbackModels: [generalModel],
			reason: "general",
		});
		await configureFallback({
			primaryModel,
			fallbackModels: [contextModel],
			reason: "context_window",
		});
		const result = await route(
			primaryModel,
			"chat",
			{ clientSignal: new AbortController().signal, requestId: randomUUID() },
			async (candidate) => {
				counts.set(candidate.row.id, (counts.get(candidate.row.id) ?? 0) + 1);
				if (candidate.row.publicModel === contextModel) return candidate.row.id;
				if (candidate.row.publicModel === generalModel) return fail("server");
				return fail("context_window");
			},
		);
		assert.equal(counts.get(deployments[0]!.id), 1);
		assert.equal(counts.get(deployments[1]!.id), 1);
		assert.equal(counts.get(deployments[2]!.id), undefined);
		assert.equal(counts.get(deployments[3]!.id), 1);
		assert.equal(result.attempts, 3);
		await result.finish(null);
	} finally {
		await cleanupDeployments(deployments);
	}
});

test("router: mixed primary causes use the general chain", {
	skip,
}, async () => {
	const primaryModel = modelName("mixed-primary");
	const generalModel = modelName("mixed-general");
	const contextModel = modelName("mixed-context");
	const deployments = [
		await deployment(primaryModel),
		await deployment(primaryModel),
		await deployment(generalModel),
		await deployment(contextModel),
	];
	const [contextDeployment, serverDeployment] = deployments;
	const counts = new Map<string, number>();
	try {
		await configureFallback({
			primaryModel,
			fallbackModels: [generalModel],
			reason: "general",
		});
		await configureFallback({
			primaryModel,
			fallbackModels: [contextModel],
			reason: "context_window",
		});
		const result = await route(
			primaryModel,
			"chat",
			{ clientSignal: new AbortController().signal, requestId: randomUUID() },
			async (candidate) => {
				counts.set(candidate.row.id, (counts.get(candidate.row.id) ?? 0) + 1);
				if (candidate.row.publicModel === generalModel) return candidate.row.id;
				if (candidate.row.id === contextDeployment!.id)
					return fail("context_window");
				if (candidate.row.id === serverDeployment!.id) return fail("server");
				return fail("server");
			},
		);
		assert.equal(counts.get(contextDeployment!.id), 1);
		assert.equal(counts.get(serverDeployment!.id), 3);
		assert.equal(counts.get(deployments[2]!.id), 1);
		assert.equal(counts.get(deployments[3]!.id), undefined);
		assert.equal(result.attempts, 5);
		await result.finish(null);
	} finally {
		await cleanupDeployments(deployments);
	}
});

test("router: attempt log carries the deployment label, omitting it when unset", {
	skip,
}, async () => {
	const labeledModel = modelName("labeled");
	const plainModel = modelName("plain");
	const labeled = await createDeployment({
		publicModel: labeledModel,
		adapterKey: "openaicompatible",
		upstreamModel: `text-${randomUUID()}`,
		credentials: { apiKey: "test", baseUrl: "https://example.test/v1" },
		label: "primary - billing key",
		catalogEntry: {
			operations: {
				"text.generate": {
					capabilities: {
						tools: true,
						vision: false,
						reasoning: false,
						structuredOutputs: true,
					},
				},
			},
		},
	});
	const plain = await deployment(plainModel);
	try {
		const route1 = await route(
			labeledModel,
			"chat",
			{ clientSignal: new AbortController().signal, requestId: randomUUID() },
			async (candidate) => candidate.row.id,
		);
		assert.equal(route1.attemptLog[0]?.label, "primary - billing key");
		await route1.finish(null);

		const route2 = await route(
			plainModel,
			"chat",
			{ clientSignal: new AbortController().signal, requestId: randomUUID() },
			async (candidate) => candidate.row.id,
		);
		assert.equal(route2.attemptLog[0]?.label, undefined);
		await route2.finish(null);
	} finally {
		await cleanupDeployments([labeled, plain]);
	}
});
