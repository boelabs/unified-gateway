import type { DeploymentCandidate } from "#gateway/deploymentCandidates.ts";
import type { RouteOptions, RouteResult } from "#router/index.ts";
import { nativeTransportForPublicWire } from "#core/transport.ts";
import type { CanonicalChatRequest } from "#core/canonical.ts";
import type { EffectiveSettings } from "#router/settings.ts";
import type { ChatExecResult } from "#gateway/executor.ts";
import { resolveTransport } from "#router/transport.ts";
import { executeChat } from "#gateway/executor.ts";
import { GatewayError } from "#core/errors.ts";
import type { AppEnv } from "#auth/types.ts";
import { route } from "#router/index.ts";
import type { Context } from "hono";

import {
	type UnsupportedParameterStrategy,
	applyUnsupportedParameterPolicy,
	assertSupportedChatParameters,
	type ParameterPolicyResult,
} from "#catalog/parameters.ts";

import {
	type FileResolutionMetadata,
	createFileInputResolver,
} from "#files/requestFiles.ts";

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
	fileResolution: FileResolutionMetadata | null;
}> {
	let parameterPolicy: ParameterPolicyResult | null = null;
	let fileResolution: FileResolutionMetadata | null = null;
	const fileResolver = createFileInputResolver(canonical, c.req.raw.signal);
	const eligibility = parameterEligibility(
		canonical,
		settings.unsupportedParameterStrategy,
	);
	const publicWire = canonical.publicWire ?? "chat_completions";
	const preferredTransport = nativeTransportForPublicWire(publicWire);
	const nativeEligibility: RouteOptions["candidateEligibility"] | undefined =
		canonical.requiresNativeWire
			? (candidate) => {
					if (
						resolveTransport(candidate, "chat", preferredTransport) !==
						preferredTransport
					) {
						throw new GatewayError({
							class: "bad_request",
							code: "native_transport_required",
							param: null,
							message: `The request uses ${publicWire} features that require its native transport`,
						});
					}
				}
			: undefined;
	const candidateEligibility: RouteOptions["candidateEligibility"] | undefined =
		eligibility || nativeEligibility || fileResolver.hasFiles
			? (candidate) => {
					eligibility?.(candidate);
					nativeEligibility?.(candidate);
					fileResolver.assertCandidate(
						candidate,
						resolveTransport(candidate, "chat", preferredTransport),
					);
				}
			: undefined;
	const routing = await route<ChatExecResult>(
		canonical.model,
		"chat",
		{
			clientSignal: c.req.raw.signal,
			requestId,
			preferredTransport,
			...(candidateEligibility ? { candidateEligibility } : {}),
		},
		async (cand, ctx) => {
			const resolved = await fileResolver.resolveForCandidate(
				cand,
				ctx.transport,
			);
			fileResolution = resolved.metadata ?? null;
			return executeChat(
				cand.adapter,
				requestForCandidate(
					resolved.request,
					cand,
					settings.unsupportedParameterStrategy,
					(result) => {
						parameterPolicy = result;
					},
				),
				ctx,
			);
		},
	);
	return { routing, parameterPolicy, fileResolution };
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

export function fileResolutionLogMetadata(
	result: FileResolutionMetadata | null,
): Record<string, unknown> | undefined {
	if (!result) return undefined;
	return {
		engine: result.engine,
		nativeFiles: result.nativeFiles,
		parsedFiles: result.parsedFiles,
		materializedUrls: result.materializedUrls,
	};
}
