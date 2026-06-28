import type { Adapter, ChatHandler } from "./types.ts";
import assert from "node:assert/strict";
import { test, after } from "node:test";

import "./index.ts"; // side effect: registers the built-in adapters into the shared registry

import {
	adapterSupportsCallType,
	registerAdapter,
	__resetRegistry,
	listAdapters,
	getAdapter,
} from "./registry.ts";

const fakeChat = {} as ChatHandler;

// These tests wipe the global adapter registry with __resetRegistry(). Under a shared-process test
// runner (bun test) that pollution would leak into other suites (e.g. the admin /operations test), so
// snapshot the built-in adapters and restore them once this file's tests finish.
const BUILTIN_ADAPTERS = listAdapters();
after(() => {
	__resetRegistry();
	for (const adapter of BUILTIN_ADAPTERS) registerAdapter(adapter);
});

test("registers and retrieves an adapter; validates CallTypes<->handlers", () => {
	__resetRegistry();
	const adapter: Adapter = {
		key: "fake",
		supportedCallTypes: new Set(["chat"]),
		chat: fakeChat,
	};
	registerAdapter(adapter);
	assert.equal(getAdapter("fake")?.key, "fake");
	assert.equal(adapterSupportsCallType("fake", "chat"), true);
	assert.equal(adapterSupportsCallType("fake", "images.generations"), false);
});

test("rejects duplicates", () => {
	__resetRegistry();
	const adapter: Adapter = {
		key: "dup",
		supportedCallTypes: new Set(["chat"]),
		chat: fakeChat,
	};
	registerAdapter(adapter);
	assert.throws(() => registerAdapter(adapter), /Duplicate adapter/);
});

test("rejects adapter keys with separators or uppercase letters", () => {
	__resetRegistry();
	const bad: Adapter = {
		key: "bad-key",
		supportedCallTypes: new Set(["chat"]),
		chat: fakeChat,
	};
	assert.throws(() => registerAdapter(bad), /adapter keys/);
});

test("rejects chat support declaration without handler implementation", () => {
	__resetRegistry();
	const broken: Adapter = {
		key: "broken",
		supportedCallTypes: new Set(["chat"]),
	};
	assert.throws(() => registerAdapter(broken), /does not implement/);
});
