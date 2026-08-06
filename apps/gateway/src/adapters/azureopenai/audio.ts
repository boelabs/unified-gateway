import type { AdapterContext, TranscriptionHandler } from "#adapters/types.ts";
import { type BaseCreds, requireApiKeyCreds } from "#adapters/creds.ts";
import { recordUnknownAdapterEvent } from "#adapters/diagnostics.ts";
import { adapterContextDiagnostics } from "#adapters/diagnostics.ts";
import { mapUpstreamHttpError } from "#adapters/upstreamError.ts";
import { normalizeAzurev1BaseUrl } from "#adapters/azurev1.ts";
import { azureRefineBadRequest } from "#adapters/azurev1.ts";
import { GatewayError } from "#core/errors.ts";

import {
	parseTranscriptionResponse,
	parseTranscriptionStream,
	buildTranscriptionForm,
} from "#contracts/openai/audioTransport.ts";

interface AzureAudioCredentials extends BaseCreds {
	/** Azure's versioned image and audio data-plane API. */
	apiVersion?: string;
}

/** Current Azure image/audio data-plane version documented by Microsoft. */
const DEFAULT_AUDIO_API_VERSION = "2025-04-01-preview";

function resourceOrigin(baseUrl: string | undefined, label: string): string {
	if (!baseUrl)
		throw new GatewayError({
			class: "bad_request",
			message: `${label}: missing 'baseUrl' in credentials`,
		});
	return new URL(normalizeAzurev1BaseUrl(baseUrl)).origin;
}

/**
 * Azure's file-audio data plane remains deployment-addressed even though text, embeddings, and
 * Realtime use `/openai/v1`. This is an explicit provider transport, not a retry fallback: one
 * canonical request produces one upstream request at the endpoint Microsoft documents for audio.
 */
export function makeAzureTranscriptionHandler(
	label: string,
): TranscriptionHandler {
	function mapError(error: unknown): GatewayError {
		return mapUpstreamHttpError(error, {
			label,
			refineBadRequest: azureRefineBadRequest,
		});
	}

	return {
		async buildRequest(request, ctx: AdapterContext) {
			const credentials = requireApiKeyCreds<AzureAudioCredentials>(
				ctx.credentials,
				label,
			);
			const apiVersion = credentials.apiVersion ?? DEFAULT_AUDIO_API_VERSION;
			if (typeof apiVersion !== "string" || apiVersion.trim().length === 0)
				throw new GatewayError({
					class: "bad_request",
					message: `${label}: credentials.apiVersion must be a non-empty string`,
				});
			const origin = resourceOrigin(credentials.baseUrl, label);
			const deployment = encodeURIComponent(ctx.upstreamModel);
			const url = new URL(
				`/openai/deployments/${deployment}/audio/transcriptions`,
				origin,
			);
			url.searchParams.set("api-version", apiVersion);
			const form = await buildTranscriptionForm(request, ctx.upstreamModel);
			// Azure addresses the deployment in the URL; unlike OpenAI's v1 endpoint, it does not use
			// the multipart model field.
			form.delete("model");
			return {
				method: "POST",
				url: url.toString(),
				headers: {
					"api-key": credentials.apiKey,
					...(credentials.headers ?? {}),
				},
				body: form,
			};
		},
		parseResponse(raw) {
			return parseTranscriptionResponse(raw);
		},
		parseStream(stream, ctx) {
			return parseTranscriptionStream(stream, {
				onUnknownEvent: (type) =>
					recordUnknownAdapterEvent(adapterContextDiagnostics(ctx), type),
				onTransportTerminator: (terminator) => {
					adapterContextDiagnostics(ctx).transportTerminator = terminator;
				},
			});
		},
		mapError,
	};
}
