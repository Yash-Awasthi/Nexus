// SPDX-License-Identifier: Apache-2.0
/**
 * Semantic cache — answers kept per account and matched by meaning (embedding cosine, or
 * substring when no embedder answers). `/v1/chat/completions` consults it only when a call asks
 * with `X-Nexus-Semantic-Cache: on`: a near match to a different question is a wrong answer, so
 * the caller decides.
 */

import { FixedEmbedder, createBestEmbedder } from "@nexus/memory";

import { sha256hex } from "./crypto-utils.js";
import { PersistentStore } from "./persistent-store.js";

interface CacheEntry {
  key: string;
  query: string;
  response: string;
  embedding: number[] | null;
  hits: number;
  createdAt: string;
  lastHit: string;
  id?: string;
  ownerId?: string | null;
}

type Caller = { nexusUserId?: string };

const store = new PersistentStore<CacheEntry>("semantic_cache");
const meta = new PersistentStore<{ id: string; misses?: number } & Record<string, unknown>>(
  "semantic_cache_meta",
);
// Workspace-level settings (one row); entries and miss counts are per user.
// 0.95: a looser match already pairs "capital of France" with "capital of Spain".
const config = { enabled: true, similarityThreshold: 0.95, maxEntries: 1000, ttlHours: 24 };
let loading: Promise<void> | null = null;
const ready = () =>
  (loading ??= Promise.all([store.load(), meta.load()]).then(() => {
    const { id: _id, ...saved } = (meta.get("config") ?? {}) as Record<string, unknown>;
    Object.assign(config, saved);
  }));

const now = () => new Date().toISOString();

/** The caller's slice of the cache. */
function cacheFor(req: Caller) {
  const owner = req.nexusUserId ?? null;
  const idOf = (key: string) => `${owner ?? "anonymous"}:${key}`;
  const values = () => [...store.values()].filter((e) => (e.ownerId ?? null) === owner);
  const missId = `misses:${owner ?? "anonymous"}`;
  return {
    values,
    set: (e: CacheEntry) => store.set(idOf(e.key), { ...e, id: idOf(e.key), ownerId: owner }),
    delete: (key: string) => {
      const had = store.has(idOf(key));
      store.delete(idOf(key));
      return had;
    },
    clear: () => {
      for (const e of values()) store.delete(e.id ?? idOf(e.key));
    },
    misses: () => meta.get(missId)?.misses ?? 0,
    miss: () => meta.set(missId, { id: missId, misses: (meta.get(missId)?.misses ?? 0) + 1 }),
  };
}

let embedder: { embed(t: string): Promise<number[]> } | null = null;
const getEmbedder = () => {
  if (!embedder) {
    try {
      embedder = createBestEmbedder();
    } catch {
      embedder = new FixedEmbedder(768);
    }
  }
  return embedder;
};
const embed = (text: string) =>
  getEmbedder()
    .embed(text)
    .catch(() => null);

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

const expired = (e: CacheEntry) =>
  Date.now() - Date.parse(e.createdAt) > config.ttlHours * 3_600_000;

/** Keep `response` as the caller's answer to `query`. */
export async function semanticStore(req: Caller, query: string, response: string) {
  await ready();
  const cache = cacheFor(req);
  const q = query.trim();
  const embedding = await embed(q);
  const key = sha256hex(q).slice(0, 16);
  cache.set({ key, query: q, response, embedding, hits: 0, createdAt: now(), lastHit: now() });
  const mine = cache.values();
  if (mine.length > config.maxEntries) {
    const oldest = mine.sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (oldest) cache.delete(oldest.key);
  }
  return { key, embedded: embedding !== null };
}

/** The caller's closest kept answer to `query`, when it is close enough. */
export async function semanticLookup(req: Caller, query: string) {
  await ready();
  const cache = cacheFor(req);
  const q = query.trim();
  for (const e of cache.values()) if (expired(e)) cache.delete(e.key);
  const entries = cache.values();
  if (!q || !config.enabled || entries.length === 0) {
    cache.miss();
    return { hit: false as const, entry: null, similarity: 0 };
  }
  const qVec = await embed(q);
  let best: CacheEntry | null = null;
  let bestSim = 0;
  for (const e of entries) {
    const a = e.query.toLowerCase();
    const b = q.toLowerCase();
    const sim =
      qVec && e.embedding ? cosine(qVec, e.embedding) : a.includes(b) || b.includes(a) ? 0.9 : 0;
    if (sim > bestSim) {
      bestSim = sim;
      best = e;
    }
  }
  const similarity = Math.round(bestSim * 10_000) / 10_000;
  if (best && bestSim >= config.similarityThreshold) {
    best.hits += 1;
    best.lastHit = now();
    cache.set(best);
    return { hit: true as const, entry: best, similarity };
  }
  cache.miss();
  return { hit: false as const, entry: null, similarity };
}
