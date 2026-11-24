// SPDX-License-Identifier: Apache-2.0
/** The sandbox page speaks for every image language: each one gets a runnable start. */
import { describe, expect, it } from "vite-plus/test";

import { SNIPPETS } from "~/routes/sandbox";

describe("sandbox snippets", () => {
  it("covers the seven image languages", () => {
    expect(Object.keys(SNIPPETS).sort()).toEqual([
      "bash",
      "go",
      "javascript",
      "python",
      "ruby",
      "rust",
      "typescript",
    ]);
  });

  it("gives each language a non-empty program", () => {
    for (const [language, snippet] of Object.entries(SNIPPETS)) {
      expect(snippet.trim(), language).not.toBe("");
    }
  });

  it("keeps the go, rust and ruby examples in their own syntax", () => {
    expect(SNIPPETS.go).toContain("package main");
    expect(SNIPPETS.rust).toContain("fn main()");
    expect(SNIPPETS.ruby).toContain("def fibonacci");
  });
});
