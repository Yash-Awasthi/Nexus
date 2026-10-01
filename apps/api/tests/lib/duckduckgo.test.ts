// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { parseDuckDuckGo } from "../../src/lib/duckduckgo.js";

const result = (url: string, title: string, snippet: string) => `
  <div class="result results_links web-result">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(url)}&amp;rut=abc">${title}</a>
    </h2>
    <a class="result__url" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(url)}&amp;rut=abc">${url}</a>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(url)}">${snippet}</a>
  </div>`;

describe("parseDuckDuckGo", () => {
  it("unwraps result links and keeps titles and snippets as text", () => {
    const html =
      `<div class="result result--ad"><a class="result__a" href="https://duckduckgo.com/y.js?ad_domain=x">Ad</a></div>` +
      result(
        "https://en.wikipedia.org/wiki/Boiling_point",
        "Boiling point - <b>Wikipedia</b>",
        "Water boils at <b>100 &deg;C</b> &amp; more &amp;lt;b&amp;gt;",
      ) +
      result("https://example.org/a?b=1&c=2", "Second", "Two") +
      result("https://en.wikipedia.org/wiki/Boiling_point", "Duplicate", "Again");

    const hits = parseDuckDuckGo(html);

    expect(hits.map((h) => h.url)).toEqual([
      "https://en.wikipedia.org/wiki/Boiling_point",
      "https://example.org/a?b=1&c=2",
    ]);
    expect(hits[0]).toMatchObject({
      title: "Boiling point - Wikipedia",
      snippet: "Water boils at 100 &deg;C & more &lt;b&gt;",
    });
  });

  it("finds nothing on a page with no results", () => {
    expect(parseDuckDuckGo("<html><body>No results.</body></html>")).toEqual([]);
  });
});
