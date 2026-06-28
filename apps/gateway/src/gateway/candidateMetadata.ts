import type { DeploymentCandidate } from "./deploymentCandidates.ts";

/** Safe routing metadata: identifies the effective configuration without including credentials. */
export function candidateMetadata(
	candidate: DeploymentCandidate,
): Record<string, unknown> {
	return {
		upstreamModel: candidate.upstreamModel,
		adapterKey: candidate.row.adapterKey,
		custom: candidate.row.catalogEntry != null,
	};
}
