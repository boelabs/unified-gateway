import { customCatalogEntrySchema } from "./schema.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

function budgetEntry(budgets?: { max: number }) {
	return {
		operations: {
			"text.generate": {
				capabilities: {
					tools: true,
					vision: false,
					reasoning: true,
					structuredOutputs: true,
				},
				reasoning: {
					kind: "anthropic_budget",
					levels: ["max"],
					...(budgets ? { budgets } : {}),
				},
			},
		},
	};
}

test("budget reasoning requires an explicit token budget for max", () => {
	const missing = customCatalogEntrySchema.safeParse(budgetEntry());
	assert.equal(missing.success, false);
	if (!missing.success) {
		assert.ok(
			missing.error.issues.some(
				(issue) =>
					issue.path.join(".") ===
					"operations.text.generate.reasoning.budgets.max",
			),
		);
	}

	assert.equal(
		customCatalogEntrySchema.safeParse(budgetEntry({ max: 64_000 })).success,
		true,
	);
});
