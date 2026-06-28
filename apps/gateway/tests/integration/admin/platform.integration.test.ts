import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { test } from "node:test";

import "#adapters/index.ts";

import { makeGatewayTestApp } from "#test-support/app.ts";
import { platformAdminApp } from "#admin/platform.ts";
import { pgAvailable } from "#test-support/infra.ts";
import { adminApp } from "#admin/index.ts";
import { env } from "#config/env.ts";

const skip = (await pgAvailable()) ? false : "Postgres unavailable";
const platformTestApp = makeGatewayTestApp((app) => {
	app.route("/", platformAdminApp);
});

test("admin mounts the new platform behind master authentication", async () => {
	const response = await adminApp.request("/operations", {
		headers: { authorization: `Bearer ${env.MASTER_KEY}` },
	});
	assert.equal(response.status, 200);
	const body = (await response.json()) as {
		data: { operations: Array<{ id: string }> };
	};
	assert.ok(
		body.data.operations.some((operation) => operation.id === "image.generate"),
	);
	assert.ok(
		body.data.operations.some(
			(operation) => operation.id === "embedding.create",
		),
	);
	assert.ok(
		body.data.operations.every((operation) =>
			[
				"text.generate",
				"image.generate",
				"image.edit",
				"audio.transcribe",
				"embedding.create",
			].includes(operation.id),
		),
	);
});

test("admin platform: resolves Azure presets against their independent catalogs", async () => {
	for (const input of [
		{
			provider: "azureopenai",
			upstreamModel: "gpt-5.4",
			adapterKey: "azureopenai",
			transport: "responses",
		},
		{
			provider: "azurefoundry",
			upstreamModel: "DeepSeek-V3.1",
			adapterKey: "azurefoundry",
			transport: "chat_completions",
		},
	]) {
		const response = await platformTestApp.request("/deployments/resolve", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				publicModel: `test-${input.provider}`,
				provider: input.provider,
				upstreamModel: input.upstreamModel,
				credentials: {
					apiKey: "ignored",
					baseUrl: "https://resource.openai.azure.com",
				},
			}),
		});
		assert.equal(response.status, 200, input.provider);
		const body = (await response.json()) as {
			data: {
				source: string;
				adapterKey: string;
				transportOverrides: Record<string, string>;
			};
		};
		assert.equal(body.data.source, "catalog");
		assert.equal(body.data.adapterKey, input.adapterKey);
		assert.equal(
			body.data.transportOverrides["text.generate"],
			input.transport,
		);
	}
});

test("admin platform: catalog model with inline api key (without catalogEntry) without exposing secrets", {
	skip,
}, async () => {
	const input = {
		publicModel: `gpt-image-${randomUUID()}`,
		provider: "openai",
		upstreamModel: "gpt-image-2",
		credentials: { apiKey: "secret-http-key" },
	};

	const resolveResponse = await platformTestApp.request(
		"/deployments/resolve",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(input),
		},
	);
	assert.equal(resolveResponse.status, 200);
	const resolved = (await resolveResponse.json()) as {
		data: { source: string; transportOverrides: Record<string, string> };
	};
	assert.equal(resolved.data.source, "catalog");
	assert.equal(resolved.data.transportOverrides["image.generate"], "images");

	let deploymentId: string | undefined;
	try {
		const createResponse = await platformTestApp.request("/deployments", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(input),
		});
		assert.equal(createResponse.status, 201);
		const deployment = (await createResponse.json()) as {
			data: {
				id: string;
				upstreamModel: string;
				adapterKey: string;
				custom: boolean;
				credentials?: unknown;
			};
		};
		deploymentId = deployment.data.id;
		assert.equal(deployment.data.upstreamModel, input.upstreamModel);
		assert.equal(deployment.data.adapterKey, "openai");
		assert.equal(deployment.data.custom, false);
		assert.equal(
			deployment.data.credentials,
			undefined,
			"must not expose credentials",
		);
	} finally {
		if (deploymentId)
			await platformTestApp.request(`/deployments/${deploymentId}`, {
				method: "DELETE",
			});
	}
});

test("admin platform: custom model requires catalogEntry; with it, creation succeeds", {
	skip,
}, async () => {
	const base = {
		publicModel: `custom-img-${randomUUID()}`,
		adapterKey: "openaicompatible",
		upstreamModel: `unknown-${randomUUID()}`,
		credentials: { apiKey: "k", baseUrl: "https://example.test/v1" },
	};

	// Without catalogEntry -> rejected (the real app maps it to 400; the standalone sub-app to 500).
	const missing = await platformTestApp.request("/deployments", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(base),
	});
	assert.ok(missing.status >= 400, `expected rejection, got ${missing.status}`);

	const withCatalog = {
		...base,
		catalogEntry: {
			operations: {
				"image.generate": {
					maxN: 1,
					outputFormats: ["png"],
					responseFormats: ["b64_json"],
					sizes: { "1024x1024": {} },
				},
			},
		},
	};
	let deploymentId: string | undefined;
	try {
		const created = await platformTestApp.request("/deployments", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(withCatalog),
		});
		assert.equal(created.status, 201);
		const deployment = (await created.json()) as {
			data: { id: string; custom: boolean };
		};
		deploymentId = deployment.data.id;
		assert.equal(deployment.data.custom, true);
	} finally {
		if (deploymentId)
			await platformTestApp.request(`/deployments/${deploymentId}`, {
				method: "DELETE",
			});
	}
});
