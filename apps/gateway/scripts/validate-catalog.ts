import { loadCatalogDocument } from "#catalog/jsonCatalog.ts";

const catalogs = [
	{
		adapterKey: "openai",
		url: new URL("../src/adapters/openai/catalog.json", import.meta.url),
	},
	{
		adapterKey: "googleaistudio",
		url: new URL("../src/adapters/google/catalog.json", import.meta.url),
	},
	{
		adapterKey: "anthropic",
		url: new URL("../src/adapters/anthropic/catalog.json", import.meta.url),
	},
	{
		adapterKey: "deepseek",
		url: new URL("../src/adapters/deepseek/catalog.json", import.meta.url),
	},
	{
		adapterKey: "moonshot",
		url: new URL("../src/adapters/moonshot/catalog.json", import.meta.url),
	},
	{
		adapterKey: "zai",
		url: new URL("../src/adapters/zai/catalog.json", import.meta.url),
	},
	{
		adapterKey: "minimax",
		url: new URL("../src/adapters/minimax/catalog.json", import.meta.url),
	},
	{
		adapterKey: "azureopenai",
		url: new URL("../src/adapters/azureopenai/catalog.json", import.meta.url),
	},
	{
		adapterKey: "azurefoundry",
		url: new URL("../src/adapters/azurefoundry/catalog.json", import.meta.url),
	},
] as const;

let total = 0;

for (const catalog of catalogs) {
	const doc = loadCatalogDocument(catalog.url, {
		adapterKey: catalog.adapterKey,
	});
	const count = Object.keys(doc.models).length;
	total += count;
	console.log(`${doc.provider.adapterKey}: ${count} models`);
}

console.log(`catalog ok: ${total} models`);
