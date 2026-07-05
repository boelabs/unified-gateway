import type { DeploymentCandidate } from "#gateway/deploymentCandidates.ts";
import type { RouteOptions, RouteResult } from "#router/index.ts";
import type { CanonicalChatRequest } from "#core/canonical.ts";
import type { EffectiveSettings } from "#router/settings.ts";
import type { ChatExecResult } from "#gateway/executor.ts";
import { executeChat } from "#gateway/executor.ts";
import type { AppEnv } from "#auth/types.ts";
import { route } from "#router/index.ts";
import type { Context } from "hono";

import {
	type UnsupportedParameterStrategy,
	applyUnsupportedParameterPolicy,
	assertSupportedChatParameters,
	type ParameterPolicyResult,
} from "#catalog/parameters.ts";

export type ParameterPolicyRecorder = (result: ParameterPolicyResult) => void;

export function parameterEligibility(
	req: CanonicalChatRequest,
	strategy: UnsupportedParameterStrategy,
): RouteOptions["candidateEligibility"] | undefined {
	if (strategy !== "error") return undefined;
	return (candidate) => assertSupportedChatParameters(req, candidate.meta);
}

export function requestForCandidate(
	req: CanonicalChatRequest,
	candidate: DeploymentCandidate,
	strategy: UnsupportedParameterStrategy,
	record: ParameterPolicyRecorder,
): CanonicalChatRequest {
	const result = applyUnsupportedParameterPolicy(req, candidate.meta, strategy);
	record(result);
	return result.request;
}

/**
 * Shared routing wiring for /v1/chat/completions, /v1/messages, and /v1/responses: resolves parameter
 * eligibility/policy for `canonical.model` and routes to a "chat" candidate. Kept in one place so a
 * fix to this wiring (eligibility, policy application, candidate execution) does not have to be
 * copy-pasted into all three endpoints and risk drifting between them.
 */
export async function routeChat(
	c: Context<AppEnv>,
	canonical: CanonicalChatRequest,
	requestId: string,
	settings: EffectiveSettings,
): Promise<{
	routing: RouteResult<ChatExecResult>;
	parameterPolicy: ParameterPolicyResult | null;
}> {
	let parameterPolicy: ParameterPolicyResult | null = null;
	const eligibility = parameterEligibility(
		canonical,
		settings.unsupportedParameterStrategy,
	);
	const routing = await route<ChatExecResult>(
		canonical.model,
		"chat",
		{
			clientSignal: c.req.raw.signal,
			requestId,
			...(eligibility ? { candidateEligibility: eligibility } : {}),
		},
		(cand, ctx) =>
			executeChat(
				cand.adapter,
				requestForCandidate(
					canonical,
					cand,
					settings.unsupportedParameterStrategy,
					(result) => {
						parameterPolicy = result;
					},
				),
				ctx,
			),
	);
	return { routing, parameterPolicy };
}

export function parameterPolicyLogMetadata(
	result: ParameterPolicyResult | null,
	strategy: UnsupportedParameterStrategy,
): Record<string, unknown> | undefined {
	if (!result || result.droppedParameters.length === 0) return undefined;
	return {
		strategy,
		droppedParameters: result.droppedParameters,
	};
}
