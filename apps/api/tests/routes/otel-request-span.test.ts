// SPDX-License-Identifier: Apache-2.0
/**
 * Every request carries an OpenTelemetry trace: a server span named for its route, joined to the
 * caller's trace when a traceparent header arrives, and handed back in the response's traceparent.
 */
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { startTracing } from "@nexus/telemetry";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";

process.env.DATABASE_URL = "pglite://:memory:otel-request-span";
const exporter = new InMemorySpanExporter();
startTracing("nexus-api", exporter);

const { buildServer } = await import("../../src/server.js");

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildServer();
  await app.ready();
}, 120_000);
afterAll(async () => {
  await app.close();
});

it("records a server span for the route and joins the caller's trace", async () => {
  const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
  const r = await app.inject({
    method: "GET",
    url: "/health",
    headers: { traceparent: `00-${traceId}-00f067aa0ba902b7-01` },
  });
  expect(r.statusCode).toBe(200);
  expect(String(r.headers["traceparent"])).toMatch(new RegExp(`^00-${traceId}-[0-9a-f]{16}-01$`));

  const span = exporter.getFinishedSpans().find((s) => s.name === "GET /health");
  expect(span).toBeDefined();
  expect(span!.spanContext().traceId).toBe(traceId);
  expect(span!.attributes["http.response.status_code"]).toBe(200);
});
