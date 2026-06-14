// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  LLMAISelector,
  NullAISelector,
  CascadeSelector,
  AISelectorError,
  truncateHtml,
  type IAISelector,
  type LLMProvider,
  type LLMRequest,
  type ElementSelectorRequest,
  type StaticSelector,
} from "../src/index.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeLLM(responseContent: string): LLMProvider {
  return {
    name: "mock-llm",
    models: ["gpt-4o"],
    async complete(_req: LLMRequest) {
      return { content: responseContent };
    },
  };
}

const SAMPLE_HTML = `
<html><body>
  <div class="product">
    <h1 class="product-title">Widget Pro</h1>
    <span class="price">$29.99</span>
    <button class="add-to-cart" id="atc-btn">Add to Cart</button>
  </div>
</body></html>`;

function makeRequest(overrides: Partial<ElementSelectorRequest> = {}): ElementSelectorRequest {
  return {
    html: SAMPLE_HTML,
    description: "the Add to Cart button",
    ...overrides,
  };
}

// ── truncateHtml ──────────────────────────────────────────────────────────────

describe("truncateHtml", () => {
  it("strips script tags", () => {
    const html = '<div>hello</div><script>alert("xss")</script>';
    expect(truncateHtml(html)).not.toContain("<script>");
    expect(truncateHtml(html)).toContain("hello");
  });

  it("strips style tags", () => {
    const html = "<style>body{color:red}</style><p>text</p>";
    expect(truncateHtml(html)).not.toContain("<style>");
    expect(truncateHtml(html)).toContain("text");
  });

  it("strips HTML comments", () => {
    const html = "<!-- secret -->  <p>visible</p>";
    expect(truncateHtml(html)).not.toContain("secret");
    expect(truncateHtml(html)).toContain("visible");
  });

  it("collapses whitespace", () => {
    const html = "<p>  hello   world  </p>";
    expect(truncateHtml(html)).toBe("<p> hello world </p>");
  });

  it("truncates to maxChars and appends ellipsis marker", () => {
    const html = "<p>" + "a".repeat(10000) + "</p>";
    const result = truncateHtml(html, 100);
    expect(result.length).toBeLessThanOrEqual(115); // 100 + "…[truncated]"
    expect(result).toContain("…[truncated]");
  });

  it("returns unchanged HTML when under limit", () => {
    const html = "<p>short</p>";
    expect(truncateHtml(html, 1000)).toBe("<p>short</p>");
  });
});

// ── LLMAISelector ─────────────────────────────────────────────────────────────

describe("LLMAISelector", () => {
  it("parses valid JSON response from LLM", async () => {
    const llm = makeLLM('{"selector":".add-to-cart","strategy":"css","confidence":0.95,"explanation":"Has class add-to-cart"}');
    const sel = new LLMAISelector(llm, { model: "gpt-4o" });
    const result = await sel.find(makeRequest());
    expect(result).toBeDefined();
    expect(result?.selector).toBe(".add-to-cart");
    expect(result?.strategy).toBe("css");
    expect(result?.confidence).toBe(0.95);
    expect(result?.explanation).toContain("add-to-cart");
  });

  it("returns undefined when LLM says element not found (confidence 0)", async () => {
    const llm = makeLLM('{"selector":"","strategy":"css","confidence":0,"explanation":"Element not found"}');
    const sel = new LLMAISelector(llm, { model: "gpt-4o" });
    expect(await sel.find(makeRequest())).toBeUndefined();
  });

  it("returns undefined when LLM returns unparseable response", async () => {
    const llm = makeLLM("I cannot find that element on this page.");
    const sel = new LLMAISelector(llm, { model: "gpt-4o" });
    expect(await sel.find(makeRequest())).toBeUndefined();
  });

  it("handles JSON embedded in prose (extracts first object)", async () => {
    const llm = makeLLM('Sure! Here you go: {"selector":"#atc-btn","strategy":"css","confidence":0.9,"explanation":"by id"}. Hope that helps!');
    const sel = new LLMAISelector(llm, { model: "gpt-4o" });
    const result = await sel.find(makeRequest());
    expect(result?.selector).toBe("#atc-btn");
  });

  it("findAll parses JSON array response", async () => {
    const llm = makeLLM('[{"selector":".add-to-cart","strategy":"css","confidence":0.95},{"selector":"#atc-btn","strategy":"css","confidence":0.85}]');
    const sel = new LLMAISelector(llm, { model: "gpt-4o" });
    const results = await sel.findAll(makeRequest());
    expect(results).toHaveLength(2);
    expect(results[0]?.selector).toBe(".add-to-cart");
    expect(results[1]?.selector).toBe("#atc-btn");
  });

  it("findAll returns empty array on parse failure", async () => {
    const llm = makeLLM("No elements found.");
    const sel = new LLMAISelector(llm, { model: "gpt-4o" });
    expect(await sel.findAll(makeRequest())).toHaveLength(0);
  });

  it("findAll sorts by confidence descending", async () => {
    const llm = makeLLM('[{"selector":"a","strategy":"css","confidence":0.5},{"selector":"b","strategy":"css","confidence":0.9}]');
    const sel = new LLMAISelector(llm, { model: "gpt-4o" });
    const results = await sel.findAll(makeRequest());
    expect(results[0]?.confidence).toBeGreaterThan(results[1]?.confidence ?? 0);
  });

  it("findAll filters out zero-confidence results", async () => {
    const llm = makeLLM('[{"selector":".good","strategy":"css","confidence":0.8},{"selector":"","strategy":"css","confidence":0}]');
    const sel = new LLMAISelector(llm, { model: "gpt-4o" });
    const results = await sel.findAll(makeRequest());
    expect(results).toHaveLength(1);
    expect(results[0]?.selector).toBe(".good");
  });

  it("truncates HTML before sending to LLM", async () => {
    const capturedRequests: LLMRequest[] = [];
    const llm: LLMProvider = {
      name: "spy",
      models: ["gpt-4o"],
      async complete(req) {
        capturedRequests.push(req);
        return { content: '{"selector":".x","strategy":"css","confidence":0.5}' };
      },
    };
    const longHtml = "<div>" + "a".repeat(20000) + "</div>";
    const sel = new LLMAISelector(llm, { model: "gpt-4o", maxHtmlChars: 500 });
    await sel.find({ html: longHtml, description: "a div" });
    const prompt = capturedRequests[0]?.messages[0]?.content ?? "";
    expect(prompt).toContain("…[truncated]");
  });

  it("passes temperature and maxTokens to LLM", async () => {
    const capturedRequests: LLMRequest[] = [];
    const llm: LLMProvider = {
      name: "spy",
      models: ["gpt-4o"],
      async complete(req) {
        capturedRequests.push(req);
        return { content: '{"selector":".x","strategy":"css","confidence":0.5}' };
      },
    };
    const sel = new LLMAISelector(llm, { model: "gpt-4o", maxTokens: 256, temperature: 0 });
    await sel.find(makeRequest());
    expect(capturedRequests[0]?.maxTokens).toBe(256);
    expect(capturedRequests[0]?.temperature).toBe(0);
  });

  it("includes few-shot examples in prompt", async () => {
    const capturedRequests: LLMRequest[] = [];
    const llm: LLMProvider = {
      name: "spy",
      models: ["gpt-4o"],
      async complete(req) {
        capturedRequests.push(req);
        return { content: '{"selector":".x","strategy":"css","confidence":0.5}' };
      },
    };
    const sel = new LLMAISelector(llm, { model: "gpt-4o" });
    await sel.find({
      ...makeRequest(),
      examples: [{ description: "price", selector: ".price", strategy: "css" }],
    });
    expect(capturedRequests[0]?.messages[0]?.content).toContain(".price");
  });

  it("includes hint in prompt", async () => {
    const captured: LLMRequest[] = [];
    const llm: LLMProvider = { name: "spy", models: ["gpt-4o"], async complete(req) { captured.push(req); return { content: '{"selector":".x","strategy":"css","confidence":0.5}' }; } };
    const sel = new LLMAISelector(llm, { model: "gpt-4o" });
    await sel.find({ ...makeRequest(), hint: "checkout flow button" });
    expect(captured[0]?.messages[0]?.content).toContain("checkout flow button");
  });

  it("implements IAISelector interface", () => {
    const llm = makeLLM("");
    const sel: IAISelector = new LLMAISelector(llm, { model: "gpt-4o" });
    expect(typeof sel.find).toBe("function");
    expect(typeof sel.findAll).toBe("function");
  });
});

// ── NullAISelector ────────────────────────────────────────────────────────────

describe("NullAISelector", () => {
  const sel = new NullAISelector();

  it("find always returns undefined", async () => {
    expect(await sel.find(makeRequest())).toBeUndefined();
  });

  it("findAll always returns empty array", async () => {
    expect(await sel.findAll(makeRequest())).toHaveLength(0);
  });
});

// ── CascadeSelector ───────────────────────────────────────────────────────────

describe("CascadeSelector", () => {
  const STATICS: StaticSelector[] = [
    { selector: ".add-to-cart", strategy: "css" },
    { selector: ".buy-now", strategy: "css" },
  ];

  it("returns static selector when it validates against HTML", async () => {
    const cascade = new CascadeSelector({
      statics: STATICS,
      ai: new NullAISelector(),
      validate: (s, html) => html.includes(s.selector.slice(1)), // strip leading dot
    });
    const result = await cascade.find({ html: '<button class="add-to-cart">Buy</button>', description: "buy button" });
    expect(result?.selector).toBe(".add-to-cart");
    expect(result?.confidence).toBe(1.0);
  });

  it("falls back to AI when all statics fail", async () => {
    const mockAI: IAISelector = {
      async find() { return { selector: "#ai-found", strategy: "css", confidence: 0.8 }; },
      async findAll() { return []; },
    };
    const cascade = new CascadeSelector({
      statics: STATICS,
      ai: mockAI,
      validate: () => false, // all statics fail
    });
    const result = await cascade.find(makeRequest());
    expect(result?.selector).toBe("#ai-found");
  });

  it("returns null AI result when both static and AI fail", async () => {
    const cascade = new CascadeSelector({
      statics: STATICS,
      ai: new NullAISelector(),
      validate: () => false,
    });
    expect(await cascade.find(makeRequest())).toBeUndefined();
  });

  it("findAll returns static hits before AI", async () => {
    const cascade = new CascadeSelector({
      statics: [
        { selector: ".add-to-cart", strategy: "css" },
        { selector: ".buy-now", strategy: "css" },
      ],
      ai: new NullAISelector(),
      validate: (s, html) => s.selector === ".add-to-cart" && html.includes("add-to-cart"),
    });
    const results = await cascade.findAll({ html: '<button class="add-to-cart">Buy</button>', description: "buy" });
    expect(results).toHaveLength(1);
    expect(results[0]?.selector).toBe(".add-to-cart");
  });

  it("findAll falls back to AI when no statics match", async () => {
    const mockAI: IAISelector = {
      async find() { return undefined; },
      async findAll() { return [{ selector: "#x", strategy: "css", confidence: 0.7 }]; },
    };
    const cascade = new CascadeSelector({
      statics: STATICS,
      ai: mockAI,
      validate: () => false,
    });
    const results = await cascade.findAll(makeRequest());
    expect(results[0]?.selector).toBe("#x");
  });
});

// ── AISelectorError ───────────────────────────────────────────────────────────

describe("AISelectorError", () => {
  it("has correct name and code", () => {
    const e = new AISelectorError("parse failed", "PARSE_ERROR", { raw: "..." });
    expect(e.name).toBe("AISelectorError");
    expect(e.code).toBe("PARSE_ERROR");
    expect(e instanceof Error).toBe(true);
  });
});
