import { createEnv } from "@t3-oss/env-core";
import * as z from "zod/v4";

const boolString = z.preprocess((value) => {
	if (typeof value !== "string") return value;
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	return value;
}, z.boolean());

/**
 * Typed environment configuration with @t3-oss/env-core. Validated once on import; if anything is
 * missing or invalid the process fails fast with a clear error. Pure backend: every variable is a
 * `server` variable (no client/clientPrefix).
 *
 * Demo keys (GEMINI_API_KEY, OPENAI_API_KEY...) are intentionally NOT declared here: they are only
 * used by dev scripts and are read directly from process.env.
 */
export const env = createEnv({
	server: {
		PORT: z.coerce.number().int().positive().default(4000),
		NODE_ENV: z
			.enum(["development", "test", "production"])
			.default("development"),
		LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

		MASTER_KEY: z.string().min(8, "MASTER_KEY is required and must be strong"),
		CREDENTIALS_ENCRYPTION_KEY: z
			.string()
			.regex(
				/^[0-9a-fA-F]{64}$/,
				"CREDENTIALS_ENCRYPTION_KEY must be 32 bytes in hex (64 chars)",
			),

		DATABASE_URL: z.url(),
		REDIS_URL: z.url(),

		MAX_STRING_LENGTH_PROMPT_IN_DB: z.coerce
			.number()
			.int()
			.positive()
			.default(8000),
		/** 16x50 MB + mask/fields; uploads are streamed to temporary disk, not memory. */
		IMAGES_MAX_MULTIPART_BYTES: z.coerce
			.number()
			.int()
			.positive()
			.default(805_000_000),
		/** Aggregate limit for the audio multipart (1 file + fields); streamed to temporary disk. */
		AUDIO_MAX_MULTIPART_BYTES: z.coerce
			.number()
			.int()
			.positive()
			.default(30_000_000),

		SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

		/** Consecutive hook failures before an extension instance is disabled for this process. */
		UNIFIED_GATEWAY_EXTENSION_MAX_FAILURES: z.coerce
			.number()
			.int()
			.positive()
			.default(3),
		/** How often each replica polls the registry version to hot-reload extensions on change. */
		UNIFIED_GATEWAY_EXTENSIONS_RELOAD_INTERVAL_MS: z.coerce
			.number()
			.int()
			.positive()
			.default(15_000),
		/** Maximum size of an uploaded extension module source, in bytes. */
		UNIFIED_GATEWAY_EXTENSIONS_MAX_CODE_BYTES: z.coerce
			.number()
			.int()
			.positive()
			.default(1_000_000),
		/** Per-hook wall-clock budget in ms. A hook exceeding it is aborted and counts as a failure. 0 disables the timeout. */
		UNIFIED_GATEWAY_EXTENSION_HOOK_TIMEOUT_MS: z.coerce
			.number()
			.int()
			.min(0)
			.default(5_000),

		REQUEST_LOG_PARTITION_CREATE_DAYS: z.coerce
			.number()
			.int()
			.min(1)
			.default(7),
		REQUEST_LOG_PARTITION_RETENTION_DAYS: z.coerce
			.number()
			.int()
			.min(1)
			.default(30),
		REQUEST_LOG_PARTITION_JOB_INTERVAL_MS: z.coerce
			.number()
			.int()
			.positive()
			.default(3_600_000),
		RESPONSES_STATE_RETENTION_DAYS: z.coerce.number().int().min(1).default(14),
		/** Interval for the in-app response_states GC job that deletes expired rows. */
		RESPONSE_STATE_GC_INTERVAL_MS: z.coerce
			.number()
			.int()
			.positive()
			.default(3_600_000),
		/** Default for `store` when the client omits it. true = OpenAI-compatible; set false for privacy-first. */
		RESPONSES_STORE_DEFAULT: boolString.default(true),

		OTEL_ENABLED: boolString.default(false),
		OTEL_SERVICE_NAME: z.string().min(1).default("unifiedgateway"),
		OTEL_METRIC_EXPORT_INTERVAL_MS: z.coerce
			.number()
			.int()
			.positive()
			.default(60_000),
		OTEL_LOG_PAYLOADS: boolString.default(true),
	},

	runtimeEnv: process.env,
	emptyStringAsUndefined: true,
});
