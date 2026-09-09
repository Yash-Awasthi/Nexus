// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/temporal-knowledge-graph — Temporal knowledge graph with episodes.
 *
 * Inspired by Graphiti's episodic node system.
 * Tracks knowledge as temporal episodes with validity windows,
 * entity edges, and community detection.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface Episode {
  id: string;
  name: string;
  content: string;
  groupId: string;
  sourceDescription: string;
  createdAt: number;
  validAt: number;
  invalidAt?: number;
  source: "text" | "json" | "message";
  entityEdges: string[];
  metadata?: Record<string, unknown>;
}

export interface Entity {
  id: string;
  name: string;
  type: string;
  groupId: string;
  createdAt: number;
  summary?: string;
  metadata?: Record<string, unknown>;
}

export interface EntityEdge {
  id: string;
  sourceEntityId: string;
  targetEntityId: string;
  relationType: string;
  fact: string;
  createdAt: number;
  validAt: number;
  invalidAt?: number;
  episodes: string[];
  confidence: number;
}

export interface Community {
  id: string;
  name: string;
  entityIds: string[];
  summary?: string;
  createdAt: number;
}

// ── Temporal Knowledge Graph ─────────────────────────────────────────────────

export class TemporalKnowledgeGraph {
  private episodes: Map<string, Episode> = new Map();
  private entities: Map<string, Entity> = new Map();
  private edges: Map<string, EntityEdge> = new Map();
  private communities: Map<string, Community> = new Map();

  /**
   * Add an episode (a piece of temporal knowledge).
   */
  addEpisode(episode: Omit<Episode, "id" | "createdAt">): Episode {
    const id = `ep-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const full: Episode = {
      ...episode,
      id,
      createdAt: Date.now(),
    };
    this.episodes.set(id, full);
    return full;
  }

  /**
   * Add an entity extracted from episodes.
   */
  addEntity(entity: Omit<Entity, "id" | "createdAt">): Entity {
    const id = `ent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const full: Entity = {
      ...entity,
      id,
      createdAt: Date.now(),
    };
    this.entities.set(id, full);
    return full;
  }

  /**
   * Add an edge between entities.
   */
  addEdge(edge: Omit<EntityEdge, "id" | "createdAt">): EntityEdge {
    const id = `edge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const full: EntityEdge = {
      ...edge,
      id,
      createdAt: Date.now(),
    };
    this.edges.set(id, full);
    return full;
  }

  /**
   * Get episodes that are valid at a given timestamp.
   */
  getValidEpisodes(groupId: string, at?: number): Episode[] {
    const timestamp = at ?? Date.now();
    return Array.from(this.episodes.values()).filter(
      (e) =>
        e.groupId === groupId &&
        e.validAt <= timestamp &&
        (e.invalidAt === undefined || e.invalidAt > timestamp),
    );
  }

  /**
   * Get all episodes for a group.
   */
  getGroupEpisodes(groupId: string): Episode[] {
    return Array.from(this.episodes.values())
      .filter((e) => e.groupId === groupId)
      .sort((a, b) => b.validAt - a.validAt);
  }

  /**
   * Get entity edges that are valid at a given timestamp.
   */
  getValidEdges(at?: number): EntityEdge[] {
    const timestamp = at ?? Date.now();
    return Array.from(this.edges.values()).filter(
      (e) => e.validAt <= timestamp && (e.invalidAt === undefined || e.invalidAt > timestamp),
    );
  }

  /**
   * Get all edges for an entity.
   */
  getEntityEdges(entityId: string): EntityEdge[] {
    return Array.from(this.edges.values()).filter(
      (e) => e.sourceEntityId === entityId || e.targetEntityId === entityId,
    );
  }

  /**
   * Invalidate an edge (mark as no longer valid).
   */
  invalidateEdge(edgeId: string, at?: number): boolean {
    const edge = this.edges.get(edgeId);
    if (!edge) return false;
    edge.invalidAt = at ?? Date.now();
    return true;
  }

  /**
   * Search episodes by content.
   */
  searchEpisodes(query: string, groupId?: string): Episode[] {
    const lower = query.toLowerCase();
    let results = Array.from(this.episodes.values());
    if (groupId) results = results.filter((e) => e.groupId === groupId);

    return results
      .filter((e) => e.content.toLowerCase().includes(lower))
      .sort((a, b) => b.validAt - a.validAt);
  }

  /**
   * Search entities by name.
   */
  searchEntities(query: string): Entity[] {
    const lower = query.toLowerCase();
    return Array.from(this.entities.values())
      .filter((e) => e.name.toLowerCase().includes(lower))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Build a community from entity connections.
   */
  buildCommunity(name: string, entityIds: string[]): Community {
    const id = `comm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const community: Community = {
      id,
      name,
      entityIds,
      createdAt: Date.now(),
    };
    this.communities.set(id, community);
    return community;
  }

  /**
   * Get the knowledge graph as text for LLM consumption.
   */
  toText(groupId: string): string {
    const episodes = this.getGroupEpisodes(groupId);
    const lines: string[] = [];

    lines.push(`=== Temporal Knowledge Graph: ${groupId} ===`);
    lines.push(`Episodes: ${episodes.length}`);
    lines.push("");

    for (const ep of episodes.slice(0, 20)) {
      const date = new Date(ep.validAt).toISOString().split("T")[0];
      lines.push(`[${date}] ${ep.name}: ${ep.content.slice(0, 200)}`);
    }

    const entities = Array.from(this.entities.values()).filter((e) => e.groupId === groupId);
    if (entities.length > 0) {
      lines.push("");
      lines.push(`Entities: ${entities.length}`);
      for (const ent of entities.slice(0, 10)) {
        lines.push(`  ${ent.name} (${ent.type})`);
      }
    }

    return lines.join("\n");
  }

  /**
   * Export all data.
   */
  export(): {
    episodes: Episode[];
    entities: Entity[];
    edges: EntityEdge[];
    communities: Community[];
  } {
    return {
      episodes: Array.from(this.episodes.values()),
      entities: Array.from(this.entities.values()),
      edges: Array.from(this.edges.values()),
      communities: Array.from(this.communities.values()),
    };
  }

  /**
   * Import all data.
   */
  import(data: {
    episodes: Episode[];
    entities: Entity[];
    edges: EntityEdge[];
    communities: Community[];
  }): void {
    for (const ep of data.episodes) this.episodes.set(ep.id, ep);
    for (const ent of data.entities) this.entities.set(ent.id, ent);
    for (const edge of data.edges) this.edges.set(edge.id, edge);
    for (const comm of data.communities) this.communities.set(comm.id, comm);
  }

  /**
   * Get statistics.
   */
  stats(): {
    episodes: number;
    entities: number;
    edges: number;
    communities: number;
  } {
    return {
      episodes: this.episodes.size,
      entities: this.entities.size,
      edges: this.edges.size,
      communities: this.communities.size,
    };
  }
}

export default TemporalKnowledgeGraph;
