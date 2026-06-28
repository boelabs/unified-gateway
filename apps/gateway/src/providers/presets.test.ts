import { getProviderPreset } from "./presets.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

test("Azure presets separate Azure OpenAI from Foundry", () => {
	const openai = getProviderPreset("azureopenai");
	assert.equal(openai?.adapterKey, "azureopenai");
	assert.equal(openai?.defaultTransportOverrides["text.generate"], "responses");
	assert.equal(
		openai?.defaultTransportOverrides["embedding.create"],
		"embeddings",
	);
	assert.deepEqual(openai?.requiredCredentialKeys, ["apiKey", "baseUrl"]);

	const foundry = getProviderPreset("azurefoundry");
	assert.equal(foundry?.adapterKey, "azurefoundry");
	assert.equal(
		foundry?.defaultTransportOverrides["text.generate"],
		"chat_completions",
	);
	assert.deepEqual(foundry?.requiredCredentialKeys, ["apiKey", "baseUrl"]);
});

test("presets expose embeddings transport where the adapter supports it", () => {
	assert.equal(
		getProviderPreset("openai")?.defaultTransportOverrides["embedding.create"],
		"embeddings",
	);
	assert.equal(
		getProviderPreset("googleaistudio")?.defaultTransportOverrides[
			"embedding.create"
		],
		"embed_content",
	);
	assert.equal(
		getProviderPreset("openaicompatible")?.defaultTransportOverrides[
			"embedding.create"
		],
		"embeddings",
	);
});
