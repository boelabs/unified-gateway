/**
 * The gateway's canonical error. Adapters map upstream errors to one of these classes (`mapError`),
 * and the router decides what to do based on the class:
 *  - rate_limit | timeout | server -> retryable per deployment; counts toward cooldown.
 *  - context_window | content_policy -> exhausts that deployment without repeating it; if the whole
 *    pool fails with the same class, selects its dedicated chain.
 *  - auth | bad_request | not_found -> exhausts that deployment without repeating it and continues the pool.
 * Provider-side request rejections (`bad_request`, `context_window`, `content_policy`) are
 * health-neutral: they describe this input, not whether the deployment is operational.
 */
export type ErrorClass =
	| "bad_request"
	| "auth"
	| "permission"
	| "not_found"
	| "rate_limit"
	| "context_window"
	| "content_policy"
	| "timeout"
	| "server";

export interface OpenAIErrorBody {
	error: {
		message: string;
		type: string;
		param: string | null;
		code: string | null;
	};
}

interface ErrorMeta {
	httpStatus: number;
	openaiType: string;
	defaultCode: string | null;
	retryable: boolean;
}

/**
 * Generic PUBLIC message per class. It is what the client ALWAYS sees (by default), because we are a
 * router: the same Public Model can resolve to different deployments and each can fail differently;
 * the public error must be stable and must not leak the provider's wording.
 * The real detail (including the provider's) is stored in `message` for the logs.
 * `type`, `code`, and `param` are exposed (they give actionable hints without leaking internals).
 */
const GENERIC_PUBLIC: Record<ErrorClass, string> = {
	bad_request: "The request is invalid.",
	auth: "Authentication failed.",
	permission: "You do not have access to this resource.",
	not_found: "The requested resource was not found.",
	rate_limit: "Rate limit or quota exceeded. Please try again later.",
	context_window: "The input exceeds the model's context window.",
	content_policy: "The request was blocked by the content policy.",
	timeout: "The upstream provider timed out. Please try again.",
	server: "The service is temporarily unavailable. Please try again later.",
};

const META: Record<ErrorClass, ErrorMeta> = {
	bad_request: {
		httpStatus: 400,
		openaiType: "invalid_request_error",
		defaultCode: null,
		retryable: false,
	},
	auth: {
		httpStatus: 401,
		openaiType: "authentication_error",
		defaultCode: null,
		retryable: false,
	},
	permission: {
		httpStatus: 403,
		openaiType: "invalid_request_error",
		defaultCode: "model_not_allowed",
		retryable: false,
	},
	not_found: {
		httpStatus: 404,
		openaiType: "invalid_request_error",
		defaultCode: null,
		retryable: false,
	},
	rate_limit: {
		httpStatus: 429,
		openaiType: "rate_limit_error",
		defaultCode: "rate_limit_exceeded",
		retryable: true,
	},
	context_window: {
		httpStatus: 400,
		openaiType: "invalid_request_error",
		defaultCode: "context_length_exceeded",
		retryable: false,
	},
	content_policy: {
		httpStatus: 400,
		openaiType: "invalid_request_error",
		defaultCode: "content_policy_violation",
		retryable: false,
	},
	timeout: {
		httpStatus: 504,
		openaiType: "server_error",
		defaultCode: "timeout",
		retryable: true,
	},
	server: {
		httpStatus: 502,
		openaiType: "server_error",
		defaultCode: null,
		retryable: true,
	},
};

/** Public error type in the Anthropic contract (Messages API). */
const ANTHROPIC_TYPE: Record<ErrorClass, string> = {
	bad_request: "invalid_request_error",
	auth: "authentication_error",
	permission: "permission_error",
	not_found: "not_found_error",
	rate_limit: "rate_limit_error",
	context_window: "invalid_request_error",
	content_policy: "invalid_request_error",
	timeout: "api_error",
	server: "api_error",
};

export interface GatewayErrorOptions {
	class: ErrorClass;
	/** INTERNAL/detailed message (goes to logs; may include the provider's detail). */
	message: string;
	/**
	 * PUBLIC message the client sees. Defaults to the class's generic message (recommended).
	 * Only overridden in very specific cases where exposing detail is safe and desired.
	 */
	publicMessage?: string;
	/** Override of the class's default HTTP status. */
	status?: number;
	/** Override of the default OpenAI code. */
	code?: string | null;
	/** Parameter that caused the error (for invalid_request_error). */
	param?: string | null;
	/** Raw provider detail (status + untouched body), for logs. */
	provider?: { status?: number; body?: unknown };
	/** Public headers the global handler must copy to the response. */
	headers?: Record<string, string>;
	/** Request-scoped failures cannot become valid by trying another deployment. */
	routingScope?: "candidate" | "request";
	/** Whether this error is evidence that the selected deployment is unhealthy. */
	deploymentHealth?: "penalize" | "neutral";
	cause?: unknown;
}

export class GatewayError extends Error {
	readonly class: ErrorClass;
	readonly httpStatus: number;
	readonly openaiType: string;
	readonly code: string | null;
	readonly param: string | null;
	readonly retryable: boolean;
	/** Message returned to the client (may differ from the internal `message`). */
	readonly publicMessage: string;
	/** Raw provider detail (for logs; never exposed to the client). */
	readonly provider?: { status?: number; body?: unknown };
	readonly headers?: Record<string, string>;
	readonly routingScope: "candidate" | "request";
	readonly deploymentHealth: "penalize" | "neutral";
	/** Router attempts that led to this error (attached by the router; for logs). */
	attempts?: unknown[];

	constructor(opts: GatewayErrorOptions) {
		super(
			opts.message,
			opts.cause !== undefined ? { cause: opts.cause } : undefined,
		);
		this.name = "GatewayError";
		const meta = META[opts.class];
		this.class = opts.class;
		this.httpStatus = opts.status ?? meta.httpStatus;
		this.openaiType = meta.openaiType;
		this.code = opts.code !== undefined ? opts.code : meta.defaultCode;
		this.param = opts.param ?? null;
		this.retryable = meta.retryable;
		// By default the client sees the class's GENERIC message; the detail stays in `message`.
		this.publicMessage = opts.publicMessage ?? GENERIC_PUBLIC[opts.class];
		if (opts.provider !== undefined) this.provider = opts.provider;
		if (opts.headers !== undefined) this.headers = opts.headers;
		this.routingScope = opts.routingScope ?? "candidate";
		const providerRejectedInput =
			opts.provider !== undefined &&
			(opts.class === "bad_request" ||
				opts.class === "context_window" ||
				opts.class === "content_policy");
		this.deploymentHealth =
			opts.deploymentHealth ??
			(this.routingScope === "request" || providerRejectedInput
				? "neutral"
				: "penalize");
	}

	/** Rich representation for LOGS: gateway classification + raw provider detail. */
	toLog(): Record<string, unknown> {
		return {
			class: this.class,
			code: this.code,
			http_status: this.httpStatus,
			message: this.message,
			...(this.routingScope !== "candidate"
				? { routing_scope: this.routingScope }
				: {}),
			...(this.deploymentHealth !== "penalize"
				? { deployment_health: this.deploymentHealth }
				: {}),
			...(this.provider !== undefined ? { provider: this.provider } : {}),
		};
	}

	/** Error body with OpenAI's exact shape (uses the PUBLIC message). */
	toOpenAI(): OpenAIErrorBody {
		return {
			error: {
				message: this.publicMessage,
				type: this.openaiType,
				param: this.param,
				code: this.code,
			},
		};
	}

	/** Error body with Anthropic's exact shape (Messages API). Uses the PUBLIC message. */
	toAnthropic(): { type: "error"; error: { type: string; message: string } } {
		return {
			type: "error",
			error: { type: ANTHROPIC_TYPE[this.class], message: this.publicMessage },
		};
	}

	static is(value: unknown): value is GatewayError {
		return value instanceof GatewayError;
	}
}
