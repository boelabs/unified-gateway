import { listPublicModels } from "#db/repos/deployments.ts";
import { GatewayError } from "#core/errors.ts";
import { getAuth } from "#auth/middleware.ts";
import type { AppEnv } from "#auth/types.ts";
import type { Context } from "hono";

/**
 * GET /v1/models - lists the public models visible to the key (OpenAI contract:
 * { object: "list", data: [{ id, object, created, owned_by }] }). Respects the virtual key's scope
 * (allowedModels[]); master sees all.
 */
function visiblePublicModels(
	auth: ReturnType<typeof getAuth>,
	publicModels: Array<{ name: string; createdAt: Date }>,
): Array<{ name: string; createdAt: Date }> {
	if (auth.type === "virtual" && auth.key.allowedModels.length > 0) {
		const allowed = new Set(auth.key.allowedModels);
		return publicModels.filter((model) => allowed.has(model.name));
	}
	return publicModels;
}

function toModelObject(publicModel: { name: string; createdAt: Date }) {
	return {
		id: publicModel.name,
		object: "model" as const,
		created: Math.floor(publicModel.createdAt.getTime() / 1000),
		owned_by: "Boelabs",
	};
}

export async function listModelsHandler(c: Context<AppEnv>): Promise<Response> {
	const publicModels = visiblePublicModels(
		getAuth(c),
		await listPublicModels(),
	);
	return c.json({ object: "list", data: publicModels.map(toModelObject) });
}

export async function retrieveModelHandler(
	c: Context<AppEnv>,
): Promise<Response> {
	const id = c.req.param("model");
	const publicModel = visiblePublicModels(
		getAuth(c),
		await listPublicModels(),
	).find((model) => model.name === id);
	if (!publicModel) {
		throw new GatewayError({
			class: "not_found",
			message: `Model "${id}" not found`,
			code: "model_not_found",
		});
	}
	return c.json(toModelObject(publicModel));
}
