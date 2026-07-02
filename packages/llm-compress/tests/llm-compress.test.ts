// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, afterEach } from "vitest";
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
  compressHeavy,
  type HeavyPromptCompressor,
  ENGINES,
  liteEngine,
  compressStacked,
  compressStackedAsync,
  compressMode,
  extractPreservedBlocks,
  restorePreservedBlocks,
  type CompressEngine,
  scoreToken,
  pruneByScore,
  ultraEngine,
  cavemanCompress,
  cavemanEngine,
  rtkCompress,
  rtkEngine,
} from "../src/index.js";
import { decode as toonDecode } from "@toon-format/toon";

// Heavy mode's optional deps are NOT installed. Mock them so the real
// `defaultLoadCompressor` path can be exercised without pulling the model.
// `vi.hoisted` lets the (hoisted) `vi.mock` factories share these spies.
const heavyMocks = vi.hoisted(() => {
  const compress_prompt = vi.fn(async (_ctx: string, _opts: { rate?: number }) => "MOCK COMPRESSED");
  const factory = vi.fn(async (_model: string, _cfg: unknown) => ({
    promptCompressor: { compress_prompt },
  }));
  return { compress_prompt, factory };
});
vi.mock("@atjsh/llmlingua-2", () => ({
  LLMLingua2: { WithBERTMultilingual: heavyMocks.factory, WithXLMRoBERTa: heavyMocks.factory },
}));
vi.mock("js-tiktoken/lite", () => ({ Tiktoken: vi.fn() }));
vi.mock("js-tiktoken/ranks/o200k_base", () => ({ default: {} }));

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

describe("compressHeavy (LLMLingua-2, opt-in / off by default)", () => {
  const INPUT = "the quick brown fox jumps over the lazy dog again and again";

  afterEach(() => {
    delete process.env.NEXUS_LLMLINGUA;
    vi.clearAllMocks();
  });

  it("is OFF by default: passthrough, no import, no model touched", async () => {
    // A loader that would throw if ever called — proves the gate short-circuits
    // BEFORE the (mocked) import or any model download.
    const loadCompressor = vi.fn(async (): Promise<HeavyPromptCompressor> => {
      throw new Error("loader must not run when heavy mode is off");
    });
    const r = await compressHeavy(INPUT, { loadCompressor });
    expect(r.enabled).toBe(false);
    expect(r.lossy).toBe(false);
    expect(r.text).toBe(INPUT);
    expect(r.applied).toEqual([]);
    expect(r.savedRatio).toBe(0);
    expect(loadCompressor).not.toHaveBeenCalled();
    expect(heavyMocks.factory).not.toHaveBeenCalled();
  });

  it("stays off even with NEXUS_LLMLINGUA set to anything but '1'", async () => {
    process.env.NEXUS_LLMLINGUA = "true";
    const loadCompressor = vi.fn(async (): Promise<HeavyPromptCompressor> => {
      throw new Error("loader must not run");
    });
    const r = await compressHeavy(INPUT, { loadCompressor });
    expect(r.enabled).toBe(false);
    expect(loadCompressor).not.toHaveBeenCalled();
  });

  it("runs when enabled via opts.enabled, using the injected compressor", async () => {
    const compress_prompt = vi.fn(async () => "brown fox jumps lazy dog");
    const loadCompressor = vi.fn(async (): Promise<HeavyPromptCompressor> => ({ compress_prompt }));
    const r = await compressHeavy(INPUT, { enabled: true, rate: 0.3, loadCompressor });
    expect(loadCompressor).toHaveBeenCalledOnce();
    expect(compress_prompt).toHaveBeenCalledWith(INPUT, { rate: 0.3 });
    expect(r.enabled).toBe(true);
    expect(r.lossy).toBe(true);
    expect(r.text).toBe("brown fox jumps lazy dog");
    expect(r.applied).toEqual(["llmlingua-2"]);
    expect(r.compressedTokens).toBeLessThan(r.originalTokens);
    expect(r.savedRatio).toBeGreaterThan(0);
  });

  it("respects the NEXUS_LLMLINGUA=1 env gate", async () => {
    process.env.NEXUS_LLMLINGUA = "1";
    const compress_prompt = vi.fn(async () => "squeezed");
    const loadCompressor = vi.fn(async (): Promise<HeavyPromptCompressor> => ({ compress_prompt }));
    const r = await compressHeavy(INPUT, { loadCompressor });
    expect(loadCompressor).toHaveBeenCalledOnce();
    expect(r.enabled).toBe(true);
    expect(r.text).toBe("squeezed");
  });

  it("default loader lazily imports the (mocked) @atjsh/llmlingua-2 package", async () => {
    // No injected loader → drives the real defaultLoadCompressor, which dynamically
    // imports @atjsh/llmlingua-2 + js-tiktoken (all mocked above).
    const r = await compressHeavy(INPUT, { enabled: true });
    expect(heavyMocks.factory).toHaveBeenCalledOnce();
    expect(heavyMocks.compress_prompt).toHaveBeenCalledWith(INPUT, { rate: 0.5 });
    expect(r.enabled).toBe(true);
    expect(r.text).toBe("MOCK COMPRESSED");
  });

  it("selects the XLM-RoBERTa factory when model = xlm-roberta", async () => {
    await compressHeavy(INPUT, { enabled: true, model: "xlm-roberta" });
    // Both factory slots point at the same spy; assert it received the larger model id.
    expect(heavyMocks.factory).toHaveBeenCalledWith(
      "atjsh/llmlingua-2-js-xlm-roberta-large-meetingbank",
      expect.anything(),
    );
  });
});

// ── Engine core (§3.2) ──────────────────────────────────────────────────────────

describe("preserved blocks (extract/restore)", () => {
  it("round-trips code fences, inline code, URLs, paths, error lines", () => {
    const input = [
      "Here is code:",
      "```js\nconst a = the thing;\n```",
      "inline `a || b` and see https://example.com/x?y=1 and ./src/index.ts",
      "Error: something broke at line 5",
    ].join("\n");
    const { text, blocks } = extractPreservedBlocks(input);
    expect(blocks.length).toBeGreaterThanOrEqual(4);
    // Masked text must not contain the raw protected content.
    expect(text).not.toContain("```");
    expect(text).not.toContain("https://");
    expect(restorePreservedBlocks(text, blocks)).toBe(input);
  });

  it("a mangling transform on masked text leaves protected spans intact", () => {
    const input = "drop the filler but keep `code_token` and https://a.b/c";
    const { text, blocks } = extractPreservedBlocks(input);
    // Simulate a lossy rule deleting the word "the" — must not touch sentinels.
    const mangled = text.replace(/\bthe\b\s*/g, "");
    const restored = restorePreservedBlocks(mangled, blocks);
    expect(restored).toContain("`code_token`");
    expect(restored).toContain("https://a.b/c");
    expect(restored).not.toMatch(/\bthe\b/);
  });
});

describe("engine registry + lite engine", () => {
  it("registers the lite engine", () => {
    expect(ENGINES.lite).toBe(liteEngine);
    expect(liteEngine.lossless).toBe(true);
  });
  it("lite engine equals the DEFAULT_FILTERS pipeline output", () => {
    const input = "[32mok[0m   \nok   \nok   \n\n\n\n\ndone";
    expect(liteEngine.apply(input)).toBe(compress(input).text);
  });
});

describe("compressStacked", () => {
  const noisy = "[31mERR[0m   \ndup\ndup\ndup\n\n\n\n\ntail";

  it("runs engines in stackPriority order (low first)", () => {
    const order: string[] = [];
    const a: CompressEngine = {
      name: "a",
      stackPriority: 30,
      lossless: true,
      apply: (t) => {
        order.push("a");
        return t.slice(0, -1); // shrink so the step is accepted
      },
    };
    const b: CompressEngine = {
      name: "b",
      stackPriority: 10,
      lossless: true,
      apply: (t) => {
        order.push("b");
        return t.slice(0, -1);
      },
    };
    compressStacked("abcdefgh", [a, b]);
    expect(order).toEqual(["b", "a"]); // b (10) before a (30)
  });

  it("applies lite and reports a per-engine breakdown", () => {
    const r = compressStacked(noisy, ["lite"]);
    expect(r.applied).toContain("lite");
    expect(r.engines).toHaveLength(1);
    expect(r.engines[0]?.name).toBe("lite");
    expect(r.compressedChars).toBeLessThan(r.originalChars);
  });

  it("throws on an unknown engine name", () => {
    expect(() => compressStacked("x", ["nope"])).toThrow(/unknown compress engine/);
  });

  it("inflation guard: an engine that grows the text is skipped, result == input", () => {
    const bloat: CompressEngine = {
      name: "bloat",
      stackPriority: 1,
      lossless: false,
      apply: (t) => t + " EXTRA PADDING ADDED",
    };
    const r = compressStacked("hello world", [bloat]);
    expect(r.text).toBe("hello world");
    expect(r.applied).toEqual([]);
    expect(r.engines[0]?.applied).toBe(false);
    expect(r.engines[0]?.note).toBe("inflates");
  });

  it("bail-out: a below-min-gain step is skipped when minGainPercent is set", () => {
    const tiny: CompressEngine = {
      name: "tiny",
      stackPriority: 1,
      lossless: true,
      apply: (t) => t.replace(/.$/, ""), // drop 1 char — negligible gain
    };
    const long = "x".repeat(400);
    const r = compressStacked(long, [tiny], { minGainPercent: 10 });
    expect(r.applied).toEqual([]);
    expect(r.engines[0]?.note).toMatch(/below-min-gain/);
  });

  it("a throwing engine is skipped (fail-open), not fatal", () => {
    const boom: CompressEngine = {
      name: "boom",
      stackPriority: 1,
      lossless: false,
      apply: () => {
        throw new Error("kaboom");
      },
    };
    const r = compressStacked(noisy, [boom, "lite"]);
    expect(r.engines.find((e) => e.name === "boom")?.note).toMatch(/error:kaboom/);
    expect(r.applied).toContain("lite"); // pipeline continued
  });
});

describe("compressStackedAsync", () => {
  it("prefers applyAsync and still guards inflation", async () => {
    const asyncEng: CompressEngine = {
      name: "async",
      stackPriority: 5,
      lossless: false,
      apply: (t) => t,
      applyAsync: async (t) => t.replace(/\s+/g, " ").trim(),
    };
    const r = await compressStackedAsync("a   b   c   d   e   f", [asyncEng]);
    expect(r.text).toBe("a b c d e f");
    expect(r.applied).toContain("async");
  });
});

describe("compressMode", () => {
  it("off returns input unchanged with no engines applied", () => {
    const r = compressMode("[31mx[0m   ", "off");
    expect(r.text).toBe("[31mx[0m   ");
    expect(r.applied).toEqual([]);
  });
  it("lite runs the lite engine", () => {
    const r = compressMode("ok   \nok   \nplain", "lite");
    expect(r.applied).toContain("lite");
  });
});

// ── ultra engine (§3.3) ─────────────────────────────────────────────────────────

describe("scoreToken", () => {
  it("force-preserves digits, URLs, paths, code, errors (1.0)", () => {
    expect(scoreToken("42")).toBe(1.0);
    expect(scoreToken("v1.2.3")).toBe(1.0);
    expect(scoreToken("https://x.y/z")).toBe(1.0);
    expect(scoreToken("./src/index.ts")).toBe(1.0);
    expect(scoreToken("Error:")).toBe(1.0);
  });
  it("scores stopwords lowest, content words higher", () => {
    expect(scoreToken("the")).toBe(0.1);
    expect(scoreToken("and")).toBe(0.1);
    expect(scoreToken("ok")).toBe(0.2); // <=2 chars
    expect(scoreToken("run")).toBe(0.5); // medium
    expect(scoreToken("database")).toBe(0.7); // long
    expect(scoreToken("Postgres")).toBe(0.8); // capitalized
  });
  it("strips surrounding punctuation before the stopword check", () => {
    expect(scoreToken("the,")).toBe(0.1);
    expect(scoreToken("(and)")).toBe(0.1);
  });
});

describe("pruneByScore", () => {
  it("drops stopwords first and keeps content words", () => {
    const out = pruneByScore("the quick brown fox and the lazy dog", 0.5);
    expect(out).not.toMatch(/\bthe\b/);
    expect(out).toContain("quick");
    expect(out).toContain("brown");
    expect(out).toContain("fox");
  });
  it("keeps everything at keepRate 1.0", () => {
    const input = "the quick brown fox";
    expect(pruneByScore(input, 1.0)).toBe(input);
  });
  it("never drops high-signal tokens even at aggressive keepRate", () => {
    const out = pruneByScore("please fetch the file from https://api.example.com/v2 now", 0.1);
    expect(out).toContain("https://api.example.com/v2");
  });
});

describe("ultra engine", () => {
  it("is registered at stackPriority 40 and is lossy", () => {
    expect(ENGINES.ultra).toBe(ultraEngine);
    expect(ultraEngine.stackPriority).toBe(40);
    expect(ultraEngine.lossless).toBe(false);
  });
  it("preserves code fences, URLs and numbers while dropping filler", () => {
    const input = "Please note that the value is really just `x = 42` and see https://a.b/c";
    const out = ultraEngine.apply(input, { keepRate: 0.4 });
    expect(out).toContain("`x = 42`");
    expect(out).toContain("https://a.b/c");
    expect(out).not.toMatch(/\bthat\b/);
  });
  it("via compressStacked shrinks prose and reports ultra applied", () => {
    const prose =
      "I would really just like to note that the function is basically a very simple helper.";
    const r = compressStacked(prose, ["ultra"], { ctx: { keepRate: 0.5 } });
    expect(r.applied).toContain("ultra");
    expect(r.compressedChars).toBeLessThan(r.originalChars);
  });
});

// ── caveman engine (§3.4) ───────────────────────────────────────────────────────

describe("caveman engine", () => {
  it("is registered at stackPriority 20 and is lossy", () => {
    expect(ENGINES.caveman).toBe(cavemanEngine);
    expect(cavemanEngine.stackPriority).toBe(20);
    expect(cavemanEngine.lossless).toBe(false);
  });

  it("removes pleasantries, polite framing and filler adverbs", () => {
    const out = cavemanCompress("Please could you just basically fix the bug.", "full");
    expect(out).not.toMatch(/please/i);
    expect(out).not.toMatch(/basically/i);
    expect(out).not.toMatch(/could you/i);
    expect(out).toMatch(/fix/i);
    expect(out).toMatch(/bug/i);
  });

  it("leaves code fences and URLs untouched", () => {
    const input = "Please run `npm install` and then see https://x.io/docs now.";
    const out = cavemanCompress(input, "ultra");
    expect(out).toContain("`npm install`");
    expect(out).toContain("https://x.io/docs");
  });

  it("escalates by intensity (articles + abbreviations only at higher tiers)", () => {
    const input = "the database configuration is ready";
    const lite = cavemanCompress(input, "lite");
    expect(lite).toContain("database"); // no article-drop / abbrev at lite
    const ultra = cavemanCompress(input, "ultra");
    expect(ultra).toContain("DB");
    expect(ultra).toContain("config");
    expect(ultra).not.toMatch(/\bdatabase\b/);
    expect(ultra).not.toMatch(/^the /i); // article dropped
  });

  it("is a no-op (lossless) on a pure code block", () => {
    const code = "```js\nconst a = the value;\n```";
    expect(cavemanCompress(code, "ultra")).toBe(code);
  });

  it("recapitalizes the sentence start after leading filler is removed", () => {
    const out = cavemanCompress("Basically the answer is 42.", "full");
    expect(out[0]).toBe(out[0]?.toUpperCase());
    expect(out).toContain("42");
  });

  it("via compressStacked with intensity ctx shrinks prose", () => {
    const prose = "Please note that I would like you to essentially refactor the parser.";
    const r = compressStacked(prose, ["caveman"], { ctx: { intensity: "full" } });
    expect(r.applied).toContain("caveman");
    expect(r.compressedChars).toBeLessThan(r.originalChars);
  });
});

// ── rtk engine (§3.5) ───────────────────────────────────────────────────────────

describe("rtk engine", () => {
  it("is registered at stackPriority 10 and is lossy", () => {
    expect(ENGINES.rtk).toBe(rtkEngine);
    expect(rtkEngine.stackPriority).toBe(10);
    expect(rtkEngine.lossless).toBe(false);
  });

  it("keeps TS errors while dropping blank/progress noise (tsc ruleset)", () => {
    const log = [
      "Compiling...",
      "",
      "src/index.ts(12,5): error TS2345: Argument of type 'string'.",
      "",
      "",
      "42 files checked",
    ].join("\n");
    const out = rtkCompress(log, { toolName: "tsc" });
    expect(out).toContain("error TS2345");
    expect(out).not.toContain("42 files checked");
    expect(out.split("\n").filter((l) => l === "").length).toBe(0); // blanks gone
  });

  it("keep patterns take precedence over drop patterns", () => {
    // A generic ruleset drops blank lines but must keep an error line regardless.
    const out = rtkCompress("ok\n\nError: boom\n\ndone", {});
    expect(out).toContain("Error: boom");
  });

  it("truncates very long output to head+tail with an elision marker", () => {
    const big = Array.from({ length: 400 }, (_, i) => `line ${i} unique`).join("\n");
    const out = rtkCompress(big, { maxLines: 100 });
    expect(out).toContain("line 0 unique");
    expect(out).toContain("line 399 unique");
    expect(out).toContain("elided");
    expect(out.length).toBeLessThan(big.length);
  });

  it("enforces the hard character cap", () => {
    const huge = "x".repeat(20000); // single long line, no newlines to filter
    const out = rtkCompress(huge, { maxChars: 5000 });
    expect(out.length).toBeLessThanOrEqual(5000 + "\n...[truncated]".length);
    expect(out).toContain("[truncated]");
  });

  it("via compressStacked routes by ctx.toolName", () => {
    const log = ["added 42 packages", "", "", "npm warn deprecated foo@1.0.0", ""].join("\n");
    const r = compressStacked(log, ["rtk"], { ctx: { toolName: "npm install" } });
    expect(r.applied).toContain("rtk");
    expect(r.text).toContain("added 42 packages");
    expect(r.text).not.toContain("deprecated");
  });
});
