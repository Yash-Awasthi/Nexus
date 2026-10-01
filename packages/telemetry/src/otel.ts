// SPDX-License-Identifier: Apache-2.0
/**
 * OpenTelemetry tracing for the API and worker. Off unless OTEL_EXPORTER_OTLP_ENDPOINT is set,
 * then spans are batched to the collector over OTLP/HTTP (the endpoint gets /v1/traces).
 */
import { trace, type Tracer } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  SimpleSpanProcessor,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

let provider: NodeTracerProvider | undefined;

/**
 * Register the global tracer provider once. `exporter` replaces OTLP (tests pass an in-memory
 * one); without it and without an endpoint, tracing stays off and this returns undefined.
 */
export function startTracing(serviceName: string, exporter?: SpanExporter): Tracer | undefined {
  if (!provider) {
    if (!exporter && !process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return undefined;
    provider = new NodeTracerProvider({
      resource: resourceFromAttributes({
        "service.name": process.env.OTEL_SERVICE_NAME ?? serviceName,
      }),
      spanProcessors: [
        exporter
          ? new SimpleSpanProcessor(exporter)
          : new BatchSpanProcessor(new OTLPTraceExporter()),
      ],
    });
    provider.register();
  }
  return trace.getTracer(serviceName);
}

/** Flush pending spans, e.g. before the process exits. */
export async function stopTracing(): Promise<void> {
  await provider?.shutdown();
  provider = undefined;
}
