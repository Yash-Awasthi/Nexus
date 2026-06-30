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
  compressAuto,
  detectTraits,
  injectSystemPrompt,
  INJECTORS,
  encodeStructured,
  estimateTokens,
  DEFAULT_FILTERS,
  resolveToolProfile,
  compressForTool,
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

describe("detectTraits", () => {
  it("flags trailing-ws, blank-runs, repeat-runs", () => {
    const input = "x   \n\n\n\n\ndup\ndup";
    const traits = detectTraits(input);
    expect(traits).toContain("trailing-ws");
    expect(traits).toContain("blank-runs");
    expect(traits).toContain("repeat-runs");
  });
  it("ignores ordinary brackets (no ESC) — clean text has no traits", () => {
    expect(detectTraits("arr[0] = list[12]")).toEqual([]);
  });
  it("does not flag a single blank line or non-adjacent repeats", () => {
    expect(detectTraits("a\n\nb\na")).toEqual([]);
  });
});

describe("compressAuto", () => {
  it("applies only the matched filters and reports detected traits", () => {
    const r = compressAuto("ok   \nok   \nplain");
    expect(r.traits).toContain("trailing-ws");
    expect(r.traits).toContain("repeat-runs");
    expect(r.traits).not.toContain("ansi");
    expect(r.applied).toContain("trim-trailing");
    expect(r.applied).not.toContain("strip-ansi");
    expect(r.compressedTokens).toBeLessThanOrEqual(r.originalTokens);
  });
  it("equals the full lossless pipeline result on the text (lossless equivalence)", () => {
    const input = "ok   \nok   \nok   \n\n\n\n\ndone";
    expect(compressAuto(input).text).toBe(compress(input).text);
  });
  it("no-op on already-clean text", () => {
    const r = compressAuto("clean single line");
    expect(r.traits).toEqual([]);
    expect(r.text).toBe("clean single line");
    expect(r.savedRatio).toBe(0);
  });
});

describe("injectSystemPrompt (opt-in)", () => {
  it("returns base unchanged with no injectors", () => {
    expect(injectSystemPrompt("You are a bot.", [])).toBe("You are a bot.");
  });
  it("appends requested injector blocks verbatim", () => {
    const out = injectSystemPrompt("Base.", ["terse-output", "yagni-minimal-code"]);
    expect(out).toContain("Base.");
    expect(out).toContain(INJECTORS["terse-output"].text);
    expect(out).toContain(INJECTORS["yagni-minimal-code"].text);
  });
  it("is idempotent — does not double-append an already-present block", () => {
    const once = injectSystemPrompt("Base.", ["terse-output"]);
    const twice = injectSystemPrompt(once, ["terse-output"]);
    expect(twice).toBe(once);
  });
});

describe("resolveToolProfile", () => {
  it("maps diff-ish tool names to the diff profile", () => {
    for (const n of ["git_diff", "git diff", "gitDiff", "diff"]) {
      expect(resolveToolProfile(n)).toBe("diff");
    }
  });
  it("maps search tools to grep, build/test tools to build-log", () => {
    expect(resolveToolProfile("grep")).toBe("grep");
    expect(resolveToolProfile("ripgrep")).toBe("grep");
    expect(resolveToolProfile("run_command:pnpm build")).toBe("build-log");
    expect(resolveToolProfile("vitest")).toBe("build-log");
  });
  it("maps listing tools and falls back to generic", () => {
    expect(resolveToolProfile("ls")).toBe("listing");
    expect(resolveToolProfile("find_files")).toBe("listing");
    expect(resolveToolProfile("some_random_tool")).toBe("generic");
  });
});

describe("compressForTool", () => {
  it("does NOT fold repeated lines for a diff (dedup excluded by profile)", () => {
    const diff = " context\n context\n context\n"; // identical consecutive context lines
    const r = compressForTool("git_diff", diff);
    expect(r.tool).toBe("diff");
    expect(r.applied).not.toContain("dedup-consecutive");
    expect(r.text).not.toContain("⟪×");
  });

  it("DOES fold repeated lines for generic/grep output", () => {
    const out = "match\nmatch\nmatch\n";
    const r = compressForTool("grep", out);
    expect(r.tool).toBe("grep");
    expect(r.applied).toContain("dedup-consecutive");
    expect(r.text).toContain("⟪×3⟫");
  });

  it("is lossless by default for build logs (no truncation unless allowLossy)", () => {
    const log = Array.from({ length: 500 }, (_, i) => `step ${i}`).join("\n");
    const r = compressForTool("pnpm build", log);
    expect(r.tool).toBe("build-log");
    expect(r.lossy).toBe(false);
    expect(r.applied).not.toContain("smart-truncate");
  });

  it("truncates huge build logs only when allowLossy is set", () => {
    const log = Array.from({ length: 500 }, (_, i) => `step ${i}`).join("\n");
    const r = compressForTool("pnpm build", log, { allowLossy: true });
    expect(r.lossy).toBe(true);
    expect(r.applied).toContain("smart-truncate");
    expect(r.text).toContain("lines elided");
    expect(r.compressedTokens).toBeLessThan(r.originalTokens);
  });

  it("strips ANSI from colored output regardless of tool", () => {
    const colored = "[31merror[0m\n";
    const r = compressForTool("git_diff", colored);
    expect(r.text).not.toContain("[31m");
    expect(r.applied).toContain("strip-ansi");
  });
});
