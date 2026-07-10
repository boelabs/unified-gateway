import type { DeploymentCandidate } from "#gateway/deploymentCandidates.ts";
import { deepseekAdapter } from "#adapters/deepseek/index.ts";
import { createFileInputResolver } from "./requestFiles.ts";
import { googleAdapter } from "#adapters/google/index.ts";
import { openaiAdapter } from "#adapters/openai/index.ts";
import type { Adapter } from "#adapters/types.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

import type {
	CanonicalContentPart,
	CanonicalChatRequest,
} from "#core/canonical.ts";

const PDF_BASE64 =
	"JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA0IDAgUiA+PiA+PiAvQ29udGVudHMgNSAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iago1IDAgb2JqCjw8IC9MZW5ndGggNTcgPj4Kc3RyZWFtCkJUIC9GMSAxMiBUZiA3MiA3MjAgVGQgKFBvcnRhYmxlIGF0dGFjaG1lbnQgdGV4dCkgVGogRVQKZW5kc3RyZWFtCmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1OCAwMDAwMCBuIAowMDAwMDAwMTE1IDAwMDAwIG4gCjAwMDAwMDAyNDEgMDAwMDAgbiAKMDAwMDAwMDMxMSAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDYgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjQxNgolJUVPRgo=";

function candidate(adapter: Adapter, vision = true): DeploymentCandidate {
	return {
		row: {} as DeploymentCandidate["row"],
		adapter,
		upstreamModel: "upstream-model",
		meta: {
			capabilities: {
				tools: true,
				vision,
				reasoning: false,
				structuredOutputs: true,
			},
		},
	};
}

function request(
	file: CanonicalContentPart,
	fileParser?: CanonicalChatRequest["fileParser"],
): CanonicalChatRequest {
	return {
		callType: "chat",
		publicWire: "responses",
		model: "public-model",
		messages: [{ role: "user", content: [file] }],
		stream: false,
		...(fileParser !== undefined ? { fileParser } : {}),
	};
}

test("file resolver materializes a PDF URL once for Gemini inlineData", async () => {
	let fetches = 0;
	const resolver = createFileInputResolver(
		request({
			type: "file",
			fileUrl: "https://assets.example/document.pdf",
			filename: "document.pdf",
		}),
		new AbortController().signal,
		{
			resolveHostname: async () => [{ address: "93.184.216.34", family: 4 }],
			fetch: (async () => {
				fetches += 1;
				return new Response(new Uint8Array(Buffer.from(PDF_BASE64, "base64")), {
					headers: { "content-type": "application/pdf" },
				});
			}) as typeof fetch,
		},
	);
	const google = candidate(googleAdapter);
	resolver.assertCandidate(google, "generate_content");

	const first = await resolver.resolveForCandidate(google, "generate_content");
	const second = await resolver.resolveForCandidate(google, "generate_content");
	assert.equal(fetches, 1);
	assert.deepEqual(first.metadata, {
		engine: "auto",
		materializedUrls: 1,
		nativeFiles: 1,
		parsedFiles: 0,
	});
	assert.equal(second.metadata?.materializedUrls, 1);

	const built = googleAdapter.chat!.buildRequest(first.request, {
		upstreamModel: "upstream-model",
		credentials: { apiKey: "test-key" },
		meta: google.meta,
		transport: "generate_content",
		requestId: "test-request",
	});
	const body = JSON.parse(built.body!);
	assert.equal(
		body.contents[0].parts[0].inlineData.mimeType,
		"application/pdf",
	);
	assert.equal(body.contents[0].parts[0].inlineData.data, PDF_BASE64);
});

test("file resolver converts UTF-8 JSON to a portable text part", async () => {
	const data = Buffer.from('{"answer":42}', "utf8").toString("base64");
	const resolved = await createFileInputResolver(
		request({
			type: "file",
			fileData: `data:application/json;base64,${data}`,
			filename: "answer.json",
		}),
		new AbortController().signal,
	).resolveForCandidate(candidate(deepseekAdapter), "chat_completions");

	assert.equal(resolved.metadata?.parsedFiles, 1);
	const content = resolved.request.messages[0]?.content;
	assert.ok(Array.isArray(content));
	assert.equal(content[0]?.type, "text");
	assert.match((content[0] as { text: string }).text, /\{"answer":42\}/);
});

test("pdf-text extracts a text PDF for a text-only upstream", async () => {
	const resolved = await createFileInputResolver(
		request(
			{
				type: "file",
				fileData: `data:application/pdf;base64,${PDF_BASE64}`,
				filename: "portable.pdf",
			},
			{ pdfEngine: "pdf-text" },
		),
		new AbortController().signal,
	).resolveForCandidate(candidate(deepseekAdapter), "chat_completions");

	const content = resolved.request.messages[0]?.content;
	assert.ok(Array.isArray(content));
	assert.match(
		(content[0] as { text: string }).text,
		/Portable attachment text/,
	);
});

test("auto parses a PDF when the native transport model is not vision-capable", async () => {
	const resolved = await createFileInputResolver(
		request({
			type: "file",
			fileData: `data:application/pdf;base64,${PDF_BASE64}`,
		}),
		new AbortController().signal,
	).resolveForCandidate(candidate(openaiAdapter, false), "responses");
	assert.equal(resolved.metadata?.nativeFiles, 0);
	assert.equal(resolved.metadata?.parsedFiles, 1);
});

test("native engine rejects a text-only upstream during eligibility", () => {
	const resolver = createFileInputResolver(
		request(
			{
				type: "file",
				fileData: "data:text/plain;base64,aGVsbG8=",
			},
			{ pdfEngine: "native" },
		),
		new AbortController().signal,
	);
	assert.throws(
		() =>
			resolver.assertCandidate(candidate(deepseekAdapter), "chat_completions"),
		(error: unknown) =>
			(error as { code?: string }).code === "native_file_input_unsupported",
	);
});

test("remote file materialization rejects private network targets", () => {
	assert.throws(
		() =>
			createFileInputResolver(
				request({
					type: "file",
					fileUrl: "https://127.0.0.1/document.pdf",
				}),
				new AbortController().signal,
			),
		(error: unknown) => (error as { code?: string }).code === "unsafe_file_url",
	);
});
