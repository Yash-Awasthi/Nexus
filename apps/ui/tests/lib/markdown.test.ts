// SPDX-License-Identifier: Apache-2.0
/** Agent replies are Markdown; the thread shows their shape, never their syntax. */
import { describe, expect, it } from "vitest";

import { markdownBlocks, markdownSpans } from "~/lib/markdown";

describe("markdown", () => {
  it("splits headings, lists, fenced code and paragraphs", () => {
    const text = "### Plan\n\n- **Build** the site\n- Launch\n\n1. first\n\n```\nnpm i\n```\nDone.";
    expect(markdownBlocks(text)).toEqual([
      { type: "heading", text: "Plan" },
      { type: "list", ordered: false, items: ["**Build** the site", "Launch"] },
      { type: "list", ordered: true, items: ["first"] },
      { type: "code", text: "npm i" },
      { type: "paragraph", text: "Done." },
    ]);
  });

  it("marks bold, italic and inline code, and leaves the rest as text", () => {
    expect(markdownSpans("a **b** _c_ `d` e")).toEqual([
      { type: "text", text: "a " },
      { type: "strong", text: "b" },
      { type: "text", text: " " },
      { type: "em", text: "c" },
      { type: "text", text: " " },
      { type: "code", text: "d" },
      { type: "text", text: " e" },
    ]);
  });
});
