// SPDX-License-Identifier: Apache-2.0
/**
 * hf-research — HuggingFace corpus publication layer.
 *
 * Provides the data pipeline surface for publishing RLHF/SFT training data
 * to HuggingFace datasets. Closes the loop: rlhf-pipeline + sft-tagger →
 * hf-research → HuggingFace Hub.
 *
 * Provides:
 *   • DataTier              — free | pro | enterprise (tier-gated access)
 *   • CorpusBatch           — batch of training samples
 *   • CorpusSample          — individual tagged sample
 *   • BatchFilter           — query filters
 *   • InMemoryBatchStore    — in-memory buffer of batches
 *   • HfPublishResult       — result of a push-to-hub operation
 *   • HfPublisher           — injectable publisher abstraction
 *   • MockHfPublisher       — test double
 *   • ResearchApiRouter     — REST-style router (list, read, query, flush, download)
 *   • TierGate              — tier-based access control
 *   • JsonlSerializer       — serialize batches to JSONL
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type DataTier = "free" | "pro" | "enterprise";
export type SampleTag = "preferred" | "rejected" | "neutral" | "flagged";

export interface CorpusSample {
  id: string;
  prompt: string;
  completion: string;
  tag: SampleTag;
  model?: string;
  sessionId?: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface CorpusBatch {
  id: string;
  name: string;
  samples: CorpusSample[];
  createdAt: string;
  flushedAt?: string;     // set when pushed to HF
  tier: DataTier;
  size: number;
}

export interface BatchFilter {
  tier?: DataTier;
  tags?: SampleTag[];
  fromDate?: string;
  toDate?: string;
  model?: string;
  limit?: number;
}

// ── InMemoryBatchStore ────────────────────────────────────────────────────────

let _batchSeq = 0;
let _sampleSeq = 0;

export class InMemoryBatchStore {
  private batches = new Map<string, CorpusBatch>();
  private pendingSamples: CorpusSample[] = [];

  addSample(sample: Omit<CorpusSample, "id" | "createdAt">): CorpusSample {
    const full: CorpusSample = {
      ...sample,
      id: `sample-${++_sampleSeq}`,
      createdAt: new Date().toISOString(),
    };
    this.pendingSamples.push(full);
    return full;
  }

  /** Flush pending samples into a new batch. */
  flush(name: string, tier: DataTier = "free"): CorpusBatch {
    const batch: CorpusBatch = {
      id: `batch-${++_batchSeq}`,
      name,
      samples: [...this.pendingSamples],
      createdAt: new Date().toISOString(),
      tier,
      size: this.pendingSamples.length,
    };
    this.batches.set(batch.id, batch);
    this.pendingSamples = [];
    return batch;
  }

  getBatch(id: string): CorpusBatch | undefined { return this.batches.get(id); }
  allBatches(): CorpusBatch[] { return [...this.batches.values()]; }
  pendingCount(): number { return this.pendingSamples.length; }

  listBatches(filter: BatchFilter = {}): CorpusBatch[] {
    let batches = this.allBatches();
    if (filter.tier) batches = batches.filter((b) => b.tier === filter.tier);
    if (filter.fromDate) batches = batches.filter((b) => b.createdAt >= filter.fromDate!);
    if (filter.toDate) batches = batches.filter((b) => b.createdAt <= filter.toDate!);
    if (filter.limit) batches = batches.slice(0, filter.limit);
    return batches;
  }

  querySamples(filter: BatchFilter = {}): CorpusSample[] {
    let samples = this.allBatches().flatMap((b) => b.samples);
    if (filter.tags && filter.tags.length > 0) {
      samples = samples.filter((s) => filter.tags!.includes(s.tag));
    }
    if (filter.model) samples = samples.filter((s) => s.model === filter.model);
    if (filter.limit) samples = samples.slice(0, filter.limit);
    return samples;
  }

  markFlushed(batchId: string): void {
    const batch = this.batches.get(batchId);
    if (batch) {
      this.batches.set(batchId, { ...batch, flushedAt: new Date().toISOString() });
    }
  }

  clear(): void { this.batches.clear(); this.pendingSamples = []; }
  size(): number { return this.batches.size; }
}

// ── TierGate ──────────────────────────────────────────────────────────────────

const TIER_ORDER: DataTier[] = ["free", "pro", "enterprise"];

export class TierGate {
  check(requiredTier: DataTier, userTier: DataTier): boolean {
    return TIER_ORDER.indexOf(userTier) >= TIER_ORDER.indexOf(requiredTier);
  }

  requireTier(required: DataTier, actual: DataTier): void {
    if (!this.check(required, actual)) {
      throw new Error(`Tier access denied: requires "${required}", got "${actual}"`);
    }
  }
}

// ── JsonlSerializer ───────────────────────────────────────────────────────────

export class JsonlSerializer {
  serialize(samples: CorpusSample[]): string {
    return samples.map((s) => JSON.stringify(s)).join("\n");
  }

  deserialize(jsonl: string): CorpusSample[] {
    return jsonl
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as CorpusSample);
  }
}

// ── HfPublisher ───────────────────────────────────────────────────────────────

export interface HfPublishResult {
  batchId: string;
  repoId: string;
  sampleCount: number;
  success: boolean;
  error?: string;
  url?: string;
}

export interface HfPublisher {
  push(batch: CorpusBatch, repoId: string): Promise<HfPublishResult>;
}

export class MockHfPublisher implements HfPublisher {
  readonly pushLog: Array<{ batch: CorpusBatch; repoId: string }> = [];
  private throws?: string;

  setThrows(message: string): this { this.throws = message; return this; }

  async push(batch: CorpusBatch, repoId: string): Promise<HfPublishResult> {
    if (this.throws) {
      return { batchId: batch.id, repoId, sampleCount: 0, success: false, error: this.throws };
    }
    this.pushLog.push({ batch, repoId });
    return {
      batchId: batch.id,
      repoId,
      sampleCount: batch.samples.length,
      success: true,
      url: `https://huggingface.co/datasets/${repoId}`,
    };
  }
}

// ── ResearchApiRouter ─────────────────────────────────────────────────────────

export interface ApiRequest {
  userTier: DataTier;
  params?: Record<string, string>;
  body?: unknown;
}

export interface ApiResponse<T> {
  data: T | null;
  status: number;
  error?: string;
}

export class ResearchApiRouter {
  private store: InMemoryBatchStore;
  private publisher: HfPublisher;
  private tierGate: TierGate;
  private serializer: JsonlSerializer;
  private defaultRepoId: string;

  constructor(opts: {
    store: InMemoryBatchStore;
    publisher: HfPublisher;
    defaultRepoId?: string;
  }) {
    this.store = opts.store;
    this.publisher = opts.publisher;
    this.tierGate = new TierGate();
    this.serializer = new JsonlSerializer();
    this.defaultRepoId = opts.defaultRepoId ?? "nexus/research";
  }

  /** GET /batches — list batches (free+) */
  listBatches(req: ApiRequest): ApiResponse<{ batches: CorpusBatch[]; total: number }> {
    const limit = req.params?.["limit"] ? parseInt(req.params["limit"]) : undefined;
    const batches = this.store.listBatches({ limit });
    return { data: { batches, total: batches.length }, status: 200 };
  }

  /** GET /batches/:id — read batch (free+) */
  readBatch(req: ApiRequest): ApiResponse<CorpusBatch> {
    const id = req.params?.["id"];
    if (!id) return { data: null, status: 400, error: "Missing batch id" };
    const batch = this.store.getBatch(id);
    if (!batch) return { data: null, status: 404, error: "Batch not found" };
    return { data: batch, status: 200 };
  }

  /** POST /query — query samples with filters (pro+) */
  querySamples(req: ApiRequest): ApiResponse<{ samples: CorpusSample[]; total: number }> {
    try {
      this.tierGate.requireTier("pro", req.userTier);
    } catch (err) {
      return { data: null, status: 403, error: err instanceof Error ? err.message : String(err) };
    }
    const filter = (req.body ?? {}) as BatchFilter;
    const samples = this.store.querySamples(filter);
    return { data: { samples, total: samples.length }, status: 200 };
  }

  /** POST /flush — flush pending samples to new batch + push to HF (enterprise+) */
  async flushAndPush(req: ApiRequest): Promise<ApiResponse<HfPublishResult>> {
    try {
      this.tierGate.requireTier("enterprise", req.userTier);
    } catch (err) {
      return { data: null, status: 403, error: err instanceof Error ? err.message : String(err) };
    }

    const name = (req.body as any)?.name ?? `batch-${Date.now()}`;
    const batch = this.store.flush(name, req.userTier);
    const result = await this.publisher.push(batch, this.defaultRepoId);

    if (result.success) {
      this.store.markFlushed(batch.id);
    }

    return { data: result, status: result.success ? 200 : 502 };
  }

  /** GET /batches/:id/download — download JSONL (pro+) */
  downloadJsonl(req: ApiRequest): ApiResponse<string> {
    try {
      this.tierGate.requireTier("pro", req.userTier);
    } catch (err) {
      return { data: null, status: 403, error: err instanceof Error ? err.message : String(err) };
    }

    const id = req.params?.["id"];
    if (!id) return { data: null, status: 400, error: "Missing batch id" };
    const batch = this.store.getBatch(id);
    if (!batch) return { data: null, status: 404, error: "Batch not found" };

    return { data: this.serializer.serialize(batch.samples), status: 200 };
  }
}
