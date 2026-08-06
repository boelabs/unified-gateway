import type { Usage } from "./usage.ts";

/** Provider-independent types for bounded-file and live audio transcription. */

export type TranscriptionResponseFormat =
	| "diarized_json"
	| "json"
	| "text"
	| "srt"
	| "verbose_json"
	| "vtt";
type TimestampGranularity = "word" | "segment";

export interface DetectedLanguage {
	code: string;
}

/** Formats whose upstream response body is plain text (not JSON). */
export const TEXT_TRANSCRIPTION_FORMATS: readonly TranscriptionResponseFormat[] =
	["text", "srt", "vtt"];

/** An audio file validated and stored on temporary disk during a multipart request. */
export interface CanonicalAudioInput {
	path: string;
	filename: string;
	mimeType: string;
	sizeBytes: number;
}

export interface CanonicalTranscriptionRequest {
	model: string;
	file: CanonicalAudioInput;
	language?: string;
	languages?: string[];
	keywords?: string[];
	prompt?: string;
	temperature?: number;
	responseFormat: TranscriptionResponseFormat;
	timestampGranularities?: TimestampGranularity[];
	include?: string[];
	stream: boolean;
	extraBody?: Record<string, unknown>;
}

/** Provider-reported token or audio-duration usage, both normalized into core accounting. */
export type TranscriptionUsage =
	| {
			type: "tokens";
			inputTokens?: number;
			outputTokens?: number;
			totalTokens?: number;
			inputTokenDetails?: { textTokens?: number; audioTokens?: number };
	  }
	| { type: "duration"; seconds: number };

/**
 * Canonical transcription response. The adapter detects text-vs-JSON from the upstream body (string
 * for text/srt/vtt; object for json/verbose_json); the output FORMAT is decided by the endpoint from
 * `req.responseFormat`. `segments`/`words` are kept raw (passthrough) to re-emit them identical to the
 * OpenAI contract.
 */
export interface CanonicalTranscriptionResponse {
	text: string;
	language?: string;
	languages?: DetectedLanguage[];
	duration?: number;
	segments?: Record<string, unknown>[];
	words?: Record<string, unknown>[];
	logprobs?: unknown;
	usage?: TranscriptionUsage;
}

export type CanonicalTranscriptionStreamEvent =
	| { kind: "delta"; delta: string; logprobs?: unknown }
	| {
			kind: "done";
			text: string;
			usage?: TranscriptionUsage;
			logprobs?: unknown;
			languages?: DetectedLanguage[];
	  };

/**
 * Canonical constraints of a transcription model (the client contract). The gateway validates the
 * request against this before routing; the operator of a custom model only declares this.
 */
export interface TranscriptionProfile {
	/** Accepted response formats. */
	responseFormats: TranscriptionResponseFormat[];
	/** The model supports SSE streaming (gpt-4o-transcribe does). */
	supportsStreaming?: boolean;
	/** Accepts `timestamp_granularities[]` (only with verbose_json). */
	supportsTimestampGranularities?: boolean;
	/** Context controls accepted by this model. */
	context?: {
		prompt?: boolean;
		language?: boolean;
		languages?: boolean;
		keywords?: boolean;
	};
	/** The response can contain detected languages. */
	returnsDetectedLanguages?: boolean;
	/** Maximum audio file size. */
	maxFileBytes?: number;
}

/** Converts the transcription usage to the core `Usage` (cost). */
export function transcriptionUsageToCore(
	u: TranscriptionUsage | undefined,
): Usage | null {
	if (!u) return null;
	if (u.type === "duration") {
		return {
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
			inputAudioSeconds: u.seconds,
		};
	}
	if (u.totalTokens === undefined) return null;
	return {
		promptTokens: u.inputTokens ?? 0,
		completionTokens: u.outputTokens ?? 0,
		totalTokens: u.totalTokens,
	};
}
