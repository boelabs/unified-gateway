import { modelsWildcardHandler, listModelsHandler } from "#endpoints/models.ts";
import { redisAvailable, pgAvailable } from "#test-support/infra.ts";
import { invalidateVirtualKey } from "#auth/virtualKeyCache.ts";
import { deleteDeployment } from "#db/repos/deployments.ts";
import { createDeployment } from "#deployments/service.ts";
import { makeGatewayTestApp } from "#test-support/app.ts";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { test } from "node:test";

import {
	type CreatedVirtualKey,
	createVirtualKey,
	deleteVirtualKey,
} from "#db/repos/virtualKeys.ts";

import "#adapters/index.ts";

const hasInfra = (await pgAvailable()) && (await redisAvailable());
const skip = hasInfra ? false : "Postgres/Redis unavailables";

// Mirrors src/index.ts's actual route wiring: /v1/models is unauthenticated, unlike the rest of /v1/*.
function modelsTestApp() {
	return makeGatewayTestApp((app) => {
		app.get("/v1/models", listModelsHandler);
		app.get("/v1/models/*", modelsWildcardHandler);
	});
}

test("GET /v1/models and /v1/models/{id} are public, but /v1/models/{id}/deployments requires a key", {
	skip,
}, async () => {
	const app = modelsTestApp();
	const publicModel = `models-e2e-${randomUUID()}`;
	let deploymentId: string | undefined;
	let virtualKey: CreatedVirtualKey | undefined;

	try {
		const deployment = await createDeployment({
			publicModel,
			adapterKey: "openai",
			upstreamModel: "gpt-5.5",
			credentials: { apiKey: "test-upstream-key" },
			weight: 7,
			rpmLimit: 42,
		});
		deploymentId = deployment.row.id;
		virtualKey = await createVirtualKey({
			name: `models-e2e-${randomUUID()}`,
		});
		const activeVirtualKey = virtualKey;

		// Public listing: no key needed, no per-deployment operational data.
		const list = await app.request("/v1/models");
		assert.equal(list.status, 200);
		const listBody = (await list.json()) as { data: Array<{ id: string }> };
		assert.ok(listBody.data.some((m) => m.id === publicModel));

		const single = await app.request(`/v1/models/${publicModel}`);
		assert.equal(single.status, 200);
		const singleBody = (await single.json()) as Record<string, unknown>;
		assert.equal(singleBody.id, publicModel);
		assert.equal("weight" in singleBody, false);
		assert.equal("metrics" in singleBody, false);

		// Deployments sub-resource: internal routing/rate-limit/health data - must require a key.
		const deploymentsNoKey = await app.request(
			`/v1/models/${publicModel}/deployments`,
		);
		assert.equal(deploymentsNoKey.status, 401);

		const deploymentsBadKey = await app.request(
			`/v1/models/${publicModel}/deployments`,
			{ headers: { authorization: "Bearer not-a-real-key" } },
		);
		assert.equal(deploymentsBadKey.status, 401);

		const deploymentsWithKey = await app.request(
			`/v1/models/${publicModel}/deployments`,
			{ headers: { authorization: `Bearer ${activeVirtualKey.rawKey}` } },
		);
		assert.equal(deploymentsWithKey.status, 200);
		const deploymentsBody = (await deploymentsWithKey.json()) as {
			data: Array<{ weight: number; limits: { rpm: number | null } }>;
		};
		assert.equal(deploymentsBody.data.length, 1);
		assert.equal(deploymentsBody.data[0]?.weight, 7);
		assert.equal(deploymentsBody.data[0]?.limits.rpm, 42);
	} finally {
		if (virtualKey) {
			await invalidateVirtualKey(virtualKey.row.keyHash);
			await deleteVirtualKey(virtualKey.row.id);
		}
		if (deploymentId) await deleteDeployment(deploymentId);
	}
});
