import assert from "node:assert/strict";
import { test } from "node:test";

import "#adapters/index.ts";

import { platformAdminApp } from "./platform.ts";

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
