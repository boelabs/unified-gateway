import { listActiveArtifactsWithCode } from "#db/repos/extensions.ts";
import type { ExtensionInstanceSource } from "./runtime.ts";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { listInstances } from "#db/repos/extensions.ts";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";

const EXTENSION_KEY_PATTERN = /^[a-z0-9]+$/;

/**
 * On-disk cache for materialized extension modules. It MUST live inside the gateway package so the
 * `#extensions/sdk.ts` subpath import that modules use resolves against this package's `imports` map.
 * Files are content-addressed (`<key>-<sha256>.mjs`), which both busts the ESM module cache when code
 * changes and lets a replica skip re-downloading a version it already has.
 */
export const EXTENSIONS_CACHE_DIR = resolve(
	import.meta.dirname,
	"..",
	"..",
	".extensions-cache",
);

export function sha256Hex(source: string): string {
	return createHash("sha256").update(source, "utf8").digest("hex");
}

function cacheFileFor(key: string, contentHash: string): string {
	return join(EXTENSIONS_CACHE_DIR, `${key}-${contentHash}.mjs`);
}

/**
 * Ensures the module source is present on disk at its content-addressed path, writing it atomically
 * (temp file + rename) if missing. Returns the absolute path to import.
 */
async function materialize(
	key: string,
	contentHash: string,
	code: string,
): Promise<string> {
	const file = cacheFileFor(key, contentHash);
	if (existsSync(file)) return file;
	await mkdir(dirname(file), { recursive: true });
	const tmp = `${file}.${randomUUID()}.tmp`;
	await writeFile(tmp, code, "utf8");
	await rename(tmp, file);
	return file;
}

interface ProbeResult {
	contentHash: string;
	sizeBytes: number;
}

/**
 * Validates uploaded module source before it is persisted: it stages the file (so the SDK subpath
 * import resolves), imports it, and asserts it exports a definition whose `key` matches. Importing
 * executes the module's top-level code — extensions are trusted, master-only code by design. Throws a
 * plain Error (the admin layer maps it to a 400) on any failure, so a bad upload never reaches the
 * database or the boot path.
 */
export async function probeArtifact(
	key: string,
	code: string,
): Promise<ProbeResult> {
	if (!EXTENSION_KEY_PATTERN.test(key))
		throw new Error(`Invalid extension key "${key}"`);
	const contentHash = sha256Hex(code);
	const file = await materialize(key, contentHash, code);

	let namespace: Record<string, unknown>;
	try {
		namespace = (await import(pathToFileURL(file).href)) as Record<
			string,
			unknown
		>;
	} catch (err) {
		throw new Error(
			`Module failed to import: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	const definition = namespace.default ?? namespace.extension;
	if (
		typeof definition !== "object" ||
		definition === null ||
		typeof (definition as { key?: unknown }).key !== "string" ||
		typeof (definition as { hooks?: unknown }).hooks !== "object" ||
		(definition as { hooks?: unknown }).hooks === null
	) {
		throw new Error("Module must export a valid extension definition");
	}
	if ((definition as { key: string }).key !== key) {
		throw new Error(
			`Module exports key "${(definition as { key: string }).key}" but was uploaded as "${key}"`,
		);
	}
	return { contentHash, sizeBytes: Buffer.byteLength(code, "utf8") };
}

/**
 * Loads the manifest from the database: active artifacts become materialized modules, instances become
 * manifest entries. Implements the source contract the runtime already consumes.
 */
export class DbExtensionInstanceSource implements ExtensionInstanceSource {
	async load() {
		const [artifacts, instances] = await Promise.all([
			listActiveArtifactsWithCode(),
			listInstances(),
		]);

		const modules: Array<{ path: string }> = [];
		for (const artifact of artifacts) {
			const actual = sha256Hex(artifact.code);
			if (actual !== artifact.contentHash) {
				throw new Error(
					`Extension artifact "${artifact.key}" v${artifact.version} failed integrity check`,
				);
			}
			const path = await materialize(
				artifact.key,
				artifact.contentHash,
				artifact.code,
			);
			modules.push({ path });
		}

		return {
			modules,
			instances: instances.map((row) => ({
				id: row.id,
				definition: row.definitionKey,
				enabled: row.enabled,
				priority: row.priority,
				...(row.critical !== null ? { critical: row.critical } : {}),
				match: row.match,
				config: row.config,
			})),
		};
	}
}
