import type { DeploymentCandidate } from "#gateway/deploymentCandidates.ts";
import type { RoutingStrategy } from "./settings.ts";
import type { DeploymentMetrics } from "./state.ts";

const ZERO: DeploymentMetrics = { inflight: 0, rpm: 0, tpm: 0 };

function weightedRandom(
	candidates: DeploymentCandidate[],
): DeploymentCandidate {
	const total = candidates.reduce((s, c) => s + Math.max(0, c.row.weight), 0);
	if (total <= 0)
		return candidates[Math.floor(Math.random() * candidates.length)]!;
	let r = Math.random() * total;
	for (const c of candidates) {
		r -= Math.max(0, c.row.weight);
		if (r < 0) return c;
	}
	return candidates[candidates.length - 1]!;
}

/** Picks the candidate with the lowest metric; ties -> random among the minimums. */
function pickMin(
	candidates: DeploymentCandidate[],
	metrics: Map<string, DeploymentMetrics>,
	key: keyof DeploymentMetrics,
): DeploymentCandidate {
	let min = Infinity;
	let winners: DeploymentCandidate[] = [];
	for (const c of candidates) {
		const v = (metrics.get(c.row.id) ?? ZERO)[key];
		if (v < min) {
			min = v;
			winners = [c];
		} else if (v === min) {
			winners.push(c);
		}
	}
	return winners[Math.floor(Math.random() * winners.length)]!;
}

/**
 * Pure selector: given a strategy, candidates, and their current metrics, picks one.
 * `candidates` must be non-empty. (Metric fetching lives in the router.)
 */
export function pickDeployment(
	strategy: RoutingStrategy,
	candidates: DeploymentCandidate[],
	metrics: Map<string, DeploymentMetrics>,
): DeploymentCandidate {
	if (candidates.length === 1) return candidates[0]!;
	switch (strategy) {
		case "least-busy":
			return pickMin(candidates, metrics, "inflight");
		case "usage-based-tpm":
			return pickMin(candidates, metrics, "tpm");
		case "usage-based-rpm":
			return pickMin(candidates, metrics, "rpm");
		case "simple-shuffle":
			return weightedRandom(candidates);
	}
}
