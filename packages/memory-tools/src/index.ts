// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/memory-tools — memory maintenance tooling.
 *
 * Provides export, import, and deduplication for the @nexus/memory vector store
 * before the memory corpus grows large enough to make these operations expensive.
 *
 * All I/O is through an injectable MemoryToolsStore — pass any implementation
 * that satisfies the three-method interface (list / save / delete).  In tests,
 * use the included InMemoryToolsStore.  In production, wrap your PgVectorStore.
 *
 * Three deduplication strategies:
 *
 *   "exact"       — case-insensitive exact text match
 *   "fingerprint" — normalised text match (collapse whitespace, strip
 *                   punctuation, lowercase) — catches rephrased duplicates
 *   "embedding"   — cosine similarity above a threshold (default 0.97)
 *                   Entries with zero-length or all-zero embeddings are
 *                   skipped and fall back to fingerprint.
 *
 * Canonical selection: when a duplicate group is found, the entry with the
 * lowest createdAt (oldest) is kept; the rest are removed.
 *
 * Export format: JSONL-compatible JSON object with schema version field so
 * future format changes can be handled on import.
 */

// ── Memory entry (mirrors @nexus/memory MemoryEntry — no hard dep) ────────────

export interface MemoryEntry {
  id: string;
  text: string;
  embedding: number[];
  metadata: Record<string, unknown>;
  /** Unix epoch seconds */
  createdAt: number;
  /** Unix epoch seconds — logically expired after this time */
  expiresAt?: number;
}

// ── Injectable store interface ─────────────────────────────────────────────────

/**
 * Minimal store contract required by memory-tools.
 * Structurally compatible with @nexus/memory's IMemoryStore + MemoryManager.
 */
export interface MemoryToolsStore {
  /** Return all stored entries (no filtering) */
  list(): Promise<MemoryEntry[]>;
  /** Persist an entry; returns the stored copy */
  save(entry: MemoryEntry): Promise<MemoryEntry>;
  /** Remove an entry by id; no-op if not found */
  delete(id: string): Promise<void>;
}

// ── InMemoryToolsStore ────────────────────────────────────────────────────────

/**
 * In-memory implementation of MemoryToolsStore.
 * Use in tests and dev; not suitable for production.
 */
export class InMemoryToolsStore implements MemoryToolsStore {
  private readonly entries = new Map<string, MemoryEntry>();

  async list(): Promise<MemoryEntry[]> {
    return Array.from(this.entries.values());
  }

  async save(entry: MemoryEntry): Promise<MemoryEntry> {
    this.entries.set(entry.id, { ...entry });
    return entry;
  }

  async delete(id: string): Promise<void> {
    this.entries.delete(id);
  }

  /** Total count — convenience for tests */
  get size(): number {
    return this.entries.size;
  }
}

// ── Export format ─────────────────────────────────────────────────────────────

export interface MemoryExport {
  /** Schema version. Increment on breaking format changes. */
  version: "1";
  /** ISO 8601 export timestamp */
  exportedAt: string;
  /** Entry count — use to validate after parsing */
  count: number;
  /** The serialised entries */
  entries: MemoryEntry[];
}

/** Export options interface definition. */
export interface ExportOptions {
  /**
   * When false, expired entries (expiresAt < now) are excluded.
   * Default: false — exclude expired entries.
   */
  includeExpired?: boolean;
}

/**
 * Dump all (or non-expired) memory entries from `store` into a portable
 * MemoryExport object that can be JSON.stringify'd for backup.
 */
export async function exportMemory(
  store: MemoryToolsStore,
  opts: ExportOptions = {},
): Promise<MemoryExport> {
  const all = await store.list();
  const now = Math.floor(Date.now() / 1000);

  const entries = opts.includeExpired
    ? all
    : all.filter((e) => e.expiresAt === undefined || e.expiresAt > now);

  return {
    version: "1",
    exportedAt: new Date().toISOString(),
    count: entries.length,
    entries,
  };
}

// ── Import ────────────────────────────────────────────────────────────────────

export interface ImportOptions {
  /**
   * How to handle an entry whose id already exists in the store.
   * "skip" — leave the existing entry intact (default).
   * "overwrite" — replace the existing entry with the incoming one.
   */
  onConflict?: "skip" | "overwrite";
  /**
   * Deduplication strategy applied to incoming entries before saving.
   * Duplicates within the import batch are collapsed (oldest kept).
   * Default: "fingerprint".
   */
  strategy?: DeduplicationStrategy;
  /**
   * Cosine similarity threshold for "embedding" strategy.
   * Default: 0.97.
   */
  similarityThreshold?: number;
}

/** Import error interface definition. */
export interface ImportError {
  id: string;
  error: string;
}

/** Import result interface definition. */
export interface ImportResult {
  /** Entries successfully saved to the store */
  imported: number;
  /** Entries skipped (duplicate or conflict) */
  skipped: number;
  /** Entries that caused an error during save */
  errors: ImportError[];
  /** IDs of successfully imported entries */
  ids: string[];
}

/**
 * Import a MemoryExport into `store`.
 *
 * Steps:
 *  1. Validate the export version.
 *  2. Collapse intra-batch duplicates via the chosen strategy.
 *  3. Fetch existing IDs from the store to enforce onConflict policy.
 *  4. Save each surviving entry, collecting errors.
 */
export async function importMemory(
  data: MemoryExport,
  store: MemoryToolsStore,
  opts: ImportOptions = {},
): Promise<ImportResult> {
  if (data.version !== "1") {
    throw new MemoryToolsError(
      `Unsupported export version "${String(data.version)}"`,
      "UNSUPPORTED_VERSION",
    );
  }

  const strategy = opts.strategy ?? "fingerprint";
  const threshold = opts.similarityThreshold ?? 0.97;
  const onConflict = opts.onConflict ?? "skip";

  // Collapse intra-batch duplicates
  const deduped = collapseDuplicates(data.entries, strategy, threshold);

  // Fetch existing ids for conflict check
  const existing = await store.list();
  const existingIds = new Set(existing.map((e) => e.id));

  const result: ImportResult = { imported: 0, skipped: 0, errors: [], ids: [] };

  for (const entry of deduped) {
    if (existingIds.has(entry.id) && onConflict === "skip") {
      result.skipped++;
      continue;
    }

    try {
      await store.save(entry);
      result.imported++;
      result.ids.push(entry.id);
    } catch (err) {
      result.errors.push({ id: entry.id, error: String(err) });
    }
  }

  result.skipped += data.entries.length - deduped.length; // intra-batch dupes

  return result;
}

// ── Deduplication ─────────────────────────────────────────────────────────────

export type DeduplicationStrategy = "exact" | "fingerprint" | "embedding";

/** Duplicate group interface definition. */
export interface DuplicateGroup {
  /** The entry that will be / was kept (lowest createdAt) */
  canonical: MemoryEntry;
  /** Entries that will be / were removed */
  duplicates: MemoryEntry[];
  /** The strategy that identified this group */
  strategy: DeduplicationStrategy;
}

/** Deduplication result interface definition. */
export interface DeduplicationResult {
  /** Entries kept in the store */
  kept: number;
  /** Entries removed from the store (0 when dryRun=true) */
  removed: number;
  /** Detected duplicate groups */
  groups: DuplicateGroup[];
}

/** Deduplicate options interface definition. */
export interface DeduplicateOptions {
  /** Default: "fingerprint" */
  strategy?: DeduplicationStrategy;
  /** Cosine similarity threshold for "embedding" strategy. Default: 0.97 */
  similarityThreshold?: number;
  /**
   * When true, identify duplicates but do NOT delete from the store.
   * Default: false.
   */
  dryRun?: boolean;
}

/**
 * Identify and optionally remove duplicate memory entries from `store`.
 *
 * Canonical selection: lowest createdAt is kept.  When dryRun=true the store
 * is not modified and `removed` in the result will be 0.
 */
export async function deduplicateMemory(
  store: MemoryToolsStore,
  opts: DeduplicateOptions = {},
): Promise<DeduplicationResult> {
  const strategy = opts.strategy ?? "fingerprint";
  const threshold = opts.similarityThreshold ?? 0.97;
  const dryRun = opts.dryRun ?? false;

  const all = await store.list();
  const groups = findDuplicates(all, { strategy, similarityThreshold: threshold });

  let removed = 0;

  if (!dryRun) {
    for (const group of groups) {
      for (const dup of group.duplicates) {
        await store.delete(dup.id);
        removed++;
      }
    }
  }

  const totalDuplicates = groups.reduce((n, g) => n + g.duplicates.length, 0);

  return {
    kept: all.length - totalDuplicates,
    removed,
    groups,
  };
}

// ── findDuplicates ────────────────────────────────────────────────────────────

export interface FindDuplicatesOptions {
  strategy?: DeduplicationStrategy;
  similarityThreshold?: number;
}

/**
 * Identify duplicate groups within `entries` without touching any store.
 *
 * Returns groups where each group has a canonical entry (oldest) and one or
 * more duplicate entries that should be removed.
 */
export function findDuplicates(
  entries: MemoryEntry[],
  opts: FindDuplicatesOptions = {},
): DuplicateGroup[] {
  const strategy = opts.strategy ?? "fingerprint";
  const threshold = opts.similarityThreshold ?? 0.97;

  if (entries.length < 2) return [];

  switch (strategy) {
    case "exact":
      return findByExact(entries);
    case "fingerprint":
      return findByFingerprint(entries);
    case "embedding":
      return findByEmbedding(entries, threshold);
  }
}

// ── Strategy implementations ──────────────────────────────────────────────────

function findByExact(entries: MemoryEntry[]): DuplicateGroup[] {
  const groups = new Map<string, MemoryEntry[]>();

  for (const entry of entries) {
    const key = entry.text.toLowerCase();
    const bucket = groups.get(key) ?? [];
    bucket.push(entry);
    groups.set(key, bucket);
  }

  return buildGroups(groups, "exact");
}

function findByFingerprint(entries: MemoryEntry[]): DuplicateGroup[] {
  const groups = new Map<string, MemoryEntry[]>();

  for (const entry of entries) {
    const key = textFingerprint(entry.text);
    const bucket = groups.get(key) ?? [];
    bucket.push(entry);
    groups.set(key, bucket);
  }

  return buildGroups(groups, "fingerprint");
}

function findByEmbedding(entries: MemoryEntry[], threshold: number): DuplicateGroup[] {
  // Separate entries with usable embeddings from those without
  const usable = entries.filter((e) => isUsableEmbedding(e.embedding));
  const unusable = entries.filter((e) => !isUsableEmbedding(e.embedding));

  const groups: DuplicateGroup[] = [];
  const consumed = new Set<string>();

  for (let i = 0; i < usable.length; i++) {
    const a = usable[i]!;
    if (consumed.has(a.id)) continue;

    const group: MemoryEntry[] = [a];

    for (let j = i + 1; j < usable.length; j++) {
      const b = usable[j]!;
      if (consumed.has(b.id)) continue;

      if (cosineSimilarity(a.embedding, b.embedding) >= threshold) {
        group.push(b);
        consumed.add(b.id);
      }
    }

    consumed.add(a.id);

    if (group.length > 1) {
      const sorted = group.slice().sort((x, y) => x.createdAt - y.createdAt);
      groups.push({
        canonical: sorted[0]!,
        duplicates: sorted.slice(1),
        strategy: "embedding",
      });
    }
  }

  // Fallback to fingerprint for unusable entries
  if (unusable.length > 1) {
    const fingerprintGroups = findByFingerprint(unusable);
    groups.push(...fingerprintGroups);
  }

  return groups;
}

function buildGroups(
  buckets: Map<string, MemoryEntry[]>,
  strategy: DeduplicationStrategy,
): DuplicateGroup[] {
  const result: DuplicateGroup[] = [];

  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    const sorted = bucket.slice().sort((a, b) => a.createdAt - b.createdAt);
    result.push({
      canonical: sorted[0]!,
      duplicates: sorted.slice(1),
      strategy,
    });
  }

  return result;
}

/** Collapse an array of entries to one per duplicate group (keep oldest). */
function collapseDuplicates(
  entries: MemoryEntry[],
  strategy: DeduplicationStrategy,
  threshold: number,
): MemoryEntry[] {
  if (entries.length < 2) return entries;

  const groups = findDuplicates(entries, { strategy, similarityThreshold: threshold });
  const removeIds = new Set(groups.flatMap((g) => g.duplicates.map((d) => d.id)));

  return entries.filter((e) => !removeIds.has(e.id));
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

/**
 * Normalise text for fingerprint comparison:
 * lowercase → collapse whitespace → strip non-alphanumeric chars.
 */
export function textFingerprint(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9 ]/g, "")
    .trim();
}

/**
 * Cosine similarity between two vectors.
 * Returns 0 for zero-length or mismatched-dimension vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;

  return Math.min(1, dot / denom);
}

/**
 * True when the embedding has non-zero magnitude.
 * Zero-dimension or all-zero vectors (from nullEmbedder) are not usable for
 * similarity search.
 */
export function isUsableEmbedding(embedding: number[]): boolean {
  if (embedding.length === 0) return false;
  return embedding.some((v) => v !== 0);
}

// ── Error ─────────────────────────────────────────────────────────────────────

export class MemoryToolsError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "MemoryToolsError";
  }
}

// ── Extended memory item model ─────────────────────────────────────────────────
// Ported from thedotmack/claude-mem: src/core/schemas/memory-item.ts
// Pattern: rich MemoryItem with structured extraction fields (facts, concepts,
// filesRead/Modified), provenance tracking via MemorySource, and ContextPack
// for token-budgeted session injection.

/** Classification of how a memory item was produced. */
export type MemoryItemKind =
  | "observation" // Captured from agent tool usage / session events
  | "summary"     // Compressed multi-observation summary
  | "prompt"      // Injected via user prompt
  | "manual";     // Manually authored / imported

/** Provenance source type for a MemoryItem. */
export type MemorySourceType =
  | "observation"
  | "session_summary"
  | "user_prompt"
  | "manual"
  | "import";

/**
 * Rich memory item with structured knowledge extraction fields.
 * Ported from claude-mem MemoryItemSchema (Zod → TS interface).
 *
 * Key fields beyond the base memory record:
 *   - `facts[]`         — discrete factual claims extracted from the session
 *   - `concepts[]`      — higher-level concepts / entities identified
 *   - `filesRead[]`     — files read during the session (provenance)
 *   - `filesModified[]` — files written/modified (provenance)
 *   - `narrative`       — free-form prose summary of what happened
 */
export interface ExtendedMemoryItem {
  id: string;
  projectId: string;
  serverSessionId?: string | null;
  kind: MemoryItemKind;
  /** Fine-grained type tag within the kind (e.g. "code_change", "decision"). */
  type: string;
  title?: string | null;
  subtitle?: string | null;
  /** Short text representation; may be null for summary-only items. */
  text?: string | null;
  /** Prose narrative of the session or event. */
  narrative?: string | null;
  /** Discrete factual claims. */
  facts: string[];
  /** Higher-level concept / entity names. */
  concepts: string[];
  /** Paths of files read during the session. */
  filesRead: string[];
  /** Paths of files modified during the session. */
  filesModified: string[];
  metadata: Record<string, unknown>;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

/** Input type for creating a new ExtendedMemoryItem (omits server-set fields). */
export type CreateExtendedMemoryItem = Omit<
  ExtendedMemoryItem,
  "id" | "createdAtEpoch" | "updatedAtEpoch"
> & Partial<Pick<ExtendedMemoryItem, "serverSessionId" | "title" | "subtitle" | "text" | "narrative">>;

/**
 * Provenance record linking a MemoryItem to its originating source.
 * Ported from claude-mem MemorySourceSchema.
 */
export interface MemoryItemSource {
  id: string;
  memoryItemId: string;
  sourceType: MemorySourceType;
  /** URI of the original source (file path, URL, tool ID, etc.). */
  sourceUri?: string | null;
  metadata: Record<string, unknown>;
  createdAtEpoch: number;
}

/**
 * A token-budgeted collection of memory items ready for session injection.
 * Ported from claude-mem ContextPackSchema.
 *
 * Fill `items` with the highest-relevance memories up to `tokenBudget`;
 * the consumer slices the context window accordingly before injecting.
 */
export interface ContextPack {
  projectId: string;
  serverSessionId?: string | null;
  /** Unix epoch (ms) when this pack was assembled. */
  generatedAtEpoch: number;
  /** Maximum token budget for this pack; null = unlimited. */
  tokenBudget?: number | null;
  items: ExtendedMemoryItem[];
  metadata: Record<string, unknown>;
}

/** Estimate token count of a context pack (rough: 1 token ≈ 4 chars). */
export function estimateContextPackTokens(pack: ContextPack): number {
  const totalChars = pack.items.reduce((sum, item) => {
    const text = [
      item.title,
      item.text,
      item.narrative,
      ...(item.facts ?? []),
      ...(item.concepts ?? []),
    ]
      .filter(Boolean)
      .join(" ");
    return sum + text.length;
  }, 0);
  return Math.ceil(totalChars / 4);
}

/**
 * Trim a context pack to fit within its token budget.
 * Drops items from the end (lowest priority) until the budget is met.
 * Items should be pre-sorted highest-priority first before calling.
 */
export function trimContextPackTobudget(pack: ContextPack): ContextPack {
  if (!pack.tokenBudget) return pack;
  const items: ExtendedMemoryItem[] = [];
  let tokens = 0;
  for (const item of pack.items) {
    const itemTokens = estimateContextPackTokens({ ...pack, items: [item] });
    if (tokens + itemTokens > pack.tokenBudget) break;
    items.push(item);
    tokens += itemTokens;
  }
  return { ...pack, items };
}
