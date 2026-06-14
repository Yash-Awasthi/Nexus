// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  MockOcrEngine,
  OcrEngine,
  DateExtractor,
  ArchiveSignalDetector,
  OcrPipeline,
  OcrBatchProcessor,
} from "../src/index.js";

// ── MockOcrEngine ─────────────────────────────────────────────────────────────

describe("MockOcrEngine", () => {
  it("produces default OCR result", async () => {
    const engine = new MockOcrEngine();
    const result = await engine.process("doc.pdf", "");
    expect(result.id).toMatch(/^ocr-/);
    expect(result.sourceId).toBe("doc.pdf");
    expect(result.text).toContain("doc.pdf");
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.status).toBe("success");
  });

  it("uses custom response when set", async () => {
    const engine = new MockOcrEngine();
    engine.setResponse("invoice.png", {
      text: "Invoice #INV-2024 dated 2024-01-15",
      confidence: 0.98,
      pageCount: 1,
    });
    const result = await engine.process("invoice.png", "");
    expect(result.text).toBe("Invoice #INV-2024 dated 2024-01-15");
    expect(result.confidence).toBe(0.98);
  });

  it("OcrEngine wraps fn and assigns id", async () => {
    const engine = new OcrEngine("tesseract", async (sourceId) => ({
      sourceId,
      text: "custom",
      confidence: 0.9,
      pageCount: 2,
      status: "success" as const,
      durationMs: 30,
      metadata: {},
    }));
    const result = await engine.process("file.pdf", "");
    expect(result.id).toMatch(/^ocr-/);
    expect(result.text).toBe("custom");
    expect(result.pageCount).toBe(2);
    expect(engine.name).toBe("tesseract");
  });
});

// ── DateExtractor ─────────────────────────────────────────────────────────────

describe("DateExtractor", () => {
  const extractor = new DateExtractor();

  it("extracts ISO dates", () => {
    const dates = extractor.extract("Document dated 2024-06-15 and revised 2024-07-01.");
    expect(dates).toHaveLength(2);
    expect(dates[0]!.iso).toBe("2024-06-15");
    expect(dates[1]!.iso).toBe("2024-07-01");
  });

  it("extracts full month name dates", () => {
    const dates = extractor.extract("Signed on January 15, 2024.");
    expect(dates.length).toBeGreaterThan(0);
    expect(dates[0]!.iso).toBe("2024-01-15");
    expect(dates[0]!.raw).toContain("January");
  });

  it("extracts abbreviated month dates", () => {
    const dates = extractor.extract("Due: Mar 22, 2025");
    expect(dates.length).toBeGreaterThan(0);
    expect(dates[0]!.iso).toBe("2025-03-22");
  });

  it("extracts DD/MM/YYYY when day > 12", () => {
    const dates = extractor.extract("Date: 25/06/2024");
    expect(dates.length).toBeGreaterThan(0);
    // day=25 > 12 so it's DD/MM/YYYY → 2024-06-25
    expect(dates[0]!.iso).toBe("2024-06-25");
  });

  it("returns empty array for no dates", () => {
    expect(extractor.extract("No dates here at all.")).toHaveLength(0);
  });

  it("includes position of date in text", () => {
    const text = "Prefix text and then 2024-01-01 follows.";
    const dates = extractor.extract(text);
    expect(dates[0]!.position).toBeGreaterThan(0);
  });

  it("returns dates sorted by position", () => {
    const dates = extractor.extract("2024-12-01 and earlier 2024-01-01 mentioned after");
    if (dates.length >= 2) {
      expect(dates[0]!.position).toBeLessThan(dates[1]!.position);
    }
  });
});

// ── ArchiveSignalDetector ─────────────────────────────────────────────────────

describe("ArchiveSignalDetector", () => {
  const detector = new ArchiveSignalDetector();

  it("detects invoice number signal", () => {
    const signals = detector.detect("Invoice #INV-20240115 total: $500");
    const inv = signals.find((s) => s.type === "invoice_number");
    expect(inv).toBeDefined();
    expect(inv!.confidence).toBeGreaterThan(0);
  });

  it("detects legal reference", () => {
    const signals = detector.detect("As per Section 42 of the Act.");
    const legal = signals.find((s) => s.type === "legal_reference");
    expect(legal).toBeDefined();
  });

  it("detects official stamp", () => {
    const signals = detector.detect("This document is certified and notarized.");
    const stamp = signals.find((s) => s.type === "official_stamp");
    expect(stamp).toBeDefined();
  });

  it("detects signature line", () => {
    const signals = detector.detect("Signature: ______ Authorized by: John Doe");
    const sig = signals.find((s) => s.type === "signature_line");
    expect(sig).toBeDefined();
  });

  it("detects letterhead pattern", () => {
    const signals = detector.detect("Dear Sir, Re: Contract Amendment Sincerely, Alice");
    const lh = signals.find((s) => s.type === "letterhead");
    expect(lh).toBeDefined();
  });

  it("detects entity reference", () => {
    const signals = detector.detect("Nexus Technologies Ltd. hereby agrees to...");
    const entity = signals.find((s) => s.type === "references_entity");
    expect(entity).toBeDefined();
  });

  it("returns empty for plain text", () => {
    const signals = detector.detect("Hello world this is a simple sentence.");
    expect(signals).toHaveLength(0);
  });

  it("computeScore returns 0 for no signals or dates", () => {
    expect(detector.computeScore([], [])).toBe(0);
  });

  it("computeScore increases with signals and dates", () => {
    const signals = detector.detect("Invoice #INV-001 notarized signed by Jane Doe.");
    const dates = [{ raw: "2024-01-01", iso: "2024-01-01", confidence: 0.9, position: 0 }];
    const score = detector.computeScore(signals, dates);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(1);
  });
});

// ── OcrPipeline ───────────────────────────────────────────────────────────────

describe("OcrPipeline", () => {
  it("processes a document and returns full pipeline result", async () => {
    const engine = new MockOcrEngine();
    engine.setResponse("doc.pdf", {
      text: "Invoice #INV-2024 dated 2024-06-14. Signed by John Doe. Certified.",
    });
    const pipeline = new OcrPipeline(engine);
    const result = await pipeline.process("doc.pdf");

    expect(result.ocr.sourceId).toBe("doc.pdf");
    expect(result.ocr.status).toBe("success");
    expect(result.dates.length).toBeGreaterThan(0);
    expect(result.dates[0]!.iso).toBe("2024-06-14");
    expect(result.signals.length).toBeGreaterThan(0);
    expect(result.archiveScore).toBeGreaterThan(0);
  });

  it("archiveScore is 0-1 range", async () => {
    const engine = new MockOcrEngine();
    const pipeline = new OcrPipeline(engine);
    const result = await pipeline.process("empty.pdf");
    expect(result.archiveScore).toBeGreaterThanOrEqual(0);
    expect(result.archiveScore).toBeLessThanOrEqual(1);
  });
});

// ── OcrBatchProcessor ─────────────────────────────────────────────────────────

describe("OcrBatchProcessor", () => {
  it("processes multiple documents", async () => {
    const engine = new MockOcrEngine();
    const pipeline = new OcrPipeline(engine);
    const processor = new OcrBatchProcessor(pipeline, 2);

    const results = await processor.process([
      { sourceId: "a.pdf" },
      { sourceId: "b.pdf" },
      { sourceId: "c.pdf" },
    ]);

    expect(results).toHaveLength(3);
    expect(results.every((r) => r.result !== undefined)).toBe(true);
    expect(results.map((r) => r.sourceId)).toContain("a.pdf");
  });

  it("captures errors per document", async () => {
    const engine = new OcrEngine("fail", async () => {
      throw new Error("OCR engine down");
    });
    const pipeline = new OcrPipeline(engine);
    const processor = new OcrBatchProcessor(pipeline);
    const results = await processor.process([{ sourceId: "x.pdf" }]);
    expect(results[0]!.error).toContain("OCR engine down");
    expect(results[0]!.result).toBeUndefined();
  });

  it("processes with concurrency=1 sequentially", async () => {
    const engine = new MockOcrEngine();
    const pipeline = new OcrPipeline(engine);
    const processor = new OcrBatchProcessor(pipeline, 1);
    const results = await processor.process([
      { sourceId: "p1.pdf" },
      { sourceId: "p2.pdf" },
    ]);
    expect(results).toHaveLength(2);
  });
});
