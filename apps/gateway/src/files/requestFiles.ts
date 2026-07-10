import type { DeploymentCandidate } from "#gateway/deploymentCandidates.ts";
import type { FileInputTransportSupport } from "#adapters/types.ts";
import type { UpstreamTransport } from "#core/transport.ts";
import { GatewayError } from "#core/errors.ts";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import type {
	CanonicalContentPart,
	CanonicalChatRequest,
	CanonicalFilePart,
	PdfParserEngine,
} from "#core/canonical.ts";

const MAX_INLINE_FILE_BYTES = 50_000_000;
const MAX_PORTABLE_FILE_BYTES = 20_000_000;
const MAX_TOTAL_BYTES = 50_000_000;
const MAX_TEXT_CHARACTERS = 2_000_000;
const MAX_PDF_PAGES = 200;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
	".bat": "text/x-bat",
	".conf": "text/plain",
	".csv": "text/csv",
	".css": "text/css",
	".eml": "message/rfc822",
	".html": "text/html",
	".htm": "text/html",
	".js": "text/javascript",
	".json": "application/json",
	".jsx": "text/jsx",
	".log": "text/plain",
	".md": "text/markdown",
	".pdf": "application/pdf",
	".py": "text/x-python",
	".sh": "text/x-shellscript",
	".sql": "application/x-sql",
	".srt": "text/srt",
	".toml": "application/toml",
	".ts": "text/typescript",
	".tsx": "text/tsx",
	".txt": "text/plain",
	".vtt": "text/vtt",
	".xml": "application/xml",
	".yaml": "application/yaml",
	".yml": "application/yaml",
};

const PORTABLE_APPLICATION_MIME_TYPES = new Set([
	"application/csv",
	"application/graphql",
	"application/javascript",
	"application/json5",
	"application/toml",
	"application/typescript",
	"application/x-bash",
	"application/x-httpd-php",
	"application/x-httpd-php-source",
	"application/x-json5",
	"application/x-ndjson",
	"application/x-patch",
	"application/x-powershell",
	"application/x-sql",
	"application/x-toml",
	"application/x-yaml",
	"message/rfc822",
]);

type ResolveHostname = (
	hostname: string,
) => Promise<readonly { address: string; family: number }[]>;

interface ResolverDependencies {
	fetch: typeof fetch;
	resolveHostname: ResolveHostname;
}

interface MaterializedFile {
	bytes: Uint8Array;
	dataUrl: string;
	filename?: string;
	mimeType: string;
}

interface FileSource {
	kind: "file_id" | "file_url" | "file_data";
	value: string;
}

export interface FileResolutionMetadata {
	engine: PdfParserEngine;
	materializedUrls: number;
	nativeFiles: number;
	parsedFiles: number;
}

export interface ResolvedFileRequest {
	request: CanonicalChatRequest;
	metadata?: FileResolutionMetadata;
}

const DEFAULT_DEPENDENCIES: ResolverDependencies = {
	fetch: ((...args: Parameters<typeof fetch>) =>
		globalThis.fetch(...args)) as typeof fetch,
	resolveHostname: async (hostname) =>
		lookup(hostname, { all: true, verbatim: true }),
};

function requestError(
	message: string,
	code: string,
	publicMessage: string,
): GatewayError {
	return new GatewayError({
		class: "bad_request",
		code,
		param: "messages",
		message,
		publicMessage,
		routingScope: "request",
	});
}

function fileSource(part: CanonicalFilePart): FileSource {
	const present: Array<[FileSource["kind"], string]> = [];
	if (part.fileId !== undefined) present.push(["file_id", part.fileId]);
	if (part.fileUrl !== undefined) present.push(["file_url", part.fileUrl]);
	if (part.fileData !== undefined) present.push(["file_data", part.fileData]);
	if (present.length !== 1) {
		throw requestError(
			`File input must contain exactly one source; received ${present.length}`,
			"invalid_file_source",
			"Each file input must contain exactly one of file_id, file_url, or file_data.",
		);
	}
	const [kind, value] = present[0]!;
	if (value.length === 0) {
		throw requestError(
			"File input source is empty",
			"invalid_file_source",
			"File input sources cannot be empty.",
		);
	}
	if (kind === "file_data" && /^https:\/\//i.test(value)) {
		return { kind: "file_url", value };
	}
	return { kind, value };
}

function fileParts(req: CanonicalChatRequest): CanonicalFilePart[] {
	const parts: CanonicalFilePart[] = [];
	for (const message of req.messages) {
		if (!Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (part.type === "file") parts.push(part);
		}
	}
	return parts;
}

export function hasFileInputs(req: CanonicalChatRequest): boolean {
	return fileParts(req).length > 0;
}

function normalizedMimeType(
	value: string | null | undefined,
): string | undefined {
	const mime = value?.split(";", 1)[0]?.trim().toLowerCase();
	return mime && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime)
		? mime
		: undefined;
}

function extensionMime(value: string | undefined): string | undefined {
	if (!value) return undefined;
	let pathname = value;
	try {
		pathname = new URL(value).pathname;
	} catch {
		// A filename is already a valid lookup input.
	}
	const dot = pathname.lastIndexOf(".");
	if (dot < 0) return undefined;
	return MIME_BY_EXTENSION[pathname.slice(dot).toLowerCase()];
}

function dataUrlMime(value: string): string | undefined {
	return normalizedMimeType(/^data:([^;,]+)/i.exec(value)?.[1]);
}

function hintedMimeType(part: CanonicalFilePart): string | undefined {
	const source = fileSource(part);
	return (
		(source.kind === "file_data" ? dataUrlMime(source.value) : undefined) ??
		extensionMime(part.filename) ??
		(source.kind === "file_url" ? extensionMime(source.value) : undefined)
	);
}

function isBlockedHostname(hostname: string): boolean {
	const normalized = hostname.toLowerCase().replace(/\.$/, "");
	return (
		normalized === "localhost" ||
		normalized.endsWith(".localhost") ||
		normalized.endsWith(".local") ||
		normalized.endsWith(".internal")
	);
}

function parseSafeHttpsUrl(value: string): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw requestError(
			`Invalid file URL: ${value}`,
			"invalid_file_url",
			"file_url must be a valid public HTTPS URL.",
		);
	}
	const literalHost =
		url.hostname.startsWith("[") && url.hostname.endsWith("]")
			? url.hostname.slice(1, -1)
			: url.hostname;
	if (
		url.protocol !== "https:" ||
		url.username !== "" ||
		url.password !== "" ||
		url.hash !== "" ||
		isBlockedHostname(url.hostname) ||
		(isIP(literalHost) !== 0 && isBlockedAddress(literalHost))
	) {
		throw requestError(
			`Unsafe file URL: ${url.href}`,
			"unsafe_file_url",
			"file_url must be a public HTTPS URL without credentials or a fragment.",
		);
	}
	return url;
}

function isBlockedIpv4(address: string): boolean {
	const octets = address.split(".").map(Number);
	if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value)))
		return true;
	const [a, b, c] = octets as [number, number, number, number];
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 0 && (c === 0 || c === 2)) ||
		(a === 192 && b === 168) ||
		(a === 192 && b === 88 && c === 99) ||
		(a === 198 && (b === 18 || b === 19)) ||
		(a === 198 && b === 51 && c === 100) ||
		(a === 203 && b === 0 && c === 113) ||
		a >= 224
	);
}

function ipv6Words(address: string): number[] | null {
	let normalized = address.toLowerCase().split("%", 1)[0]!;
	if (normalized.startsWith("[") && normalized.endsWith("]"))
		normalized = normalized.slice(1, -1);
	if (normalized.includes(".")) return null;
	const halves = normalized.split("::");
	if (halves.length > 2) return null;
	const left = halves[0] ? halves[0].split(":") : [];
	const right = halves[1] ? halves[1].split(":") : [];
	const missing = 8 - left.length - right.length;
	if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
	const words = [
		...left,
		...Array.from({ length: missing }, () => "0"),
		...right,
	].map((word) => Number.parseInt(word, 16));
	if (
		words.length !== 8 ||
		words.some((word) => !Number.isInteger(word) || word < 0 || word > 0xffff)
	)
		return null;
	return words;
}

function isBlockedIpv6(address: string): boolean {
	const words = ipv6Words(address);
	if (!words) return true;
	const first = words[0]!;
	const allZeroPrefix = words.slice(0, 7).every((word) => word === 0);
	return (
		(allZeroPrefix && (words[7] === 0 || words[7] === 1)) ||
		(words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) ||
		(first & 0xfe00) === 0xfc00 ||
		(first & 0xffc0) === 0xfe80 ||
		(first & 0xffc0) === 0xfec0 ||
		(first & 0xff00) === 0xff00 ||
		(first === 0x2001 && words[1] === 0x0db8) ||
		(first === 0x2001 && (words[1]! & 0xfff0) === 0x0010)
	);
}

function isBlockedAddress(address: string): boolean {
	const normalized =
		address.startsWith("[") && address.endsWith("]")
			? address.slice(1, -1)
			: address;
	const family = isIP(normalized);
	if (family === 0) return true;
	return family === 4 ? isBlockedIpv4(normalized) : isBlockedIpv6(normalized);
}

async function assertPublicUrl(
	value: string,
	resolveHostname: ResolveHostname,
): Promise<URL> {
	const url = parseSafeHttpsUrl(value);

	const literalHost =
		url.hostname.startsWith("[") && url.hostname.endsWith("]")
			? url.hostname.slice(1, -1)
			: url.hostname;
	const literalFamily = isIP(literalHost);
	const addresses = literalFamily
		? [{ address: literalHost, family: literalFamily }]
		: await resolveHostname(url.hostname).catch((cause: unknown) => {
				throw requestError(
					`Could not resolve file URL hostname ${url.hostname}: ${String(cause)}`,
					"file_fetch_failed",
					"The file URL hostname could not be resolved.",
				);
			});
	if (
		addresses.length === 0 ||
		addresses.some(({ address }) => isBlockedAddress(address))
	) {
		throw requestError(
			`File URL resolved to a non-public address: ${url.hostname}`,
			"unsafe_file_url",
			"file_url must resolve only to public network addresses.",
		);
	}
	return url;
}

function filenameFromUrl(url: URL): string | undefined {
	const segment = url.pathname.split("/").filter(Boolean).at(-1);
	if (!segment) return undefined;
	try {
		return decodeURIComponent(segment);
	} catch {
		return segment;
	}
}

function effectiveMimeType(
	declared: string | undefined,
	filename: string | undefined,
	bytes: Uint8Array,
): string {
	if (Buffer.from(bytes.subarray(0, 1_024)).indexOf("%PDF-", 0, "ascii") >= 0)
		return "application/pdf";
	if (declared === undefined || declared === "application/octet-stream")
		return extensionMime(filename) ?? declared ?? "application/octet-stream";
	return declared;
}

async function readLimitedBody(response: Response): Promise<Uint8Array> {
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > MAX_PORTABLE_FILE_BYTES) {
		throw requestError(
			`Remote file declares ${declared} bytes, above the ${MAX_PORTABLE_FILE_BYTES} byte limit`,
			"file_too_large",
			"The file is too large for portable processing.",
		);
	}
	if (!response.body) return new Uint8Array();

	const chunks: Uint8Array[] = [];
	let total = 0;
	const reader = response.body.getReader();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > MAX_PORTABLE_FILE_BYTES) {
				await reader.cancel();
				throw requestError(
					`Remote file exceeded the ${MAX_PORTABLE_FILE_BYTES} byte limit`,
					"file_too_large",
					"The file is too large for portable processing.",
				);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

async function fetchFile(
	value: string,
	signal: AbortSignal,
	dependencies: ResolverDependencies,
): Promise<MaterializedFile> {
	let current = value;
	for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
		const url = await assertPublicUrl(current, dependencies.resolveHostname);
		let response: Response;
		try {
			response = await dependencies.fetch(url, {
				method: "GET",
				redirect: "manual",
				signal: AbortSignal.any([
					signal,
					AbortSignal.timeout(FETCH_TIMEOUT_MS),
				]),
				headers: {
					accept: "application/pdf, text/*, application/json, */*;q=0.1",
				},
			});
		} catch (cause) {
			throw requestError(
				`Could not fetch file URL ${url.href}: ${String(cause)}`,
				"file_fetch_failed",
				"The file URL could not be fetched.",
			);
		}

		if ([301, 302, 303, 307, 308].includes(response.status)) {
			const location = response.headers.get("location");
			if (!location || redirects === MAX_REDIRECTS) {
				throw requestError(
					`File URL exceeded ${MAX_REDIRECTS} redirects`,
					"file_fetch_failed",
					"The file URL has too many redirects.",
				);
			}
			await response.body?.cancel();
			current = new URL(location, url).href;
			continue;
		}
		if (!response.ok) {
			await response.body?.cancel();
			throw requestError(
				`File URL returned HTTP ${response.status}`,
				"file_fetch_failed",
				"The file URL could not be fetched.",
			);
		}

		const bytes = await readLimitedBody(response);
		if (bytes.byteLength === 0) {
			throw requestError(
				"Remote file is empty",
				"invalid_file_data",
				"The remote file cannot be empty.",
			);
		}
		const filename = filenameFromUrl(url);
		const mimeType = effectiveMimeType(
			normalizedMimeType(response.headers.get("content-type")),
			filename,
			bytes,
		);
		return {
			bytes,
			dataUrl: `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`,
			...(filename !== undefined ? { filename } : {}),
			mimeType,
		};
	}
	throw new Error("unreachable");
}

function decodeDataUrl(value: string, filename?: string): MaterializedFile {
	const match =
		/^data:([^;,]+)(?:;charset=[^;,]+)?;base64,([a-z0-9+/]*={0,2})$/i.exec(
			value,
		);
	if (!match) {
		throw requestError(
			"file_data is not a valid base64 data URL",
			"invalid_file_data",
			"file_data must be a valid base64 data URL.",
		);
	}
	const mimeType = normalizedMimeType(match[1]);
	if (!mimeType) {
		throw requestError(
			`Invalid file_data MIME type: ${String(match[1])}`,
			"invalid_file_data",
			"file_data must include a valid MIME type.",
		);
	}
	const encoded = match[2]!;
	if (encoded.length % 4 !== 0) {
		throw requestError(
			"file_data base64 has invalid padding",
			"invalid_file_data",
			"file_data must contain valid padded base64.",
		);
	}
	const bytes = Uint8Array.from(Buffer.from(encoded, "base64"));
	if (bytes.byteLength === 0) {
		throw requestError(
			"file_data is empty",
			"invalid_file_data",
			"file_data cannot be empty.",
		);
	}
	if (
		Buffer.from(bytes).toString("base64").replace(/=+$/, "") !==
		encoded.replace(/=+$/, "")
	) {
		throw requestError(
			"file_data base64 is not canonical",
			"invalid_file_data",
			"file_data must contain valid base64.",
		);
	}
	if (bytes.byteLength > MAX_INLINE_FILE_BYTES) {
		throw requestError(
			`Inline file contains ${bytes.byteLength} bytes, above the ${MAX_INLINE_FILE_BYTES} byte limit`,
			"file_too_large",
			"The file is too large for portable processing.",
		);
	}
	return {
		bytes,
		dataUrl: value,
		...(filename !== undefined ? { filename } : {}),
		mimeType: effectiveMimeType(mimeType, filename, bytes),
	};
}

function mimeMatches(
	mimeType: string | undefined,
	patterns: readonly string[] | undefined,
): boolean {
	if (mimeType === undefined || patterns === undefined) return true;
	return patterns.some((pattern) => {
		if (pattern.endsWith("/*"))
			return mimeType.startsWith(pattern.slice(0, -1));
		return mimeType === pattern;
	});
}

function modelAllowsNativeFile(
	candidate: DeploymentCandidate,
	mimeType: string | undefined,
): boolean {
	const inputs =
		candidate.meta.operations?.["text.generate"]?.modalities?.input;
	if (inputs === undefined)
		return mimeType !== "application/pdf" || candidate.meta.capabilities.vision;
	return mimeType === "application/pdf"
		? inputs.includes("pdf") || inputs.includes("file")
		: inputs.includes("file");
}

function canUseNative(
	part: CanonicalFilePart,
	candidate: DeploymentCandidate,
	support: FileInputTransportSupport | undefined,
	mimeType = hintedMimeType(part),
): boolean {
	if (
		support === undefined ||
		!mimeMatches(mimeType, support.mimeTypes) ||
		!modelAllowsNativeFile(candidate, mimeType)
	)
		return false;
	const source = fileSource(part);
	if (support.sources.includes(source.kind)) return true;
	return source.kind === "file_url" && support.sources.includes("file_data");
}

function isPortableTextMime(mimeType: string): boolean {
	return (
		mimeType.startsWith("text/") ||
		mimeType === "application/json" ||
		mimeType.endsWith("+json") ||
		mimeType === "application/xml" ||
		mimeType.endsWith("+xml") ||
		mimeType === "application/yaml" ||
		PORTABLE_APPLICATION_MIME_TYPES.has(mimeType)
	);
}

function assertPdfSignature(file: MaterializedFile): void {
	if (
		file.mimeType === "application/pdf" &&
		Buffer.from(file.bytes.subarray(0, 1_024)).indexOf("%PDF-", 0, "ascii") < 0
	) {
		throw requestError(
			"A file declared as application/pdf does not have a PDF signature",
			"file_type_mismatch",
			"The file content does not match its declared PDF type.",
		);
	}
}

async function extractPortableText(file: MaterializedFile): Promise<string> {
	if (file.bytes.byteLength > MAX_PORTABLE_FILE_BYTES) {
		throw requestError(
			`File contains ${file.bytes.byteLength} bytes, above the ${MAX_PORTABLE_FILE_BYTES} byte parser limit`,
			"file_too_large",
			"The file is too large for portable text extraction.",
		);
	}
	assertPdfSignature(file);
	let text: string;
	if (file.mimeType === "application/pdf") {
		let result: { totalPages: number; text: string };
		try {
			const { getDocumentProxy, extractText } = await import("unpdf");
			const document = await getDocumentProxy(file.bytes);
			try {
				if (document.numPages > MAX_PDF_PAGES) {
					throw requestError(
						`PDF has ${document.numPages} pages, above the ${MAX_PDF_PAGES} page parser limit`,
						"file_too_large",
						"The PDF has too many pages for portable text extraction.",
					);
				}
				result = await extractText(document, { mergePages: true });
			} finally {
				await document.destroy().catch(() => undefined);
			}
		} catch (cause) {
			if (GatewayError.is(cause)) throw cause;
			throw requestError(
				`PDF text extraction failed: ${String(cause)}`,
				"file_parser_failed",
				"The PDF could not be parsed as text. Use a native document-capable model for this file.",
			);
		}
		text = result.text;
		if (text.trim().length === 0) {
			throw requestError(
				"PDF text extraction returned no text",
				"file_parser_no_text",
				"The PDF contains no extractable text. Use a native or OCR-capable engine.",
			);
		}
	} else if (isPortableTextMime(file.mimeType)) {
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
		} catch (cause) {
			throw requestError(
				`Text file is not valid UTF-8: ${String(cause)}`,
				"file_parser_failed",
				"Portable text files must use UTF-8 encoding.",
			);
		}
	} else {
		throw requestError(
			`No portable parser is available for ${file.mimeType}`,
			"unsupported_file_type",
			`No portable parser is available for ${file.mimeType}. Use a native file-capable model.`,
		);
	}
	if (text.length > MAX_TEXT_CHARACTERS) {
		throw requestError(
			`Parsed file contains ${text.length} characters, above the ${MAX_TEXT_CHARACTERS} character limit`,
			"file_too_large",
			"The extracted file text is too large for portable processing.",
		);
	}
	return text;
}

function portableTextPart(
	part: CanonicalFilePart,
	file: MaterializedFile,
	text: string,
): CanonicalContentPart {
	const filename = part.filename ?? file.filename ?? "attachment";
	return {
		type: "text",
		text: `[Attached file: ${JSON.stringify(filename)}; type=${file.mimeType}]\n${text}\n[End attached file]`,
		...(part.cacheControl !== undefined
			? { cacheControl: part.cacheControl }
			: {}),
	};
}

export class FileInputResolver {
	readonly #request: CanonicalChatRequest;
	readonly #signal: AbortSignal;
	readonly #dependencies: ResolverDependencies;
	readonly #files: CanonicalFilePart[];
	readonly #engine: PdfParserEngine;
	readonly #materialized = new WeakMap<
		CanonicalFilePart,
		Promise<MaterializedFile>
	>();
	readonly #materializedBySource = new Map<string, Promise<MaterializedFile>>();
	readonly #parsedText = new WeakMap<MaterializedFile, Promise<string>>();
	readonly #accounted = new WeakSet<CanonicalFilePart>();
	#totalBytes = 0;

	constructor(
		request: CanonicalChatRequest,
		signal: AbortSignal,
		dependencies: ResolverDependencies = DEFAULT_DEPENDENCIES,
	) {
		this.#request = request;
		this.#signal = signal;
		this.#dependencies = dependencies;
		this.#files = fileParts(request);
		this.#engine = request.fileParser?.pdfEngine ?? "auto";
		for (const part of this.#files) {
			const source = fileSource(part);
			if (source.kind === "file_url") parseSafeHttpsUrl(source.value);
		}
	}

	get hasFiles(): boolean {
		return this.#files.length > 0;
	}

	assertCandidate(
		candidate: DeploymentCandidate,
		transport: UpstreamTransport,
	): void {
		const support = candidate.adapter.fileInputs?.[transport];
		for (const part of this.#files) {
			const source = fileSource(part);
			const native = canUseNative(part, candidate, support);
			if (source.kind === "file_id" && !native) {
				throw new GatewayError({
					class: "bad_request",
					code: "unsupported_file_reference",
					param: "messages",
					message: `Adapter ${candidate.adapter.key} cannot consume this provider file reference`,
					publicMessage:
						"The selected deployment cannot consume this provider-scoped file_id.",
				});
			}
			if (this.#engine === "native" && !native) {
				throw new GatewayError({
					class: "bad_request",
					code: "native_file_input_unsupported",
					param: "plugins",
					message: `Adapter ${candidate.adapter.key} does not support native file input on ${transport}`,
					publicMessage:
						"The selected deployment does not support the native file-parser engine.",
				});
			}
		}
	}

	async #materialize(part: CanonicalFilePart): Promise<MaterializedFile> {
		let pending = this.#materialized.get(part);
		if (pending === undefined) {
			const source = fileSource(part);
			const sourceKey = `${source.kind}:${source.value}:${source.kind === "file_data" ? (part.filename ?? "") : ""}`;
			pending = this.#materializedBySource.get(sourceKey);
			if (pending === undefined) {
				pending =
					source.kind === "file_url"
						? fetchFile(source.value, this.#signal, this.#dependencies)
						: source.kind === "file_data"
							? Promise.resolve(decodeDataUrl(source.value, part.filename))
							: Promise.reject(
									requestError(
										"Provider file IDs cannot be materialized by the gateway",
										"unsupported_file_reference",
										"file_id references require a compatible native upstream.",
									),
								);
				this.#materializedBySource.set(sourceKey, pending);
			}
			this.#materialized.set(part, pending);
		}
		const file = await pending;
		if (!this.#accounted.has(part)) {
			this.#accounted.add(part);
			this.#totalBytes += file.bytes.byteLength;
			if (this.#totalBytes > MAX_TOTAL_BYTES) {
				throw requestError(
					`Materialized files contain ${this.#totalBytes} bytes, above the ${MAX_TOTAL_BYTES} byte request limit`,
					"file_too_large",
					"The combined file inputs are too large for portable processing.",
				);
			}
		}
		return file;
	}

	async #text(file: MaterializedFile): Promise<string> {
		let pending = this.#parsedText.get(file);
		if (pending === undefined) {
			pending = extractPortableText(file);
			this.#parsedText.set(file, pending);
		}
		return pending;
	}

	async #nativePart(
		part: CanonicalFilePart,
		candidate: DeploymentCandidate,
		support: FileInputTransportSupport,
		metadata: FileResolutionMetadata,
	): Promise<CanonicalFilePart> {
		const source = fileSource(part);
		if (support.sources.includes(source.kind)) {
			if (source.kind === "file_data") {
				const file = await this.#materialize(part);
				assertPdfSignature(file);
				if (
					!mimeMatches(file.mimeType, support.mimeTypes) ||
					!modelAllowsNativeFile(candidate, file.mimeType) ||
					(support.maxBytes !== undefined &&
						file.bytes.byteLength > support.maxBytes)
				) {
					throw requestError(
						`Native file input does not support ${file.mimeType}`,
						"native_file_input_unsupported",
						"The selected deployment does not support this file type natively.",
					);
				}
			}
			metadata.nativeFiles += 1;
			if (source.kind === "file_url" && part.fileUrl === undefined) {
				const normalized = { ...part, fileUrl: source.value };
				delete normalized.fileData;
				return normalized;
			}
			return { ...part };
		}
		const file = await this.#materialize(part);
		if (
			!support.sources.includes("file_data") ||
			!mimeMatches(file.mimeType, support.mimeTypes) ||
			!modelAllowsNativeFile(candidate, file.mimeType) ||
			(support.maxBytes !== undefined &&
				file.bytes.byteLength > support.maxBytes)
		) {
			throw requestError(
				`Native file input does not support ${file.mimeType}`,
				"native_file_input_unsupported",
				"The selected deployment does not support this file type natively.",
			);
		}
		metadata.materializedUrls += 1;
		metadata.nativeFiles += 1;
		return {
			type: "file",
			fileData: file.dataUrl,
			...((part.filename ?? file.filename)
				? { filename: part.filename ?? file.filename }
				: {}),
			...(part.detail !== undefined ? { detail: part.detail } : {}),
			...(part.cacheControl !== undefined
				? { cacheControl: part.cacheControl }
				: {}),
		};
	}

	async #resolvePart(
		part: CanonicalFilePart,
		candidate: DeploymentCandidate,
		transport: UpstreamTransport,
		metadata: FileResolutionMetadata,
	): Promise<CanonicalContentPart> {
		const support = candidate.adapter.fileInputs?.[transport];
		const hintedMime = hintedMimeType(part);
		const forcePdfText =
			this.#engine === "pdf-text" && hintedMime === "application/pdf";
		if (
			!forcePdfText &&
			support !== undefined &&
			canUseNative(part, candidate, support, hintedMime)
		) {
			return this.#nativePart(part, candidate, support, metadata);
		}

		const file = await this.#materialize(part);
		const nativeAfterMaterialization =
			support !== undefined &&
			canUseNative(part, candidate, support, file.mimeType);
		if (
			this.#engine !== "pdf-text" &&
			nativeAfterMaterialization &&
			support !== undefined
		) {
			return this.#nativePart(part, candidate, support, metadata);
		}
		if (this.#engine === "native") {
			throw requestError(
				`Adapter ${candidate.adapter.key} cannot consume ${file.mimeType} natively`,
				"native_file_input_unsupported",
				"The selected deployment does not support this file type natively.",
			);
		}

		const text = await this.#text(file);
		metadata.parsedFiles += 1;
		return portableTextPart(part, file, text);
	}

	async resolveForCandidate(
		candidate: DeploymentCandidate,
		transport: UpstreamTransport,
	): Promise<ResolvedFileRequest> {
		if (!this.hasFiles) return { request: this.#request };
		const metadata: FileResolutionMetadata = {
			engine: this.#engine,
			materializedUrls: 0,
			nativeFiles: 0,
			parsedFiles: 0,
		};
		const messages = [];
		for (const message of this.#request.messages) {
			if (!Array.isArray(message.content)) {
				messages.push(message);
				continue;
			}
			const content: CanonicalContentPart[] = [];
			for (const part of message.content) {
				content.push(
					part.type === "file"
						? await this.#resolvePart(part, candidate, transport, metadata)
						: part,
				);
			}
			messages.push({ ...message, content });
		}
		return { request: { ...this.#request, messages }, metadata };
	}
}

export function createFileInputResolver(
	request: CanonicalChatRequest,
	signal: AbortSignal,
	dependencies?: Partial<ResolverDependencies>,
): FileInputResolver {
	return new FileInputResolver(request, signal, {
		...DEFAULT_DEPENDENCIES,
		...dependencies,
	});
}
