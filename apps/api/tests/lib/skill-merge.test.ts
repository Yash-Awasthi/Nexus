// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import {
  estimateTokens,
  mergeReport,
  mergeSkillCodes,
  pickLanguage,
  polishMergedSkill,
  type PolishDriver,
  type SkillSource,
} from "../../src/lib/skill-merge.js";

const s1: SkillSource = {
  id: "a",
  name: "Scraper",
  description: "Scrape pages",
  language: "Python",
  code: `import requests
import re

def scrape(url):
    resp = requests.get(url, timeout=10)
    return resp.text

def clean(html):
    return re.sub(r"<[^>]+>", "", html)
`,
};

const s2: SkillSource = {
  id: "b",
  name: "Parser",
  description: "Parse links",
  language: "Python",
  code: `import requests
import re

def links(html):
    return re.findall(r"href=\\"([^\\"]+)\\"", html)

def title(html):
    m = re.search(r"<title>(.*?)</title>", html)
    return m.group(1) if m else ""
`,
};

describe("skill-merge", () => {
  it("dedupes shared import lines and preserves per-skill sections", () => {
    const merged = mergeSkillCodes([s1, s2]);
    expect(merged).toContain("import requests");
    expect(merged).toContain("import re");
    // Dedupe: each import appears exactly once across the whole merged body.
    const importRequests = merged.split("\n").filter((l) => l.trim() === "import requests");
    expect(importRequests).toHaveLength(1);
    const importRe = merged.split("\n").filter((l) => l.trim() === "import re");
    expect(importRe).toHaveLength(1);
    // Sections carry the source names.
    expect(merged).toContain("── Scraper");
    expect(merged).toContain("── Parser");
    // Both capabilities survive.
    expect(merged).toContain("def scrape(");
    expect(merged).toContain("def links(");
    // Header comment follows the language (Python → #, not C-style //).
    expect(merged.startsWith("# Merged skill")).toBe(true);
    expect(merged).toContain("# ── Scraper");
    expect(merged).not.toContain("//");
  });

  it("single skill returns its code unchanged", () => {
    expect(mergeSkillCodes([s1])).toBe(s1.code);
  });

  it("empty input degrades gracefully", () => {
    expect(mergeSkillCodes([])).toContain("No skills");
  });

  it("pickLanguage: unanimous, majority, and fallback", () => {
    expect(pickLanguage([s1, s2])).toBe("Python");
    expect(
      pickLanguage([
        { ...s1, language: "TypeScript" },
        { ...s2, language: "TypeScript" },
        { ...s2, language: "JavaScript" },
      ]),
    ).toBe("TypeScript");
    expect(pickLanguage([{ ...s1, language: "" }])).toBe("Python");
  });

  it("mergeReport computes honest token estimates and savings", () => {
    const merged = mergeSkillCodes([s1, s2]);
    const report = mergeReport([s1, s2], merged);
    expect(report.inputTokens).toBe(estimateTokens(s1.code) + estimateTokens(s2.code));
    expect(report.outputTokens).toBe(estimateTokens(merged));
    expect(report.estimatedTokensSaved).toBe(Math.max(0, report.inputTokens - report.outputTokens));
    expect(report.sources).toHaveLength(2);
  });
});

describe("skill-merge polish", () => {
  const driverWith = (
    content: string,
    extra: Partial<Parameters<PolishDriver["complete"]>[0]> = {},
  ): PolishDriver => ({
    complete: async (_opts) => ({
      content,
      usage: { inputTokens: 123, outputTokens: 45 },
      servedBy: "openrouter",
      ...extra,
    }),
  });

  it("polish success: LLM result merged in with fences stripped, servedBy + usage recorded", async () => {
    const driver = driverWith(
      'Here is the merged skill:\n```python\nimport requests\n\ndef fetch(url):\n    """Fetch a URL."""\n    return requests.get(url, timeout=10).text\n```\n',
    );
    const res = await polishMergedSkill([s1, s2], driver, { model: "m1" });
    expect(res.polished).toBe(true);
    expect(res.error).toBeUndefined();
    expect(res.code).toContain("import requests");
    expect(res.code).toContain("def fetch(");
    // Fences and prose are gone.
    expect(res.code).not.toContain("```");
    expect(res.code).not.toContain("Here is the merged skill");
    expect(res.servedBy).toBe("openrouter");
    expect(res.polishTokens).toEqual({ inputTokens: 123, outputTokens: 45 });
  });

  it("polish without driver usage falls back to chars/4 estimates", async () => {
    const driver = driverWith("def x():\n    return 1\n", { usage: undefined });
    const res = await polishMergedSkill([s1, s2], driver, { model: "m1" });
    expect(res.polished).toBe(true);
    expect(res.polishTokens.inputTokens).toBeGreaterThan(0);
    expect(res.polishTokens.outputTokens).toBeGreaterThan(0);
  });

  it("polish failure: provider error degrades to polished:false with an honest error", async () => {
    const driver: PolishDriver = {
      complete: async () => {
        throw new Error("AUTH_FAILED: bad key");
      },
    };
    const res = await polishMergedSkill([s1, s2], driver, { model: "m1" });
    expect(res.polished).toBe(false);
    expect(res.code).toBe("");
    expect(res.error).toContain("AUTH_FAILED");
  });

  it("polish timeout: a hung provider is bounded and degrades to fallback", async () => {
    const driver: PolishDriver = {
      complete: () => new Promise(() => {}), // never settles
    };
    const res = await polishMergedSkill([s1, s2], driver, { model: "m1", timeoutMs: 20 });
    expect(res.polished).toBe(false);
    expect(res.code).toBe("");
    expect(res.error).toContain("timed out after 20ms");
  });

  it("polish empty result degrades to fallback with an honest error", async () => {
    const driver = driverWith("   \n```\n```\n  ");
    const res = await polishMergedSkill([s1, s2], driver, { model: "m1" });
    expect(res.polished).toBe(false);
    expect(res.code).toBe("");
    expect(res.error).toContain("empty");
  });
});
