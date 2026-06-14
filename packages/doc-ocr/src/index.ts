// SPDX-License-Identifier: Apache-2.0
/**
 * doc-ocr — OCR ingestion layer with date-parsing and archive-signal detection.
 *
 * Provides:
 *   • OcrResult          — normalised OCR output
 *   • OcrEngine          — injectable OCR backend interface
 *   • DateExtractor      — extract and normalise dates from OCR text
 *   • ArchiveSignal      — detect archive-worthiness signals in OCR text
 *   • OcrPipeline        — orchestrate OCR → date-extract → archive-signal
 *   • OcrBatchProcessor  — process multiple documents with concurrency control
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type OcrStatus = "success" | "partial" | "failed" | "skipped";

export interface OcrResult {
  id: string;
  sourceId: string; // e.g. file path or URL
  text: string;
  confidence: number; // 0-1
  pageCount: number;
  language?: string;
  status: OcrStatus;
  durationMs: number;
  metadata: Record<string, unknown>;
}

export interface ExtractedDate {
  raw: string;      // original string in text
  iso: string;      // normalised ISO 8601
  confidence: number;
  position: number; // character index in text
}

export type ArchiveSignalType =
  | "contains_date"
  | "references_entity"
  | "invoice_number"
  | "official_stamp"
  | "signature_line"
  | "letterhead"
  | "legal_reference";

export interface ArchiveSignal {
  type: ArchiveSignalType;
  value: string;
  confidence: number;
}

export interface PipelineResult {
  ocr: OcrResult;
  dates: ExtractedDate[];
  signals: ArchiveSignal[];
  archiveScore: number; // 0-1, higher = more archive-worthy
}

// ── ID util ───────────────────────────────────────────────────────────────────

let _seq = 0;
function uid() { return `ocr-${Date.now()}-${++_seq}`; }

// ── OcrEngine ─────────────────────────────────────────────────────────────────

export type OcrFn = (sourceId: string, data: Uint8Array | string) => Promise<Omit<OcrResult, "id">>;

export class OcrEngine {
  private fn: OcrFn;
  readonly name: string;

  constructor(name: string, fn: OcrFn) {
    this.name = name;
    this.fn = fn;
  }

  async process(sourceId: string, data: Uint8Array | string): Promise<OcrResult> {
    const result = await this.fn(sourceId, data);
    return { id: uid(), ...result };
  }
}

/** Mock OCR engine for testing */
export class MockOcrEngine extends OcrEngine {
  private responses = new Map<string, Partial<Omit<OcrResult, "id">>>();

  constructor() {
    super("mock", async (sourceId) => {
      const override = this.responses.get(sourceId) ?? {};
      return {
        sourceId,
        text: override.text ?? `Extracted text from ${sourceId}`,
        confidence: override.confidence ?? 0.92,
        pageCount: override.pageCount ?? 1,
        language: override.language ?? "en",
        status: override.status ?? "success",
        durationMs: override.durationMs ?? 50,
        metadata: override.metadata ?? {},
      };
    });
  }

  setResponse(sourceId: string, response: Partial<Omit<OcrResult, "id">>): void {
    this.responses.set(sourceId, response);
  }
}

// ── DateExtractor ─────────────────────────────────────────────────────────────

const DATE_PATTERNS: Array<{ re: RegExp; parse: (m: RegExpMatchArray) => string | null }> = [
  // ISO: 2024-01-15
  {
    re: /\b(\d{4})-(\d{2})-(\d{2})\b/g,
    parse: (m) => `${m[1]}-${m[2]}-${m[3]}`,
  },
  // DD/MM/YYYY or MM/DD/YYYY
  {
    re: /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g,
    parse: (m) => {
      const d = parseInt(m[1]!, 10);
      const mo = parseInt(m[2]!, 10);
      const y = m[3]!;
      // Assume DD/MM/YYYY if day > 12
      if (d > 12) return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      return `${y}-${String(d).padStart(2, "0")}-${String(mo).padStart(2, "0")}`;
    },
  },
  // Month name: January 15, 2024 or 15 January 2024
  {
    re: /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})\b/gi,
    parse: (m) => {
      const months: Record<string, string> = {
        january: "01", february: "02", march: "03", april: "04",
        may: "05", june: "06", july: "07", august: "08",
        september: "09", october: "10", november: "11", december: "12",
      };
      const mo = months[m[1]!.toLowerCase()] ?? "01";
      return `${m[3]}-${mo}-${String(parseInt(m[2]!, 10)).padStart(2, "0")}`;
    },
  },
  // Abbreviated: Jan 15, 2024
  {
    re: /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.?\s+(\d{1,2}),?\s+(\d{4})\b/gi,
    parse: (m) => {
      const months: Record<string, string> = {
        jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
        jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
      };
      const mo = months[m[1]!.toLowerCase().replace(".", "")] ?? "01";
      return `${m[3]}-${mo}-${String(parseInt(m[2]!, 10)).padStart(2, "0")}`;
    },
  },
];

export class DateExtractor {
  extract(text: string): ExtractedDate[] {
    const results: ExtractedDate[] = [];
    const seen = new Set<string>();

    for (const { re, parse } of DATE_PATTERNS) {
      re.lastIndex = 0;
      let m: RegExpMatchArray | null;
      while ((m = re.exec(text)) !== null) {
        const iso = parse(m);
        if (!iso) continue;
        // Validate the date
        const d = new Date(iso);
        if (isNaN(d.getTime())) continue;
        const key = `${iso}:${m.index}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({
          raw: m[0]!,
          iso,
          confidence: 0.85,
          position: m.index ?? 0,
        });
      }
    }

    return results.sort((a, b) => a.position - b.position);
  }
}

// ── ArchiveSignalDetector ─────────────────────────────────────────────────────

const SIGNAL_PATTERNS: Array<{ type: ArchiveSignalType; re: RegExp; confidence: number }> = [
  { type: "invoice_number", re: /\b(invoice|inv\.?|bill)\s*#?\s*(\w{4,})/gi, confidence: 0.9 },
  { type: "legal_reference", re: /\b(section|§|clause|article|act)\s+\d+/gi, confidence: 0.85 },
  { type: "official_stamp", re: /\b(notarized|certified|official|registered|stamped)\b/gi, confidence: 0.8 },
  { type: "signature_line", re: /\b(signature|signed by|authorised by|authorized by)\b/gi, confidence: 0.75 },
  { type: "letterhead", re: /\b(re:|subject:|dear\s+\w+|sincerely|yours faithfully)\b/gi, confidence: 0.7 },
  { type: "references_entity", re: /\b(company|corp\.?|ltd\.?|inc\.?|llc|plc)\b/gi, confidence: 0.65 },
];

export class ArchiveSignalDetector {
  detect(text: string): ArchiveSignal[] {
    const signals: ArchiveSignal[] = [];

    for (const { type, re, confidence } of SIGNAL_PATTERNS) {
      re.lastIndex = 0;
      const m = re.exec(text);
      if (m) {
        signals.push({ type, value: m[0]!, confidence });
      }
    }

    return signals;
  }

  /** Compute an aggregate archive score from 0-1. */
  computeScore(signals: ArchiveSignal[], dates: ExtractedDate[]): number {
    const dateBonus = Math.min(dates.length * 0.1, 0.3);
    const signalScore = signals.reduce((sum, s) => sum + s.confidence, 0) / Math.max(signals.length, 1);
    return Math.min((signalScore * 0.7 + dateBonus) * (signals.length > 0 ? 1 : 0.2), 1);
  }
}

// ── OcrPipeline ───────────────────────────────────────────────────────────────

export class OcrPipeline {
  private engine: OcrEngine;
  private dateExtractor: DateExtractor;
  private signalDetector: ArchiveSignalDetector;

  constructor(engine: OcrEngine) {
    this.engine = engine;
    this.dateExtractor = new DateExtractor();
    this.signalDetector = new ArchiveSignalDetector();
  }

  async process(sourceId: string, data: Uint8Array | string = ""): Promise<PipelineResult> {
    const ocr = await this.engine.process(sourceId, data);
    const dates = this.dateExtractor.extract(ocr.text);
    const signals = this.signalDetector.detect(ocr.text);
    const archiveScore = this.signalDetector.computeScore(signals, dates);
    return { ocr, dates, signals, archiveScore };
  }
}

// ── OcrBatchProcessor ─────────────────────────────────────────────────────────

export interface BatchJob {
  sourceId: string;
  data?: Uint8Array | string;
}

export interface BatchResult {
  sourceId: string;
  result?: PipelineResult;
  error?: string;
}

export class OcrBatchProcessor {
  private pipeline: OcrPipeline;
  private concurrency: number;

  constructor(pipeline: OcrPipeline, concurrency = 3) {
    this.pipeline = pipeline;
    this.concurrency = concurrency;
  }

  async process(jobs: BatchJob[]): Promise<BatchResult[]> {
    const results: BatchResult[] = [];

    for (let i = 0; i < jobs.length; i += this.concurrency) {
      const batch = jobs.slice(i, i + this.concurrency);
      const batchResults = await Promise.all(
        batch.map(async (job) => {
          try {
            const result = await this.pipeline.process(job.sourceId, job.data ?? "");
            return { sourceId: job.sourceId, result };
          } catch (err) {
            return {
              sourceId: job.sourceId,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        }),
      );
      results.push(...batchResults);
    }

    return results;
  }
}
