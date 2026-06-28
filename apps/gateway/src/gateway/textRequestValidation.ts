import type { ResolvedModelMetadata } from "#catalog/types.ts";
import { GatewayError } from "#core/errors.ts";

import type {
	CanonicalChatRequest,
	CanonicalContentPart,
} from "#core/canonical.ts";

function hasPart(
	req: CanonicalChatRequest,
	predicate: (part: CanonicalContentPart) => boolean,
): boolean {
	for (const message of req.messages) {
		if (!Array.isArray(message.content)) continue;
		if (message.content.some(predicate)) return true;
	}
	return false;
}

export function assertTextRequestSupported(
	req: CanonicalChatRequest,
	meta: ResolvedModelMetadata,
): void {
	if (req.tools && req.tools.length > 0 && !meta.capabilities.tools) {
		throw new GatewayError({
			class: "bad_request",
			message: "The selected model does not support tools",
			code: "unsupported_model_capability",
			param: "tools",
		});
	}

	if (
		hasPart(req, (part) => part.type === "image") &&
		!meta.capabilities.vision
	) {
		throw new GatewayError({
			class: "bad_request",
			message: "The selected model does not support vision inputs",
			code: "unsupported_model_capability",
			param: "messages",
		});
	}

	if (
		req.responseFormat?.type === "json_schema" &&
		!meta.capabilities.structuredOutputs
	) {
		throw new GatewayError({
			class: "bad_request",
			message:
				"The selected model does not support JSON Schema structured outputs",
			code: "unsupported_model_capability",
			param: "response_format",
		});
	}

	const requestedEffort = req.reasoning?.effort;
	if (requestedEffort !== undefined) {
		// The model supports reasoning if it declares the feature flag and carries an effective spec.
		const spec = meta.capabilities.reasoning ? meta.reasoning : undefined;

		if (requestedEffort === "none") {
			// Disabling reasoning is only valid if the model allows it. On a mandatory reasoner
			// (canDisable=false, e.g. gemini-3.1-pro-preview) "none" is an invalid parameter for THIS
			// model: it is rejected explicitly instead of silently coercing it to the lowest level. It is
			// agnostic: it depends only on spec.canDisable, not the concrete model/upstream. On a non-reasoner
			// "none" is an allowed no-op (there is nothing to disable).
			if (spec && !spec.canDisable) {
				throw new GatewayError({
					class: "bad_request",
					message:
						'The selected model is a reasoning model and does not support disabling reasoning (effort "none")',
					code: "unsupported_model_capability",
					param: "reasoning.effort",
				});
			}
		} else if (!spec) {
			throw new GatewayError({
				class: "bad_request",
				message: "The selected model does not support reasoning controls",
				code: "unsupported_model_capability",
				param: "reasoning",
			});
		} else if (
			spec.kind === "fixed" &&
			!spec.levels.includes(requestedEffort)
		) {
			throw new GatewayError({
				class: "bad_request",
				message: `The selected model has fixed reasoning and only supports effort "${spec.levels[0] ?? "high"}"`,
				code: "unsupported_model_capability",
				param: "reasoning.effort",
			});
		}
	}
}
