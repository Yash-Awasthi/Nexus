// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  url: vi.fn(),
  probeFlociHealth: vi.fn(),
}));

vi.mock("../src/bridge-manager.js", () => ({
  getBridgeManager: () => ({ url: mocks.url }),
}));

vi.mock("../src/floci-client.js", () => ({
  probeFlociHealth: mocks.probeFlociHealth,
  resolveFlociEndpoint: vi.fn(() => "http://localhost:4566"),
}));

import { FlociExecutionAdapter } from "../src/floci-adapter.js";
import { EXTENDED_FLOCI_ACTIONS } from "../src/floci-extended.js";

function stubFetch(ok: boolean, body: unknown): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => {
  mocks.url.mockReset();
  mocks.probeFlociHealth.mockReset();
  mocks.url.mockResolvedValue("http://localhost:4567");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("FlociExecutionAdapter", () => {
  it("handles floci task types", () => {
    const adapter = new FlociExecutionAdapter();
    expect(adapter.canExecute("floci")).toBe(true);
    expect(adapter.canExecute("floci:create_s3_bucket")).toBe(true);
    expect(adapter.canExecute("browser")).toBe(false);
  });

  it("dispatches extended actions and emits completion events", async () => {
    stubFetch(true, { ok: true, bucket: "b1" });
    const onEvent = vi.fn(async () => {});
    const adapter = new FlociExecutionAdapter({ onEvent });
    const out = await adapter.execute(
      { payload: { action: "create_s3_bucket", service: "s3", bucketName: "b1" } },
      { taskId: "t1" },
    );
    expect(out.success).toBe(true);
    expect(out.action).toBe("create_s3_bucket");
    expect(out.service).toBe("s3");
    expect(out.bucket).toBe("b1");
    expect(mocks.url).toHaveBeenCalledWith("floci");
    expect(onEvent).toHaveBeenCalledOnce();
    const [event, payload] = onEvent.mock.calls[0];
    expect(event).toBe("floci_action_completed");
    expect(payload.taskId).toBe("t1");
  });

  it("falls back to a payload type as the action", async () => {
    stubFetch(true, { ok: true });
    const adapter = new FlociExecutionAdapter();
    const out = await adapter.execute({ payload: { type: "list_s3_buckets" } }, {});
    expect(out.success).toBe(true);
    expect(out.action).toBe("list_s3_buckets");
  });

  it("degrades gracefully in non-strict mode when dispatch fails", async () => {
    stubFetch(false, { message: "nope" });
    const adapter = new FlociExecutionAdapter();
    const out = await adapter.execute({ payload: { action: "create_s3_bucket" } }, {});
    expect(out.success).toBe(false);
    expect(out.error).toContain("HTTP 500");
    expect(out.action).toBe("create_s3_bucket");
  });

  it("throws for unknown actions in strict mode", async () => {
    const adapter = new FlociExecutionAdapter({ strict: true });
    await expect(adapter.execute({ payload: { action: "hack_the_planet" } }, {})).rejects.toThrow(
      /strict/,
    );
  });

  it("rethrows dispatch failures in strict mode", async () => {
    stubFetch(false, {});
    const adapter = new FlociExecutionAdapter({ strict: true });
    await expect(adapter.execute({ payload: { action: "create_s3_bucket" } }, {})).rejects.toThrow();
  });

  it("executeAction wraps args into a task payload", async () => {
    stubFetch(true, { done: true });
    const adapter = new FlociExecutionAdapter();
    const out = await adapter.executeAction("delete_s3_bucket", { bucketName: "b" }, { taskId: "x" });
    expect(out.success).toBe(true);
  });

  it("probes health and caches the last result", async () => {
    mocks.probeFlociHealth.mockResolvedValue({
      reachable: true,
      latencyMs: 3,
      endpoint: "http://localhost:4566",
      healthPath: "/health",
    });
    const adapter = new FlociExecutionAdapter();
    expect(adapter.getLastHealth()).toBeUndefined();
    const health = await adapter.probeHealth();
    expect(health.reachable).toBe(true);
    expect(adapter.getLastHealth()).toEqual(health);
  });

  it("exposes the registered extended action list", () => {
    expect(EXTENDED_FLOCI_ACTIONS).toContain("create_dynamodb_table");
  });
});
