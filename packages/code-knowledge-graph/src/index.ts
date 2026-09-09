// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/code-knowledge-graph — Codebase knowledge graph with community detection.
 *
 * Inspired by Axon's code analysis and community detection.
 * Indexes codebases into structural knowledge graphs with dependency tracking,
 * call chain analysis, and Leiden community detection.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type NodeLabel = "function" | "method" | "class" | "module" | "variable" | "interface";
export type RelType = "calls" | "extends" | "implements" | "imports" | "uses_type" | "contains";

export interface GraphNode {
  id: string;
  label: NodeLabel;
  name: string;
  filePath: string;
  startLine: number;
  endLine: number;
  complexity?: number;
  metadata?: Record<string, unknown>;
}

export interface GraphEdge {
  source: string;
  target: string;
  type: RelType;
  weight: number;
}

export interface Community {
  id: number;
  nodes: string[];
  label: string;
  size: number;
  internalEdges: number;
  externalEdges: number;
}

// ── Knowledge Graph ──────────────────────────────────────────────────────────

export class CodeKnowledgeGraph {
  private nodes: Map<string, GraphNode> = new Map();
  private edges: GraphEdge[] = [];
  private adjacency: Map<string, Set<string>> = new Map();
  private reverseAdjacency: Map<string, Set<string>> = new Map();

  addNode(node: GraphNode): void {
    this.nodes.set(node.id, node);
    if (!this.adjacency.has(node.id)) this.adjacency.set(node.id, new Set());
    if (!this.reverseAdjacency.has(node.id)) this.reverseAdjacency.set(node.id, new Set());
  }

  addEdge(edge: GraphEdge): void {
    this.edges.push(edge);
    if (!this.adjacency.has(edge.source)) this.adjacency.set(edge.source, new Set());
    if (!this.reverseAdjacency.has(edge.target)) this.reverseAdjacency.set(edge.target, new Set());
    this.adjacency.get(edge.source)!.add(edge.target);
    this.reverseAdjacency.get(edge.target)!.add(edge.source);
  }

  getNode(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  getNodesByLabel(label: NodeLabel): GraphNode[] {
    return Array.from(this.nodes.values()).filter((n) => n.label === label);
  }

  getEdgesFrom(nodeId: string): GraphEdge[] {
    return this.edges.filter((e) => e.source === nodeId);
  }

  getEdgesTo(nodeId: string): GraphEdge[] {
    return this.edges.filter((e) => e.target === nodeId);
  }

  getCallers(nodeId: string): GraphNode[] {
    const callerIds = this.reverseAdjacency.get(nodeId) ?? new Set();
    return Array.from(callerIds)
      .map((id) => this.nodes.get(id))
      .filter((n): n is GraphNode => n !== undefined);
  }

  getCallees(nodeId: string): GraphNode[] {
    const calleeIds = this.adjacency.get(nodeId) ?? new Set();
    return Array.from(calleeIds)
      .map((id) => this.nodes.get(id))
      .filter((n): n is GraphNode => n !== undefined);
  }

  // ── Community Detection (Leiden-like) ────────────────────────────────────

  /**
   * Detect communities using a simplified Leiden-like algorithm.
   * Returns communities of tightly coupled code modules.
   */
  detectCommunities(resolution: number = 1.0): Community[] {
    // Phase 1: Initialize each node in its own community
    const communityMap = new Map<string, number>();
    let nextCommunity = 0;
    for (const nodeId of this.nodes.keys()) {
      communityMap.set(nodeId, nextCommunity++);
    }

    // Phase 2: Local moving — move nodes to neighboring communities
    let improved = true;
    let iterations = 0;
    while (improved && iterations < 100) {
      improved = false;
      iterations++;

      for (const nodeId of this.nodes.keys()) {
        const currentCommunity = communityMap.get(nodeId)!;
        const neighborCommunities = this.getNeighborCommunities(nodeId, communityMap);

        let bestCommunity = currentCommunity;
        let bestGain = 0;

        for (const [community, weight] of neighborCommunities) {
          if (community === currentCommunity) continue;

          const gain = this.computeModularityGain(nodeId, community, communityMap, resolution);
          if (gain > bestGain) {
            bestGain = gain;
            bestCommunity = community;
          }
        }

        if (bestCommunity !== currentCommunity) {
          communityMap.set(nodeId, bestCommunity);
          improved = true;
        }
      }
    }

    // Phase 3: Build community objects
    const communityNodes = new Map<number, string[]>();
    for (const [nodeId, community] of communityMap) {
      if (!communityNodes.has(community)) communityNodes.set(community, []);
      communityNodes.get(community)!.push(nodeId);
    }

    const communities: Community[] = [];
    for (const [communityId, nodeIds] of communityNodes) {
      let internalEdges = 0;
      let externalEdges = 0;

      for (const edge of this.edges) {
        const sourceCommunity = communityMap.get(edge.source);
        const targetCommunity = communityMap.get(edge.target);
        if (sourceCommunity === communityId && targetCommunity === communityId) {
          internalEdges++;
        } else if (sourceCommunity === communityId || targetCommunity === communityId) {
          externalEdges++;
        }
      }

      // Generate label from most common file path prefix
      const paths = nodeIds
        .map((id) => this.nodes.get(id)?.filePath ?? "")
        .filter((p) => p.length > 0);
      const prefix = this.findCommonPrefix(paths);

      communities.push({
        id: communityId,
        nodes: nodeIds,
        label: prefix || `community-${communityId}`,
        size: nodeIds.length,
        internalEdges,
        externalEdges,
      });
    }

    return communities.sort((a, b) => b.size - a.size);
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private getNeighborCommunities(
    nodeId: string,
    communityMap: Map<string, number>,
  ): Map<number, number> {
    const result = new Map<number, number>();
    const neighbors = new Set([
      ...(this.adjacency.get(nodeId) ?? []),
      ...(this.reverseAdjacency.get(nodeId) ?? []),
    ]);

    for (const neighbor of neighbors) {
      const community = communityMap.get(neighbor);
      if (community !== undefined) {
        result.set(community, (result.get(community) ?? 0) + 1);
      }
    }

    return result;
  }

  private computeModularityGain(
    nodeId: string,
    targetCommunity: number,
    communityMap: Map<string, number>,
    resolution: number,
  ): number {
    const neighbors = new Set([
      ...(this.adjacency.get(nodeId) ?? []),
      ...(this.reverseAdjacency.get(nodeId) ?? []),
    ]);

    let internalWeight = 0;
    let totalWeight = 0;

    for (const neighbor of neighbors) {
      totalWeight++;
      if (communityMap.get(neighbor) === targetCommunity) {
        internalWeight++;
      }
    }

    return totalWeight > 0 ? (internalWeight / totalWeight) * resolution : 0;
  }

  private findCommonPrefix(paths: string[]): string {
    if (paths.length === 0) return "";
    if (paths.length === 1) return paths[0]!;

    const parts = paths[0]!.split("/");
    let commonLength = 0;

    for (let i = 0; i < parts.length; i++) {
      if (paths.every((p) => p.split("/")[i] === parts[i])) {
        commonLength = i + 1;
      } else {
        break;
      }
    }

    return parts.slice(0, commonLength).join("/") || paths[0]!;
  }

  size(): number {
    return this.nodes.size;
  }

  edgeCount(): number {
    return this.edges.length;
  }
}

export default CodeKnowledgeGraph;
