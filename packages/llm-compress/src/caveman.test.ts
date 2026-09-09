// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";

import { compressCaveman, makeCavemanFilter } from "./caveman.js";
import {
  cavemanOutput,
  compressPreset,
  estimateTokens,
  injectSystemPrompt,
  ponytail,
  terseOutput,
} from "./index.js";

describe("compressCaveman — filler removal", () => {
  it("removes filler words and condenses verbose phrases", () => {
    const input =
      "Please basically just write the code. In order to fix the bug, as a result of the failed deploy, " +
      "we need to check the logs. Actually, I think the issue is clear.";
    const out = compressCaveman(input);
    expect(out).not.toMatch(/\bplease\b/i);
    expect(out).not.toMatch(/\bbasically\b/i);
    expect(out).not.toMatch(/\bI think\b/i);
    expect(out).not.toMatch(/\bIn order to\b/i);
    expect(out).toMatch(/\bto fix the bug\b/i);
    expect(out).toMatch(/\bbecause\b/i);
    expect(out.length).toBeLessThan(input.length);
  });

  it("condenses polite hedging and connectors", () => {
    const hedged =
      "Would you mind if I asked you to please check the deployment logs and verify the health endpoint returns ok?";
    const out = compressCaveman(hedged);
    expect(out).not.toContain("Would you mind");
    expect(out).not.toContain("please");
    // Long enough to clear the savings gate; the substance survives.
    expect(out).toContain("check the deployment logs");
    expect(out).toContain("health endpoint");
  });

  it("preserves code blocks, inline code, URLs, paths, and JSON byte-identical", () => {
    const code = "```python\ndef please_wait(just: int):\n    return just + 1\n```";
    const input =
      `Please review this snippet: ${code}. ` +
      "See https://example.com/fix?q=basically for details, in /usr/src/app/main.ts. " +
      'The payload is {"kindOf": "basically", "please": true}.';
    const out = compressCaveman(input);
    expect(out).toContain(code);
    expect(out).toContain("https://example.com/fix?q=basically");
    expect(out).toContain("/usr/src/app/main.ts");
    expect(out).toContain('{"kindOf": "basically", "please": true}');
  });

  it("never touches identifiers (word boundaries + masking)", () => {
    const out = compressCaveman("const pleaseWait = basically() // kindOf flag");
    expect(out).toContain("pleaseWait");
    expect(out).toContain("basically()");
    expect(out).toContain("kindOf");
  });

  it("returns the input unchanged when savings are below the gate", () => {
    const input = "Short text.";
    expect(compressCaveman(input)).toBe(input);
    expect(compressCaveman("a b c", { minSaveChars: 100 })).toBe("a b c");
  });

  it("is honest about lossy-ness and reports token savings", () => {
    const filter = makeCavemanFilter();
    expect(filter.lossless).toBe(false);
    expect(filter.name).toBe("caveman");
    const input =
      "Please basically just check the logs. In order to fix it, note that we need to rerun.";
    const out = filter.apply(input);
    expect(estimateTokens(out)).toBeLessThanOrEqual(estimateTokens(input));
  });

  it("rides the preset pipeline", () => {
    const input =
      "Please note that the build failed because of the fact that the deploy timed out. " +
      "However, we can fix it by checking the logs and rerunning the pipeline.";
    const res = compressPreset(input, "caveman");
    expect(res.applied).toContain("caveman");
    expect(res.text).not.toContain("Please note");
    expect(res.text).not.toContain("However");
    expect(res.text).toContain("build failed");
  });
});

describe("output-style injectors (caveman-ponytail parity)", () => {
  it("injects ponytail and caveman-output blocks into a system prompt", () => {
    const base = "You are a mission agent.";
    const withStyles = injectSystemPrompt(base, ["ponytail", "caveman-output"]);
    expect(withStyles).toContain("best code is the code never written");
    expect(withStyles).toContain("Reply in minimal words");
    expect(withStyles.startsWith(base)).toBe(true);
  });

  it("is idempotent — re-injecting is a no-op", () => {
    const once = injectSystemPrompt("base", ["ponytail"]);
    const twice = injectSystemPrompt(once, ["ponytail"]);
    expect(twice).toBe(once);
  });

  it("keeps existing injectors working", () => {
    const out = injectSystemPrompt("base", ["terse-output", "ponytail"]);
    expect(out).toContain("Be terse");
    expect(out).toContain("code never written");
  });

  it("returns the base unchanged when no injectors are requested", () => {
    expect(injectSystemPrompt("base", [])).toBe("base");
  });

  it("exports all four injectors", () => {
    expect(terseOutput.name).toBe("terse-output");
    expect(cavemanOutput.name).toBe("caveman-output");
    expect(ponytail.name).toBe("ponytail");
  });
});
