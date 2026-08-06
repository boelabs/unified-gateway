import type { CanonicalTranscriptionRequest } from "#core/audio.ts";
import type { ResolvedModelMetadata } from "#catalog/types.ts";
import { transcriptionProfileFor } from "#catalog/types.ts";
import { GatewayError } from "#core/errors.ts";

function unsupported(param: string, message: string): never {
	throw new GatewayError({
		class: "bad_request",
		message,
		code: "unsupported_parameter",
		param,
		publicMessage: message,
	});
}

export function assertTranscriptionRequestSupported(
	req: CanonicalTranscriptionRequest,
	meta: ResolvedModelMetadata,
): void {
	const profile = transcriptionProfileFor(meta);
	if (!profile)
		unsupported(
			"model",
			"The selected model has no audio transcription profile.",
		);

	if (!profile.responseFormats.includes(req.responseFormat)) {
		unsupported(
			"response_format",
			`The selected model does not support response_format=${req.responseFormat}.`,
		);
	}
	if (req.language !== undefined && req.languages !== undefined) {
		unsupported("languages", "language and languages cannot be used together.");
	}
	if (req.prompt !== undefined && profile.context?.prompt === false) {
		unsupported("prompt", "The selected model does not support prompt.");
	}
	if (req.language !== undefined && profile.context?.language === false) {
		unsupported("language", "The selected model does not support language.");
	}
	if (req.languages !== undefined && profile.context?.languages !== true) {
		unsupported("languages", "The selected model does not support languages.");
	}
	if (req.keywords !== undefined && profile.context?.keywords !== true) {
		unsupported("keywords", "The selected model does not support keywords.");
	}
	for (const [index, keyword] of (req.keywords ?? []).entries()) {
		if (/[<>\r\n]/.test(keyword)) {
			unsupported(
				`keywords[${index}]`,
				"Keywords cannot contain <, >, carriage returns, or line feeds.",
			);
		}
	}
	if (req.stream && !profile.supportsStreaming) {
		unsupported(
			"stream",
			"The selected model does not support streaming transcriptions.",
		);
	}
	if (req.timestampGranularities && req.timestampGranularities.length > 0) {
		if (!profile.supportsTimestampGranularities) {
			unsupported(
				"timestamp_granularities",
				"The selected model does not support timestamp_granularities.",
			);
		}
		if (req.responseFormat !== "verbose_json") {
			unsupported(
				"timestamp_granularities",
				"timestamp_granularities requires response_format=verbose_json.",
			);
		}
	}
	if (
		profile.maxFileBytes !== undefined &&
		req.file.sizeBytes > profile.maxFileBytes
	) {
		unsupported(
			"file",
			`The audio file exceeds the ${profile.maxFileBytes} byte model limit.`,
		);
	}
}
