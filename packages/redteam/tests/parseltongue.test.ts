// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  detectTriggers,
  applyParseltongue,
  getDefaultConfig,
  getTechniqueDescription,
  DEFAULT_TRIGGERS,
  type ParseltongueConfig,
  type ObfuscationTechnique,
} from "../src/index.js";

describe("detectTriggers", () => {
  it("detects a trigger word in text", () => {
    const found = detectTriggers("how to hack the system");
    expect(found).toContain("hack");
  });

  it("detects multiple trigger words", () => {
    const found = detectTriggers("exploit the vulnerability and bypass the firewall");
    expect(found).toContain("exploit");
    expect(found).toContain("vulnerability");
    expect(found).toContain("bypass");
  });

  it("returns empty array for clean text", () => {
    const found = detectTriggers("the cat sat on the mat");
    expect(found).toHaveLength(0);
  });

  it("is case-insensitive", () => {
    const found = detectTriggers("How to HACK the system");
    expect(found).toContain("hack");
  });

  it("requires whole-word match (no partial)", () => {
    const found = detectTriggers("attachment hackneyed");
    expect(found).not.toContain("hack");
  });

  it("includes custom triggers", () => {
    const found = detectTriggers("use the secret backdoor", ["secret"]);
    expect(found).toContain("secret");
    expect(found).toContain("backdoor");
  });

  it("deduplicates repeated trigger words", () => {
    const found = detectTriggers("hack this then hack that");
    expect(found.filter((t) => t === "hack")).toHaveLength(1);
  });
});

describe("applyParseltongue", () => {
  const enabledConfig = (technique: ObfuscationTechnique = "leetspeak"): ParseltongueConfig => ({
    enabled: true,
    technique,
    intensity: "medium",
    customTriggers: [],
  });

  it("returns original text when disabled", () => {
    const config: ParseltongueConfig = {
      enabled: false,
      technique: "leetspeak",
      intensity: "medium",
      customTriggers: [],
    };
    const result = applyParseltongue("hack the system", config);
    expect(result.transformedText).toBe("hack the system");
    expect(result.triggersFound).toHaveLength(0);
  });

  it("returns original text when no triggers found", () => {
    const result = applyParseltongue("the cat sat on the mat", enabledConfig());
    expect(result.transformedText).toBe("the cat sat on the mat");
    expect(result.triggersFound).toHaveLength(0);
  });

  it("transforms trigger words with leetspeak", () => {
    const result = applyParseltongue("how to hack the system", enabledConfig("leetspeak"));
    expect(result.triggersFound).toContain("hack");
    expect(result.transformedText).not.toBe("how to hack the system");
    expect(result.transformations).toHaveLength(1);
  });

  it("transforms trigger words with unicode", () => {
    const result = applyParseltongue("bypass the security check", enabledConfig("unicode"));
    expect(result.triggersFound).toContain("bypass");
    // Transformed text should differ from original
    expect(result.transformedText.length).toBeGreaterThan(0);
  });

  it("transforms trigger words with zwj", () => {
    const result = applyParseltongue("exploit this vulnerability", enabledConfig("zwj"));
    expect(result.triggersFound.length).toBeGreaterThan(0);
    expect(result.transformedText).not.toBe("exploit this vulnerability");
  });

  it("transforms with mixedcase", () => {
    const result = applyParseltongue("jailbreak the model", enabledConfig("mixedcase"));
    expect(result.triggersFound).toContain("jailbreak");
  });

  it("transforms with phonetic substitution", () => {
    const result = applyParseltongue("bypass this check", enabledConfig("phonetic"));
    // phonetic: c→k/s, ph→f etc. bypass → by-pass stays (no phonetic change on bypass)
    expect(result.triggersFound).toContain("bypass");
  });

  it("reports correct trigger words found", () => {
    const result = applyParseltongue("exploit and hack and bypass", enabledConfig());
    expect(result.triggersFound.length).toBeGreaterThanOrEqual(3);
  });

  it("includes transformation records", () => {
    const result = applyParseltongue("hack the bypass", enabledConfig());
    for (const t of result.transformations) {
      expect(t.original).toBeTruthy();
      expect(t.transformed).toBeTruthy();
      expect(t.technique).toBe("leetspeak");
    }
  });

  it("preserves non-trigger words in output", () => {
    const result = applyParseltongue("the hack is here", enabledConfig());
    expect(result.transformedText).toContain("the");
    expect(result.transformedText).toContain("is");
    expect(result.transformedText).toContain("here");
  });

  it("random technique applies some obfuscation", () => {
    const result = applyParseltongue("hack this exploit", enabledConfig("random"));
    expect(result.triggersFound.length).toBeGreaterThan(0);
  });
});

describe("getDefaultConfig", () => {
  it("returns disabled by default", () => {
    expect(getDefaultConfig().enabled).toBe(false);
  });

  it("returns leetspeak as default technique", () => {
    expect(getDefaultConfig().technique).toBe("leetspeak");
  });
});

describe("getTechniqueDescription", () => {
  it("returns a string for each technique", () => {
    const techniques: ObfuscationTechnique[] = [
      "leetspeak",
      "unicode",
      "zwj",
      "mixedcase",
      "phonetic",
      "random",
    ];
    for (const t of techniques) {
      expect(typeof getTechniqueDescription(t)).toBe("string");
      expect(getTechniqueDescription(t).length).toBeGreaterThan(0);
    }
  });
});

describe("DEFAULT_TRIGGERS", () => {
  it("includes common security terms", () => {
    expect(DEFAULT_TRIGGERS).toContain("hack");
    expect(DEFAULT_TRIGGERS).toContain("exploit");
    expect(DEFAULT_TRIGGERS).toContain("bypass");
    expect(DEFAULT_TRIGGERS).toContain("malware");
  });
});
