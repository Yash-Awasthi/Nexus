// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { SessionDedup } from "./session-dedup.js";

describe("SessionDedup", () => {
  const big = "line of file content\n".repeat(50);

  it("replaces a repeated large output with a pointer to the first", () => {
    const d = new SessionDedup();
    expect(d.apply("read_file (call 1)", big).text).toBe(big);
    const again = d.apply("read_file (call 2)", big);
    expect(again.text).toMatch(/identical to the output of read_file \(call 1\)/);
    expect(again.savedTokens).toBeGreaterThan(100);
  });

  it("leaves small or different outputs alone", () => {
    const d = new SessionDedup();
    d.apply("a", "ok");
    expect(d.apply("b", "ok").text).toBe("ok");
    d.apply("c", big);
    expect(d.apply("d", big + "x").text).toBe(big + "x");
  });

  it("repeats the output when the first copy is gone from the history", () => {
    const d = new SessionDedup();
    d.apply("read_file (call 1)", big);
    expect(d.apply("read_file (call 2)", big, () => false).text).toBe(big);
  });
});
