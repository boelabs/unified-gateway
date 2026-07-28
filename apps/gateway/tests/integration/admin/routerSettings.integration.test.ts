import { invalidateRouterSettingsCache } from "#router/settings.ts";
import { makeGatewayTestApp } from "#test-support/app.ts";
import { pgAvailable } from "#test-support/infra.ts";
import { after, before, test } from "node:test";
import { adminApp } from "#admin/index.ts";
import assert from "node:assert/strict";
import { env } from "#config/env.ts";

import {
	type RouterSettingsPatch,
	type RouterSettingsRow,
	updateRouterSettings,
	getRouterSettings,
} from "#db/repos/router.ts";

const skip = (await pgAvailable()) ? false : "Postgres unavailable";
const auth = {
	authorization: `Bearer ${env.MASTER_KEY}`,
	"content-type": "application/json",
};
const app = makeGatewayTestApp((gateway) => {
	gateway.route("/admin", adminApp);
});
let originalSettings: RouterSettingsRow | undefined;

function settingsPatch(row: RouterSettingsRow): RouterSettingsPatch {
	return {
		routingStrategy: row.routingStrategy,
		unsupportedParameterStrategy: row.unsupportedParameterStrategy,
		allowedFails: row.allowedFails,
		cooldownSeconds: row.cooldownSeconds,
		failureWindowSeconds: row.failureWindowSeconds,
		maxCooldownSeconds: row.maxCooldownSeconds,
		halfOpenProbeSeconds: row.halfOpenProbeSeconds,
		configurationCooldownSeconds: row.configurationCooldownSeconds,
		throttleCooldownSeconds: row.throttleCooldownSeconds,
		numRetries: row.numRetries,
		maxAttemptsPerRequest: row.maxAttemptsPerRequest,
		timeoutSeconds: row.timeoutSeconds,
		retryAfterSeconds: row.retryAfterSeconds,
	};
}

before(async () => {
	if (skip) return;
	originalSettings = await getRouterSettings();
});

after(async () => {
	if (!originalSettings) return;
	await updateRouterSettings(settingsPatch(originalSettings));
	invalidateRouterSettingsCache();
});

test("router settings: the five reliability controls are independently configurable", {
	skip,
}, async () => {
	const response = await app.request("/admin/router-settings", {
		method: "PUT",
		headers: auth,
		body: JSON.stringify({
			allowedFails: 0,
			cooldownSeconds: 7,
			numRetries: 7,
			timeoutSeconds: 42,
			retryAfterSeconds: 2,
		}),
	});
	assert.equal(response.status, 200);
	const body = (await response.json()) as {
		data: RouterSettingsRow;
	};
	assert.equal(body.data.allowedFails, 0);
	assert.equal(body.data.cooldownSeconds, 7);
	assert.equal(body.data.numRetries, 7);
	assert.equal(body.data.timeoutSeconds, 42);
	assert.equal(body.data.retryAfterSeconds, 2);
	assert.equal(body.data.maxAttemptsPerRequest, 8);
});

test("router settings: an explicit request ceiling cannot truncate retries", {
	skip,
}, async () => {
	const response = await app.request("/admin/router-settings", {
		method: "PUT",
		headers: auth,
		body: JSON.stringify({
			numRetries: 3,
			maxAttemptsPerRequest: 3,
		}),
	});
	assert.equal(response.status, 400);
	const body = (await response.json()) as {
		error: { code: string };
	};
	assert.equal(body.error.code, "invalid_router_settings");
});
