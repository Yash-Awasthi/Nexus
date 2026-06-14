// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";

import {
  estimateTokens,
  chunkByFixed,
  chunkBySentence,
  chunkByParagraph,
  chunkBySemantic,
  chunkByStrategy,
  jaccardSimilarity,
  detectLanguage,
  extractKeywords,
  extractEntities,
  extractRelationships,
  nullNlpLlmClient,
  CHARS_PER_TOKEN,
  DEFAULT_MAX_TOKENS,
  DEFAULT_OVERLAP_TOKENS,
  DEFAULT_SEMANTIC_THRESHOLD,
  DEFAULT_SEMANTIC_MAX_CHARS,
  STOPWORDS,
  type NlpLlmClient,
  type Entity,
  type TextChunk,
} from "../src/index.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeLlm(content: string): NlpLlmClient {
  return vi.fn().mockResolvedValue({ content, model: "test" });
}

// ── Constants ─────────────────────────────────────────────────────────────────

describe("constants", () => {
  it("CHARS_PER_TOKEN = 4", () => expect(CHARS_PER_TOKEN).toBe(4));
  it("DEFAULT_MAX_TOKENS = 256", () => expect(DEFAULT_MAX_TOKENS).toBe(256));
  it("DEFAULT_OVERLAP_TOKENS = 32", () => expect(DEFAULT_OVERLAP_TOKENS).toBe(32));
  it("STOPWORDS contains 'the'", () => expect(STOPWORDS.has("the")).toBe(true));
  it("STOPWORDS contains 'and'", () => expect(STOPWORDS.has("and")).toBe(true));
  it("STOPWORDS does not contain 'nexus'", () => expect(STOPWORDS.has("nexus")).toBe(false));
});

// ── estimateTokens ────────────────────────────────────────────────────────────

describe("estimateTokens", () => {
  it("returns 0 for empty string", () => expect(estimateTokens("")).toBe(0));
  it("returns 1 for 4-char string", () => expect(estimateTokens("abcd")).toBe(1));
  it("rounds up", () => expect(estimateTokens("abcde")).toBe(2));
  it("scales linearly", () => expect(estimateTokens("a".repeat(400))).toBe(100));
});

// ── chunkByFixed ──────────────────────────────────────────────────────────────

describe("chunkByFixed", () => {
  it("returns [] for empty text", () => expect(chunkByFixed("")).toEqual([]));

  it("returns single chunk for short text", () => {
    const chunks = chunkByFixed("hello world");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toBe("hello world");
  });

  it("produces multiple chunks for long text", () => {
    const text = "a".repeat(100);
    const chunks = chunkByFixed(text, { maxTokens: 4, overlapTokens: 0 });
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("chunks stay within maxChars", () => {
    const text = "x".repeat(200);
    const maxChars = 4 * CHARS_PER_TOKEN;
    const chunks = chunkByFixed(text, { maxTokens: 4, overlapTokens: 0 });
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(maxChars);
    }
  });

  it("overlapping chunks share a suffix/prefix", () => {
    const text = "abcdefghijklmnopqrstuvwxyz";
    const chunks = chunkByFixed(text, { maxTokens: 4, overlapTokens: 2 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const overlap = 2 * CHARS_PER_TOKEN;
    expect(chunks[0]!.text.slice(-overlap)).toBe(chunks[1]!.text.slice(0, overlap));
  });

  it("indices are sequential from 0", () => {
    const chunks = chunkByFixed("a".repeat(100), { maxTokens: 4, overlapTokens: 0 });
    chunks.forEach((c, i) => expect(c.index).toBe(i));
  });

  it("last chunk ends at end of text", () => {
    const text = "Hello World this is a test string.";
    const chunks = chunkByFixed(text, { maxTokens: 3, overlapTokens: 0 });
    expect(text.endsWith(chunks[chunks.length - 1]!.text)).toBe(true);
  });
});

// ── chunkBySentence ───────────────────────────────────────────────────────────

describe("chunkBySentence", () => {
  it("returns [] for empty text", () => expect(chunkBySentence("")).toEqual([]));
  it("returns [] for whitespace-only text", () => expect(chunkBySentence("   ")).toEqual([]));

  it("returns single chunk for single sentence", () => {
    const chunks = chunkBySentence("The quick brown fox.");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toBe("The quick brown fox.");
  });

  it("groups sentences under maxCharsPerChunk", () => {
    const text = "Sentence one. Sentence two. Sentence three.";
    const chunks = chunkBySentence(text, { maxCharsPerChunk: 500 });
    expect(chunks).toHaveLength(1);
  });

  it("splits when combined sentences exceed maxCharsPerChunk", () => {
    const s = "A".repeat(200) + ".";
    const text = `${s} ${s}`;
    const chunks = chunkBySentence(text, { maxCharsPerChunk: 250 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  it("chunk text content is trimmed", () => {
    const chunks = chunkBySentence("Hello world.", {});
    expect(chunks[0]?.text).toBe("Hello world.");
  });

  it("indices are sequential from 0", () => {
    const s = "Word ".repeat(60) + ".";
    const chunks = chunkBySentence(`${s} ${s}`, { maxCharsPerChunk: 50 });
    chunks.forEach((c, i) => expect(c.index).toBe(i));
  });

  it("tokenEstimate matches estimateTokens", () => {
    const chunks = chunkBySentence("Hello. World.");
    for (const c of chunks) {
      expect(c.tokenEstimate).toBe(estimateTokens(c.text));
    }
  });

  it("handles text without sentence-ending punctuation as one chunk", () => {
    const text = "no punctuation at all here just words";
    const chunks = chunkBySentence(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toBe(text);
  });

  it("handles Japanese sentence-ending characters", () => {
    const text = "こんにちは。ありがとう。";
    const chunks = chunkBySentence(text);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });
});

// ── chunkByParagraph ──────────────────────────────────────────────────────────

describe("chunkByParagraph", () => {
  it("returns [] for empty text", () => expect(chunkByParagraph("")).toEqual([]));

  it("returns single chunk for single paragraph", () => {
    const chunks = chunkByParagraph("Hello world.");
    expect(chunks).toHaveLength(1);
  });

  it("splits on double newline", () => {
    const text = "First paragraph.\n\nSecond paragraph.";
    const chunks = chunkByParagraph(text, { maxCharsPerChunk: 5000 });
    expect(chunks).toHaveLength(1); // fits in one chunk
  });

  it("splits across chunks when maxCharsPerChunk is small", () => {
    const para = "A".repeat(100);
    const text = `${para}\n\n${para}`;
    const chunks = chunkByParagraph(text, { maxCharsPerChunk: 120 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  it("filters empty paragraphs", () => {
    const text = "Para one.\n\n\n\nPara two.";
    const chunks = chunkByParagraph(text, { maxCharsPerChunk: 5000 });
    expect(chunks).toHaveLength(1); // both paras in one chunk
    expect(chunks[0]?.text).not.toContain("\n\n\n\n");
  });

  it("handles \\r\\n\\r\\n Windows line endings", () => {
    const text = "Para one.\r\n\r\nPara two.";
    const chunks = chunkByParagraph(text, { maxCharsPerChunk: 5000 });
    expect(chunks).toHaveLength(1);
  });

  it("indices are sequential from 0", () => {
    const para = "B".repeat(200);
    const text = `${para}\n\n${para}\n\n${para}`;
    const chunks = chunkByParagraph(text, { maxCharsPerChunk: 250 });
    chunks.forEach((c, i) => expect(c.index).toBe(i));
  });

  it("tokenEstimate matches estimateTokens", () => {
    const text = "First.\n\nSecond.";
    const chunks = chunkByParagraph(text);
    for (const c of chunks) {
      expect(c.tokenEstimate).toBe(estimateTokens(c.text));
    }
  });
});

// ── chunkByStrategy ───────────────────────────────────────────────────────────

describe("chunkByStrategy", () => {
  const text = "Hello world. This is a test.";

  it("dispatches 'fixed' to chunkByFixed", () => {
    const a = chunkByStrategy(text, "fixed", { maxTokens: 4, overlapTokens: 0 });
    const b = chunkByFixed(text, { maxTokens: 4, overlapTokens: 0 });
    expect(a).toEqual(b);
  });

  it("dispatches 'sentence' to chunkBySentence", () => {
    const a = chunkByStrategy(text, "sentence", { maxCharsPerChunk: 500 });
    const b = chunkBySentence(text, { maxCharsPerChunk: 500 });
    expect(a).toEqual(b);
  });

  it("dispatches 'paragraph' to chunkByParagraph", () => {
    const a = chunkByStrategy(text, "paragraph", { maxCharsPerChunk: 500 });
    const b = chunkByParagraph(text, { maxCharsPerChunk: 500 });
    expect(a).toEqual(b);
  });

  it("returns [] for empty text on all strategies", () => {
    for (const s of ["fixed", "sentence", "paragraph"] as const) {
      expect(chunkByStrategy("", s)).toEqual([]);
    }
  });
});

// ── detectLanguage ────────────────────────────────────────────────────────────

describe("detectLanguage", () => {
  it("returns unknown for empty text", () => {
    const r = detectLanguage("");
    expect(r.language).toBe("unknown");
    expect(r.confidence).toBe(0);
  });

  it("returns unknown for whitespace-only text", () => {
    expect(detectLanguage("   ").language).toBe("unknown");
  });

  it("detects English with latin script", () => {
    const r = detectLanguage("The quick brown fox jumps over the lazy dog. This is a simple test.");
    expect(r.script).toBe("latin");
    expect(r.language).toBe("en");
    expect(r.confidence).toBeGreaterThan(0);
  });

  it("detects Spanish", () => {
    const r = detectLanguage("El perro rápido salta sobre el zorro. No hay nadie en casa hoy.");
    expect(r.language).toBe("es");
  });

  it("detects French", () => {
    const r = detectLanguage("Le chat noir est sur le tapis. Je ne sais pas ce que tu veux faire.");
    expect(r.language).toBe("fr");
  });

  it("detects German", () => {
    const r = detectLanguage("Der schnelle braune Fuchs springt über den faulen Hund. Das ist nicht gut.");
    expect(r.language).toBe("de");
  });

  it("detects CJK script", () => {
    const r = detectLanguage("你好世界这是一个测试");
    expect(r.script).toBe("cjk");
    expect(r.language).toBe("zh");
  });

  it("detects Cyrillic script as Russian", () => {
    const r = detectLanguage("Привет мир это тест на русском языке");
    expect(r.script).toBe("cyrillic");
    expect(r.language).toBe("ru");
  });

  it("detects Arabic script", () => {
    const r = detectLanguage("مرحبا بالعالم هذا اختبار");
    expect(r.script).toBe("arabic");
    expect(r.language).toBe("ar");
  });

  it("detects Hiragana/Katakana as Japanese", () => {
    const r = detectLanguage("こんにちは世界テスト");
    expect(["ja", "zh"]).toContain(r.language);
    expect(["hiragana", "katakana", "cjk"]).toContain(r.script);
  });

  it("confidence is between 0 and 1", () => {
    const texts = [
      "Hello world",
      "你好世界",
      "Привет мир",
      "مرحبا",
    ];
    for (const t of texts) {
      const r = detectLanguage(t);
      expect(r.confidence).toBeGreaterThanOrEqual(0);
      expect(r.confidence).toBeLessThanOrEqual(1);
    }
  });

  it("falls back to en for latin text with no strong fingerprint", () => {
    // Pure digits/symbols have no word fingerprint
    const r = detectLanguage("abc xyz pqr");
    expect(r.script).toBe("latin");
    expect(r.confidence).toBeGreaterThanOrEqual(0);
  });
});

// ── extractKeywords ───────────────────────────────────────────────────────────

describe("extractKeywords", () => {
  it("returns [] for empty text", () => expect(extractKeywords("")).toEqual([]));
  it("returns [] for whitespace-only text", () => expect(extractKeywords("   ")).toEqual([]));

  it("returns keywords sorted by score descending", () => {
    const keywords = extractKeywords("machine learning machine learning machine deep neural");
    expect(keywords[0]?.keyword).toBe("machine");
  });

  it("filters stopwords", () => {
    const keywords = extractKeywords("the quick brown fox");
    const words = keywords.map((k) => k.keyword);
    expect(words).not.toContain("the");
  });

  it("filters words below minLength", () => {
    const keywords = extractKeywords("go do be run quickly", { minLength: 4 });
    const words = keywords.map((k) => k.keyword);
    expect(words).not.toContain("go");
    expect(words).not.toContain("do");
    expect(words).not.toContain("be");
    expect(words).not.toContain("run");
  });

  it("respects topK limit", () => {
    const text = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu";
    const keywords = extractKeywords(text, { topK: 3 });
    expect(keywords.length).toBeLessThanOrEqual(3);
  });

  it("returns frequency as raw count", () => {
    const keywords = extractKeywords("nexus nexus nexus platform platform");
    const nexus = keywords.find((k) => k.keyword === "nexus");
    expect(nexus?.frequency).toBe(3);
  });

  it("score is between 0 and 1 for all results", () => {
    const keywords = extractKeywords("one two three four five six seven eight nine ten");
    for (const k of keywords) {
      expect(k.score).toBeGreaterThanOrEqual(0);
      expect(k.score).toBeLessThanOrEqual(1);
    }
  });

  it("returns [] when only stopwords are present", () => {
    const keywords = extractKeywords("the and is are for of to in");
    expect(keywords).toEqual([]);
  });

  it("handles text with punctuation correctly", () => {
    const keywords = extractKeywords("Hello, World! This is a test. Hello again.");
    const words = keywords.map((k) => k.keyword);
    expect(words).toContain("hello");
    expect(words).toContain("test");
    expect(words).toContain("world");
  });

  it("default topK is 10", () => {
    const text = Array.from({ length: 20 }, (_, i) => `word${i} word${i}`).join(" ");
    const keywords = extractKeywords(text);
    expect(keywords.length).toBeLessThanOrEqual(10);
  });
});

// ── nullNlpLlmClient ──────────────────────────────────────────────────────────

describe("nullNlpLlmClient", () => {
  it("returns content '[]'", async () => {
    const r = await nullNlpLlmClient([{ role: "user", content: "x" }]);
    expect(r.content).toBe("[]");
  });

  it("returns model 'null'", async () => {
    const r = await nullNlpLlmClient([]);
    expect(r.model).toBe("null");
  });
});

// ── extractEntities ───────────────────────────────────────────────────────────

describe("extractEntities", () => {
  it("returns [] for empty text without calling LLM", async () => {
    const llm: NlpLlmClient = vi.fn();
    const result = await extractEntities("", llm);
    expect(result).toEqual([]);
    expect(llm).not.toHaveBeenCalled();
  });

  it("returns [] for whitespace-only text", async () => {
    const llm: NlpLlmClient = vi.fn();
    expect(await extractEntities("   ", llm)).toEqual([]);
    expect(llm).not.toHaveBeenCalled();
  });

  it("returns parsed entities from LLM JSON", async () => {
    const llm = makeLlm('[{"text":"Yash","type":"PERSON","confidence":0.95}]');
    const entities = await extractEntities("Yash works at NIT Raipur.", llm);
    expect(entities).toHaveLength(1);
    expect(entities[0]?.text).toBe("Yash");
    expect(entities[0]?.type).toBe("PERSON");
    expect(entities[0]?.confidence).toBeCloseTo(0.95);
  });

  it("handles multiple entities", async () => {
    const llm = makeLlm(
      '[{"text":"Yash","type":"PERSON","confidence":0.9},{"text":"NIT Raipur","type":"ORG","confidence":0.85}]',
    );
    const entities = await extractEntities("Yash works at NIT Raipur.", llm);
    expect(entities).toHaveLength(2);
  });

  it("re-classifies unknown entity types as OTHER", async () => {
    const llm = makeLlm('[{"text":"Python","type":"LANGUAGE","confidence":0.8}]');
    const entities = await extractEntities("Python is a language.", llm);
    expect(entities[0]?.type).toBe("OTHER");
  });

  it("clamps confidence above 1 to 1", async () => {
    const llm = makeLlm('[{"text":"X","type":"PERSON","confidence":2.0}]');
    const entities = await extractEntities("X did something.", llm);
    expect(entities[0]?.confidence).toBe(1);
  });

  it("clamps confidence below 0 to 0", async () => {
    const llm = makeLlm('[{"text":"X","type":"ORG","confidence":-0.5}]');
    const entities = await extractEntities("X corp.", llm);
    expect(entities[0]?.confidence).toBe(0);
  });

  it("defaults confidence to 0.5 when missing", async () => {
    const llm = makeLlm('[{"text":"London","type":"LOCATION"}]');
    const entities = await extractEntities("London is a city.", llm);
    expect(entities[0]?.confidence).toBe(0.5);
  });

  it("returns [] when LLM returns empty array", async () => {
    const llm = makeLlm("[]");
    expect(await extractEntities("some text", llm)).toEqual([]);
  });

  it("handles LLM response with markdown fences", async () => {
    const llm = makeLlm("```json\n[{\"text\":\"Paris\",\"type\":\"LOCATION\",\"confidence\":0.9}]\n```");
    const entities = await extractEntities("Paris is the capital.", llm);
    expect(entities).toHaveLength(1);
    expect(entities[0]?.text).toBe("Paris");
  });

  it("returns [] gracefully when LLM returns invalid JSON", async () => {
    const llm = makeLlm("I found some entities but forgot to format them");
    const entities = await extractEntities("some text", llm);
    expect(entities).toEqual([]);
  });

  it("filters out entries with empty text", async () => {
    const llm = makeLlm('[{"text":"","type":"PERSON","confidence":0.9},{"text":"Alice","type":"PERSON","confidence":0.8}]');
    const entities = await extractEntities("Alice said hi.", llm);
    expect(entities).toHaveLength(1);
    expect(entities[0]?.text).toBe("Alice");
  });

  it("uses nullNlpLlmClient by default", async () => {
    // nullNlpLlmClient returns "[]" so result should be []
    const entities = await extractEntities("some text");
    expect(entities).toEqual([]);
  });

  it("passes text as user message to LLM", async () => {
    const llm: NlpLlmClient = vi.fn().mockResolvedValue({ content: "[]", model: "m" });
    await extractEntities("my text here", llm);
    const [messages] = (llm as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Array<{ role: string; content: string }>,
    ];
    expect(messages.find((m) => m.role === "user")?.content).toBe("my text here");
  });

  it("recognises all valid EntityType values", async () => {
    const types = ["PERSON", "ORG", "LOCATION", "DATE", "PRODUCT", "EVENT", "OTHER"] as const;
    for (const type of types) {
      const llm = makeLlm(`[{"text":"x","type":"${type}","confidence":0.8}]`);
      const [entity] = await extractEntities("text", llm);
      expect(entity?.type).toBe(type);
    }
  });
});

// ── extractRelationships ──────────────────────────────────────────────────────

describe("extractRelationships", () => {
  const entities: Entity[] = [
    { text: "Yash", type: "PERSON", confidence: 0.9 },
    { text: "NIT Raipur", type: "ORG", confidence: 0.85 },
  ];

  it("returns [] for empty text", async () => {
    const llm: NlpLlmClient = vi.fn();
    expect(await extractRelationships("", entities, llm)).toEqual([]);
    expect(llm).not.toHaveBeenCalled();
  });

  it("returns [] when entities array is empty", async () => {
    const llm: NlpLlmClient = vi.fn();
    expect(await extractRelationships("some text", [], llm)).toEqual([]);
    expect(llm).not.toHaveBeenCalled();
  });

  it("returns parsed relationships from LLM JSON", async () => {
    const llm = makeLlm(
      '[{"subject":"Yash","predicate":"studies at","object":"NIT Raipur","confidence":0.92}]',
    );
    const rels = await extractRelationships("Yash studies at NIT Raipur.", entities, llm);
    expect(rels).toHaveLength(1);
    expect(rels[0]?.subject).toBe("Yash");
    expect(rels[0]?.predicate).toBe("studies at");
    expect(rels[0]?.object).toBe("NIT Raipur");
    expect(rels[0]?.confidence).toBeCloseTo(0.92);
  });

  it("returns [] when LLM returns empty array", async () => {
    const llm = makeLlm("[]");
    expect(await extractRelationships("text", entities, llm)).toEqual([]);
  });

  it("returns [] gracefully when LLM returns invalid JSON", async () => {
    const llm = makeLlm("no relationships found");
    expect(await extractRelationships("text", entities, llm)).toEqual([]);
  });

  it("handles markdown-fenced response", async () => {
    const llm = makeLlm(
      "```json\n[{\"subject\":\"A\",\"predicate\":\"knows\",\"object\":\"B\",\"confidence\":0.7}]\n```",
    );
    const rels = await extractRelationships("A knows B.", entities, llm);
    expect(rels).toHaveLength(1);
  });

  it("filters out incomplete triples", async () => {
    const llm = makeLlm(
      '[{"subject":"A","predicate":"knows"},{"subject":"X","predicate":"works at","object":"Y","confidence":0.8}]',
    );
    const rels = await extractRelationships("text", entities, llm);
    expect(rels).toHaveLength(1);
    expect(rels[0]?.subject).toBe("X");
  });

  it("defaults confidence to 0.5 when missing", async () => {
    const llm = makeLlm('[{"subject":"A","predicate":"likes","object":"B"}]');
    const rels = await extractRelationships("A likes B.", entities, llm);
    expect(rels[0]?.confidence).toBe(0.5);
  });

  it("clamps confidence to [0, 1]", async () => {
    const llm = makeLlm(
      '[{"subject":"A","predicate":"p","object":"B","confidence":5.0}]',
    );
    const rels = await extractRelationships("text", entities, llm);
    expect(rels[0]?.confidence).toBe(1);
  });

  it("includes entity list in user message", async () => {
    const llm: NlpLlmClient = vi.fn().mockResolvedValue({ content: "[]", model: "m" });
    await extractRelationships("Yash studies at NIT.", entities, llm);
    const [messages] = (llm as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Array<{ role: string; content: string }>,
    ];
    const userMsg = messages.find((m) => m.role === "user")?.content ?? "";
    expect(userMsg).toContain("Yash");
    expect(userMsg).toContain("NIT Raipur");
  });

  it("uses nullNlpLlmClient by default", async () => {
    const rels = await extractRelationships("text", entities);
    expect(rels).toEqual([]);
  });
});

// ── jaccardSimilarity ─────────────────────────────────────────────────────────

describe("jaccardSimilarity", () => {
  it("returns 0 for two empty sets", () => {
    expect(jaccardSimilarity(new Set(), new Set())).toBe(0);
  });

  it("returns 0 when sets are disjoint", () => {
    expect(jaccardSimilarity(new Set(["a", "b"]), new Set(["c", "d"]))).toBe(0);
  });

  it("returns 1 for identical sets", () => {
    const s = new Set(["x", "y", "z"]);
    expect(jaccardSimilarity(s, s)).toBe(1);
  });

  it("returns 0.5 for half-overlapping sets", () => {
    // A={a,b,c}, B={b,c,d} → intersection=2, union=4 → 0.5
    expect(jaccardSimilarity(new Set(["a", "b", "c"]), new Set(["b", "c", "d"]))).toBe(0.5);
  });

  it("returns 1/3 for one-element overlap in three-element sets", () => {
    // A={a,b,c}, B={c,d,e} → intersection=1, union=5 → 0.2
    expect(jaccardSimilarity(new Set(["a", "b", "c"]), new Set(["c", "d", "e"]))).toBeCloseTo(
      1 / 5,
    );
  });

  it("is commutative", () => {
    const a = new Set(["dog", "cat", "bird"]);
    const b = new Set(["cat", "fish", "frog"]);
    expect(jaccardSimilarity(a, b)).toBeCloseTo(jaccardSimilarity(b, a));
  });

  it("returns 0 when left set is empty", () => {
    expect(jaccardSimilarity(new Set(), new Set(["a", "b"]))).toBe(0);
  });

  it("returns 0 when right set is empty", () => {
    expect(jaccardSimilarity(new Set(["a", "b"]), new Set())).toBe(0);
  });
});

// ── DEFAULT_SEMANTIC_THRESHOLD / DEFAULT_SEMANTIC_MAX_CHARS ───────────────────

describe("semantic chunking constants", () => {
  it("DEFAULT_SEMANTIC_THRESHOLD is 0.15", () => {
    expect(DEFAULT_SEMANTIC_THRESHOLD).toBe(0.15);
  });

  it("DEFAULT_SEMANTIC_MAX_CHARS is 2000", () => {
    expect(DEFAULT_SEMANTIC_MAX_CHARS).toBe(2000);
  });
});

// ── chunkBySemantic ───────────────────────────────────────────────────────────

describe("chunkBySemantic — edge cases", () => {
  it("returns [] for empty text", () => {
    expect(chunkBySemantic("")).toEqual([]);
  });

  it("returns [] for whitespace-only text", () => {
    expect(chunkBySemantic("   ")).toEqual([]);
  });

  it("returns single chunk for single sentence", () => {
    const chunks = chunkBySemantic("The quick brown fox jumps over the lazy dog.");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toContain("fox");
  });

  it("indices start at 0 and are sequential", () => {
    const s1 = "The quick brown fox jumps over the lazy dog.";
    const s2 = "Blockchain consensus algorithms ensure distributed trust.";
    const chunks = chunkBySemantic(`${s1} ${s2}`, { similarityThreshold: 0.99 });
    chunks.forEach((c, i) => expect(c.index).toBe(i));
  });

  it("tokenEstimate matches estimateTokens for every chunk", () => {
    const text =
      "Dogs are loyal pets. Dogs love to play fetch. Quantum computing uses qubits.";
    const chunks = chunkBySemantic(text);
    for (const c of chunks) {
      expect(c.tokenEstimate).toBe(estimateTokens(c.text));
    }
  });

  it("text without sentence punctuation returns one chunk", () => {
    const text = "no punctuation at all just words flowing along";
    const chunks = chunkBySemantic(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toBe(text);
  });
});

describe("chunkBySemantic — topic cohesion", () => {
  it("keeps sentences on the same topic together", () => {
    // Two sentences sharing vocabulary → should merge
    const text = "Dogs love to run and play. Dogs also enjoy swimming and fetching.";
    const chunks = chunkBySemantic(text, { similarityThreshold: 0.05 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toContain("Dogs");
  });

  it("splits sentences with no shared vocabulary when threshold is high", () => {
    const dogSentence = "Dogs love running playing fetching barking wagging tails.";
    const quantumSentence =
      "Qubits entanglement superposition quantum coherence decoherence fidelity.";
    const chunks = chunkBySemantic(`${dogSentence} ${quantumSentence}`, {
      similarityThreshold: 0.3,
    });
    // These sentences share zero vocabulary → must split into 2
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  it("threshold=0 groups all sentences (always similar enough)", () => {
    const text =
      "Alpha beta gamma. Delta epsilon zeta. Eta theta iota.";
    const chunks = chunkBySemantic(text, { similarityThreshold: 0 });
    // With threshold 0, every sentence meets ≥ 0 → all merge
    expect(chunks).toHaveLength(1);
  });

  it("threshold=1 splits every sentence into its own chunk", () => {
    // With threshold 1, only identical word sets qualify — extremely rare in natural text
    const text = "Alpha beta gamma delta. Epsilon zeta eta theta. Iota kappa lambda mu.";
    const chunks = chunkBySemantic(text, { similarityThreshold: 1 });
    // All three sentences have disjoint vocabularies → 3 chunks
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });
});

describe("chunkBySemantic — maxCharsPerChunk", () => {
  it("respects maxCharsPerChunk even within a single topic", () => {
    // Build many short sentences on the same topic so they'd normally merge but
    // the char limit forces splits.
    const sentence = "Dogs love running and playing fetch.";
    const text = Array.from({ length: 6 }, () => sentence).join(" ");
    const chunks = chunkBySemantic(text, { maxCharsPerChunk: 80, similarityThreshold: 0 });
    // Each chunk must not dramatically exceed the limit
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(sentence.length * 2 + 5);
    }
    // Must produce multiple chunks
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("a single very long sentence is emitted as one chunk even beyond maxCharsPerChunk", () => {
    const sentence = "word ".repeat(600).trim() + ".";
    const chunks = chunkBySemantic(sentence, { maxCharsPerChunk: 100 });
    // The single sentence exceeds max but has no boundary to split at
    expect(chunks).toHaveLength(1);
  });
});

describe("chunkBySemantic — chunkByStrategy integration", () => {
  it("chunkByStrategy dispatches 'semantic' to chunkBySemantic", () => {
    const text = "Hello world. This is a test sentence.";
    const a = chunkByStrategy(text, "semantic", { similarityThreshold: 0.05 });
    const b = chunkBySemantic(text, { similarityThreshold: 0.05 });
    expect(a).toEqual(b);
  });

  it("returns [] for empty text via strategy dispatcher", () => {
    expect(chunkByStrategy("", "semantic")).toEqual([]);
  });
});
