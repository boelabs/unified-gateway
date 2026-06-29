import { EFFORT_ORDER, type ReasoningControlKind } from "#core/reasoning.ts";
import { ADAPTER_KEY_PATTERN, ADAPTER_KEY_RULE } from "#adapters/key.ts";
import type { OperationProfiles } from "#profiles/types.ts";
import type { CatalogEntry } from "./types.ts";
import { readFileSync } from "node:fs";

interface CatalogProviderInfo {
	id: string;
	adapterKey: string;
	name?: string;
	docs?: string[];
	notes?: string;
}

export interface CatalogDocument {
	schemaVersion: 1;
	provider: CatalogProviderInfo;
	models: Record<string, CatalogEntry>;
}

export interface LoadCatalogOptions {
	adapterKey?: string;
}

const OPERATION_IDS = new Set<keyof OperationProfiles>([
	"text.generate",
	"image.generate",
	"image.edit",
	"audio.transcribe",
	"embedding.create",
]);

const REASONING_KINDS = new Set<ReasoningControlKind>([
	"openai_effort",
	"openai_body",
	"anthropic_adaptive",
	"anthropic_budget",
	"gemini_level",
	"gemini_budget",
	"chat_template_flag",
	"fixed",
]);

const MODEL_KEYS = new Set([
	"id",
	"name",
	"family",
	"aliases",
	"openWeights",
	"deprecated",
	"lifecycle",
	"knowledge",
	"modalities",
	"operations",
	"pricing",
	"sources",
	"lastVerifiedAt",
	"notes",
	"metadata",
]);

const LIFECYCLE_STATUSES = new Set([
	"active",
	"preview",
	"deprecated",
	"retired",
	"limited",
]);
const MODALITIES = new Set([
	"text",
	"image",
	"audio",
	"video",
	"pdf",
	"file",
	"embedding",
	"moderation",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(path: string, message: string): never {
	throw new Error(`Invalid JSON catalog at ${path}: ${message}`);
}

function assertString(value: unknown, path: string): asserts value is string {
	if (typeof value !== "string" || value.length === 0)
		fail(path, "must be a non-empty string");
}

function assertAdapterKey(
	value: unknown,
	path: string,
): asserts value is string {
	assertString(value, path);
	if (!ADAPTER_KEY_PATTERN.test(value)) fail(path, ADAPTER_KEY_RULE);
}

function assertNumber(value: unknown, path: string): asserts value is number {
	if (typeof value !== "number" || !Number.isFinite(value))
		fail(path, "must be a finite number");
}

function assertBoolean(value: unknown, path: string): asserts value is boolean {
	if (typeof value !== "boolean") fail(path, "must be a boolean");
}

function assertStringArray(
	value: unknown,
	path: string,
): asserts value is string[] {
	if (!Array.isArray(value)) fail(path, "must be an array");
	for (const [i, item] of value.entries()) assertString(item, `${path}[${i}]`);
}

function validatePricing(value: unknown, path: string): void {
	if (value === undefined) return;
	if (!isRecord(value)) fail(path, "must be an object");
	for (const key of [
		"inputCentsPerMTokens",
		"outputCentsPerMTokens",
		"cacheReadCentsPerMTokens",
		"cacheWriteCentsPerMTokens",
	]) {
		if (value[key] !== undefined) assertNumber(value[key], `${path}.${key}`);
	}
	if (value.tiers !== undefined) {
		if (!Array.isArray(value.tiers)) fail(`${path}.tiers`, "must be an array");
		for (const [i, tier] of value.tiers.entries()) {
			if (!isRecord(tier)) fail(`${path}.tiers[${i}]`, "must be an object");
			assertNumber(
				tier.aboveInputTokens,
				`${path}.tiers[${i}].aboveInputTokens`,
			);
			for (const key of [
				"inputCentsPerMTokens",
				"outputCentsPerMTokens",
				"cacheReadCentsPerMTokens",
				"cacheWriteCentsPerMTokens",
			]) {
				if (tier[key] !== undefined)
					assertNumber(tier[key], `${path}.tiers[${i}].${key}`);
			}
		}
	}
}

function validateCapabilities(value: unknown, path: string): void {
	if (value === undefined) return;
	if (!isRecord(value)) fail(path, "must be an object");
	for (const key of ["tools", "vision", "reasoning", "structuredOutputs"]) {
		if (value[key] !== undefined) assertBoolean(value[key], `${path}.${key}`);
	}
}

function validateReasoning(value: unknown, path: string): void {
	if (value === undefined) return;
	if (!isRecord(value)) fail(path, "must be an object");
	assertString(value.kind, `${path}.kind`);
	if (!REASONING_KINDS.has(value.kind as ReasoningControlKind)) {
		fail(`${path}.kind`, `unknown kind "${value.kind}"`);
	}
	assertStringArray(value.levels, `${path}.levels`);
	for (const level of value.levels) {
		if (!(EFFORT_ORDER as readonly string[]).includes(level))
			fail(`${path}.levels`, `unknown effort "${level}"`);
	}
	if (value.budgets !== undefined) {
		if (!isRecord(value.budgets)) fail(`${path}.budgets`, "must be an object");
		for (const [level, tokens] of Object.entries(value.budgets)) {
			if (!(EFFORT_ORDER as readonly string[]).includes(level))
				fail(`${path}.budgets`, `unknown effort "${level}"`);
			assertNumber(tokens, `${path}.budgets.${level}`);
		}
	}
	if (value.upstreamEffortMap !== undefined) {
		if (!isRecord(value.upstreamEffortMap))
			fail(`${path}.upstreamEffortMap`, "must be an object");
		for (const [level, upstream] of Object.entries(value.upstreamEffortMap)) {
			if (!(EFFORT_ORDER as readonly string[]).includes(level)) {
				fail(`${path}.upstreamEffortMap`, `unknown effort "${level}"`);
			}
			assertString(upstream, `${path}.upstreamEffortMap.${level}`);
		}
	}
	if (value.effortField !== undefined)
		assertString(value.effortField, `${path}.effortField`);
	if (value.bodyField !== undefined) {
		if (!isRecord(value.bodyField))
			fail(`${path}.bodyField`, "must be an object");
		assertString(value.bodyField.param, `${path}.bodyField.param`);
	}
	if (value.chatTemplateFlag !== undefined) {
		if (!isRecord(value.chatTemplateFlag))
			fail(`${path}.chatTemplateFlag`, "must be an object");
		assertString(
			value.chatTemplateFlag.param,
			`${path}.chatTemplateFlag.param`,
		);
	}
	if (value.kind === "openai_body" && value.bodyField === undefined) {
		fail(`${path}.bodyField`, 'is required when kind is "openai_body"');
	}
	if (value.kind !== "openai_body" && value.bodyField !== undefined) {
		fail(`${path}.bodyField`, 'is only allowed when kind is "openai_body"');
	}
	if (value.kind !== "openai_body" && value.effortField !== undefined) {
		fail(`${path}.effortField`, 'is only allowed when kind is "openai_body"');
	}
	if (
		value.kind === "chat_template_flag" &&
		value.chatTemplateFlag === undefined
	) {
		fail(
			`${path}.chatTemplateFlag`,
			'is required when kind is "chat_template_flag"',
		);
	}
	if (
		value.kind !== "chat_template_flag" &&
		value.chatTemplateFlag !== undefined
	) {
		fail(
			`${path}.chatTemplateFlag`,
			'is only allowed when kind is "chat_template_flag"',
		);
	}
}

function validateOperations(value: unknown, path: string): void {
	if (!isRecord(value)) fail(path, "must be an object");
	for (const [operation, profile] of Object.entries(value)) {
		if (!OPERATION_IDS.has(operation as keyof OperationProfiles))
			fail(path, `unknown operation "${operation}"`);
		if (!isRecord(profile)) fail(`${path}.${operation}`, "must be an object");
		if (operation === "text.generate") {
			validateCapabilities(
				profile.capabilities,
				`${path}.${operation}.capabilities`,
			);
			if (profile.maxInputTokens !== undefined)
				assertNumber(
					profile.maxInputTokens,
					`${path}.${operation}.maxInputTokens`,
				);
			if (profile.maxOutputTokens !== undefined)
				assertNumber(
					profile.maxOutputTokens,
					`${path}.${operation}.maxOutputTokens`,
				);
			validateReasoning(profile.reasoning, `${path}.${operation}.reasoning`);
		} else if (operation === "embedding.create") {
			for (const key of [
				"dimensions",
				"minDimensions",
				"maxDimensions",
				"maxInputs",
				"maxInputTokens",
				"maxTotalTokens",
				"maxInputBytes",
				"maxTotalInputBytes",
			]) {
				if (profile[key] !== undefined)
					assertNumber(profile[key], `${path}.${operation}.${key}`);
			}
			for (const key of ["supportsDimensions", "supportsTokenInput"]) {
				if (profile[key] !== undefined)
					assertBoolean(profile[key], `${path}.${operation}.${key}`);
			}
			if (profile.encodingFormats !== undefined) {
				assertStringArray(
					profile.encodingFormats,
					`${path}.${operation}.encodingFormats`,
				);
				for (const format of profile.encodingFormats) {
					if (format !== "float" && format !== "base64")
						fail(
							`${path}.${operation}.encodingFormats`,
							`unknown format "${format}"`,
						);
				}
			}
		}
	}
}

function validateLifecycle(value: unknown, path: string): void {
	if (value === undefined) return;
	if (!isRecord(value)) fail(path, "must be an object");
	if (value.status !== undefined) {
		assertString(value.status, `${path}.status`);
		if (!LIFECYCLE_STATUSES.has(value.status))
			fail(`${path}.status`, `unknown status "${value.status}"`);
	}
	for (const key of [
		"releaseDate",
		"lastUpdated",
		"deprecationDate",
		"retirementDate",
	]) {
		if (value[key] !== undefined) assertString(value[key], `${path}.${key}`);
	}
}

function validateModalities(value: unknown, path: string): void {
	if (value === undefined) return;
	if (!isRecord(value)) fail(path, "must be an object");
	for (const key of ["input", "output"]) {
		if (value[key] === undefined) continue;
		assertStringArray(value[key], `${path}.${key}`);
		for (const modality of value[key]) {
			if (!MODALITIES.has(modality))
				fail(`${path}.${key}`, `unknown modality "${modality}"`);
		}
	}
}

function validateModelMetadata(
	model: Record<string, unknown>,
	path: string,
): void {
	for (const key of Object.keys(model)) {
		if (!MODEL_KEYS.has(key)) fail(path, `unknown field "${key}"`);
	}
	for (const key of [
		"id",
		"name",
		"family",
		"knowledge",
		"lastVerifiedAt",
		"notes",
	]) {
		if (model[key] !== undefined) assertString(model[key], `${path}.${key}`);
	}
	if (model.aliases !== undefined)
		assertStringArray(model.aliases, `${path}.aliases`);
	if (model.openWeights !== undefined)
		assertBoolean(model.openWeights, `${path}.openWeights`);
	validateLifecycle(model.lifecycle, `${path}.lifecycle`);
	validateModalities(model.modalities, `${path}.modalities`);
	if (model.sources !== undefined)
		assertStringArray(model.sources, `${path}.sources`);
	if (model.metadata !== undefined && !isRecord(model.metadata))
		fail(`${path}.metadata`, "must be an object");
}

function validateDocument(
	value: unknown,
	path: string,
	opts: LoadCatalogOptions,
): asserts value is CatalogDocument {
	if (!isRecord(value)) fail(path, "the root must be an object");
	if (value.schemaVersion !== 1) fail(`${path}.schemaVersion`, "must be 1");
	if (!isRecord(value.provider)) fail(`${path}.provider`, "must be an object");
	assertString(value.provider.id, `${path}.provider.id`);
	assertAdapterKey(value.provider.adapterKey, `${path}.provider.adapterKey`);
	if (
		opts.adapterKey !== undefined &&
		value.provider.adapterKey !== opts.adapterKey
	) {
		fail(
			`${path}.provider.adapterKey`,
			`expected "${opts.adapterKey}", received "${value.provider.adapterKey}"`,
		);
	}
	if (value.provider.name !== undefined)
		assertString(value.provider.name, `${path}.provider.name`);
	if (value.provider.docs !== undefined)
		assertStringArray(value.provider.docs, `${path}.provider.docs`);
	if (!isRecord(value.models))
		fail(`${path}.models`, "must be an object keyed by model id");
	for (const [modelId, model] of Object.entries(value.models)) {
		if (!isRecord(model))
			fail(`${path}.models.${modelId}`, "must be an object");
		validateModelMetadata(model, `${path}.models.${modelId}`);
		if (model.id !== undefined && model.id !== modelId) {
			fail(
				`${path}.models.${modelId}.id`,
				`if declared, it must match key "${modelId}"`,
			);
		}
		validateOperations(
			model.operations,
			`${path}.models.${modelId}.operations`,
		);
		validatePricing(model.pricing, `${path}.models.${modelId}.pricing`);
		if (model.deprecated !== undefined)
			assertBoolean(model.deprecated, `${path}.models.${modelId}.deprecated`);
	}
}

export function loadCatalogDocument(
	url: URL,
	opts: LoadCatalogOptions = {},
): CatalogDocument {
	const path = url.pathname;
	const parsed = JSON.parse(readFileSync(url, "utf8")) as unknown;
	validateDocument(parsed, path, opts);
	return parsed;
}

export function loadProviderCatalog(
	url: URL,
	opts: LoadCatalogOptions = {},
): Record<string, CatalogEntry> {
	return loadCatalogDocument(url, opts).models;
}
