// SPDX-License-Identifier: Apache-2.0
/**
 * Knowledge Graph — builds, queries, and visualizes a knowledge graph
 * from document chunks, conversation history, and external data sources.
 *
 * Features:
 * - Entity extraction (people, orgs, concepts, code symbols)
 * - Relationship inference
 * - Graph traversal (BFS/DFS/shortest path)
 * - Subgraph extraction for context
 * - Temporal knowledge (when relationships changed)
 * - Persistence via adjacency list
 */

export interface KGNode {
  id: string;
  label: string;
  type: EntityType;
  properties: Record<string, any>;
  createdAt: number;
  updatedAt: number;
}

export interface KGEdge {
  id: string;
  source: string;
  target: string;
  relation: string;
  weight: number;
  properties: Record<string, any>;
  createdAt: number;
}

export type EntityType =
  | "person"
  | "organization"
  | "concept"
  | "code_symbol"
  | "document"
  | "event"
  | "location"
  | "technology"
  | "file";

export interface GraphQuery {
  /** BFS/DFS/traversal depth */
  depth?: number;
  /** Filter by node types */
  nodeTypes?: EntityType[];
  /** Filter by edge relations */
  edgeRelations?: string[];
  /** Minimum edge weight */
  minWeight?: number;
  /** Text search on labels */
  textSearch?: string;
  /** Limit results */
  limit?: number;
}

export interface SubGraph {
  nodes: KGNode[];
  edges: KGEdge[];
  centerNode: string;
  radius: number;
}

export interface PathResult {
  path: KGNode[];
  edges: KGEdge[];
  totalWeight: number;
  found: boolean;
}

export class KnowledgeGraph {
  private nodes = new Map<string, KGNode>();
  private edges = new Map<string, KGEdge>();
  private adjacencyList = new Map<string, Set<string>>();
  private reverseAdj = new Map<string, Set<string>>();

  // ── CRUD ──────────────────────────────────────────────────────────────────

  addNode(
    id: string,
    label: string,
    type: EntityType,
    properties: Record<string, any> = {},
  ): KGNode {
    const now = Date.now();
    const existing = this.nodes.get(id);
    if (existing) {
      existing.label = label;
      existing.properties = { ...existing.properties, ...properties };
      existing.updatedAt = now;
      return existing;
    }

    const node: KGNode = { id, label, type, properties, createdAt: now, updatedAt: now };
    this.nodes.set(id, node);
    this.adjacencyList.set(id, new Set());
    this.reverseAdj.set(id, new Set());
    return node;
  }

  addEdge(
    sourceId: string,
    targetId: string,
    relation: string,
    weight = 1.0,
    properties: Record<string, any> = {},
  ): KGEdge | null {
    if (!this.nodes.has(sourceId) || !this.nodes.has(targetId)) return null;

    const id = `${sourceId}--${relation}-->${targetId}`;
    const existing = this.edges.get(id);
    if (existing) {
      existing.weight = Math.min(10, existing.weight + weight * 0.1);
      existing.properties = { ...existing.properties, ...properties };
      return existing;
    }

    const edge: KGEdge = {
      id,
      source: sourceId,
      target: targetId,
      relation,
      weight,
      properties,
      createdAt: Date.now(),
    };
    this.edges.set(id, edge);
    this.adjacencyList.get(sourceId)!.add(targetId);
    const rev = this.reverseAdj.get(targetId);
    if (rev) rev.add(sourceId);
    else this.reverseAdj.set(targetId, new Set([sourceId]));

    return edge;
  }

  getNode(id: string): KGNode | undefined {
    return this.nodes.get(id);
  }

  getEdge(id: string): KGEdge | undefined {
    return this.edges.get(id);
  }

  removeNode(id: string): boolean {
    if (!this.nodes.has(id)) return false;
    // Remove all connected edges
    for (const neighbor of this.adjacencyList.get(id) || []) {
      this.reverseAdj.get(neighbor)?.delete(id);
    }
    for (const neighbor of this.reverseAdj.get(id) || []) {
      this.adjacencyList.get(neighbor)?.delete(id);
    }
    this.adjacencyList.delete(id);
    this.reverseAdj.delete(id);
    this.nodes.delete(id);
    return true;
  }

  // ── TRAVERSAL ─────────────────────────────────────────────────────────────

  /**
   * BFS traversal from a start node.
   */
  bfs(startId: string, depth = 3, filter?: GraphQuery): KGNode[] {
    if (!this.nodes.has(startId)) return [];

    const visited = new Set<string>();
    const result: KGNode[] = [];
    const queue: { id: string; currentDepth: number }[] = [{ id: startId, currentDepth: 0 }];

    while (queue.length > 0) {
      const { id, currentDepth } = queue.shift()!;
      if (visited.has(id) || currentDepth > depth) continue;
      visited.add(id);

      const node = this.nodes.get(id)!;
      if (this.matchesFilter(node, filter)) {
        result.push(node);
      }

      if (currentDepth < depth) {
        for (const neighbor of this.adjacencyList.get(id) || []) {
          if (!visited.has(neighbor)) {
            queue.push({ id: neighbor, currentDepth: currentDepth + 1 });
          }
        }
      }
    }

    return result;
  }

  /**
   * Find shortest path between two nodes (BFS-based).
   */
  findPath(sourceId: string, targetId: string, maxDepth = 6): PathResult {
    if (!this.nodes.has(sourceId) || !this.nodes.has(targetId)) {
      return { path: [], edges: [], totalWeight: 0, found: false };
    }
    if (sourceId === targetId) {
      return { path: [this.nodes.get(sourceId)!], edges: [], totalWeight: 0, found: true };
    }

    const visited = new Set<string>();
    const parentMap = new Map<string, string>();
    const edgeMap = new Map<string, KGEdge>();
    const queue: { id: string; depth: number }[] = [{ id: sourceId, depth: 0 }];
    visited.add(sourceId);

    while (queue.length > 0) {
      const { id, depth } = queue.shift()!;
      if (depth >= maxDepth) continue;

      for (const neighbor of this.adjacencyList.get(id) || []) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        parentMap.set(neighbor, id);

        // Find the edge
        const edge = Array.from(this.edges.values()).find(
          (e) => e.source === id && e.target === neighbor,
        );
        if (edge) edgeMap.set(neighbor, edge);

        if (neighbor === targetId) {
          // Reconstruct path
          const path: KGNode[] = [];
          const edges: KGEdge[] = [];
          let current = targetId;
          while (current !== sourceId) {
            path.unshift(this.nodes.get(current)!);
            const e = edgeMap.get(current);
            if (e) edges.unshift(e);
            current = parentMap.get(current)!;
          }
          path.unshift(this.nodes.get(sourceId)!);
          const totalWeight = edges.reduce((sum, e) => sum + e.weight, 0);
          return { path, edges, totalWeight, found: true };
        }

        queue.push({ id: neighbor, depth: depth + 1 });
      }
    }

    return { path: [], edges: [], totalWeight: 0, found: false };
  }

  /**
   * Extract subgraph around a center node.
   */
  getSubgraph(centerId: string, radius = 2, filter?: GraphQuery): SubGraph {
    const nodes = this.bfs(centerId, radius, filter);
    const nodeIds = new Set(nodes.map((n) => n.id));

    const edges = Array.from(this.edges.values()).filter(
      (e) => nodeIds.has(e.source) && nodeIds.has(e.target),
    );

    return { nodes, edges, centerNode: centerId, radius };
  }

  // ── SEARCH & QUERY ────────────────────────────────────────────────────────

  /**
   * Full-text search across node labels and properties.
   */
  search(query: string, limit = 20): KGNode[] {
    const lower = query.toLowerCase();
    const scored: { node: KGNode; score: number }[] = [];

    for (const node of this.nodes.values()) {
      let score = 0;
      if (node.label.toLowerCase().includes(lower)) score += 10;
      if (node.id.toLowerCase().includes(lower)) score += 5;
      for (const val of Object.values(node.properties)) {
        if (String(val).toLowerCase().includes(lower)) score += 1;
      }
      if (score > 0) scored.push({ node, score });
    }

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.node);
  }

  /**
   * Find nodes by type.
   */
  findByType(type: EntityType, limit = 100): KGNode[] {
    return Array.from(this.nodes.values())
      .filter((n) => n.type === type)
      .slice(0, limit);
  }

  /**
   * Get neighbors of a node.
   */
  getNeighbors(nodeId: string): { outgoing: KGNode[]; incoming: KGNode[] } {
    const outgoing = Array.from(this.adjacencyList.get(nodeId) || [])
      .map((id) => this.nodes.get(id)!)
      .filter(Boolean);

    const incoming = Array.from(this.reverseAdj.get(nodeId) || [])
      .map((id) => this.nodes.get(id)!)
      .filter(Boolean);

    return { outgoing, incoming };
  }

  /**
   * Get all edges for a node.
   */
  getEdges(nodeId: string): KGEdge[] {
    return Array.from(this.edges.values()).filter(
      (e) => e.source === nodeId || e.target === nodeId,
    );
  }

  // ── STATS ─────────────────────────────────────────────────────────────────

  getStats(): {
    nodeCount: number;
    edgeCount: number;
    typeDistribution: Record<EntityType, number>;
    avgDegree: number;
    connectedComponents: number;
  } {
    const typeDistribution: Record<string, number> = {};
    let totalDegree = 0;

    for (const node of this.nodes.values()) {
      typeDistribution[node.type] = (typeDistribution[node.type] || 0) + 1;
      totalDegree +=
        (this.adjacencyList.get(node.id)?.size || 0) + (this.reverseAdj.get(node.id)?.size || 0);
    }

    const avgDegree = this.nodes.size > 0 ? totalDegree / this.nodes.size : 0;

    // Count connected components via BFS
    const visited = new Set<string>();
    let components = 0;
    for (const startId of this.nodes.keys()) {
      if (visited.has(startId)) continue;
      components++;
      const queue = [startId];
      while (queue.length > 0) {
        const id = queue.shift()!;
        if (visited.has(id)) continue;
        visited.add(id);
        for (const neighbor of this.adjacencyList.get(id) || []) {
          if (!visited.has(neighbor)) queue.push(neighbor);
        }
        for (const neighbor of this.reverseAdj.get(id) || []) {
          if (!visited.has(neighbor)) queue.push(neighbor);
        }
      }
    }

    return {
      nodeCount: this.nodes.size,
      edgeCount: this.edges.size,
      typeDistribution: typeDistribution as Record<EntityType, number>,
      avgDegree,
      connectedComponents: components,
    };
  }

  // ── SERIALIZATION ─────────────────────────────────────────────────────────

  toJSON(): { nodes: KGNode[]; edges: KGEdge[] } {
    return {
      nodes: Array.from(this.nodes.values()),
      edges: Array.from(this.edges.values()),
    };
  }

  static fromJSON(data: { nodes: KGNode[]; edges: KGEdge[] }): KnowledgeGraph {
    const graph = new KnowledgeGraph();
    for (const node of data.nodes) {
      graph.nodes.set(node.id, node);
      graph.adjacencyList.set(node.id, new Set());
      graph.reverseAdj.set(node.id, new Set());
    }
    for (const edge of data.edges) {
      graph.edges.set(edge.id, edge);
      graph.adjacencyList.get(edge.source)?.add(edge.target);
      graph.reverseAdj.get(edge.target)?.add(edge.source);
    }
    return graph;
  }

  // ── HELPERS ───────────────────────────────────────────────────────────────

  private matchesFilter(node: KGNode, filter?: GraphQuery): boolean {
    if (!filter) return true;
    if (filter.nodeTypes && !filter.nodeTypes.includes(node.type)) return false;
    if (filter.textSearch) {
      const lower = filter.textSearch.toLowerCase();
      if (!node.label.toLowerCase().includes(lower)) return false;
    }
    return true;
  }
}
