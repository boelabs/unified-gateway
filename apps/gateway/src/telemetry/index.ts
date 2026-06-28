import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type { RequestLogInput } from "#logging/logger.ts";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { log } from "#logging/log.ts";
import { env } from "#config/env.ts";

import {
	type Attributes,
	SpanStatusCode,
	metrics,
	trace,
} from "@opentelemetry/api";

let sdk: NodeSDK | null = null;

const tracer = trace.getTracer("unifiedgateway");

/**
 * The metric instruments are created AFTER sdk.start() so they use the real MeterProvider (instruments
 * created before registering the provider would stay on a no-op meter and would not export). They are
 * stored here and recordRequestTelemetry uses them only if they exist.
 */
interface Instruments {
	requestCounter: ReturnType<
		ReturnType<typeof metrics.getMeter>["createCounter"]
	>;
	errorCounter: ReturnType<
		ReturnType<typeof metrics.getMeter>["createCounter"]
	>;
	requestDuration: ReturnType<
		ReturnType<typeof metrics.getMeter>["createHistogram"]
	>;
	upstreamDuration: ReturnType<
		ReturnType<typeof metrics.getMeter>["createHistogram"]
	>;
	tokenCounter: ReturnType<
		ReturnType<typeof metrics.getMeter>["createCounter"]
	>;
	costCounter: ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]>;
}
let inst: Instruments | null = null;

function createInstruments(): Instruments {
	const meter = metrics.getMeter("unifiedgateway");
	return {
		requestCounter: meter.createCounter("unifiedgateway_requests_total", {
			description: "Total gateway inference requests recorded by request_logs.",
		}),
		errorCounter: meter.createCounter("unifiedgateway_errors_total", {
			description: "Total gateway inference errors recorded by request_logs.",
		}),
		requestDuration: meter.createHistogram(
			"unifiedgateway_request_duration_ms",
			{
				description: "Gateway request duration in milliseconds.",
				unit: "ms",
			},
		),
		upstreamDuration: meter.createHistogram("unifiedgateway_upstream_ttft_ms", {
			description:
				"Upstream time-to-first-token in milliseconds (winning attempt).",
			unit: "ms",
		}),
		tokenCounter: meter.createCounter("unifiedgateway_tokens_total", {
			description: "Total tokens reported by upstream providers.",
		}),
		costCounter: meter.createCounter("unifiedgateway_cost_cents_total", {
			description: "Total estimated request cost in USD cents.",
		}),
	};
}

export function startTelemetry(): void {
	if (!env.OTEL_ENABLED || sdk) return;

	const metricReader = new PeriodicExportingMetricReader({
		exporter: new OTLPMetricExporter(),
		exportIntervalMillis: env.OTEL_METRIC_EXPORT_INTERVAL_MS,
	});

	sdk = new NodeSDK({
		serviceName: env.OTEL_SERVICE_NAME,
		resource: resourceFromAttributes({
			"service.name": env.OTEL_SERVICE_NAME,
			"deployment.environment": env.NODE_ENV,
		}),
		traceExporter: new OTLPTraceExporter(),
		metricReaders: [metricReader],
		instrumentations: [new HttpInstrumentation()],
	});
	sdk.start();
	inst = createInstruments(); // after start(): the real provider is registered
	log.info("otel", "enabled", { service: env.OTEL_SERVICE_NAME });
}

export async function shutdownTelemetry(): Promise<void> {
	if (!sdk) return;
	await sdk.shutdown();
	sdk = null;
}

function jsonAttr(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "null";
	} catch {
		return "[unserializable]";
	}
}

function baseAttributes(input: RequestLogInput): Attributes {
	return {
		"request.id": input.requestId,
		"model.public_name": input.publicModel ?? "unknown",
		"deployment.id": input.deploymentId ?? "unknown",
		"adapter.key": input.adapterKey ?? "unknown",
		"call.type": input.callType,
		"gateway.status": input.status,
		"http.status_code": input.httpStatus ?? 0,
		"cache.hit": input.cacheHit,
		"fallback.used": input.fallbackUsed,
		retries: input.retries,
	};
}

function payloadAttributes(input: RequestLogInput): Attributes {
	if (!env.OTEL_LOG_PAYLOADS) return {};
	return {
		"request.body_json": jsonAttr(input.requestBody),
		"response.body_json": jsonAttr(input.responseBody),
		metadata_json: jsonAttr(input.metadata),
		error_json: jsonAttr(input.error),
		attempts_json: jsonAttr(input.attempts ?? null),
	};
}

export function recordRequestTelemetry(input: RequestLogInput): void {
	if (!env.OTEL_ENABLED || !inst) return;

	const attrs = baseAttributes(input);
	inst.requestCounter.add(1, attrs);
	inst.requestDuration.record(input.durationMs, attrs);
	if (input.upstreamTtftMs != null)
		inst.upstreamDuration.record(input.upstreamTtftMs, attrs);
	if (input.status === "error") inst.errorCounter.add(1, attrs);
	if (input.usage?.totalTokens)
		inst.tokenCounter.add(input.usage.totalTokens, attrs);
	if (input.cost?.totalCents)
		inst.costCounter.add(input.cost.totalCents, attrs);

	tracer.startActiveSpan(
		"unifiedgateway.request_log",
		{ attributes: attrs },
		(span) => {
			if (input.status === "error") {
				span.setStatus({
					code: SpanStatusCode.ERROR,
					message: String(input.error?.message ?? "gateway error"),
				});
			}
			span.addEvent(
				"unifiedgateway.request_log.payload",
				payloadAttributes(input),
			);
			span.end();
		},
	);
}
