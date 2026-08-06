import type { DetectedLanguage } from "./audio.ts";

export type LiveTranscriptionDelay =
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh";

export type LiveAudioFormat =
	| { type: "audio/pcm"; rate: number }
	| { type: "audio/pcmu" }
	| { type: "audio/pcma" };

export interface CanonicalLiveTranscriptionConfig {
	model: string;
	format: LiveAudioFormat;
	noiseReduction?: null | { type: "near_field" | "far_field" };
	prompt?: string;
	language?: string;
	languages?: string[];
	keywords?: string[];
	delay?: LiveTranscriptionDelay;
	turnDetection: null | {
		type: "server_vad";
		threshold?: number;
		prefixPaddingMs?: number;
		silenceDurationMs?: number;
	};
	include?: string[];
}

export type CanonicalLiveTranscriptionClientEvent =
	| {
			kind: "session.update";
			eventId?: string;
			config: CanonicalLiveTranscriptionConfig;
	  }
	| { kind: "audio.append"; eventId?: string; audio: string }
	| { kind: "audio.commit"; eventId?: string }
	| { kind: "audio.clear"; eventId?: string };

export type CanonicalLiveTranscriptionServerEvent =
	| {
			kind: "session.created";
			eventId?: string;
			sessionId?: string;
			expiresAt?: number;
			config: CanonicalLiveTranscriptionConfig;
	  }
	| {
			kind: "session.updated";
			eventId?: string;
			sessionId?: string;
			expiresAt?: number;
			config: CanonicalLiveTranscriptionConfig;
	  }
	| {
			kind: "transcript.failed";
			eventId?: string;
			itemId: string;
			contentIndex: number;
			error: {
				type?: string;
				code?: string;
				message: string;
				param?: string | null;
			};
	  }
	| {
			kind: "transcript.delta";
			eventId?: string;
			itemId: string;
			contentIndex: number;
			delta: string;
			logprobs?: unknown;
	  }
	| {
			kind: "transcript.completed";
			eventId?: string;
			itemId: string;
			contentIndex: number;
			transcript: string;
			languages?: DetectedLanguage[];
			logprobs?: unknown;
	  }
	| {
			kind:
				| "audio.committed"
				| "audio.cleared"
				| "speech.started"
				| "speech.stopped";
			eventId?: string;
			itemId?: string;
			previousItemId?: string;
			audioStartMs?: number;
			audioEndMs?: number;
	  }
	| {
			kind: "error";
			eventId?: string;
			error: {
				type?: string;
				code?: string;
				message: string;
				param?: string | null;
				eventId?: string | null;
			};
	  };

export interface LiveTranscriptionProfile {
	emission: "continuous" | "after_commit";
	inputFormats: LiveAudioFormat[];
	turnDetection: Array<"manual" | "server_vad">;
	supportsPrompt?: boolean;
	supportsLanguage?: boolean;
	supportsLanguages?: boolean;
	supportsKeywords?: boolean;
	supportsNoiseReduction?: boolean;
	returnsDetectedLanguages?: boolean;
	delayLevels?: LiveTranscriptionDelay[];
}

export function estimateLiveAudioSeconds(
	format: LiveAudioFormat,
	base64Audio: string,
): number {
	const bytes = Buffer.byteLength(base64Audio, "base64");
	if (format.type === "audio/pcm") return bytes / (format.rate * 2);
	return bytes / 8_000;
}
