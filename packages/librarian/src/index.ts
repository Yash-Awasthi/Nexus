// SPDX-License-Identifier: Apache-2.0
/**
 * librarian — Knowledge organisation agent for the Nexus platform.
 *
 * Provides:
 *   • KnowledgeItem    — tagged, cross-linked document unit
 *   • KnowledgeStore   — CRUD + tag/link management
 *   • TagIndex         — fast tag-to-item index
 *   • CrossLinker      — auto-suggest related items by keyword overlap
 *   • LibrarianAgent   — orchestrates ingest → tag → link pipeline
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type ItemStatus = "active" | "archived" | "draft";

/** Knowledge item interface definition. */
export interface KnowledgeItem {
  id: string;
  title: string;
  content: string;
  tags: string[];
  links: string[]; // ids of related items
  status: ItemStatus;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
}

/** Create item input interface definition. */
export interface CreateItemInput {
  title: string;
  content: string;
  tags?: string[];
  links?: string[];
  status?: ItemStatus;
  metadata?: Record<string, unknown>;
}

/** Search options interface definition. */
export interface SearchOptions {
  tags?: string[];
  status?: ItemStatus;
  query?: string;
  limit?: number;
}

// ── ID util ───────────────────────────────────────────────────────────────────

let _seq = 0;
function uid() {
  return `ki-${Date.now()}-${++_seq}`;
}

// ── KnowledgeStore ────────────────────────────────────────────────────────────

export class KnowledgeStore {
  private items = new Map<string, KnowledgeItem>();

  create(input: CreateItemInput): KnowledgeItem {
    const now = new Date().toISOString();
    const item: KnowledgeItem = {
      id: uid(),
      title: input.title,
      content: input.content,
      tags: input.tags ? [...new Set(input.tags.map((t) => t.toLowerCase()))] : [],
      links: input.links ? [...new Set(input.links)] : [],
      status: input.status ?? "active",
      createdAt: now,
      updatedAt: now,
      metadata: input.metadata ?? {},
    };
    this.items.set(item.id, item);
    return item;
  }

  get(id: string): KnowledgeItem | undefined {
    return this.items.get(id);
  }

  update(
    id: string,
    changes: Partial<Omit<KnowledgeItem, "id" | "createdAt">>,
  ): KnowledgeItem | undefined {
    const item = this.items.get(id);
    if (!item) return undefined;
    const updated: KnowledgeItem = {
      ...item,
      ...changes,
      id: item.id,
      createdAt: item.createdAt,
      updatedAt: new Date().toISOString(),
    };
    if (changes.tags) {
      updated.tags = [...new Set(changes.tags.map((t) => t.toLowerCase()))];
    }
    this.items.set(id, updated);
    return updated;
  }

  delete(id: string): boolean {
    return this.items.delete(id);
  }

  list(): KnowledgeItem[] {
    return [...this.items.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  search(opts: SearchOptions = {}): KnowledgeItem[] {
    let results = [...this.items.values()];

    if (opts.status) {
      results = results.filter((i) => i.status === opts.status);
    }

    if (opts.tags && opts.tags.length > 0) {
      const required = opts.tags.map((t) => t.toLowerCase());
      results = results.filter((i) => required.every((tag) => i.tags.includes(tag)));
    }

    if (opts.query) {
      const q = opts.query.toLowerCase();
      results = results.filter(
        (i) =>
          i.title.toLowerCase().includes(q) ||
          i.content.toLowerCase().includes(q) ||
          i.tags.some((t) => t.includes(q)),
      );
    }

    results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return opts.limit ? results.slice(0, opts.limit) : results;
  }

  count(): number {
    return this.items.size;
  }

  /** Add a tag to an item (idempotent). */
  addTag(id: string, tag: string): KnowledgeItem | undefined {
    const item = this.items.get(id);
    if (!item) return undefined;
    const t = tag.toLowerCase();
    if (!item.tags.includes(t)) {
      return this.update(id, { tags: [...item.tags, t] });
    }
    return item;
  }

  /** Remove a tag from an item. */
  removeTag(id: string, tag: string): KnowledgeItem | undefined {
    const item = this.items.get(id);
    if (!item) return undefined;
    const t = tag.toLowerCase();
    return this.update(id, { tags: item.tags.filter((x) => x !== t) });
  }

  /** Add a cross-link between two items (bidirectional). */
  link(idA: string, idB: string): boolean {
    const a = this.items.get(idA);
    const b = this.items.get(idB);
    if (!a || !b) return false;
    if (!a.links.includes(idB)) this.update(idA, { links: [...a.links, idB] });
    if (!b.links.includes(idA)) this.update(idB, { links: [...b.links, idA] });
    return true;
  }

  /** Remove a cross-link between two items (bidirectional). */
  unlink(idA: string, idB: string): boolean {
    const a = this.items.get(idA);
    const b = this.items.get(idB);
    if (!a || !b) return false;
    this.update(idA, { links: a.links.filter((x) => x !== idB) });
    this.update(idB, { links: b.links.filter((x) => x !== idA) });
    return true;
  }
}

// ── TagIndex ──────────────────────────────────────────────────────────────────

export class TagIndex {
  private index = new Map<string, Set<string>>();

  add(tag: string, itemId: string): void {
    const t = tag.toLowerCase();
    if (!this.index.has(t)) this.index.set(t, new Set());
    this.index.get(t)!.add(itemId);
  }

  remove(tag: string, itemId: string): void {
    const t = tag.toLowerCase();
    this.index.get(t)?.delete(itemId);
    if (this.index.get(t)?.size === 0) this.index.delete(t);
  }

  lookup(tag: string): string[] {
    return [...(this.index.get(tag.toLowerCase()) ?? [])];
  }

  tags(): string[] {
    return [...this.index.keys()].sort();
  }

  /** Build index from a store snapshot. */
  static fromStore(store: KnowledgeStore): TagIndex {
    const idx = new TagIndex();
    for (const item of store.list()) {
      for (const tag of item.tags) idx.add(tag, item.id);
    }
    return idx;
  }
}

// ── CrossLinker ───────────────────────────────────────────────────────────────

function tokenize(text: string): Set<string> {
  const stop = new Set([
    "the",
    "a",
    "an",
    "is",
    "and",
    "or",
    "in",
    "of",
    "to",
    "for",
    "with",
    "on",
    "at",
  ]);
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !stop.has(w)),
  );
}

/** Suggested link interface definition. */
export interface SuggestedLink {
  id: string;
  title: string;
  score: number;
}

/** Cross linker. */
export class CrossLinker {
  /** Return items most similar to the given item based on keyword overlap. */
  suggest(item: KnowledgeItem, candidates: KnowledgeItem[], topK = 5): SuggestedLink[] {
    const sourceKw = tokenize(`${item.title} ${item.content} ${item.tags.join(" ")}`);
    const scored: SuggestedLink[] = [];

    for (const cand of candidates) {
      if (cand.id === item.id) continue;
      const candKw = tokenize(`${cand.title} ${cand.content} ${cand.tags.join(" ")}`);
      let overlap = 0;
      for (const kw of sourceKw) if (candKw.has(kw)) overlap++;
      if (overlap > 0) {
        const score = overlap / Math.sqrt(sourceKw.size * candKw.size);
        scored.push({ id: cand.id, title: cand.title, score });
      }
    }

    return scored.sort((a, b) => b.score - a.score).slice(0, topK);
  }
}

// ── LibrarianAgent ────────────────────────────────────────────────────────────

export interface IngestResult {
  item: KnowledgeItem;
  suggestedLinks: SuggestedLink[];
  autoLinked: number;
}

/** Librarian agent. */
export class LibrarianAgent {
  private store: KnowledgeStore;
  private linker: CrossLinker;
  private autoLinkThreshold: number;

  constructor(opts: { store?: KnowledgeStore; autoLinkThreshold?: number } = {}) {
    this.store = opts.store ?? new KnowledgeStore();
    this.linker = new CrossLinker();
    this.autoLinkThreshold = opts.autoLinkThreshold ?? 0.15;
  }

  getStore(): KnowledgeStore {
    return this.store;
  }

  /** Ingest a new item: create, auto-suggest links, apply threshold auto-linking. */
  ingest(input: CreateItemInput): IngestResult {
    const item = this.store.create(input);
    const all = this.store.list().filter((i) => i.id !== item.id);
    const suggestedLinks = this.linker.suggest(item, all);
    let autoLinked = 0;

    for (const s of suggestedLinks) {
      if (s.score >= this.autoLinkThreshold) {
        this.store.link(item.id, s.id);
        autoLinked++;
      }
    }

    return { item: this.store.get(item.id)!, suggestedLinks, autoLinked };
  }

  /** Recompute links for an existing item. */
  relink(id: string): SuggestedLink[] {
    const item = this.store.get(id);
    if (!item) return [];
    const others = this.store.list().filter((i) => i.id !== id);
    return this.linker.suggest(item, others);
  }

  /** Archive items older than cutoffDate. Returns count archived. */
  archiveOlderThan(cutoffDate: string): number {
    let count = 0;
    for (const item of this.store.list()) {
      if (item.status === "active" && item.updatedAt < cutoffDate) {
        this.store.update(item.id, { status: "archived" });
        count++;
      }
    }
    return count;
  }
}
