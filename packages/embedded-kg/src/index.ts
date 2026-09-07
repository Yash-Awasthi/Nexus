/**
 * @nexus/embedded-kg — Embedded knowledge graph with progressive disclosure.
 *
 * An in-process knowledge graph engine optimized for LLM agent consumption.
 * Features progressive-disclosure schema descriptions, temporal as-of queries,
 * declared ontology enforcement, and MCP server integration.
 * Inspired by KGLite's approach to graph-for-agents.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface KgNode {
  id: string;
  type: string;
  title: string;
  properties: Record<string, unknown>;
  /** Temporal bounds */
  validFrom?: string;
  validTo?: string;
}

export interface KgEdge {
  id: string;
  sourceId: string;
  targetId: string;
  type: string;
  properties: Record<string, unknown>;
  validFrom?: string;
  validTo?: string;
}

export type SchemaTier = "full" | "compact" | "top50" | "summary";

export interface OntologyRule {
  /** Edge type this rule applies to */
  edgeType: string;
  /** Required source node type */
  sourceType: string;
  /** Required target node type */
  targetType: string;
  /** Required properties on the edge */
  requiredProperties?: string[];
  /** Property type constraints */
  propertyTypes?: Record<string, "string" | "number" | "boolean" | "date">;
  /** Enforcement level */
  level: "error" | "warning" | "info";
}

export interface OntologyAuditResult {
  passed: boolean;
  totalRules: number;
  passedRules: number;
  violations: Array<{
    rule: OntologyRule;
    edgeId?: string;
    message: string;
  }>;
}

// ─── Embedded Knowledge Graph ────────────────────────────────────────────────

export class EmbeddedKg {
  private nodes = new Map<string, KgNode>();
  private edges = new Map<string, KgEdge>();
  private ontology: OntologyRule[] = [];
  private nodeTypeIndex = new Map<string, Set<string>>();
  private edgeTypeIndex = new Map<string, Set<string>>();

  // ─── Node Operations ────────────────────────────────────────────────

  addNode(node: KgNode): void {
    this.nodes.set(node.id, node);
    const typeSet = this.nodeTypeIndex.get(node.type) ?? new Set();
    typeSet.add(node.id);
    this.nodeTypeIndex.set(node.type, typeSet);
  }

  getNode(id: string): KgNode | undefined {
    return this.nodes.get(id);
  }

  getNodesByType(type: string): KgNode[] {
    const ids = this.nodeTypeIndex.get(type) ?? new Set();
    return [...ids].map((id) => this.nodes.get(id)!).filter(Boolean);
  }

  searchNodes(query: string, limit = 10): KgNode[] {
    const q = query.toLowerCase();
    const results: Array<{ node: KgNode; score: number }> = [];

    for (const node of this.nodes.values()) {
      let score = 0;
      if (node.title.toLowerCase().includes(q)) score += 2;
      if (node.type.toLowerCase().includes(q)) score += 1;
      for (const v of Object.values(node.properties)) {
        if (String(v).toLowerCase().includes(q)) score += 0.5;
      }
      if (score > 0) results.push({ node, score });
    }

    return results.sort((a, b) => b.score - a.score).slice(0, limit).map((r) => r.node);
  }

  // ─── Edge Operations ────────────────────────────────────────────────

  addEdge(edge: KgEdge): void {
    this.edges.set(edge.id, edge);
    const typeSet = this.edgeTypeIndex.get(edge.type) ?? new Set();
    typeSet.add(edge.id);
    this.edgeTypeIndex.set(edge.type, typeSet);
  }

  getEdge(id: string): KgEdge | undefined {
    return this.edges.get(id);
  }

  getEdgesByType(type: string): KgEdge[] {
    const ids = this.edgeTypeIndex.get(type) ?? new Set();
    return [...ids].map((id) => this.edges.get(id)!).filter(Boolean);
  }

  getNeighbors(nodeId: string): { node: KgNode; edge: KgEdge }[] {
    const results: { node: KgNode; edge: KgEdge }[] = [];
    for (const edge of this.edges.values()) {
      if (edge.sourceId === nodeId) {
        const node = this.nodes.get(edge.targetId);
        if (node) results.push({ node, edge });
      } else if (edge.targetId === nodeId) {
        const node = this.nodes.get(edge.sourceId);
        if (node) results.push({ node, edge });
      }
    }
    return results;
  }

  // ─── Progressive Disclosure describe() ──────────────────────────────

  /**
   * Generate a schema description sized for LLM context windows.
   * Adapts detail level based on graph size:
   *   < 16 types → full detail
   *   < 50 types → compact listing
   *   < 200 types → top 50 listing
   *   ≥ 200 types → statistical summary
   */
  describe(options?: { tier?: SchemaTier }): string {
    const nodeTypes = [...this.nodeTypeIndex.entries()].map(([type, ids]) => ({
      type,
      count: ids.size,
      sample: this.nodes.get([...ids][0]),
    }));

    const edgeTypes = [...this.edgeTypeIndex.entries()].map(([type, ids]) => ({
      type,
      count: ids.size,
    }));

    const totalNodes = this.nodes.size;
    const totalEdges = this.edges.size;
    const tier = options?.tier ?? this.inferTier(nodeTypes.length);

    const parts: string[] = [];
    parts.push(`# Knowledge Graph Schema (${tier} detail)`);
    parts.push(`Nodes: ${totalNodes} | Edges: ${totalEdges} | Node types: ${nodeTypes.length} | Edge types: ${edgeTypes.length}`);
    parts.push("");

    switch (tier) {
      case "full": {
        parts.push("## Node Types (full detail)");
        for (const nt of nodeTypes) {
          const props = nt.sample
            ? Object.entries(nt.sample.properties)
                .map(([k, v]) => `${k}: ${typeof v}`)
                .join(", ")
            : "none";
          parts.push(`- **${nt.type}** (${nt.count} nodes) — properties: ${props}`);
        }
        parts.push("");
        parts.push("## Edge Types");
        for (const et of edgeTypes) {
          parts.push(`- **${et.type}** (${et.count} edges)`);
        }
        break;
      }

      case "compact": {
        parts.push("## Node Types");
        for (const nt of nodeTypes) {
          parts.push(`- ${nt.type}: ${nt.count} nodes`);
        }
        parts.push("");
        parts.push("## Edge Types");
        for (const et of edgeTypes) {
          parts.push(`- ${et.type}: ${et.count} edges`);
        }
        break;
      }

      case "top50": {
        const sorted = [...nodeTypes].sort((a, b) => b.count - a.count).slice(0, 50);
        parts.push("## Top Node Types");
        for (const nt of sorted) {
          parts.push(`- ${nt.type}: ${nt.count}`);
        }
        break;
      }

      case "summary": {
        const totalProps = [...this.nodes.values()].reduce(
          (s, n) => s + Object.keys(n.properties).length,
          0,
        );
        parts.push("## Summary");
        parts.push(`- ${totalNodes} nodes across ${nodeTypes.length} types`);
        parts.push(`- ${totalEdges} edges across ${edgeTypes.length} types`);
        parts.push(`- ~${totalProps} total properties`);
        parts.push(`- Most common type: ${nodeTypes.sort((a, b) => b.count - a.count)[0]?.type ?? "N/A"}`);
        parts.push("");
        parts.push(`Use query tools to explore specific types. Top types: ${nodeTypes.sort((a, b) => b.count - a.count).slice(0, 5).map((t) => t.type).join(", ")}`);
        break;
      }
    }

    return parts.join("\n");
  }

  private inferTier(typeCount: number): SchemaTier {
    if (typeCount < 16) return "full";
    if (typeCount < 50) return "compact";
    if (typeCount < 200) return "top50";
    return "summary";
  }

  // ─── Temporal As-of Queries ─────────────────────────────────────────

  /**
   * Query nodes as they existed on a specific date.
   * A node matches if validFrom <= date AND (validTo is null OR validTo >= date).
   */
  asOfNodes(date: string, type?: string): KgNode[] {
    const d = new Date(date);
    return [...this.nodes.values()].filter((n) => {
      if (type && n.type !== type) return false;
      return this.isTemporallyValid(n.validFrom, n.validTo, d);
    });
  }

  /**
   * Query edges as they existed on a specific date.
   */
  asOfEdges(date: string, type?: string): KgEdge[] {
    const d = new Date(date);
    return [...this.edges.values()].filter((e) => {
      if (type && e.type !== type) return false;
      return this.isTemporallyValid(e.validFrom, e.validTo, d);
    });
  }

  /**
   * Query neighbors as they existed on a specific date.
   */
  asOfNeighbors(nodeId: string, date: string): { node: KgNode; edge: KgEdge }[] {
    const d = new Date(date);
    const results: { node: KgNode; edge: KgEdge }[] = [];

    for (const edge of this.edges.values()) {
      if (!this.isTemporallyValid(edge.validFrom, edge.validTo, d)) continue;

      if (edge.sourceId === nodeId) {
        const node = this.nodes.get(edge.targetId);
        if (node && this.isTemporallyValid(node.validFrom, node.validTo, d)) {
          results.push({ node, edge });
        }
      } else if (edge.targetId === nodeId) {
        const node = this.nodes.get(edge.sourceId);
        if (node && this.isTemporallyValid(node.validFrom, node.validTo, d)) {
          results.push({ node, edge });
        }
      }
    }

    return results;
  }

  private isTemporallyValid(
    from: string | undefined,
    to: string | undefined,
    date: Date,
  ): boolean {
    if (from && new Date(from) > date) return false;
    if (to && new Date(to) < date) return false;
    return true;
  }

  // ─── Ontology Enforcement ───────────────────────────────────────────

  /** Define ontology rules. */
  defineOntology(rules: OntologyRule[]): void {
    this.ontology = rules;
  }

  /**
   * Audit the graph against ontology rules.
   */
  auditOntology(): OntologyAuditResult {
    const violations: OntologyAuditResult["violations"] = [];
    let passed = 0;

    for (const rule of this.ontology) {
      const edges = this.getEdgesByType(rule.edgeType);
      let rulePassed = true;

      for (const edge of edges) {
        const source = this.nodes.get(edge.sourceId);
        const target = this.nodes.get(edge.targetId);

        // Check source type
        if (source && source.type !== rule.sourceType) {
          violations.push({
            rule,
            edgeId: edge.id,
            message: `Edge ${edge.id}: source type ${source.type} ≠ required ${rule.sourceType}`,
          });
          rulePassed = false;
        }

        // Check target type
        if (target && target.type !== rule.targetType) {
          violations.push({
            rule,
            edgeId: edge.id,
            message: `Edge ${edge.id}: target type ${target.type} ≠ required ${rule.targetType}`,
          });
          rulePassed = false;
        }

        // Check required properties
        if (rule.requiredProperties) {
          for (const prop of rule.requiredProperties) {
            if (!(prop in edge.properties)) {
              violations.push({
                rule,
                edgeId: edge.id,
                message: `Edge ${edge.id}: missing required property "${prop}"`,
              });
              rulePassed = false;
            }
          }
        }

        // Check property types
        if (rule.propertyTypes) {
          for (const [prop, expectedType] of Object.entries(rule.propertyTypes)) {
            const value = edge.properties[prop];
            if (value !== undefined) {
              const actualType = typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)
                ? "date"
                : typeof value;
              if (actualType !== expectedType) {
                violations.push({
                  rule,
                  edgeId: edge.id,
                  message: `Edge ${edge.id}: property "${prop}" is ${actualType}, expected ${expectedType}`,
                });
                rulePassed = false;
              }
            }
          }
        }
      }

      if (rulePassed) passed++;
    }

    return {
      passed: violations.length === 0,
      totalRules: this.ontology.length,
      passedRules: passed,
      violations,
    };
  }

  // ─── Utility ────────────────────────────────────────────────────────

  /** Get statistics. */
  stats(): {
    totalNodes: number;
    totalEdges: number;
    nodeTypes: string[];
    edgeTypes: string[];
  } {
    return {
      totalNodes: this.nodes.size,
      totalEdges: this.edges.size,
      nodeTypes: [...this.nodeTypeIndex.keys()],
      edgeTypes: [...this.edgeTypeIndex.keys()],
    };
  }

  /** Clear the graph. */
  clear(): void {
    this.nodes.clear();
    this.edges.clear();
    this.nodeTypeIndex.clear();
    this.edgeTypeIndex.clear();
  }

  /** Serialize to JSON. */
  toJSON(): { nodes: KgNode[]; edges: KgEdge[]; ontology: OntologyRule[] } {
    return {
      nodes: [...this.nodes.values()],
      edges: [...this.edges.values()],
      ontology: this.ontology,
    };
  }

  /** Deserialize from JSON. */
  static fromJSON(data: {
    nodes: KgNode[];
    edges: KgEdge[];
    ontology?: OntologyRule[];
  }): EmbeddedKg {
    const kg = new EmbeddedKg();
    for (const node of data.nodes) kg.addNode(node);
    for (const edge of data.edges) kg.addEdge(edge);
    if (data.ontology) kg.defineOntology(data.ontology);
    return kg;
  }
}
