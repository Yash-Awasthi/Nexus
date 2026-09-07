// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/knowledge-graph-lite — Embedded knowledge graph with Cypher queries.
 *
 * Inspired by kglite.
 * Lightweight in-process knowledge graph with node/edge storage,
 * Cypher-like querying, and text-based scoring for LLM agents.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface KGNode {
  id: string;
  label: string;
  properties: Record<string, unknown>;
}

export interface KGEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  properties: Record<string, unknown>;
}

export interface QueryResult {
  nodes: KGNode[];
  edges: KGEdge[];
  bindings: Map<string, KGNode | KGEdge>;
}

// ── Knowledge Graph ──────────────────────────────────────────────────────────

export class KnowledgeGraphLite {
  private nodes: Map<string, KGNode> = new Map();
  private edges: Map<string, KGEdge> = new Map();
  private adjacency: Map<string, Set<string>> = new Map();
  private reverseAdj: Map<string, Set<string>> = new Map();

  /**
   * Add a node.
   */
  addNode(node: KGNode): void {
    this.nodes.set(node.id, node);
    if (!this.adjacency.has(node.id)) this.adjacency.set(node.id, new Set());
    if (!this.reverseAdj.has(node.id)) this.reverseAdj.set(node.id, new Set());
  }

  /**
   * Add an edge.
   */
  addEdge(edge: KGEdge): void {
    this.edges.set(edge.id, edge);
    if (!this.adjacency.has(edge.source)) this.adjacency.set(edge.source, new Set());
    if (!this.reverseAdj.has(edge.target)) this.reverseAdj.set(edge.target, new Set());
    this.adjacency.get(edge.source)!.add(edge.id);
    this.reverseAdj.get(edge.target)!.add(edge.id);
  }

  /**
   * Get a node by ID.
   */
  getNode(id: string): KGNode | undefined {
    return this.nodes.get(id);
  }

  /**
   * Get all nodes with a given label.
   */
  getNodesByLabel(label: string): KGNode[] {
    return Array.from(this.nodes.values()).filter((n) => n.label === label);
  }

  /**
   * Get edges from a node.
   */
  getEdgesFrom(nodeId: string): KGEdge[] {
    const edgeIds = this.adjacency.get(nodeId) ?? new Set();
    return Array.from(edgeIds).map((id) => this.edges.get(id)!).filter(Boolean);
  }

  /**
   * Get edges to a node.
   */
  getEdgesTo(nodeId: string): KGEdge[] {
    const edgeIds = this.reverseAdj.get(nodeId) ?? new Set();
    return Array.from(edgeIds).map((id) => this.edges.get(id)!).filter(Boolean);
  }

  /**
   * Get neighbors of a node.
   */
  getNeighbors(nodeId: string): KGNode[] {
    const edgeIds = this.adjacency.get(nodeId) ?? new Set();
    const neighborIds = new Set<string>();
    for (const edgeId of edgeIds) {
      const edge = this.edges.get(edgeId);
      if (edge) neighborIds.add(edge.target);
    }
    return Array.from(neighborIds).map((id) => this.nodes.get(id)!).filter(Boolean);
  }

  /**
   * Execute a Cypher-like MATCH query.
   *
   * Supported patterns:
   *   MATCH (n:Label)-[r:TYPE]->(m:Label) RETURN n, r, m
   *   MATCH (n:Label) WHERE n.prop = 'value' RETURN n
   */
  match(query: string): QueryResult {
    const normalized = query.trim();

    // Simple MATCH parser
    const matchMatch = normalized.match(
      /MATCH\s+\((\w+)(?::(\w+))?\)(?:\s*-\[(\w+)(?::(\w+))?\]->\s*\((\w+)(?::(\w+))?\))?/i,
    );

    if (!matchMatch) {
      return { nodes: [], edges: [], bindings: new Map() };
    }

    const [, nodeVar, nodeLabel, edgeVar, edgeType, targetVar, targetLabel] = matchMatch;

    // Find matching nodes
    let candidateNodes = nodeLabel
      ? this.getNodesByLabel(nodeLabel)
      : Array.from(this.nodes.values());

    // WHERE clause
    const whereMatch = normalized.match(/WHERE\s+(\w+)\.(\w+)\s*=\s*['"]([^'"]+)['"]/i);
    if (whereMatch && whereMatch[1] === nodeVar) {
      const [, , prop, value] = whereMatch;
      candidateNodes = candidateNodes.filter(
        (n) => String(n.properties[prop ?? ""]) === value,
      );
    }

    const bindings = new Map<string, KGNode | KGEdge>();
    const resultNodes: KGNode[] = [];
    const resultEdges: KGEdge[] = [];

    for (const node of candidateNodes) {
      bindings.set(nodeVar ?? "n", node);
      resultNodes.push(node);

      if (edgeType && targetVar) {
        const edges = this.getEdgesFrom(node.id).filter(
          (e) => !edgeType || e.type === edgeType,
        );
        for (const edge of edges) {
          const target = this.nodes.get(edge.target);
          if (target && (!targetLabel || target.label === targetLabel)) {
            bindings.set(edgeVar ?? "r", edge);
            bindings.set(targetVar, target);
            resultEdges.push(edge);
            resultNodes.push(target);
          }
        }
      }
    }

    return { nodes: resultNodes, edges: resultEdges, bindings };
  }

  /**
   * Text-based scoring: score nodes by text similarity.
   */
  textScore(query: string, limit: number = 10): Array<{ node: KGNode; score: number }> {
    const queryWords = new Set(query.toLowerCase().split(/\s+/));

    const scored = Array.from(this.nodes.values()).map((node) => {
      const nodeText = `${node.label} ${Object.values(node.properties).join(" ")}`.toLowerCase();
      const nodeWords = new Set(nodeText.split(/\s+/));
      const overlap = [...queryWords].filter((w) => nodeWords.has(w)).length;
      const score = overlap / queryWords.size;
      return { node, score };
    });

    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * Export the graph as adjacency list text (for LLM consumption).
   */
  toText(maxNodes: number = 50): string {
    const lines: string[] = [];
    lines.push(`=== Knowledge Graph ===`);
    lines.push(`Nodes: ${this.nodes.size}, Edges: ${this.edges.size}`);

    const nodes = Array.from(this.nodes.values()).slice(0, maxNodes);
    for (const node of nodes) {
      const props = Object.entries(node.properties)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      lines.push(`  (${node.label} {${props}})`);
    }

    for (const edge of Array.from(this.edges.values()).slice(0, maxNodes)) {
      const source = this.nodes.get(edge.source);
      const target = this.nodes.get(edge.target);
      if (source && target) {
        lines.push(`  (${source.label})-[:${edge.type}]->(${target.label})`);
      }
    }

    return lines.join("\n");
  }

  /**
   * Get graph statistics.
   */
  stats(): { nodes: number; edges: number; labels: string[]; edgeTypes: string[] } {
    const labels = [...new Set(Array.from(this.nodes.values()).map((n) => n.label))];
    const edgeTypes = [...new Set(Array.from(this.edges.values()).map((e) => e.type))];
    return { nodes: this.nodes.size, edges: this.edges.size, labels, edgeTypes };
  }
}

export default KnowledgeGraphLite;
