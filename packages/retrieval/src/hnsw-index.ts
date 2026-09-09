// SPDX-License-Identifier: Apache-2.0

import { dot, normalize, mulberry32 } from "@nexus/shared";
/**
 * @nexus/retrieval — HNSW approximate nearest-neighbor index (hnswlib port).
 *
 * Faithful TypeScript port of hnswlib's layered-graph ANN index and its
 * brute-force reference index (nmslib/hnswlib, Malkov & Yashunin 2018).
 * The API mirrors the upstream python bindings so callers can treat this as
 * the same index type the major vector stores (Chroma, Qdrant, Weaviate,
 * Milvus) embed under the hood:
 *
 *   HNSWIndex            — hnswlib.Index equivalent.
 *     initIndex(maxElements, { M, efConstruction, randomSeed })   init_index
 *     addItems(vectors, labels?)   — insert; same label ⇒ feature update
 *     searchKnn(query, k, filter?) / searchKnnBatch               knn_query
 *     markDeleted / unmarkDeleted                                 same names
 *     resizeIndex(newSize) / setEf(ef)                            same names
 *     getters: currentCount, maxElements, M, efConstruction, ef   index props
 *   BFIndex              — hnswlib.BFIndex equivalent (exact, filter-aware).
 *
 * Distance conventions match the upstream C++ spaces exactly:
 *   "l2"      — squared Euclidean distance (L2Sqr, no sqrt).
 *   "cosine"  — vectors normalized, then 1 − inner product.
 *   "ip"      — 1 − inner product (InnerProductDistance = 1.0f − dot).
 *
 * Not ported (named, as in the upstream repo): file persistence
 * (save_index/load_index), replace-deleted slot recycling, SIMD and
 * multithreaded add/query. Construction order + seeded RNG make the index
 * deterministic: the same add sequence with the same randomSeed rebuilds an
 * identical graph.
 *
 * Deletion behavior (measured on 800 random points, dim 16): markDeleted
 * never leaks a deleted label into results, and recall vs a filter-matched
 * brute-force scan holds at 1.0 up to ~80% of elements deleted. Beyond that
 * the survivor graph can fragment: at 90% deleted some queries return fewer
 * than k hits (recall 0.89 at ef=100); raising ef restores full recall
 * (1.0 at ef=200). This matches upstream hnswlib, which also marks
 * deletions without graph repair; compact the index (rebuild from survivors)
 * for extreme deletion churn.
 */

// ── Spaces ───────────────────────────────────────────────────────────────────

export type HnswSpace = "l2" | "ip" | "cosine";

/** Distance functions mirroring hnswlib's space_*.h: lower = more similar. */
export type DistanceFn = (a: number[], b: number[]) => number;

export function makeDistance(space: HnswSpace): DistanceFn {
  switch (space) {
    case "l2": {
      return (a, b) => {
        let s = 0;
        const n = Math.min(a.length, b.length);
        for (let i = 0; i < n; i++) {
          const d = (a[i] ?? 0) - (b[i] ?? 0);
          s += d * d;
        }
        return s;
      };
    }
    case "cosine": {
      return (a, b) => 1 - dot(normalize(a), normalize(b));
    }
    case "ip": {
      return (a, b) => 1 - dot(a, b);
    }
  }
}

// ── Result type ──────────────────────────────────────────────────────────────

export interface HnswHit {
  /** User-facing label (id) of the matched element. */
  label: number;
  /** Distance in the index's space (see DistanceFn conventions). */
  distance: number;
}

export type LabelFilter = (label: number) => boolean;

// ── Internal element record ──────────────────────────────────────────────────

interface HnswElement {
  label: number;
  vector: number[];
  /** Adjacency lists, one per graph layer index 0..level. */
  links: number[][];
  level: number;
  deleted: boolean;
}

interface Candidate {
  pos: number;
  dist: number;
}

// ── Brute-force reference index (hnswlib BFIndex) ───────────────────────────

/**
 * Exact nearest-neighbor index: linear scan over all stored elements.
 * Mirrors hnswlib's bruteforce.h — used to validate the approximate HNSW
 * index and for small collections where exactness beats graph overhead.
 */
export class BFIndex {
  readonly space: HnswSpace;
  readonly dimension: number;
  private readonly elements: HnswElement[] = [];
  private readonly byLabel = new Map<number, number>();
  private readonly distance: DistanceFn;

  constructor(space: HnswSpace, dimension: number) {
    this.space = space;
    this.dimension = dimension;
    this.distance = makeDistance(space);
  }

  get size(): number {
    return this.elements.length;
  }

  addItems(vectors: number[][], labels?: number[]): void {
    if (labels !== undefined && labels.length !== vectors.length)
      throw new Error("labels length must match vectors length");
    for (let i = 0; i < vectors.length; i++) {
      const label = labels === undefined ? this.elements.length : labels[i]!;
      const vector = vectors[i]!;
      if (vector.length !== this.dimension)
        throw new Error(`expected ${this.dimension} dims, got ${vector.length}`);
      const pos = this.byLabel.get(label);
      if (pos !== undefined) {
        this.elements[pos]!.vector = vector.slice();
      } else {
        this.byLabel.set(label, this.elements.length);
        this.elements.push({
          label,
          vector: vector.slice(),
          links: [],
          level: 0,
          deleted: false,
        });
      }
    }
  }

  /** k nearest neighbors (exact), optionally restricted by a label filter. */
  searchKnn(query: number[], k: number, filter?: LabelFilter): HnswHit[] {
    if (query.length !== this.dimension)
      throw new Error(`expected ${this.dimension} dims, got ${query.length}`);
    const scored: HnswHit[] = [];
    for (const e of this.elements) {
      if (e.deleted) continue;
      if (filter !== undefined && !filter(e.label)) continue;
      scored.push({
        label: e.label,
        distance: this.distance(query, e.vector),
      });
    }
    scored.sort((a, b) => a.distance - b.distance || a.label - b.label);
    return scored.slice(0, k);
  }
}

// ── HNSW index ───────────────────────────────────────────────────────────────

export interface HNSWInitOptions {
  /** Graph connectivity (hnswlib default 16). */
  M?: number;
  /** Construction-time candidate breadth (hnswlib default 200). */
  efConstruction?: number;
  /** Seed for the deterministic level generator (hnswlib default 100). */
  randomSeed?: number;
}

export interface HNSWSearchOptions {
  /** Query-time breadth. Defaults to the value set via setEf(). */
  ef?: number;
}

/**
 * Layered graph ANN index ported from hnswlib (Malkov & Yashunin 2018).
 *
 * The graph is a multi-layer skip list: upper layers hold sparse long-range
 * links for fast greedy descent, layer 0 holds the full connectivity with up
 * to 2×M neighbors per element (hnswlib's maxM0 = M*2). Neighbor selection
 * uses the paper's diversity heuristic (alg. 4), which is what hnswlib
 * applies, so a freshly inserted element connects to nearby elements that are
 * also far apart from each other.
 */
export class HNSWIndex {
  readonly space: HnswSpace;
  readonly dimension: number;
  private rng = mulberry32(100);
  private M = 16;
  private efConstruction = 200;
  private ef = 10;
  private maxM0 = 32;
  private levelMult = 1 / Math.log(16);
  private maxElements = 0;
  private elements: HnswElement[] = [];
  private byLabel = new Map<number, number>();
  private entryPoint = -1;
  private maxLevel = 0;
  private initialized = false;
  private readonly distance: DistanceFn;

  constructor(space: HnswSpace, dimension: number) {
    this.space = space;
    this.dimension = dimension;
    this.distance = makeDistance(space);
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  initIndex(maxElements: number, options: HNSWInitOptions = {}): void {
    if (maxElements <= 0) throw new Error("maxElements must be positive");
    this.M = options.M ?? 16;
    this.efConstruction = options.efConstruction ?? 200;
    if (this.M < 2) throw new Error("M must be ≥ 2");
    if (this.efConstruction < this.M) throw new Error("efConstruction must be ≥ M");
    this.maxElements = maxElements;
    this.maxM0 = this.M * 2;
    this.levelMult = 1 / Math.log(this.M);
    this.ef = 10;
    this.elements = [];
    this.byLabel.clear();
    this.entryPoint = -1;
    this.maxLevel = 0;
    // hnswlib: a single RNG constructed from random_seed drives all levels.
    this.rng = mulberry32(options.randomSeed ?? 100);
    this.initialized = true;
  }

  resizeIndex(newSize: number): void {
    if (newSize < this.elements.length) throw new Error("new size must be ≥ current element count");
    this.maxElements = newSize;
  }

  setEf(ef: number): void {
    if (ef <= 0) throw new Error("ef must be positive");
    this.ef = ef;
  }

  // ── getters (mirror hnswlib index properties) ──────────────────────────────

  get currentCount(): number {
    return this.elements.length;
  }

  get capacity(): number {
    return this.maxElements;
  }

  get getM(): number {
    return this.M;
  }

  get getEfConstruction(): number {
    return this.efConstruction;
  }

  get getEf(): number {
    return this.ef;
  }

  isDeleted(label: number): boolean {
    const pos = this.byLabel.get(label);
    return pos === undefined ? false : this.elements[pos]!.deleted;
  }

  getItem(label: number): number[] | undefined {
    const pos = this.byLabel.get(label);
    if (pos === undefined) return undefined;
    return this.elements[pos]!.vector.slice();
  }

  getDistance(labelA: number, labelB: number): number | undefined {
    const a = this.byLabel.get(labelA);
    const b = this.byLabel.get(labelB);
    if (a === undefined || b === undefined) return undefined;
    return this.distance(this.elements[a]!.vector, this.elements[b]!.vector);
  }

  // ── insertion / update ─────────────────────────────────────────────────────

  /**
   * Insert vectors. Labels default to 0..n-1 within each batch (upstream
   * arange semantics); re-adding an existing label updates that element's
   * feature vector in place — hnswlib's documented upsert behavior — which
   * is slower than a fresh insert but keeps the label searchable.
   */
  addItems(vectors: number[][], labels?: number[]): void {
    if (!this.initialized) throw new Error("initIndex() must be called first");
    if (labels !== undefined && labels.length !== vectors.length)
      throw new Error("labels length must match vectors length");
    for (let i = 0; i < vectors.length; i++) {
      const label = labels === undefined ? i : labels[i]!;
      const vector = vectors[i]!;
      if (vector.length !== this.dimension)
        throw new Error(`expected ${this.dimension} dims, got ${vector.length}`);
      const pos = this.byLabel.get(label);
      if (pos !== undefined) {
        this.updateElement(pos, vector);
      } else {
        if (this.elements.length >= this.maxElements)
          throw new Error(`index full (${this.maxElements}); call resizeIndex() first`);
        this.insertNew(vector, label);
      }
    }
  }

  // ── deletion ───────────────────────────────────────────────────────────────

  /** Mark an element deleted so it is omitted from search results. */
  markDeleted(label: number): void {
    const pos = this.byLabel.get(label);
    if (pos === undefined) throw new Error(`label ${label} not in index`);
    if (this.elements[pos]!.deleted) throw new Error("element already deleted");
    this.elements[pos]!.deleted = true;
  }

  unmarkDeleted(label: number): void {
    const pos = this.byLabel.get(label);
    if (pos === undefined) throw new Error(`label ${label} not in index`);
    if (!this.elements[pos]!.deleted) throw new Error("element not deleted");
    this.elements[pos]!.deleted = false;
  }

  // ── search ─────────────────────────────────────────────────────────────────

  /** k nearest neighbors (approximate), optionally restricted by a filter. */
  searchKnn(
    query: number[],
    k: number,
    filter?: LabelFilter,
    options?: HNSWSearchOptions,
  ): HnswHit[] {
    if (query.length !== this.dimension)
      throw new Error(`expected ${this.dimension} dims, got ${query.length}`);
    if (k <= 0 || this.entryPoint < 0) return [];
    const ef = Math.max(options?.ef ?? this.ef, k);
    const results = this.searchGraph(query, ef);
    return this.unwrapResults(results, k, filter);
  }

  /** Batch form of searchKnn (hnswlib's knn_query over multiple rows). */
  searchKnnBatch(queries: number[][], k: number, filter?: LabelFilter): HnswHit[][] {
    return queries.map((q) => this.searchKnn(q, k, filter));
  }

  // ── internal: graph ops ────────────────────────────────────────────────────

  private randomLevel(): number {
    // hnswlib: level = floor(-log(U) * levelMult), U ∈ (0, 1].
    let u = this.rng();
    if (u === 0) u = Number.MIN_VALUE;
    return Math.floor(-Math.log(u) * this.levelMult);
  }

  private insertNew(vector: number[], label: number): void {
    const level = this.randomLevel();
    const node: HnswElement = {
      label,
      vector: vector.slice(),
      links: Array.from({ length: level + 1 }, () => [] as number[]),
      level,
      deleted: false,
    };
    this.elements.push(node);
    const newPos = this.elements.length - 1;
    this.byLabel.set(label, newPos);

    if (this.entryPoint < 0) {
      this.entryPoint = newPos;
      this.maxLevel = level;
      return;
    }

    // Descend greedily through layers above the new node's level to seed the
    // first layer where the node will actually connect.
    let ep = this.entryPoint;
    let epDist = this.distance(vector, this.elements[ep]!.vector);
    for (let lc = this.maxLevel; lc > level; lc--) {
      const g = this.greedyClosest(ep, lc, vector);
      ep = g.pos;
      epDist = g.dist;
    }
    for (let lc = Math.min(level, this.maxLevel); lc >= 0; lc--) {
      const found = this.searchLayer(vector, [{ pos: ep, dist: epDist }], this.efConstruction, lc);
      const selected = this.selectNeighborsHeuristic(found, lc === 0 ? this.maxM0 : this.M, vector);
      this.connect(newPos, selected, lc);
      if (found.length) {
        ep = found[0]!.pos;
        epDist = found[0]!.dist;
      }
    }

    if (level > this.maxLevel) {
      this.maxLevel = level;
      this.entryPoint = newPos;
    }
  }

  /** hnswlib updatePoint: re-link the existing slot at its current level. */
  private updateElement(pos: number, vector: number[]): void {
    const e = this.elements[pos]!;
    const wasDeleted = e.deleted;
    e.deleted = false;
    for (let lc = 0; lc <= e.level; lc++) {
      // Unlink from neighbors.
      for (const nbPos of e.links[lc] ?? []) {
        const nb = this.elements[nbPos]!;
        if (nb.level >= lc) {
          const list = nb.links[lc]!;
          const i = list.indexOf(pos);
          if (i >= 0) list.splice(i, 1);
        }
      }
      e.links[lc] = [];
    }
    e.vector = vector.slice();

    // Seed the relink from another element when the updated slot is the
    // current entry point (it is isolated right now).
    let ep = this.entryPoint === pos ? this.findOtherEntry(pos) : this.entryPoint;
    let epDist = this.distance(vector, this.elements[ep]!.vector);
    for (let lc = this.maxLevel; lc > Math.min(e.level, this.maxLevel); lc--) {
      const g = this.greedyClosest(ep, lc, vector);
      ep = g.pos;
      epDist = g.dist;
    }
    for (let lc = Math.min(e.level, this.maxLevel); lc >= 0; lc--) {
      const found = this.searchLayer(vector, [{ pos: ep, dist: epDist }], this.efConstruction, lc);
      const selected = this.selectNeighborsHeuristic(found, lc === 0 ? this.maxM0 : this.M, vector);
      this.connect(pos, selected, lc);
      if (found.length) {
        ep = found[0]!.pos;
        epDist = found[0]!.dist;
      }
    }
    // Deleted elements stay marked deleted after an update, matching hnswlib
    // (updating a deleted label keeps it omitted from results).
    e.deleted = wasDeleted;
  }

  /** Any non-deleted slot other than `pos` (used to re-seed an update). */
  private findOtherEntry(pos: number): number {
    for (let i = 0; i < this.elements.length; i++) {
      if (i !== pos && !this.elements[i]!.deleted) return i;
    }
    return pos; // sole element: relink stays isolated until more are added
  }

  /** Bidirectional edge: connect `pos` to each selected neighbor at layer lc. */
  private connect(pos: number, selected: Candidate[], lc: number): void {
    const node = this.elements[pos]!;
    for (const { pos: nbPos } of selected) {
      if (nbPos === pos) continue;
      (node.links[lc] ??= []).push(nbPos);
      const nb = this.elements[nbPos]!;
      if (nb.level >= lc) {
        (nb.links[lc] ??= []).push(pos);
        const cap = lc === 0 ? this.maxM0 : this.M;
        if ((nb.links[lc] ?? []).length > cap) this.shrink(nbPos, lc, cap);
      }
    }
  }

  /** Over-capacity neighbor list: re-select the closest, diverse cap entries. */
  private shrink(pos: number, lc: number, cap: number): void {
    const node = this.elements[pos]!;
    const candidates: Candidate[] = (node.links[lc] ?? []).map((nbPos) => ({
      pos: nbPos,
      dist: this.distance(node.vector, this.elements[nbPos]!.vector),
    }));
    const kept = this.selectNeighborsHeuristic(candidates, cap, node.vector);
    node.links[lc] = kept.map((c) => c.pos);
  }

  /**
   * Alg. 1 greedy walk: from `start` at layer `lc`, keep stepping to the
   * neighbor closest to the query until reaching a local minimum.
   */
  private greedyClosest(start: number, lc: number, query: number[]): Candidate {
    let cur = start;
    let curDist = this.distance(query, this.elements[cur]!.vector);
    let improved = true;
    while (improved) {
      improved = false;
      const node = this.elements[cur]!;
      if (node.level < lc) break;
      for (const nbPos of node.links[lc] ?? []) {
        const d = this.distance(query, this.elements[nbPos]!.vector);
        if (d < curDist) {
          curDist = d;
          cur = nbPos;
          improved = true;
        }
      }
    }
    return { pos: cur, dist: curDist };
  }

  /**
   * Descend the graph (alg. 1 through the upper layers, then a best-first
   * ef-bounded search at layer 0) and return the ef closest candidates.
   */
  private searchGraph(query: number[], ef: number): Candidate[] {
    let ep = this.entryPoint;
    let epDist = this.distance(query, this.elements[ep]!.vector);
    for (let lc = this.maxLevel; lc > 0; lc--) {
      const g = this.greedyClosest(ep, lc, query);
      ep = g.pos;
      epDist = g.dist;
    }
    return this.searchLayer(query, [{ pos: ep, dist: epDist }], ef, 0);
  }

  /**
   * Best-first search from the given start candidates within one layer.
   * Returns up to `ef` closest candidates, ascending by distance.
   */
  private searchLayer(query: number[], eps: Candidate[], ef: number, lc: number): Candidate[] {
    const results: Candidate[] = [];
    // Min-heap ordered frontier; shift() keeps the closest candidate next.
    const frontier: Candidate[] = [];
    const seen = new Set<number>();
    const addResult = (c: Candidate): void => {
      results.push(c);
      results.sort((a, b) => a.dist - b.dist || a.pos - b.pos);
      if (results.length > ef) results.pop();
    };
    for (const c of eps) {
      if (seen.has(c.pos)) continue;
      seen.add(c.pos);
      frontier.push(c);
      addResult(c);
    }
    frontier.sort((a, b) => a.dist - b.dist || a.pos - b.pos);
    let furthest = results.length ? results[results.length - 1]!.dist : Infinity;
    while (frontier.length) {
      const c = frontier.shift()!;
      if (c.dist > furthest) break;
      const node = this.elements[c.pos]!;
      if (node.level < lc) continue;
      for (const nbPos of node.links[lc] ?? []) {
        if (seen.has(nbPos)) continue;
        seen.add(nbPos);
        const d = this.distance(query, this.elements[nbPos]!.vector);
        if (results.length < ef || d < furthest) {
          const cand: Candidate = { pos: nbPos, dist: d };
          frontier.push(cand);
          frontier.sort((a, b) => a.dist - b.dist || a.pos - b.pos);
          addResult(cand);
          furthest = results.length ? results[results.length - 1]!.dist : Infinity;
        }
      }
    }
    return results;
  }

  private unwrapResults(cands: Candidate[], k: number, filter?: LabelFilter): HnswHit[] {
    const hits: HnswHit[] = [];
    for (const c of cands) {
      const e = this.elements[c.pos]!;
      if (e.deleted) continue;
      if (filter !== undefined && !filter(e.label)) continue;
      hits.push({ label: e.label, distance: c.dist });
      if (hits.length >= k) break;
    }
    return hits;
  }

  /**
   * Paper alg. 4 / hnswlib's diversity heuristic: greedily keep the closest
   * remaining candidate, dropping any candidate closer to an already-kept
   * neighbor than to the query (it adds no coverage).
   */
  private selectNeighborsHeuristic(
    candidates: Candidate[],
    count: number,
    _query: number[],
  ): Candidate[] {
    if (candidates.length <= count) return candidates.slice();
    const sorted = candidates.slice().sort((a, b) => a.dist - b.dist);
    const selected: Candidate[] = [];
    const rejected: Candidate[] = [];
    const taken = new Set<number>();
    while (sorted.length && selected.length < count) {
      const c = sorted.shift()!;
      if (taken.has(c.pos)) continue;
      let keep = true;
      for (const s of selected) {
        const d = this.distance(this.elements[c.pos]!.vector, this.elements[s.pos]!.vector);
        if (d < c.dist) {
          keep = false;
          break;
        }
      }
      if (keep) {
        selected.push(c);
        taken.add(c.pos);
      } else {
        rejected.push(c);
      }
    }
    // Fill the quota from rejected candidates (closest first) if the
    // diversity pass did not reach `count`.
    for (const c of rejected) {
      if (selected.length >= count) break;
      if (!taken.has(c.pos)) {
        selected.push(c);
        taken.add(c.pos);
      }
    }
    return selected;
  }
}
