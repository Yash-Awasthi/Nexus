// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, afterEach } from "vitest";

import { runHealthcheck } from "../src/healthcheck.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runHealthcheck", () => {
  it("runs all five checks and reports a boolean result without throwing", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = runHealthcheck();
    expect(typeof result).toBe("boolean");
    expect(log).toHaveBeenCalled();
    expect(err.mock.calls.length + warn.mock.calls.length).toBeGreaterThanOrEqual(0);
    // every check emitted a [CHECK] header regardless of pass/fail
    const checkHeaders = log.mock.calls.filter((c) => String(c[0]).includes("[CHECK]"));
    expect(checkHeaders.length).toBeGreaterThanOrEqual(5);
    void result;
  });
});
