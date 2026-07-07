import type { CanonicalChatRequest } from "#core/canonical.ts";
import { log as appLog } from "#logging/log.ts";
import type { Auth } from "#auth/types.ts";

import {
	hydrateCanonicalToolCallOpaqueState,
	type OpaqueToolCallStateMap,
} from "#core/opaqueToolState.ts";

import {
	findInternalResponseItemByIdForScope,
	storeResponseState,
} from "#db/repos/responseStates.ts";

function authVirtualKeyId(auth: Auth): string | null {
	return auth.type === "virtual" ? auth.key.id : null;
}

export function newOpaqueToolCallStateMap(): OpaqueToolCallStateMap {
	return new Map();
}

export async function hydrateRequestOpaqueToolState(
	req: CanonicalChatRequest,
	auth: Auth,
): Promise<CanonicalChatRequest> {
	const virtualKeyId = authVirtualKeyId(auth);
	return hydrateCanonicalToolCallOpaqueState(req, (id) =>
		findInternalResponseItemByIdForScope(id, virtualKeyId),
	);
}

export async function persistOpaqueToolStateBestEffort(opts: {
	auth: Auth;
	id: string;
	publicModel: string;
	deploymentId: string | null;
	adapterKey: string | null;
	requestId: string;
	output: Record<string, unknown>[];
	metadata?: Record<string, unknown>;
}): Promise<void> {
	if (opts.output.length === 0) return;
	try {
		await storeResponseState({
			id: opts.id,
			virtualKeyId: authVirtualKeyId(opts.auth),
			publicModel: opts.publicModel,
			deploymentId: opts.deploymentId,
			adapterKey: opts.adapterKey,
			previousResponseId: null,
			store: false,
			requestInput: [],
			output: opts.output,
			response: { id: opts.id, object: "opaque_tool_state", store: false },
			metadata: {
				requestId: opts.requestId,
				internalOnly: true,
				...(opts.metadata ?? {}),
			},
		});
	} catch (err) {
		appLog.error("opaque-tool-state", "failed to persist opaque tool state", {
			err,
		});
	}
}
