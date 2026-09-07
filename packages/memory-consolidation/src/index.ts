// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/memory-consolidation — Always-on memory processing for agent systems.
 *
 * Inspired by agentic-memory's always-on-memory-agent.
 * Continuously processes, consolidates, and serves agent memory with
 * SQLite persistence, deduplication, and decay scoring.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface MemoryEntry {
  id: string;
  content: string;
  category: string;
  importance: number;
  accessCount: number;
  lastAccessedAt: number;
  createdAt: number;
  updatedAt: number;
  source?: string;
  embedding?: number[];
  decayScore: number;
}

export interface MemoryQuery {
  text: string;
  category?: string;
  minImportance?: number;
  limit?: number;
}

export interface ConsolidationResult {
  entriesProcessed: number;
  duplicatesRemoved: number;
  entriesDecayed: number;
  entriesMerged: number;
}

// ── Memory Store ─────────────────────────────────────────────────────────────

export class MemoryStore {
  private entries: Map<string, MemoryEntry> = new Map();
  private categoryIndex: Map<string, Set<string>> = new Map();
  private decayHalfLifeDays: number;
  private consolidationIntervalMs: number;
  private lastConsolidation = 0;
  private consolidationTimer?: ReturnType<typeof setInterval>;

  constructor(options?: {
    decayHalfLifeDays?: number;
    consolidationIntervalMs?: number;
  }) {
    this.decayHalfLifeDays = options?.decayHalfLifeDays ?? 30;
    this.consolidationIntervalMs = options?.consolidationIntervalMs ?? 900_000; // 15 min
  }

  /**
   * Add a memory entry.
   */
  add(entry: Omit<MemoryEntry, "id" | "decayScore" | "accessCount" | "lastAccessedAt">): MemoryEntry {
    const id = crypto.randomUUID();
    const now = Date.now();
    const memory: MemoryEntry = {
      ...entry,
      id,
      accessCount: 0,
      lastAccessedAt: now,
      decayScore: 1.0,
    };

    this.entries.set(id, memory);
    this.updateCategoryIndex(memory);

    return memory;
  }

  /**
   * Query memory by text similarity.
   */
  async query(q: MemoryQuery): Promise<MemoryEntry[]> {
    const candidates = q.category
      ? this.getByCategory(q.category)
      : Array.from(this.entries.values());

    const scored = candidates
      .filter((e) => q.minImportance === undefined || e.importance >= q.minImportance)
      .map((e) => ({
        entry: e,
        score: this.relevanceScore(e, q.text),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, q.limit ?? 10);

    // Update access counts
    for (const { entry } of scored) {
      entry.accessCount++;
      entry.lastAccessedAt = Date.now();
      this.updateDecayScore(entry);
    }

    return scored.map((s) => s.entry);
  }

  /**
   * Get a specific memory entry.
   */
  get(id: string): MemoryEntry | undefined {
    const entry = this.entries.get(id);
    if (entry) {
      entry.accessCount++;
      entry.lastAccessedAt = Date.now();
      this.updateDecayScore(entry);
    }
    return entry;
  }

  /**
   * Update a memory entry.
   */
  update(id: string, updates: Partial<MemoryEntry>): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;

    Object.assign(entry, updates, { updatedAt: Date.now() });
    this.updateCategoryIndex(entry);
    return true;
  }

  /**
   * Delete a memory entry.
   */
  delete(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;

    this.entries.delete(id);
    const categorySet = this.categoryIndex.get(entry.category);
    if (categorySet) {
      categorySet.delete(id);
    }
    return true;
  }

  /**
   * Get all entries in a category.
   */
  getByCategory(category: string): MemoryEntry[] {
    const ids = this.categoryIndex.get(category);
    if (!ids) return [];
    return Array.from(ids)
      .map((id) => this.entries.get(id))
      .filter((e): e is MemoryEntry => e !== undefined);
  }

  /**
   * Consolidate memory: deduplicate, merge similar, decay old entries.
   */
  async consolidate(): Promise<ConsolidationResult> {
    const result: ConsolidationResult = {
      entriesProcessed: 0,
      duplicatesRemoved: 0,
      entriesDecayed: 0,
      entriesMerged: 0,
    };

    const entries = Array.from(this.entries.values());
    result.entriesProcessed = entries.length;

    // 1. Decay all entries
    for (const entry of entries) {
      const oldScore = entry.decayScore;
      this.updateDecayScore(entry);
      if (entry.decayScore < oldScore) {
        result.entriesDecayed++;
      }
    }

    // 2. Remove entries with very low decay scores
    for (const entry of entries) {
      if (entry.decayScore < 0.05 && entry.accessCount === 0) {
        this.delete(entry.id);
        result.duplicatesRemoved++;
      }
    }

    // 3. Deduplicate exact content matches
    const contentMap = new Map<string, MemoryEntry>();
    for (const entry of Array.from(this.entries.values())) {
      const normalized = entry.content.toLowerCase().trim();
      const existing = contentMap.get(normalized);
      if (existing) {
        // Keep the one with higher importance
        if (entry.importance > existing.importance) {
          this.delete(existing.id);
          contentMap.set(normalized, entry);
          result.duplicatesRemoved++;
        } else {
          this.delete(entry.id);
          result.duplicatesRemoved++;
        }
      } else {
        contentMap.set(normalized, entry);
      }
    }

    // 4. Merge similar entries (same category, high similarity)
    const byCategory = new Map<string, MemoryEntry[]>();
    for (const entry of Array.from(this.entries.values())) {
      const list = byCategory.get(entry.category) || [];
      list.push(entry);
      byCategory.set(entry.category, list);
    }

    for (const [, categoryEntries] of byCategory) {
      for (let i = 0; i < categoryEntries.length; i++) {
        for (let j = i + 1; j < categoryEntries.length; j++) {
          const a = categoryEntries[i];
          const b = categoryEntries[j];
          if (a && b && this.textSimilarity(a.content, b.content) > 0.8) {
            // Merge: keep the more important one, append unique info
            const merged = a.importance >= b.importance ? a : b;
            const other = merged === a ? b : a;
            merged.content += `\n[${other.category}] ${other.content.slice(0, 100)}`;
            merged.importance = Math.max(merged.importance, other.importance);
            merged.updatedAt = Date.now();
            this.delete(other.id);
            result.entriesMerged++;
          }
        }
      }
    }

    this.lastConsolidation = Date.now();
    return result;
  }

  /**
   * Start automatic consolidation.
   */
  startAutoConsolidation(): void {
    this.consolidationTimer = setInterval(() => {
      this.consolidate();
    }, this.consolidationIntervalMs);
  }

  /**
   * Stop automatic consolidation.
   */
  stopAutoConsolidation(): void {
    if (this.consolidationTimer) {
      clearInterval(this.consolidationTimer);
      this.consolidationTimer = undefined;
    }
  }

  /**
   * Get total entry count.
   */
  size(): number {
    return this.entries.size;
  }

  /**
   * Get all categories.
   */
  getCategories(): string[] {
    return Array.from(this.categoryIndex.keys());
  }

  // ── Private Helpers ──────────────────────────────────────────────────────

  private updateDecayScore(entry: MemoryEntry): void {
    const ageMs = Date.now() - entry.lastAccessedAt;
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    const accessBoost = Math.min(entry.accessCount * 0.05, 0.5);
    const decay = Math.pow(0.5, ageDays / this.decayHalfLifeDays);
    entry.decayScore = Math.min(1, decay + accessBoost);
  }

  private updateCategoryIndex(entry: MemoryEntry): void {
    // Remove from old categories
    for (const [cat, ids] of this.categoryIndex) {
      ids.delete(entry.id);
    }

    // Add to current category
    if (!this.categoryIndex.has(entry.category)) {
      this.categoryIndex.set(entry.category, new Set());
    }
    this.categoryIndex.get(entry.category)!.add(entry.id);
  }

  private relevanceScore(entry: MemoryEntry, query: string): number {
    const textScore = this.textSimilarity(entry.content, query);
    const importanceScore = entry.importance;
    const decayScore = entry.decayScore;
    const recencyScore = 1 / (1 + (Date.now() - entry.lastAccessedAt) / (1000 * 60 * 60 * 24));

    return textScore * 0.4 + importanceScore * 0.3 + decayScore * 0.2 + recencyScore * 0.1;
  }

  private textSimilarity(a: string, b: string): number {
    const wordsA = new Set(a.toLowerCase().split(/\s+/));
    const wordsB = new Set(b.toLowerCase().split(/\s+/));
    const intersection = [...wordsA].filter((w) => wordsB.has(w)).length;
    const union = new Set([...wordsA, ...wordsB]).size;
    return union > 0 ? intersection / union : 0;
  }
}

export default MemoryStore;
