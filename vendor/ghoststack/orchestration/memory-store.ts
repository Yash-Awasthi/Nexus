/**
 * Unified Memory & Knowledge Layer
 * 
 * Cross-agent, cross-workflow memory store with searchable execution history,
 * semantic indexing, and trace-based retrieval.
 */

import { IRuntimePersistence } from "./interfaces/persistence.interface";
import { IEventStore } from "./interfaces/persistence.interface";
import { ILogger } from "./interfaces/logger.interface";

// ─── Types ───────────────────────────────────────────────────────────

export interface MemoryEntry {
  id: string;
  agentId?: string;
  workflowId?: string;
  executionId?: string;
  type: "observation" | "decision" | "result" | "error" | "state" | "knowledge";
  key: string;
  value: unknown;
  tags: string[];
  timestamp: Date;
  ttlMs?: number;
}

export interface MemoryQuery {
  types?: MemoryEntry["type"][];
  agents?: string[];
  workflows?: string[];
  tags?: string[];
  keyPrefix?: string;
  since?: Date;
  until?: Date;
  limit?: number;
  offset?: number;
}

export interface MemorySearchResult {
  entries: MemoryEntry[];
  total: number;
  query: MemoryQuery;
}

export interface IMemoryStore {
  store(entry: Omit<MemoryEntry, "id" | "timestamp">): Promise<string>;
  get(id: string): Promise<MemoryEntry | undefined>;
  query(query: MemoryQuery): Promise<MemorySearchResult>;
  delete(id: string): Promise<void>;
  prune(): Promise<number>;
  getStats(): Promise<{
    totalEntries: number;
    byType: Record<string, number>;
    oldest: Date | null;
    newest: Date | null;
  }>;
}

// ─── In-Memory Store with Index ──────────────────────────────────────

export class MemoryStore implements IMemoryStore {
  private entries = new Map<string, MemoryEntry>();
  private indexByAgent = new Map<string, Set<string>>();
  private indexByWorkflow = new Map<string, Set<string>>();
  private indexByType = new Map<string, Set<string>>();
  private indexByTag = new Map<string, Set<string>>();
  private persistence?: IRuntimePersistence;
  private loaded = false;

  private readonly STORAGE_KEY = "memory_store_data";

  private autoPruneTimer: ReturnType<typeof setInterval> | null = null;
  private readonly DEFAULT_AUTO_PRUNE_INTERVAL_MS = 60_000; // 1 minute
  private logger?: ILogger;

  constructor(persistence?: IRuntimePersistence, logger?: ILogger) {
    this.persistence = persistence;
    this.logger = logger;
  }

  /**
   * Start proactive TTL eviction on a timer.
   * Automatically sweeps expired entries at the given interval.
   * Safe to call multiple times (previous timer is cleared).
   */
  startAutoPrune(intervalMs: number = this.DEFAULT_AUTO_PRUNE_INTERVAL_MS): void {
    if (this.autoPruneTimer) {
      clearInterval(this.autoPruneTimer);
    }
    this.autoPruneTimer = setInterval(async () => {
      try {
        const pruned = await this.prune();
        if (pruned > 0) {
          const msg = `[MemoryStore] Auto-prune evicted ${pruned} expired TTL entr(ies)`;
          if (this.logger) { this.logger.info(msg); } else { console.warn(msg); }
        }
      } catch (err) {
        const errMsg = `[MemoryStore] Auto-prune error: ${(err as Error).message}`;
        if (this.logger) { this.logger.error(errMsg, err); } else { console.warn(errMsg); }
      }
    }, intervalMs).unref();
  }

  /** Stop the proactive TTL eviction timer. */
  stopAutoPrune(): void {
    if (this.autoPruneTimer) {
      clearInterval(this.autoPruneTimer);
      this.autoPruneTimer = null;
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (this.persistence) {
      const data = await this.persistence.getState<{
        entries: [string, MemoryEntry][];
        indexByAgent: [string, string[]][];
        indexByWorkflow: [string, string[]][];
        indexByType: [string, string[]][];
        indexByTag: [string, string[]][];
      }>(this.STORAGE_KEY);
      if (data) {
        this.entries = new Map(data.entries);
        this.indexByAgent = new Map(
          data.indexByAgent.map(([k, v]) => [k, new Set(v)])
        );
        this.indexByWorkflow = new Map(
          data.indexByWorkflow.map(([k, v]) => [k, new Set(v)])
        );
        this.indexByType = new Map(
          data.indexByType.map(([k, v]) => [k, new Set(v)])
        );
        this.indexByTag = new Map(
          data.indexByTag.map(([k, v]) => [k, new Set(v)])
        );
      }
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    if (!this.persistence) return;
    await this.persistence.saveState(this.STORAGE_KEY, {
      entries: Array.from(this.entries.entries()),
      indexByAgent: Array.from(this.indexByAgent.entries()).map(([k, v]) => [k, Array.from(v)]),
      indexByWorkflow: Array.from(this.indexByWorkflow.entries()).map(([k, v]) => [k, Array.from(v)]),
      indexByType: Array.from(this.indexByType.entries()).map(([k, v]) => [k, Array.from(v)]),
      indexByTag: Array.from(this.indexByTag.entries()).map(([k, v]) => [k, Array.from(v)])
    });
  }

  async store(entry: Omit<MemoryEntry, "id" | "timestamp">): Promise<string> {
    await this.ensureLoaded();
    const id = `mem-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    const full: MemoryEntry = {
      ...entry,
      id,
      timestamp: new Date()
    };

    this.entries.set(id, full);

    // Update indexes
    if (full.agentId) {
      const set = this.indexByAgent.get(full.agentId) || new Set();
      set.add(id);
      this.indexByAgent.set(full.agentId, set);
    }
    if (full.workflowId) {
      const set = this.indexByWorkflow.get(full.workflowId) || new Set();
      set.add(id);
      this.indexByWorkflow.set(full.workflowId, set);
    }
    const typeSet = this.indexByType.get(full.type) || new Set();
    typeSet.add(id);
    this.indexByType.set(full.type, typeSet);

    for (const tag of full.tags) {
      const tagSet = this.indexByTag.get(tag) || new Set();
      tagSet.add(id);
      this.indexByTag.set(tag, tagSet);
    }

    await this.persist();
    return id;
  }

  async get(id: string): Promise<MemoryEntry | undefined> {
    await this.ensureLoaded();
    const entry = this.entries.get(id);
    if (!entry) return undefined;

    // Check TTL
    if (entry.ttlMs) {
      const age = Date.now() - entry.timestamp.getTime();
      if (age > entry.ttlMs) {
        this.entries.delete(id);
        await this.persist();
        return undefined;
      }
    }
    return entry;
  }

  async query(query: MemoryQuery): Promise<MemorySearchResult> {
    await this.ensureLoaded();
    let candidates = new Set(this.entries.keys());

    // Filter by type
    if (query.types && query.types.length > 0) {
      const typeSets: Set<string>[] = query.types.map((t) => this.indexByType.get(t) || new Set<string>());
      const union = new Set<string>();
      for (const s of typeSets) {
        for (const id of s) union.add(id);
      }
      candidates = intersect(candidates, union);
    }

    // Filter by agent
    if (query.agents && query.agents.length > 0) {
      const agentSets: Set<string>[] = query.agents.map((a) => this.indexByAgent.get(a) || new Set<string>());
      const union = new Set<string>();
      for (const s of agentSets) {
        for (const id of s) union.add(id);
      }
      candidates = intersect(candidates, union);
    }

    // Filter by workflow
    if (query.workflows && query.workflows.length > 0) {
      const wfSets: Set<string>[] = query.workflows.map((w) => this.indexByWorkflow.get(w) || new Set<string>());
      const union = new Set<string>();
      for (const s of wfSets) {
        for (const id of s) union.add(id);
      }
      candidates = intersect(candidates, union);
    }

    // Filter by tags
    if (query.tags && query.tags.length > 0) {
      const tagSets: Set<string>[] = query.tags.map((t) => this.indexByTag.get(t) || new Set<string>());
      let tagFiltered = new Set(candidates);
      for (const s of tagSets) {
        tagFiltered = intersect(tagFiltered, s);
      }
      candidates = tagFiltered;
    }

    // Filter by key prefix
    if (query.keyPrefix) {
      const prefixFiltered = new Set<string>();
      for (const id of candidates) {
        const entry = this.entries.get(id)!;
        if (entry.key.startsWith(query.keyPrefix)) {
          prefixFiltered.add(id);
        }
      }
      candidates = prefixFiltered;
    }

    // Time range filter
    if (query.since || query.until) {
      const timeFiltered = new Set<string>();
      const since = query.since?.getTime() || 0;
      const until = query.until?.getTime() || Infinity;
      for (const id of candidates) {
        const ts = this.entries.get(id)!.timestamp.getTime();
        if (ts >= since && ts <= until) {
          timeFiltered.add(id);
        }
      }
      candidates = timeFiltered;
    }

    // Sort by timestamp desc
    const sorted = Array.from(candidates)
      .map((id) => this.entries.get(id)!)
      .filter((e) => {
        // TTL check — use _removeFromIndexes so stale IDs are cleaned from all index Sets
        if (e.ttlMs && Date.now() - e.timestamp.getTime() > e.ttlMs) {
          this._removeFromIndexes(e.id, e);
          return false;
        }
        return true;
      })
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    const total = sorted.length;
    const offset = query.offset || 0;
    const limit = query.limit || 50;
    const entries = sorted.slice(offset, offset + limit);

    return { entries, total, query };
  }

  /**
   * Remove a single entry from the entries Map AND all four index Sets.
   * Must be called whenever an entry is evicted (delete, prune, TTL eviction).
   */
  private _removeFromIndexes(id: string, entry: MemoryEntry): void {
    this.entries.delete(id);
    if (entry.agentId) {
      this.indexByAgent.get(entry.agentId)?.delete(id);
    }
    if (entry.workflowId) {
      this.indexByWorkflow.get(entry.workflowId)?.delete(id);
    }
    this.indexByType.get(entry.type)?.delete(id);
    for (const tag of entry.tags) {
      this.indexByTag.get(tag)?.delete(id);
    }
  }

  async delete(id: string): Promise<void> {
    await this.ensureLoaded();
    const entry = this.entries.get(id);
    if (!entry) return;
    this._removeFromIndexes(id, entry);
    await this.persist();
  }

  async prune(): Promise<number> {
    await this.ensureLoaded();
    let pruned = 0;
    for (const [id, entry] of this.entries) {
      if (entry.ttlMs && Date.now() - entry.timestamp.getTime() > entry.ttlMs) {
        this._removeFromIndexes(id, entry);
        pruned++;
      }
    }
    if (pruned > 0) await this.persist();
    return pruned;
  }

  /**
   * Compact the memory store using rolling-window importance scoring.
   *
   * Strategy:
   *   1. Score each entry by recency + type weight + tag diversity
   *   2. Keep the top `keepCount` entries + all entries newer than `recentWindowMs`
   *   3. Evict the rest
   *
   * Returns the number of entries evicted.
   */
  async compact(opts: {
    keepCount?: number;
    recentWindowMs?: number;
    preserveTypes?: MemoryEntry["type"][];
  } = {}): Promise<number> {
    await this.ensureLoaded();
    const keepCount = opts.keepCount ?? 200;
    const recentWindowMs = opts.recentWindowMs ?? 60 * 60 * 1000; // 1 hour
    const preserveTypes: Set<string> = new Set(opts.preserveTypes ?? ["decision", "knowledge"]);

    if (this.entries.size <= keepCount) return 0;

    const now = Date.now();
    // Type importance weights (decision + knowledge are high value)
    const TYPE_WEIGHT: Record<string, number> = {
      knowledge: 1.0,
      decision: 0.9,
      result: 0.7,
      state: 0.6,
      observation: 0.4,
      error: 0.3
    };

    // Score each entry
    const scored = Array.from(this.entries.entries()).map(([id, entry]) => {
      const ageMs = now - entry.timestamp.getTime();
      const recencyScore = Math.exp(-ageMs / (24 * 60 * 60 * 1000)); // decays over 24h
      const typeScore = TYPE_WEIGHT[entry.type] ?? 0.5;
      const tagDiversityBonus = Math.min(entry.tags.length * 0.05, 0.2);
      const importanceScore = typeScore * 0.5 + recencyScore * 0.4 + tagDiversityBonus;
      const isRecent = ageMs < recentWindowMs;
      const isPreserved = preserveTypes.has(entry.type);
      return { id, entry, importanceScore, isRecent, isPreserved };
    });

    // Always keep: recent entries + preserved types
    const mustKeep = new Set(
      scored.filter((s) => s.isRecent || s.isPreserved).map((s) => s.id)
    );

    // From remaining, keep top-scored up to keepCount
    const remaining = scored.filter((s) => !mustKeep.has(s.id));
    remaining.sort((a, b) => b.importanceScore - a.importanceScore);

    const additionalKeep = Math.max(0, keepCount - mustKeep.size);
    remaining.slice(0, additionalKeep).forEach((s) => mustKeep.add(s.id));

    // Evict everything not in mustKeep
    let evicted = 0;
    for (const [id, entry] of this.entries) {
      if (!mustKeep.has(id)) {
        this._removeFromIndexes(id, entry);
        evicted++;
      }
    }

    if (evicted > 0) {
      this.logger?.info(`MemoryStore.compact: evicted ${evicted} entries, retained ${this.entries.size}`);
      await this.persist();
    }
    return evicted;
  }

  async getStats(): Promise<{
    totalEntries: number;
    byType: Record<string, number>;
    oldest: Date | null;
    newest: Date | null;
  }> {
    await this.ensureLoaded();
    const byType: Record<string, number> = {};
    let oldest: Date | null = null;
    let newest: Date | null = null;

    for (const entry of this.entries.values()) {
      byType[entry.type] = (byType[entry.type] || 0) + 1;
      if (!oldest || entry.timestamp < oldest) oldest = entry.timestamp;
      if (!newest || entry.timestamp > newest) newest = entry.timestamp;
    }

    return {
      totalEntries: this.entries.size,
      byType,
      oldest,
      newest
    };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

function intersect(a: Set<string>, b: Set<string>): Set<string> {
  const result = new Set<string>();
  // Iterate over smaller set for efficiency
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const item of small) {
    if (large.has(item)) result.add(item);
  }
  return result;
}

// ─── Trace Indexer ───────────────────────────────────────────────────
// Indexes event store events as searchable memory entries

export class TraceIndexer {
  private lastIndexed = 0;

  constructor(
    private eventStore: IEventStore,
    private memoryStore: IMemoryStore
  ) {}

  async indexRecentEvents(): Promise<number> {
    const events = await this.eventStore.replayEvents();
    let indexed = 0;
    for (let i = this.lastIndexed; i < events.length; i++) {
      const event = events[i];
      const memType = this.mapEventToMemoryType(event.event);
      if (!memType) continue;

      await this.memoryStore.store({
        type: memType,
        key: `event:${event.event}`,
        value: event.payload,
        tags: ["event-store", event.event],
        workflowId: (event.payload as Record<string, unknown>)?.workflowId as string | undefined,
        executionId: ((event.payload as Record<string, unknown>)?.executionId ||
          (event.payload as Record<string, unknown>)?.taskId) as string | undefined,
        ttlMs: 7 * 24 * 60 * 60 * 1000 // 7 day TTL
      });
      indexed++;
    }
    this.lastIndexed = events.length;
    return indexed;
  }

  private mapEventToMemoryType(eventName: string): MemoryEntry["type"] | null {
    if (eventName.includes("succeeded") || eventName.includes("completed")) return "result";
    if (eventName.includes("failed") || eventName.includes("error")) return "error";
    if (eventName.includes("approved") || eventName.includes("denied")) return "decision";
    if (eventName.includes("planned") || eventName.includes("routed")) return "observation";
    if (eventName.includes("state") || eventName.includes("snapshot")) return "state";
    return null;
  }
}
