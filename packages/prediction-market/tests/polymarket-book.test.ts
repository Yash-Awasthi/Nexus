// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PolymarketHttpBackend,
  avgPriceForQuantity,
  bookMidpoint,
  bookSpread,
  fetchPolymarketBook,
} from "../src/index.js";

afterEach(() => vi.unstubAllGlobals());

function stubFetch(body: unknown) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
  return calls;
}

describe("fetchPolymarketBook", () => {
  it("builds a sorted book from the CLOB's string levels", async () => {
    const calls = stubFetch({
      asset_id: "tok-yes",
      bids: [
        { price: "0.40", size: "100" },
        { price: "0.44", size: "50" },
      ],
      asks: [
        { price: "0.52", size: "30" },
        { price: "0.48", size: "20" },
      ],
    });
    const book = await fetchPolymarketBook("tok-yes");
    expect(calls[0]).toBe("https://clob.polymarket.com/book?token_id=tok-yes");
    expect(book.bids.map((l) => l.price)).toEqual([0.44, 0.4]);
    expect(book.asks.map((l) => l.price)).toEqual([0.48, 0.52]);
    expect(bookMidpoint(book)).toBeCloseTo(0.46);
    expect(bookSpread(book)).toBeCloseTo(0.04);
    expect(avgPriceForQuantity(book, "BUY", 40).avgPrice).toBeCloseTo((20 * 0.48 + 20 * 0.52) / 40);
  });
});

describe("PolymarketHttpBackend.fetchMarkets", () => {
  it("lists open markets, not the archive, and honours the limit", async () => {
    const raw = (i: number) => ({
      condition_id: `c${i}`,
      question: `Q${i}?`,
      tokens: [
        { token_id: `y${i}`, outcome: "Yes", price: 0.3 },
        { token_id: `n${i}`, outcome: "No", price: 0.7 },
      ],
    });
    const calls = stubFetch({ data: [raw(1), raw(2), raw(3)] });
    const res = await new PolymarketHttpBackend().fetchMarkets({ limit: 2 });
    expect(calls[0]).toContain("/sampling-markets");
    expect(res.markets.map((m) => m.id)).toEqual(["c1", "c2"]);
    expect(res.markets[0]!.outcomes[0]).toMatchObject({ id: "y1", label: "Yes", price: 0.3 });
  });
});
