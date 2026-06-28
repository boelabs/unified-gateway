import assert from "node:assert/strict";
import { test } from "node:test";

import {
	resolveBodyFieldReasoning,
	toUpstreamReasoningEffort,
	resolveChatTemplateFlag,
	effortFromBudgetTokens,
	type ReasoningSpec,
	resolveReasoning,
	summaryForEffort,
	summaryVisible,
	snapEffort,
} from "./reasoning.ts";

test("snapEffort: none is respected only if the model can disable reasoning", () => {
	const canDisable: ReasoningSpec = {
		kind: "openai_effort",
		levels: ["low", "medium", "high"],
		canDisable: true,
	};
	const cannotDisable: ReasoningSpec = {
		kind: "gemini_level",
		levels: ["low", "medium", "high"],
		canDisable: false,
	};
	assert.equal(snapEffort("none", canDisable), "none");
	assert.equal(snapEffort("none", cannotDisable), "low");
});

test("snapEffort: lowers to the nearest supported level", () => {
	const spec: ReasoningSpec = {
		kind: "anthropic_adaptive",
		levels: ["low", "medium", "high"],
		canDisable: true,
	};
	assert.equal(snapEffort("xhigh", spec), "high");
	assert.equal(snapEffort("minimal", spec), "low");
});

test("snapEffort: a binary toggle normalizes exclusively to none/high", () => {
	const spec: ReasoningSpec = {
		kind: "openai_effort",
		levels: ["high"],
		canDisable: true,
	};
	assert.equal(snapEffort("none", spec), "none");
	for (const effort of ["minimal", "low", "medium", "high", "xhigh"] as const) {
		assert.equal(snapEffort(effort, spec), "high");
	}
});

test("effortFromBudgetTokens: buckets legacy budgets", () => {
	assert.equal(effortFromBudgetTokens(0), "none");
	assert.equal(effortFromBudgetTokens(2_048), "low");
	assert.equal(effortFromBudgetTokens(10_000), "medium");
	assert.equal(effortFromBudgetTokens(32_000), "xhigh");
});

test("toUpstreamReasoningEffort: separates our xhigh from native max", () => {
	const spec: ReasoningSpec = {
		kind: "openai_effort",
		levels: ["high", "xhigh"],
		canDisable: true,
		upstreamEffortMap: { xhigh: "max" },
	};
	assert.equal(toUpstreamReasoningEffort("high", spec), "high");
	assert.equal(toUpstreamReasoningEffort("xhigh", spec), "max");
});

test("resolveChatTemplateFlag: binary on/off toggle against the spec", () => {
	const spec: ReasoningSpec = {
		kind: "chat_template_flag",
		levels: ["high"],
		canDisable: true,
		chatTemplateFlag: { param: "thinking" },
	};
	// omitted effort on a model that can disable -> off -> no offValue -> no output.
	assert.equal(resolveChatTemplateFlag(undefined, spec), undefined);
	// any non-none effort -> on -> default onValue true.
	assert.deepEqual(resolveChatTemplateFlag({ effort: "low" }, spec), {
		param: "thinking",
		value: true,
	});
	assert.deepEqual(resolveChatTemplateFlag({ effort: "high" }, spec), {
		param: "thinking",
		value: true,
	});
});

test("resolveChatTemplateFlag: respects custom onValue/offValue and parameter name", () => {
	const spec: ReasoningSpec = {
		kind: "chat_template_flag",
		levels: ["high"],
		canDisable: true,
		chatTemplateFlag: {
			param: "enable_thinking",
			onValue: "on",
			offValue: "off",
		},
	};
	assert.deepEqual(resolveChatTemplateFlag({ effort: "high" }, spec), {
		param: "enable_thinking",
		value: "on",
	});
	assert.deepEqual(resolveChatTemplateFlag({ effort: "none" }, spec), {
		param: "enable_thinking",
		value: "off",
	});
});

test("resolveChatTemplateFlag: undefined for other kinds", () => {
	const spec: ReasoningSpec = {
		kind: "openai_effort",
		levels: ["high"],
		canDisable: true,
	};
	assert.equal(resolveChatTemplateFlag({ effort: "high" }, spec), undefined);
});

test("resolveBodyFieldReasoning: emits top-level JSON values for OpenAI-compatible", () => {
	const spec: ReasoningSpec = {
		kind: "openai_body",
		levels: ["high"],
		canDisable: true,
		bodyField: {
			param: "thinking",
			onValue: { type: "enabled" },
			offValue: { type: "disabled" },
		},
	};
	assert.deepEqual(resolveBodyFieldReasoning(undefined, spec), {
		param: "thinking",
		value: { type: "disabled" },
	});
	assert.deepEqual(resolveBodyFieldReasoning({ effort: "low" }, spec), {
		param: "thinking",
		value: { type: "enabled" },
	});
});

test("summaryForEffort: enabled effort implies auto unless opt-out none", () => {
	assert.equal(summaryForEffort("high", undefined), "auto");
	assert.equal(summaryForEffort("high", "none"), "none");
	assert.equal(summaryForEffort("none", undefined), undefined);
});

test("resolveReasoning: omitted effort on MANDATORY reasoner -> lowest level + auto summary", () => {
	// canDisable=false -> cannot avoid reasoning: default = minimum level, with thoughts.
	const spec: ReasoningSpec = {
		kind: "gemini_level",
		levels: ["low", "medium", "high"],
		canDisable: false,
	};
	const resolved = resolveReasoning(undefined, spec);
	assert.equal(resolved.effort, "low");
	assert.equal(resolved.summary, "auto");
	assert.equal(summaryVisible(resolved.summary), true);
});

test("resolveReasoning: omitted effort on model that CAN skip reasoning -> none (does not reason)", () => {
	// canDisable=true -> the default is no reasoning (none), without thoughts.
	const spec: ReasoningSpec = {
		kind: "openai_effort",
		levels: ["low", "medium", "high"],
		canDisable: true,
	};
	const resolved = resolveReasoning(undefined, spec);
	assert.equal(resolved.effort, "none");
	assert.equal(resolved.summary, undefined);
	assert.equal(summaryVisible(resolved.summary), false);
});

test("resolveReasoning: explicit effort is snapped and respects summary opt-out", () => {
	const spec: ReasoningSpec = {
		kind: "openai_effort",
		levels: ["low", "medium", "high"],
		canDisable: true,
	};
	const high = resolveReasoning({ effort: "xhigh" }, spec);
	assert.equal(high.effort, "high"); // snapped to the supported ceiling
	assert.equal(high.summary, "auto");

	const optOut = resolveReasoning({ effort: "medium", summary: "none" }, spec);
	assert.equal(optOut.summary, "none");
	assert.equal(summaryVisible(optOut.summary), false);

	// Client can request a specific summary.
	assert.equal(
		resolveReasoning({ effort: "low", summary: "detailed" }, spec).summary,
		"detailed",
	);
});

test("resolveReasoning: effort none on model that can disable -> no summary", () => {
	const spec: ReasoningSpec = {
		kind: "openai_effort",
		levels: ["low", "medium", "high"],
		canDisable: true,
	};
	const resolved = resolveReasoning({ effort: "none" }, spec);
	assert.equal(resolved.effort, "none");
	assert.equal(resolved.summary, undefined);
	assert.equal(summaryVisible(resolved.summary), false);
});
