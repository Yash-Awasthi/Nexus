// SPDX-License-Identifier: Apache-2.0
/** Closing the server flushes the tracer and the request traces still queued for storage. */
import { expect, it, vi } from "vitest";

const stopTracing = vi.fn(async () => {});
vi.mock("@nexus/telemetry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@nexus/telemetry")>()),
  stopTracing,
}));

const flushTraces = vi.fn(async () => {});
vi.mock("../../src/lib/request-traces.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/request-traces.js")>()),
  flushTraces,
}));

const { buildServer } = await import("../../src/server.js");

it("stops tracing when the server closes", async () => {
  const app = await buildServer();
  await app.ready();
  expect(stopTracing).not.toHaveBeenCalled();
  await app.close();
  expect(stopTracing).toHaveBeenCalledTimes(1);
});

it("writes the queued request traces when the server closes", async () => {
  flushTraces.mockClear();
  const app = await buildServer();
  await app.ready();
  await app.close();
  expect(flushTraces).toHaveBeenCalledTimes(1);
});
