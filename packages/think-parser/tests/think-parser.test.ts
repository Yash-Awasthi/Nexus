// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import {
  ThinkTagParser,
  splitThinking,
  collectChunks,
  extractThinking,
  extractText,
  type ContentChunk,
} from "../src/index.js";

// ── ThinkTagParser — one-shot ──────────────────────────────────────────────

describe("ThinkTagParser — one-shot feed + flush", () => {
  let p: ThinkTagParser;
  beforeEach(() => {
    p = new ThinkTagParser();
  });

  it("plain text emits single TEXT chunk", () => {
    const chunks = [...p.feed("hello world"), ...p.flush()];
    expect(chunks).toEqual([{ type: "TEXT", text: "hello world" }]);
  });

  it("pure think block emits single THINKING chunk", () => {
    const chunks = [...p.feed("<think>step one</think>"), ...p.flush()];
    expect(chunks).toEqual([{ type: "THINKING", text: "step one" }]);
  });

  it("think then text produces THINKING + TEXT", () => {
    const chunks = [...p.feed("<think>reason</think>answer"), ...p.flush()];
    expect(chunks.map((c) => c.type)).toEqual(["THINKING", "TEXT"]);
    expect(chunks[0]!.text).toBe("reason");
    expect(chunks[1]!.text).toBe("answer");
  });

  it("text before think produces TEXT + THINKING", () => {
    const chunks = [...p.feed("prefix<think>reason</think>"), ...p.flush()];
    expect(chunks.map((c) => c.type)).toEqual(["TEXT", "THINKING"]);
  });

  it("multiple think blocks", () => {
    const chunks = [...p.feed("<think>a</think>mid<think>b</think>end"), ...p.flush()];
    expect(chunks.map((c) => c.type)).toEqual(["THINKING", "TEXT", "THINKING", "TEXT"]);
  });

  it("empty think block", () => {
    const chunks = [...p.feed("<think></think>text"), ...p.flush()];
    const types = chunks.filter((c) => c.text !== "").map((c) => c.type);
    expect(types).toContain("TEXT");
  });

  it("flush emits remaining buffer as TEXT when outside think", () => {
    // Feed text ending with '<' — triggers holdback (potential partial tag)
    const fromFeed = p.feed("partial<");
    // "partial" emits from feed, "<" is held; flush releases the held "<"
    const flushed = p.flush();
    const allText = [...fromFeed, ...flushed]
      .filter((c) => c.type === "TEXT")
      .map((c) => c.text)
      .join("");
    expect(allText).toContain("partial");
    expect(allText).toContain("<");
  });

  it("flush emits remaining as THINKING when inside think", () => {
    // Feed think tag with trailing '<' at end — held back in buffer
    const fromFeed = p.feed("<think>reasoning<");
    // "reasoning" may emit; "<" is held back as potential partial </think>
    const flushed = p.flush();
    const all = [...fromFeed, ...flushed];
    // Combined output must include THINKING content
    expect(all.some((c) => c.type === "THINKING")).toBe(true);
  });

  it("isInsideThink is true after partial open tag content", () => {
    p.feed("<think>partial");
    expect(p.isInsideThink()).toBe(true);
  });

  it("isInsideThink is false after close tag", () => {
    p.feed("<think>x</think>");
    // drain happens during feed
    expect(p.isInsideThink()).toBe(false);
  });

  it("reset clears state", () => {
    p.feed("<think>something");
    p.reset();
    expect(p.isInsideThink()).toBe(false);
    expect(p.getBuffer()).toBe("");
  });
});

// ── ThinkTagParser — chunked streaming ────────────────────────────────────

describe("ThinkTagParser — chunk-boundary buffering", () => {
  it("tag split across chunks is handled correctly", () => {
    const p = new ThinkTagParser();
    const chunks1 = p.feed("pre<thi"); // partial <think>
    const chunks2 = p.feed("nk>reasoning</think>post");
    const flushed = p.flush();
    const all = [...chunks1, ...chunks2, ...flushed];
    const types = all.filter((c) => c.text !== "").map((c) => c.type);
    expect(types).toContain("THINKING");
    expect(types).toContain("TEXT");
  });

  it("close tag split across chunks", () => {
    const p = new ThinkTagParser();
    p.feed("<think>reason</thi");
    const c2 = p.feed("nk>after");
    const flushed = p.flush();
    const all = [...c2, ...flushed];
    const text = all.find((c) => c.type === "TEXT");
    expect(text?.text).toContain("after");
  });

  it("single-character chunks produce correct output", () => {
    const p = new ThinkTagParser();
    const input = "<think>hi</think>ok";
    const chunks: ContentChunk[] = [];
    for (const char of input) chunks.push(...p.feed(char));
    chunks.push(...p.flush());
    const thinking = chunks
      .filter((c) => c.type === "THINKING")
      .map((c) => c.text)
      .join("");
    const text = chunks
      .filter((c) => c.type === "TEXT")
      .map((c) => c.text)
      .join("");
    expect(thinking).toContain("hi");
    expect(text).toContain("ok");
  });

  it("two-chunk split right at <think> boundary", () => {
    const p = new ThinkTagParser();
    const c1 = p.feed("before<think>");
    const c2 = p.feed("inside</think>after");
    const all = [...c1, ...c2, ...p.flush()];
    const text = all
      .filter((c) => c.type === "TEXT")
      .map((c) => c.text)
      .join("");
    const thinking = all
      .filter((c) => c.type === "THINKING")
      .map((c) => c.text)
      .join("");
    expect(text).toContain("before");
    expect(text).toContain("after");
    expect(thinking).toContain("inside");
  });
});

// ── splitThinking ──────────────────────────────────────────────────────────

describe("splitThinking", () => {
  it("returns TEXT for plain string", () => {
    const chunks = splitThinking("hello");
    expect(chunks).toEqual([{ type: "TEXT", text: "hello" }]);
  });

  it("returns THINKING + TEXT for think-prefixed string", () => {
    const chunks = splitThinking("<think>reason</think>answer");
    expect(chunks[0]!.type).toBe("THINKING");
    expect(chunks[1]!.type).toBe("TEXT");
  });

  it("empty string returns empty array", () => {
    expect(splitThinking("").filter((c) => c.text !== "")).toHaveLength(0);
  });
});

// ── collectChunks ──────────────────────────────────────────────────────────

describe("collectChunks", () => {
  async function* makeStream(chunks: string[]): AsyncIterable<string> {
    for (const c of chunks) yield c;
  }

  it("collects TEXT and THINKING from async iterable", async () => {
    const source = makeStream(["<think>", "step", "</think>", "answer"]);
    const chunks: ContentChunk[] = [];
    for await (const c of collectChunks(source)) chunks.push(c);
    const thinking = chunks
      .filter((c) => c.type === "THINKING")
      .map((c) => c.text)
      .join("");
    const text = chunks
      .filter((c) => c.type === "TEXT")
      .map((c) => c.text)
      .join("");
    expect(thinking).toContain("step");
    expect(text).toContain("answer");
  });

  it("plain text stream emits TEXT chunks only", async () => {
    const source = makeStream(["hello", " world"]);
    const chunks: ContentChunk[] = [];
    for await (const c of collectChunks(source)) chunks.push(c);
    expect(chunks.every((c) => c.type === "TEXT")).toBe(true);
  });
});

// ── extractThinking / extractText ──────────────────────────────────────────

describe("extractThinking", () => {
  it("extracts reasoning content only", () => {
    expect(extractThinking("<think>step 1</think>answer")).toBe("step 1");
  });

  it("returns empty for plain text", () => {
    expect(extractThinking("just text")).toBe("");
  });

  it("concatenates multiple think blocks", () => {
    expect(extractThinking("<think>a</think>mid<think>b</think>")).toBe("ab");
  });
});

describe("extractText", () => {
  it("extracts non-think content only", () => {
    expect(extractText("<think>reason</think>answer")).toBe("answer");
  });

  it("returns full string for plain text", () => {
    expect(extractText("just text")).toBe("just text");
  });

  it("returns empty for pure think block", () => {
    expect(extractText("<think>reasoning</think>")).toBe("");
  });
});
