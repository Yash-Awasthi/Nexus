// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, afterEach } from "vitest";

import { EXTENDED_FLOCI_ACTIONS, dispatchExtendedAction } from "../src/floci-extended.js";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.FLOCI_ENDPOINT;
});

function stubFetch(status: number, body: unknown): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("EXTENDED_FLOCI_ACTIONS", () => {
  it("lists the extended emulator operations", () => {
    expect(EXTENDED_FLOCI_ACTIONS).toContain("create_s3_bucket");
    expect(EXTENDED_FLOCI_ACTIONS).toContain("invoke_lambda");
    expect(EXTENDED_FLOCI_ACTIONS).toContain("publish_sns_message");
    expect(EXTENDED_FLOCI_ACTIONS.length).toBeGreaterThan(10);
  });
});

describe("dispatchExtendedAction", () => {
  it("uses the 4-arg signature with an explicit endpoint", async () => {
    const fetchFn = stubFetch(200, { ok: true, id: "x" });
    const onEvent = vi.fn(async () => {});
    const result = await dispatchExtendedAction(
      "http://floci.test:4566",
      "create_s3_bucket",
      { bucketName: "b1" },
      onEvent,
    );
    expect(result).toEqual({ ok: true, id: "x" });
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("http://floci.test:4566/_floci/extended/create_s3_bucket");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ bucketName: "b1" });
    expect(onEvent).toHaveBeenCalledWith("floci_extended_create_s3_bucket", expect.any(Object));
  });

  it("uses the 3-arg signature with the FLOCI_ENDPOINT env default", async () => {
    process.env.FLOCI_ENDPOINT = "http://env:4566";
    const fetchFn = stubFetch(200, { done: true });
    const result = await dispatchExtendedAction("delete_lambda", { functionName: "fn" });
    expect(result).toEqual({ done: true });
    const [url] = fetchFn.mock.calls[0];
    expect(url).toBe("http://env:4566/_floci/extended/delete_lambda");
  });

  it("falls back to the localhost emulator default", async () => {
    const fetchFn = stubFetch(200, {});
    await dispatchExtendedAction("list_s3_buckets", {});
    const [url] = fetchFn.mock.calls[0];
    expect(url).toContain("localhost:4566");
  });

  it("throws on a non-ok HTTP response", async () => {
    stubFetch(500, { message: "boom" });
    await expect(dispatchExtendedAction("create_s3_bucket", { bucketName: "b" })).rejects.toThrow(
      /HTTP 500/,
    );
  });
});
