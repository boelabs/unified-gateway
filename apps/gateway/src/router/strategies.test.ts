import type { DeploymentCandidate } from "#gateway/deploymentCandidates.ts";
import type { DeploymentMetrics } from "./state.ts";
import { pickDeployment } from "./strategies.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

function cand(id: string, weight = 1): DeploymentCandidate {
	return {
		row: { id, weight } as DeploymentCandidate["row"],
		adapter: {
			key: "fake",
			supportedCallTypes: new Set(["chat"]),
		} as DeploymentCandidate["adapter"],
		upstreamModel: id,
		meta: {
			capabilities: {
				tools: true,
				vision: true,
				reasoning: false,
				structuredOutputs: false,
			},
		},
	};
}

function metrics(
	m: Record<string, Partial<DeploymentMetrics>>,
): Map<string, DeploymentMetrics> {
	const map = new Map<string, DeploymentMetrics>();
	for (const [id, v] of Object.entries(m)) {
		map.set(id, {
			inflight: v.inflight ?? 0,
			rpm: v.rpm ?? 0,
			tpm: v.tpm ?? 0,
		});
	}
	return map;
}

test("a single candidate is returned as-is", () => {
	const only = cand("a");
	assert.equal(pickDeployment("least-busy", [only], new Map()), only);
});

test("least-busy chooses the lowest inflight", () => {
	const c = [cand("a"), cand("b"), cand("c")];
	const m = metrics({
		a: { inflight: 5 },
		b: { inflight: 1 },
		c: { inflight: 3 },
	});
	assert.equal(pickDeployment("least-busy", c, m).row.id, "b");
});

test("usage-based-tpm chooses the lowest tpm", () => {
	const c = [cand("a"), cand("b")];
	const m = metrics({ a: { tpm: 1000 }, b: { tpm: 10 } });
	assert.equal(pickDeployment("usage-based-tpm", c, m).row.id, "b");
});

test("usage-based-rpm chooses the lowest rpm", () => {
	const c = [cand("a"), cand("b")];
	const m = metrics({ a: { rpm: 2 }, b: { rpm: 9 } });
	assert.equal(pickDeployment("usage-based-rpm", c, m).row.id, "a");
});

test("simple-shuffle always returns a valid candidate", () => {
	const c = [cand("a", 1), cand("b", 3), cand("c", 0)];
	const ids = new Set(c.map((x) => x.row.id));
	for (let i = 0; i < 50; i++) {
		assert.ok(ids.has(pickDeployment("simple-shuffle", c, new Map()).row.id));
	}
});
