import type { CanonicalLiveTranscriptionConfig } from "#core/liveTranscription.ts";
import { liveTranscriptionProfileFor } from "#catalog/types.ts";
import type { ResolvedModelMetadata } from "#catalog/types.ts";
import { GatewayError } from "#core/errors.ts";

function unsupported(param: string, message: string): never {
	throw new GatewayError({
		class: "bad_request",
		code: "unsupported_parameter",
		message,
		param,
		publicMessage: message,
	});
}

export function assertLiveTranscriptionSupported(
	config: CanonicalLiveTranscriptionConfig,
	meta: ResolvedModelMetadata,
): void {
	const profile = liveTranscriptionProfileFor(meta);
	if (!profile)
		unsupported(
			"model",
			"The selected model has no live transcription profile.",
		);
	if (
		!profile.inputFormats.some(
			(format) =>
				format.type === config.format.type &&
				(format.type !== "audio/pcm" ||
					(config.format.type === "audio/pcm" &&
						format.rate === config.format.rate)),
		)
	)
		unsupported(
			"session.audio.input.format",
			"The selected model does not support this input audio format.",
		);
	const turn = config.turnDetection === null ? "manual" : "server_vad";
	if (!profile.turnDetection.includes(turn))
		unsupported(
			"session.audio.input.turn_detection",
			"The selected model does not support this turn detection mode.",
		);
	if (config.prompt !== undefined && !profile.supportsPrompt)
		unsupported(
			"session.audio.input.transcription.prompt",
			"The selected model does not support prompt.",
		);
	if (config.language !== undefined && !profile.supportsLanguage)
		unsupported(
			"session.audio.input.transcription.language",
			"The selected model does not support language.",
		);
	if (config.languages !== undefined && !profile.supportsLanguages)
		unsupported(
			"session.audio.input.transcription.languages",
			"The selected model does not support languages.",
		);
	if (config.language !== undefined && config.languages !== undefined)
		unsupported(
			"session.audio.input.transcription.languages",
			"language and languages cannot be used together.",
		);
	if (config.keywords !== undefined && !profile.supportsKeywords)
		unsupported(
			"session.audio.input.transcription.keywords",
			"The selected model does not support keywords.",
		);
	if (config.noiseReduction !== undefined && !profile.supportsNoiseReduction)
		unsupported(
			"session.audio.input.noise_reduction",
			"The selected model does not support input noise reduction.",
		);
	for (const [index, keyword] of (config.keywords ?? []).entries())
		if (/[<>\r\n]/.test(keyword))
			unsupported(
				`session.audio.input.transcription.keywords[${index}]`,
				"Keywords cannot contain <, >, carriage returns, or line feeds.",
			);
	if (
		config.delay !== undefined &&
		!profile.delayLevels?.includes(config.delay)
	)
		unsupported(
			"session.audio.input.transcription.delay",
			"The selected model does not support this delay level.",
		);
}
