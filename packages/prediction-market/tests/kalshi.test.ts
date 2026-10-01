// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";
import { KalshiHttpBackend } from "../src/index.js";

afterEach(() => vi.unstubAllGlobals());

describe("KalshiHttpBackend", () => {
  it("reads the current public API and its dollar-string prices", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      return new Response(
        JSON.stringify({
          markets: [
            {
              ticker: "KXRAIN-26",
              title: "Rain in NYC?",
              yes_bid_dollars: "0.4100",
              yes_ask_dollars: "0.4300",
              last_price_dollars: "0.4200",
              volume_fp: "1250.00",
              open_interest_fp: "300.00",
              expiration_time: "2026-10-01T00:00:00Z",
            },
          ],
        }),
      );
    });

    const { markets } = await new KalshiHttpBackend().fetchMarkets({ limit: 5 });

    expect(urls[0]).toMatch(/^https:\/\/api\.elections\.kalshi\.com\/trade-api\/v2\/markets\?/);
    expect(urls[0]).toContain("mve_filter=exclude");
    expect(urls[0]).toContain("status=open");
    expect(markets[0]!.outcomes[0]!.probability).toBeCloseTo(0.42);
    expect(markets[0]!.volume).toBe(1250);
    expect(markets[0]!.liquidity).toBe(300);
  });

  it("retries once, after a pause, when the connection is reset", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      if (calls++ === 0) throw new TypeError("fetch failed");
      return new Response(JSON.stringify({ markets: [] }));
    });

    const { markets } = await new KalshiHttpBackend().fetchMarkets({ limit: 5 });

    expect(markets).toEqual([]);
    expect(calls).toBe(2);
  });

  it("gives up after three resets", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      throw new TypeError("fetch failed");
    });

    await expect(new KalshiHttpBackend().fetchMarkets({ limit: 5 })).rejects.toThrow(
      "fetch failed",
    );
    expect(calls).toBe(3);
  });
});
