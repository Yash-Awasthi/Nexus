// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/knowledge-graph — community detection (Leiden/Louvain parity slice).
 *
 * knowledge-graph stores and traverses graphs; it never *clusters* them.
 * This module ports the classic modularity-optimization family behind the
 * reference repos (puzzlef/leiden-communities-openmp-dynamic,
 * networkanalysis-ts): Louvain's local-moving phase, Leiden's refinement
 * pass (moves restricted to the moving-phase partition, keeping refined
 * communities connected), and multi-level aggregation with resolution
 * parameter γ. The C++ OpenMP repo's dynamic-screening variants and
 * networkanalysis-ts's VOS layout are out of scope.
 *
 * Determinism: node and community iteration is in fixed order (the paper
 * randomizes; a deterministic tie-break is a documented deviation so
 * results are reproducible for the same input).
 *
 * Usage
 * ─────
 * ```ts
 * const adj = new Map([["a", new Set(["b", "c"])], ...]);
 * const communities = detectCommunities(adj);            // node → community id
 * const q = modularity(adj, communities);                // quality score
 * ```
 */

export interface CommunityOptions {
  /** Modularity resolution γ (default 1.0); higher values favor smaller communities. */
  resolution?: number;
  /** Max outer (aggregation) levels (default 20). */
  maxLevels?: number;
}

interface Graph {
  adj: number[][];
  /** Self-loop count per node (created by aggregation of internal edges). */
  loop: number[];
  /** Total degree per node, loops counted twice. */
  deg: number[];
}

function makeGraph(adj: number[][]): Graph {
  return { adj, loop: new Array(adj.length).fill(0), deg: adj.map((ns) => ns.length) };
}

/** Contract nodes of a partition into supernodes; edges are counted as multiedges. */
function aggregate(g: Graph, comm: number[]): Graph {
  const n = g.adj.length;
  const superOf = new Map<number, number>();
  const members: number[][] = [];
  for (let u = 0; u < n; u++) {
    let s = superOf.get(comm[u]!);
    if (s === undefined) {
      s = members.length;
      superOf.set(comm[u]!, s);
      members.push([]);
    }
    members[s]!.push(u);
  }
  const k = members.length;
  const adj: number[][] = Array.from({ length: k }, () => []);
  const loop = new Array(k).fill(0);
  for (let s = 0; s < k; s++) {
    let internal = 0;
    for (const u of members[s]!) {
      loop[s]! += g.loop[u]!;
      for (const v of g.adj[u]!) {
        if (comm[v] === comm[u]) internal++;
        else adj[s]!.push(comm[v]!);
      }
    }
    loop[s]! += internal / 2;
  }
  const deg = adj.map((ns, i) => ns.length + 2 * loop[i]);
  return { adj, loop, deg };
}

interface PartitionState {
  comm: number[];
  tot: number[];
  kIn: number[];
}

/** One local-moving pass: every node moves to the neighbor community with the best modularity gain. */
function movePass(g: Graph, resolution: number, maxPasses: number): PartitionState {
  const n = g.adj.length;
  const m2 = g.deg.reduce((a, b) => a + b, 0);
  const st: PartitionState = {
    comm: Array.from({ length: n }, (_, i) => i),
    tot: [...g.deg],
    kIn: [...g.loop],
  };
  if (m2 === 0) return st;

  for (let pass = 0; pass < maxPasses; pass++) {
    let changed = false;
    for (let u = 0; u < n; u++) {
      const cu = st.comm[u]!;
      const ku = g.deg[u]!;
      const kTo = new Map<number, number>();
      for (const v of g.adj[u]!) {
        const cv = st.comm[v]!;
        if (cv !== cu) kTo.set(cv, (kTo.get(cv) ?? 0) + 1);
      }
      const kuCu = g.adj[u]!.length - [...kTo.values()].reduce((a, b) => a + b, 0);

      // Gain of removing u from its current community.
      const kInCu = st.kIn[cu]!;
      const totCu = st.tot[cu]!;
      const remQ =
        kInCu / m2 -
        resolution * (totCu / m2) ** 2 -
        ((kInCu - 2 * kuCu) / m2 - resolution * ((totCu - ku) / m2) ** 2);

      let bestS = -1;
      let bestGain = 0;
      for (const [S, k] of kTo) {
        const kInS = st.kIn[S]!;
        const totS = st.tot[S]!;
        const addQ =
          (kInS + 2 * k) / m2 -
          resolution * ((totS + ku) / m2) ** 2 -
          (kInS / m2 - resolution * (totS / m2) ** 2);
        const gain = remQ + addQ;
        if (gain > bestGain || (gain === bestGain && bestS >= 0 && S < bestS)) {
          bestGain = gain;
          bestS = S;
        }
      }
      if (bestS >= 0 && bestGain > 0) {
        st.kIn[cu]! -= 2 * kuCu + g.loop[u]!;
        st.tot[cu]! -= ku;
        st.kIn[bestS]! += 2 * kTo.get(bestS)! + g.loop[u]!;
        st.tot[bestS]! += ku;
        st.comm[u] = bestS;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return st;
}

/**
 * Leiden refinement: within each moving-phase community, nodes may move
 * between refined communities — but only to a refined community that
 * contains a neighbor (keeps every refined community connected).
 */
function refine(g: Graph, resolution: number, moved: PartitionState): number[] {
  const n = g.adj.length;
  const m2 = g.deg.reduce((a, b) => a + b, 0);
  const st: PartitionState = {
    comm: Array.from({ length: n }, (_, i) => i),
    tot: [...g.deg],
    kIn: [...g.loop],
  };
  if (m2 === 0) return st.comm;

  const byComm = new Map<number, number[]>();
  for (let u = 0; u < n; u++) {
    const c = moved.comm[u]!;
    if (!byComm.has(c)) byComm.set(c, []);
    byComm.get(c)!.push(u);
  }
  for (const members of byComm.values()) {
    for (const u of members) {
      const ru = st.comm[u]!;
      const ku = g.deg[u]!;
      const kTo = new Map<number, number>();
      for (const v of g.adj[u]!) {
        const rv = st.comm[v]!;
        // Target refined community must stay inside u's moving-phase community.
        if (rv !== ru && moved.comm[v]! === moved.comm[u]!) {
          kTo.set(rv, (kTo.get(rv) ?? 0) + 1);
        }
      }
      const kuRu = g.adj[u]!.length - [...kTo.values()].reduce((a, b) => a + b, 0);
      const kInRu = st.kIn[ru]!;
      const totRu = st.tot[ru]!;
      const remQ =
        kInRu / m2 -
        resolution * (totRu / m2) ** 2 -
        ((kInRu - 2 * kuRu) / m2 - resolution * ((totRu - ku) / m2) ** 2);

      let bestR = -1;
      let bestGain = 0;
      for (const [S, k] of kTo) {
        const kInS = st.kIn[S]!;
        const totS = st.tot[S]!;
        const addQ =
          (kInS + 2 * k) / m2 -
          resolution * ((totS + ku) / m2) ** 2 -
          (kInS / m2 - resolution * (totS / m2) ** 2);
        const gain = remQ + addQ;
        if (gain > bestGain || (gain === bestGain && bestR >= 0 && S < bestR)) {
          bestGain = gain;
          bestR = S;
        }
      }
      if (bestR >= 0 && bestGain > 0) {
        st.kIn[ru]! -= 2 * kuRu + g.loop[u]!;
        st.tot[ru]! -= ku;
        st.kIn[bestR]! += 2 * kTo.get(bestR)! + g.loop[u]!;
        st.tot[bestR]! += ku;
        st.comm[u] = bestR;
      }
    }
  }
  return st.comm;
}

/** Renumber community ids 0..k-1 in first-appearance order (matches aggregate). */
function canonicalize(comm: number[]): number[] {
  const remap = new Map<number, number>();
  const out = new Array<number>(comm.length);
  for (let i = 0; i < comm.length; i++) {
    const c = comm[i]!;
    let r = remap.get(c);
    if (r === undefined) {
      r = remap.size;
      remap.set(c, r);
    }
    out[i] = r;
  }
  return out;
}

/**
 * Detect communities in an undirected graph (node id → neighbor id set)
 * with the Leiden algorithm: local moving → refinement → aggregation,
 * repeated until no community merges. Returns node id → community id.
 */
export function detectCommunities(
  adjacency: Map<string, Set<string>>,
  options: CommunityOptions = {},
): Map<string, number> {
  const resolution = options.resolution ?? 1.0;
  const maxLevels = options.maxLevels ?? 20;

  const nodeIds = [...adjacency.keys()];
  const idx = new Map(nodeIds.map((id, i) => [id, i]));
  const adj: number[][] = nodeIds.map((id) => [...(adjacency.get(id) ?? [])].map((v) => idx.get(v)!));
  let g = makeGraph(adj);

  const levels: number[][] = [];
  let comm: number[] = [];
  for (let level = 0; level < maxLevels; level++) {
    const moved = movePass(g, resolution, 10);
    const refined = canonicalize(refine(g, resolution, moved));
    const agg = aggregate(g, refined);
    if (agg.adj.length === g.adj.length) {
      comm = refined;
      break;
    }
    levels.push(refined);
    g = agg;
  }
  if (comm.length === 0) comm = nodeIds.map((_, i) => i);

  const result = new Map<string, number>();
  for (let u = 0; u < nodeIds.length; u++) {
    let x = u;
    for (const l of levels) x = l[x]!;
    result.set(nodeIds[u]!, comm[x]!);
  }
  return result;
}

/** Modularity Q of a partition (resolution 1.0). Higher is more modular. */
export function modularity(
  adjacency: Map<string, Set<string>>,
  communities: Map<string, number>,
): number {
  const nodeIds = [...adjacency.keys()];
  const comm = nodeIds.map((id) => communities.get(id) ?? 0);
  const idx = new Map(nodeIds.map((id, i) => [id, i]));
  const adj = nodeIds.map((id) => [...(adjacency.get(id) ?? [])].map((v) => idx.get(v)!));
  const m2 = adj.reduce((a, ns) => a + ns.length, 0);
  if (m2 === 0) return 0;

  const tot = new Map<number, number>();
  const kIn = new Map<number, number>();
  for (let u = 0; u < nodeIds.length; u++) {
    tot.set(comm[u]!, (tot.get(comm[u]!) ?? 0) + adj[u]!.length);
    for (const v of adj[u]!) {
      if (comm[v]! === comm[u]!) kIn.set(comm[u]!, (kIn.get(comm[u]!) ?? 0) + 1);
    }
  }
  let q = 0;
  for (const [c, t] of tot) {
    q += (kIn.get(c) ?? 0) / m2 - (t / m2) ** 2;
  }
  return q;
}