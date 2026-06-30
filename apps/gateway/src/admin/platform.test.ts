import type { ContentfulStatusCode } from "hono/utils/http-status";
import { GatewayError } from "#core/errors.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";

import "#adapters/index.ts";

import { platformAdminApp } from "./platform.ts";

/** Mounts the admin app behind the OpenAI-compatible error handler, without pulling auth/env. */
function adminAppWithErrors(): Hono {
	const app = new Hono();
	app.onError((err, c) =>
		GatewayError.is(err)
			? c.json(err.toOpenAI(), err.httpStatus as ContentfulStatusCode)
			: c.json({ error: { message: "server" } }, 500),
	);
	app.route("/", platformAdminApp);
	return app;
}

test("admin operations exposes embeddings by operation, endpoint, and transport per adapter", async () => {
	const response = await platformAdminApp.request("/operations");
	assert.equal(response.status, 200);

	const body = (await response.json()) as {
		data: {
			operations: Array<{
				id: string;
				callType?: string;
				publicEndpoints: string[];
			}>;
			adapters: Array<{
				id: string;
				supportedCallTypes: string[];
				operations: Array<{
					id: string;
					family: string;
					callType: string;
					publicEndpoints: string[];
					transports: string[];
					defaultTransport: string | null;
				}>;
			}>;
		};
	};

	const embeddingOperation = body.data.operations.find(
		(operation) => operation.id === "embedding.create",
	);
	assert.equal(embeddingOperation?.callType, "embeddings");
	assert.deepEqual(embeddingOperation?.publicEndpoints, ["/v1/embeddings"]);

	const expectedAdapters = [
		["openai", "embeddings"],
		["azureopenai", "embeddings"],
		["googleaistudio", "embed_content"],
		["openaicompatible", "embeddings"],
	] as const;
	for (const [adapterId, expectedDefault] of expectedAdapters) {
		const adapter = body.data.adapters.find((item) => item.id === adapterId);
		assert.ok(adapter, `adapter ${adapterId} is not registered`);
		assert.ok(adapter.supportedCallTypes.includes("embeddings"));

		const operation = adapter.operations.find(
			(item) => item.id === "embedding.create",
		);
		assert.equal(operation?.family, "embedding");
		assert.equal(operation?.callType, "embeddings");
		assert.deepEqual(operation?.publicEndpoints, ["/v1/embeddings"]);
		assert.equal(operation?.defaultTransport, expectedDefault);
		assert.ok(operation?.transports.includes(expectedDefault));
	}
});

test("admin platform: rejects deployment metadata over the size limit", async () => {
	const app = adminAppWithErrors();
	// Oversized metadata trips the size guard at validation, before any DB access.
	const body = JSON.stringify({
		publicModel: "x",
		adapterKey: "openai",
		upstreamModel: "gpt-image-2",
		credentials: { apiKey: "k" },
		metadata: { note: "x".repeat(17_000) },
	});
	const response = await app.request("/deployments", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body,
	});
	assert.equal(response.status, 400);
	const json = (await response.json()) as { error?: { param?: string } };
	assert.match(json.error?.param ?? "", /metadata/);
});
