// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  stripAnsi,
  trimTrailing,
  collapseBlankLines,
  dedupConsecutive,
  smartTruncate,
  compress,
  compressPreset,
  encodeStructured,
  estimateTokens,
  DEFAULT_FILTERS,
} from "../src/index.js";
import { decode as toonDecode } from "@toon-format/toon";

describe("estimateTokens", () => {
  it("≈ 1 token / 4 chars", () => expect(estimateTokens("hello")).toBe(2));
  it("0 for empty", () => expect(estimateTokens("")).toBe(0));
});

describe("stripAnsi (lossless)", () => {
  it("removes color codes, keeps text", () => {
    const colored = "[31mERROR[0m: boom";
    expect(stripAnsi.apply(colored)).toBe("ERROR: boom");
  });
  it("no-op on plain text", () => {
    expect(stripAnsi.apply("plain text")).toBe("plain text");
  });
  it("does NOT eat ordinary brackets like arr[0] (ESC byte required)", () => {
    expect(stripAnsi.apply("arr[0] = list[12]")).toBe("arr[0] = list[12]");
  });
});

describe("trimTrailing (lossless)", () => {
  it("strips trailing spaces/tabs per line", () => {
    expect(trimTrailing.apply("a   \nb\t\nc")).toBe("a\nb\nc");
  });
});

describe("collapseBlankLines (lossless)", () => {
  it("3+ blank lines → 1 blank line", () => {
    expect(collapseBlankLines.apply("a\n\n\n\n\nb")).toBe("a\n\nb");
  });
  it("leaves a single blank line alone", () => {
    expect(collapseBlankLines.apply("a\n\nb")).toBe("a\n\nb");
  });
});

describe("dedupConsecutive (lossless)", () => {
  it("folds identical runs with exact count", () => {
    expect(dedupConsecutive.apply("foo\nfoo\nfoo\nbar")).toBe("foo  ⟪×3⟫\nbar");
  });
  it("leaves non-repeated lines untouched", () => {
    expect(dedupConsecutive.apply("a\nb\nc")).toBe("a\nb\nc");
  });
  it("count is recoverable (lossless of cardinality)", () => {
    const out = dedupConsecutive.apply("x\nx\nx\nx\nx");
    expect(out).toContain("×5");
  });
});

describe("smartTruncate (lossy, opt-in)", () => {
  it("elides the middle of long output, records dropped count", () => {
    const input = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    const out = smartTruncate(input, { headLines: 10, tailLines: 5 });
    expect(out).toContain("line 0");
    expect(out).toContain("line 199");
    expect(out).toContain("185 lines elided"); // 200 - 10 - 5
    expect(out).not.toContain("line 100");
  });
  it("no-op when already short", () => {
    const input = "a\nb\nc";
    expect(smartTruncate(input, { headLines: 40, tailLines: 20 })).toBe(input);
  });
});

describe("encodeStructured", () => {
  const rows = {
    users: [
      { id: 1, name: "a" },
      { id: 2, name: "b" },
      { id: 3, name: "c" },
    ],
  };

  it("defaults to JSON", () => {
    expect(encodeStructured(rows)).toBe(JSON.stringify(rows));
  });

  it("toon is smaller than JSON on uniform arrays and round-trips (lossless)", () => {
    const toon = encodeStructured(rows, "toon");
    expect(toon.length).toBeLessThan(JSON.stringify(rows).length);
    expect(toonDecode(toon)).toEqual(rows);
  });

  it("never throws on a plain value (encoding tool output must not lose the result)", () => {
    expect(() => encodeStructured({ ok: 1 }, "toon")).not.toThrow();
    expect(encodeStructured(42, "toon")).toBeTypeOf("string");
  });
});

describe("compress pipeline", () => {
  it("default pipeline is all-lossless", () => {
    expect(DEFAULT_FILTERS.every((f) => f.lossless)).toBe(true);
  });

  it("reports which filters fired + token delta", () => {
    const noisy = "[32mok[0m   \nok   \nok   \n\n\n\n\ndone";
    const r = compress(noisy);
    expect(r.applied).toContain("strip-ansi");
    expect(r.applied).toContain("dedup-consecutive");
    expect(r.compressedTokens).toBeLessThan(r.originalTokens);
    expect(r.savedRatio).toBeGreaterThan(0);
  });

  it("savedRatio is 0 on already-clean text (nothing to do)", () => {
    const r = compress("clean single line");
    expect(r.applied).toEqual([]);
    expect(r.savedRatio).toBe(0);
  });

  it("preset 'off' changes nothing", () => {
    const r = compressPreset("[31mx[0m", "off");
    expect(r.text).toContain("[31m");
    expect(r.savedRatio).toBe(0);
  });

  // Lossless guarantee spot-check: stripping ANSI + dedup must preserve the
  // visible signal — every distinct non-blank token survives.
  it("lossless filters preserve all distinct content lines", () => {
    const input = "[31mAlpha[0m\nBeta\nBeta\nGamma";
    const r = compress(input);
    for (const word of ["Alpha", "Beta", "Gamma"]) expect(r.text).toContain(word);
  });
});
