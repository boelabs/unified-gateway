import type { TextCapabilities, ReasoningSpec } from "#core/reasoning.ts";
import type { OperationProfiles } from "#profiles/types.ts";
import type { EmbeddingProfile } from "#core/embeddings.ts";
import type { TranscriptionProfile } from "#core/audio.ts";
import type { RuntimeModelMetadata } from "#db/schema.ts";
import type { ImageModelProfile } from "#core/images.ts";
import type { CallType } from "#core/callType.ts";

/**
 * Catalog entry for known models. Lives in CODE (like the adapters) and describes what a model can do
 * DECLARATIVELY AND PER OPERATION: `operations` maps each operation (text.generate, image.generate,
 * audio.transcribe, ...) to its profile (capabilities, limits, reasoning control, image restrictions...).
 * Same shape as the operator's override in the DB (`model_deployments.catalogEntry` for custom), so a
 * model of any modality is declared the same way.
 * The DB pricing can override these defaults (see resolveModelMetadata).
 */
export interface CatalogEntry {
	/** Optional: if declared in JSON it must match the key of the `models` map. */
	id?: string;
	name?: string;
	family?: string;
	aliases?: string[];
	openWeights?: boolean;
	knowledge?: string;
	lifecycle?: {
		status?: "active" | "preview" | "deprecated" | "retired" | "limited";
		releaseDate?: string;
		lastUpdated?: string;
		deprecationDate?: string;
		retirementDate?: string;
	};
	modalities?: {
		input?: Array<
			| "text"
			| "image"
			| "audio"
			| "video"
			| "pdf"
			| "file"
			| "embedding"
			| "moderation"
		>;
		output?: Array<
			| "text"
			| "image"
			| "audio"
			| "video"
			| "pdf"
			| "file"
			| "embedding"
			| "moderation"
		>;
	};
	sources?: string[];
	lastVerifiedAt?: string;
	notes?: string;
	metadata?: Record<string, unknown>;
	operations: OperationProfiles;
	pricing?: RuntimeModelMetadata["pricing"];
	/** Flagged as not recommended (does not affect behavior). */
	deprecated?: boolean;
}

/**
 * Resolved metadata of a deployment: catalog or custom CatalogEntry, plus the operator's pricing.
 * They travel via AdapterContext and feed validation, adapters, and cost calculation.
 */
export interface ResolvedModelMetadata {
	capabilities: TextCapabilities;
	supportedCallTypes?: CallType[];
	image?: ImageModelProfile;
	embedding?: EmbeddingProfile;
	operations?: OperationProfiles;
	pricing?: RuntimeModelMetadata["pricing"];
	maxInputTokens?: number;
	maxOutputTokens?: number;
	reasoning?: ReasoningSpec;
}

export function imageProfileFor(
	meta: ResolvedModelMetadata,
	operation: "generation" | "edit",
): ImageModelProfile | undefined {
	const operationId =
		operation === "generation" ? "image.generate" : "image.edit";
	return (
		(meta.operations?.[operationId] as ImageModelProfile | undefined) ??
		meta.image
	);
}

export function transcriptionProfileFor(
	meta: ResolvedModelMetadata,
): TranscriptionProfile | undefined {
	return meta.operations?.["audio.transcribe"] as
		| TranscriptionProfile
		| undefined;
}

export function embeddingProfileFor(
	meta: ResolvedModelMetadata,
): EmbeddingProfile | undefined {
	return (
		(meta.operations?.["embedding.create"] as EmbeddingProfile | undefined) ??
		meta.embedding
	);
}
