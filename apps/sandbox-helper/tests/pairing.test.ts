// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { Pairing } from "../src/pairing.ts";

function clock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("Pairing", () => {
  it("mints a six-digit code", () => {
    const pairing = new Pairing();
    expect(pairing.start().code).toMatch(/^\d{6}$/);
  });

  it("keeps the live code until it expires, then mints another", () => {
    const time = clock();
    const pairing = new Pairing({ now: time.now, codeTtlMs: 1_000 });
    const first = pairing.current();
    expect(pairing.current().code).toBe(first.code);

    time.advance(1_001);
    expect(pairing.current().code).toMatch(/^\d{6}$/);
    expect(pairing.current().expiresAt).toBeGreaterThan(first.expiresAt);
  });

  it("exchanges a code for a token exactly once", () => {
    const pairing = new Pairing();
    const { code } = pairing.start();

    const token = pairing.redeem(code, "http://localhost:5173");
    expect(token).not.toBeNull();
    expect(pairing.verify(token!.token, "http://localhost:5173")).toBe(true);
    expect(pairing.redeem(code, "http://localhost:5173")).toBeNull();
  });

  it("refuses a token from another origin", () => {
    const pairing = new Pairing();
    const { code } = pairing.start();
    const token = pairing.redeem(code, "http://localhost:5173")!;

    expect(pairing.verify(token.token, "http://evil.example")).toBe(false);
    expect(pairing.verify(token.token, "http://localhost:5173")).toBe(true);
  });

  it("stops accepting a code after too many wrong guesses", () => {
    const pairing = new Pairing({ maxAttempts: 3 });
    const { code } = pairing.start();
    const wrong = code === "000000" ? "111111" : "000000";

    for (let i = 0; i < 3; i += 1)
      expect(pairing.redeem(wrong, "http://localhost:5173")).toBeNull();
    expect(pairing.redeem(code, "http://localhost:5173")).toBeNull();
  });

  it("refuses an expired code", () => {
    const time = clock();
    const pairing = new Pairing({ now: time.now, codeTtlMs: 1_000 });
    const { code } = pairing.start();

    time.advance(1_001);
    expect(pairing.redeem(code, "http://localhost:5173")).toBeNull();
  });

  it("expires tokens and stops counting them as paired", () => {
    const time = clock();
    const pairing = new Pairing({ now: time.now, tokenTtlMs: 1_000 });
    const { code } = pairing.start();
    const token = pairing.redeem(code, "http://localhost:5173")!;
    expect(pairing.paired()).toBe(1);

    time.advance(1_001);
    expect(pairing.verify(token.token, "http://localhost:5173")).toBe(false);
    expect(pairing.paired()).toBe(0);
  });
});
