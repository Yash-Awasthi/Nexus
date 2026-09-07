/**
 * @nexus/temporal-kg — Temporal Knowledge Graph with bi-temporal fact management.
 *
 * Inspired by Graphiti (getzep/graphiti). Provides:
 * - Bi-temporal fact tracking (valid_at / invalid_at windows)
 * - Episode-based provenance (raw data → derived facts lineage)
 * - Automatic contradiction detection and fact invalidation
 * - Graph distance reranking for search results
 * - Entity deduplication and merging
 * - Incremental graph construction (no batch recomputation)
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TemporalFact {
  id: string;
  subjectId: string;
  predicate: string;
  objectId: string;
  /** When this fact became true */
  validAt: Date;
  /** When this fact was superseded (null = currently true) */
  invalidAt: Date | null;
  /** Episode IDs that produced this fact */
  episodeIds: string[];
  /** Confidence score 0-1 */
  confidence: number;
  /** Current version (incremented on invalidation) */
  version: number;
  /** SHA-256 hash of (subject, predicate, object) for dedup */
  contentHash: string;
}

export interface Episode {
  id: string;
  /** Raw content as ingested */
  content: string;
  /** Structured data if JSON episode */
  structuredData?: Record<string, unknown>;
  /** When this episode was ingested */
  ingestedAt: Date;
  /** Source type: message, text, json, etc. */
  source: EpisodeSource;
  /** Group/user ID for partitioning */
  groupId: string;
  /** Entity UUIDs derived from this episode */
  derivedEntityIds: string[];
  /** Fact IDs derived from this episode */
  derivedFactIds: string[];
}

export type EpisodeSource = 'message' | 'text' | 'json' | 'stream' | 'api';

export interface TemporalEntity {
  id: string;
  name: string;
  /** Entity type (prescribed or learned) */
  type: string;
  /** Summary that evolves over time */
  summary: string;
  /** When this entity was first created */
  createdAt: Date;
  /** Last time this entity was updated */
  updatedAt: Date;
  /** All episode IDs that mention this entity */
  episodeIds: string[];
  /** Aliases / alternate names for dedup */
  aliases: string[];
  /** Embedding vector for semantic search */
  embedding?: number[];
}

export interface ProvenanceChain {
  factId: string;
  /** Fact → Episode → Raw content lineage */
  lineage: Array<{
    fact: TemporalFact;
    episodes: Episode[];
  }>;
}

export interface ContradictionResult {
  /** The new fact that triggered the contradiction */
  newFactId: string;
  /** Facts that were invalidated */
  invalidatedFactIds: string[];
  /** Reason for invalidation */
  reason: string;
}

export interface GraphSearchResult {
  entity: TemporalEntity;
  /** Semantic similarity score */
  semanticScore: number;
  /** Graph distance from anchor entity (lower = closer) */
  graphDistance: number;
  /** Combined reranked score */
  combinedScore: number;
  /** The facts connecting query to result */
  connectingFacts: TemporalFact[];
}

export interface DeduplicationResult {
  /** ID of the surviving entity */
  survivorId: string;
  /** IDs of entities that were merged into the survivor */
  mergedIds: string[];
  /** Combined aliases */
  mergedAliases: string[];
}

// ─── Temporal Fact Store ─────────────────────────────────────────────────────

/**
 * In-memory temporal fact store with bi-temporal tracking.
 * Production: wrap with a graph DB driver (Neo4j, FalkorDB, etc.)
 */
export class TemporalFactStore {
  private facts = new Map<string, TemporalFact>();
  private episodes = new Map<string, Episode>();
  private entities = new Map<string, TemporalEntity>();
  /** contentHash → fact IDs for dedup */
  private hashIndex = new Map<string, Set<string>>();
  /** entityId → connected entity IDs for graph traversal */
  private adjacency = new Map<string, Set<string>>();
  /** entityId → fact IDs */
  private entityFacts = new Map<string, Set<string>>();

  // ── Episode Management ───────────────────────────────────────────────

  addEpisode(episode: Episode): void {
    this.episodes.set(episode.id, episode);
  }

  getEpisode(id: string): Episode | undefined {
    return this.episodes.get(id);
  }

  getEpisodesByGroup(groupId: string, limit?: number): Episode[] {
    const results = Array.from(this.episodes.values())
      .filter(e => e.groupId === groupId)
      .sort((a, b) => b.ingestedAt.getTime() - a.ingestedAt.getTime());
    return limit ? results.slice(0, limit) : results;
  }

  getEpisodeProvenance(factId: string): ProvenanceChain | undefined {
    const fact = this.facts.get(factId);
    if (!fact) return undefined;

    const episodes = fact.episodeIds
      .map(id => this.episodes.get(id))
      .filter((e): e is Episode => e !== undefined);

    return {
      factId,
      lineage: [{ fact, episodes }],
    };
  }

  // ── Fact Management (Bi-temporal) ───────────────────────────────────

  /**
   * Add a new fact. If it contradicts an existing fact, the old fact is
   * automatically invalidated (not deleted) with its temporal history preserved.
   */
  addFact(
    fact: Omit<TemporalFact, 'id' | 'validAt' | 'invalidAt' | 'version' | 'contentHash'>,
  ): TemporalFact {
    const id = this.generateId();
    const contentHash = this.computeHash(fact.subjectId, fact.predicate, fact.objectId);

    const newFact: TemporalFact = {
      ...fact,
      id,
      validAt: new Date(),
      invalidAt: null,
      version: 1,
      contentHash,
    };

    // Check for contradictions with currently valid facts
    const contradictions = this.detectContradictions(newFact);
    for (const existingFact of contradictions) {
      existingFact.invalidAt = new Date();
      existingFact.version += 1;
    }

    this.facts.set(id, newFact);

    // Update indices
    if (!this.hashIndex.has(contentHash)) {
      this.hashIndex.set(contentHash, new Set());
    }
    this.hashIndex.get(contentHash)!.add(id);

    // Update adjacency graph
    this.addToAdjacency(fact.subjectId, fact.objectId);
    this.addToAdjacency(fact.objectId, fact.subjectId);

    // Update entity-fact index
    this.addToEntityFacts(fact.subjectId, id);
    this.addToEntityFacts(fact.objectId, id);

    return newFact;
  }

  /**
   * Query what was true at a specific point in time.
   */
  getFactsAsOf(asOf: Date): TemporalFact[] {
    return Array.from(this.facts.values()).filter(
      f => f.validAt <= asOf && (f.invalidAt === null || f.invalidAt > asOf),
    );
  }

  /**
   * Query what is currently true (fact not yet invalidated).
   */
  getCurrentFacts(): TemporalFact[] {
    return Array.from(this.facts.values()).filter(f => f.invalidAt === null);
  }

  /**
   * Get the full history of a fact (all versions including invalidated).
   */
  getFactHistory(subjectId: string, predicate: string): TemporalFact[] {
    return Array.from(this.facts.values())
      .filter(f => f.subjectId === subjectId && f.predicate === predicate)
      .sort((a, b) => a.validAt.getTime() - b.validAt.getTime());
  }

  /**
   * Manually invalidate a fact.
   */
  invalidateFact(factId: string, reason?: string): TemporalFact | undefined {
    const fact = this.facts.get(factId);
    if (!fact || fact.invalidAt !== null) return undefined;
    fact.invalidAt = new Date();
    fact.version += 1;
    return fact;
  }

  // ── Contradiction Detection ──────────────────────────────────────────

  /**
   * Detect existing valid facts that contradict a new fact.
   * Two facts contradict if they share (subject, predicate) but differ in object.
   */
  private detectContradictions(newFact: TemporalFact): TemporalFact[] {
    const entityFactIds = this.entityFacts.get(newFact.subjectId);
    if (!entityFactIds) return [];

    const contradictions: TemporalFact[] = [];
    for (const factId of entityFactIds) {
      const existing = this.facts.get(factId);
      if (
        existing &&
        existing.invalidAt === null &&
        existing.id !== newFact.id &&
        existing.predicate === newFact.predicate &&
        existing.objectId !== newFact.objectId
      ) {
        contradictions.push(existing);
      }
    }
    return contradictions;
  }

  // ── Entity Management ────────────────────────────────────────────────

  addEntity(entity: TemporalEntity): void {
    this.entities.set(entity.id, entity);
  }

  getEntity(id: string): TemporalEntity | undefined {
    return this.entities.get(id);
  }

  /**
   * Find duplicate entities by name similarity or embedding cosine distance.
   */
  findDuplicateEntities(
    threshold = 0.85,
    embeddings?: Map<string, number[]>,
  ): Array<{ entityA: TemporalEntity; entityB: TemporalEntity; similarity: number }> {
    const duplicates: Array<{ entityA: TemporalEntity; entityB: TemporalEntity; similarity: number }> = [];
    const allEntities = Array.from(this.entities.values());

    for (let i = 0; i < allEntities.length; i++) {
      for (let j = i + 1; j < allEntities.length; j++) {
        const a = allEntities[i];
        const b = allEntities[j];

        // Check name similarity
        const nameSimilarity = this.computeNameSimilarity(a.name, b.name);
        if (nameSimilarity >= threshold) {
          duplicates.push({ entityA: a, entityB: b, similarity: nameSimilarity });
          continue;
        }

        // Check alias overlap
        const aliasSimilarity = this.computeAliasSimilarity(a, b);
        if (aliasSimilarity >= threshold) {
          duplicates.push({ entityA: a, entityB: b, similarity: aliasSimilarity });
          continue;
        }

        // Check embedding cosine similarity if available
        if (embeddings) {
          const embA = embeddings.get(a.id);
          const embB = embeddings.get(b.id);
          if (embA && embB) {
            const cosineSim = this.cosineSimilarity(embA, embB);
            if (cosineSim >= threshold) {
              duplicates.push({ entityA: a, entityB: b, similarity: cosineSim });
            }
          }
        }
      }
    }

    return duplicates;
  }

  /**
   * Merge duplicate entities. The entity with more episodes survives.
   */
  mergeEntities(survivorId: string, mergeIds: string[]): DeduplicationResult {
    const survivor = this.entities.get(survivorId);
    if (!survivor) throw new Error(`Entity ${survivorId} not found`);

    const mergedAliases: string[] = [...survivor.aliases];

    for (const mergeId of mergeIds) {
      const merged = this.entities.get(mergeId);
      if (!merged) continue;

      // Merge episode references
      survivor.episodeIds = [...new Set([...survivor.episodeIds, ...merged.episodeIds])];

      // Merge aliases
      mergedAliases.push(merged.name, ...merged.aliases);

      // Re-point facts to survivor
      const factIds = this.entityFacts.get(mergeId);
      if (factIds) {
        for (const factId of factIds) {
          const fact = this.facts.get(factId);
          if (fact) {
            if (fact.subjectId === mergeId) fact.subjectId = survivorId;
            if (fact.objectId === mergeId) fact.objectId = survivorId;
            this.addToEntityFacts(survivorId, factId);
          }
        }
        this.entityFacts.delete(mergeId);
      }

      // Re-point adjacency
      const neighbors = this.adjacency.get(mergeId);
      if (neighbors) {
        for (const neighborId of neighbors) {
          this.addToAdjacency(survivorId, neighborId);
          // Update neighbor's adjacency
          const neighborAdj = this.adjacency.get(neighborId);
          if (neighborAdj) {
            neighborAdj.delete(mergeId);
            neighborAdj.add(survivorId);
          }
        }
        this.adjacency.delete(mergeId);
      }

      // Remove merged entity
      this.entities.delete(mergeId);
    }

    survivor.aliases = [...new Set(mergedAliases)];

    return {
      survivorId,
      mergedIds: mergeIds,
      mergedAliases: survivor.aliases,
    };
  }

  // ── Graph Search with Distance Reranking ─────────────────────────────

  /**
   * Search entities by semantic similarity, then rerank by graph distance.
   * Combines semantic score with graph proximity for better relevance.
   */
  searchWithGraphReranking(
    queryEmbedding: number[],
    anchorEntityId?: string,
    options: {
      limit?: number;
      semanticWeight?: number;
      graphWeight?: number;
      maxGraphDistance?: number;
    } = {},
  ): GraphSearchResult[] {
    const {
      limit = 10,
      semanticWeight = 0.6,
      graphWeight = 0.4,
      maxGraphDistance = 5,
    } = options;

    // Step 1: Compute semantic similarity for all entities with embeddings
    const scored: Array<{ entity: TemporalEntity; semanticScore: number }> = [];
    for (const entity of this.entities.values()) {
      if (entity.embedding) {
        const semanticScore = this.cosineSimilarity(queryEmbedding, entity.embedding);
        scored.push({ entity, semanticScore });
      }
    }

    // Step 2: Sort by semantic score, take top candidates
    scored.sort((a, b) => b.semanticScore - a.semanticScore);
    const candidates = scored.slice(0, limit * 3); // oversample for reranking

    // Step 3: Compute graph distance from anchor entity
    const results: GraphSearchResult[] = [];
    for (const { entity, semanticScore } of candidates) {
      const graphDistance = anchorEntityId
        ? this.bfsDistance(anchorEntityId, entity.id, maxGraphDistance)
        : 0;

      // Normalize graph distance to 0-1 (1 = closest)
      const graphScore = anchorEntityId
        ? 1 - graphDistance / maxGraphDistance
        : 1; // no anchor = no penalty

      const combinedScore = semanticWeight * semanticScore + graphWeight * graphScore;

      // Get connecting facts if anchor provided
      const connectingFacts = anchorEntityId
        ? this.getConnectingFacts(anchorEntityId, entity.id)
        : [];

      results.push({
        entity,
        semanticScore,
        graphDistance,
        combinedScore,
        connectingFacts,
      });
    }

    // Step 4: Sort by combined score
    results.sort((a, b) => b.combinedScore - a.combinedScore);

    return results.slice(0, limit);
  }

  /**
   * BFS to find shortest path distance between two entities in the graph.
   * Returns maxGraphDistance + 1 if unreachable.
   */
  private bfsDistance(
    fromId: string,
    toId: string,
    maxDistance: number,
  ): number {
    if (fromId === toId) return 0;

    const visited = new Set<string>([fromId]);
    let frontier = [fromId];

    for (let distance = 1; distance <= maxDistance; distance++) {
      const nextFrontier: string[] = [];
      for (const nodeId of frontier) {
        const neighbors = this.adjacency.get(nodeId);
        if (!neighbors) continue;
        for (const neighbor of neighbors) {
          if (neighbor === toId) return distance;
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            nextFrontier.push(neighbor);
          }
        }
      }
      frontier = nextFrontier;
    }

    return maxDistance + 1;
  }

  /**
   * Get facts that connect two entities through the graph.
   */
  private getConnectingFacts(fromId: string, toId: string): TemporalFact[] {
    const fromFacts = this.entityFacts.get(fromId);
    if (!fromFacts) return [];

    const results: TemporalFact[] = [];
    for (const factId of fromFacts) {
      const fact = this.facts.get(factId);
      if (!fact || fact.invalidAt !== null) continue;
      if (
        (fact.subjectId === fromId && fact.objectId === toId) ||
        (fact.subjectId === toId && fact.objectId === fromId)
      ) {
        results.push(fact);
      }
    }
    return results;
  }

  // ── Incremental Update ───────────────────────────────────────────────

  /**
   * Process a new episode incrementally. Extracts entities and facts,
   * handles contradictions, and updates the graph without recomputation.
   */
  processEpisode(
    episode: Episode,
    extractedEntities: Array<Omit<TemporalEntity, 'createdAt' | 'updatedAt' | 'episodeIds'>>,
    extractedFacts: Array<Omit<TemporalFact, 'id' | 'validAt' | 'invalidAt' | 'version' | 'contentHash' | 'episodeIds'>>,
  ): {
    newEntities: TemporalEntity[];
    newFacts: TemporalFact[];
    contradictions: ContradictionResult[];
    duplicatesFound: Array<{ entityA: TemporalEntity; entityB: TemporalEntity; similarity: number }>;
  } {
    this.addEpisode(episode);

    const newEntities: TemporalEntity[] = [];
    const newFacts: TemporalFact[] = [];
    const contradictions: ContradictionResult[] = [];

    // Add or update entities
    for (const entityData of extractedEntities) {
      // Check for existing entity by name
      const existing = this.findEntityByName(entityData.name);
      if (existing) {
        // Update existing entity
        existing.summary = entityData.summary;
        existing.updatedAt = new Date();
        existing.episodeIds.push(episode.id);
        existing.aliases = [...new Set([...existing.aliases, ...(entityData.aliases || [])])];
        newEntities.push(existing);
      } else {
        // Create new entity
        const entity: TemporalEntity = {
          ...entityData,
          id: this.generateId(),
          createdAt: new Date(),
          updatedAt: new Date(),
          episodeIds: [episode.id],
        };
        this.addEntity(entity);
        newEntities.push(entity);
      }
    }

    // Add facts with contradiction detection
    for (const factData of extractedFacts) {
      const fact = this.addFact({
        ...factData,
        episodeIds: [episode.id],
        confidence: factData.confidence ?? 1.0,
      });

      // Check what was invalidated
      const invalidatedIds = Array.from(this.facts.values())
        .filter(
          f =>
            f.subjectId === fact.subjectId &&
            f.predicate === fact.predicate &&
            f.objectId !== fact.objectId &&
            f.invalidAt !== null &&
            f.version > 1 &&
            f.validAt.getTime() >= fact.validAt.getTime() - 1000, // within 1 second of creation
        )
        .map(f => f.id);

      if (invalidatedIds.length > 0) {
        contradictions.push({
          newFactId: fact.id,
          invalidatedFactIds: invalidatedIds,
          reason: `Fact "${fact.predicate}" contradicts previous knowledge`,
        });
      }

      newFacts.push(fact);

      // Update episode provenance
      const ep = this.episodes.get(episode.id);
      if (ep) {
        ep.derivedFactIds.push(fact.id);
      }
    }

    // Update episode's derived entities
    const ep = this.episodes.get(episode.id);
    if (ep) {
      ep.derivedEntityIds = newEntities.map(e => e.id);
    }

    // Find potential duplicates
    const duplicatesFound = this.findDuplicateEntities(0.85);

    return {
      newEntities,
      newFacts,
      contradictions,
      duplicatesFound,
    };
  }

  // ── Utility Methods ──────────────────────────────────────────────────

  private findEntityByName(name: string): TemporalEntity | undefined {
    const lower = name.toLowerCase();
    for (const entity of this.entities.values()) {
      if (entity.name.toLowerCase() === lower) return entity;
      if (entity.aliases.some(a => a.toLowerCase() === lower)) return entity;
    }
    return undefined;
  }

  private computeHash(subjectId: string, predicate: string, objectId: string): string {
    // Simple hash — production would use crypto.subtle.digest
    const input = `${subjectId}|${predicate}|${objectId}`;
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
      const char = input.charCodeAt(i);
      hash = ((hash << 5) - hash + char) | 0;
    }
    return hash.toString(36);
  }

  private computeNameSimilarity(a: string, b: string): number {
    const aLower = a.toLowerCase();
    const bLower = b.toLowerCase();
    if (aLower === bLower) return 1.0;

    // Levenshtein-based similarity
    const maxLen = Math.max(aLower.length, bLower.length);
    if (maxLen === 0) return 1.0;
    const distance = this.levenshtein(aLower, bLower);
    return 1 - distance / maxLen;
  }

  private computeAliasSimilarity(a: TemporalEntity, b: TemporalEntity): number {
    const aNames = new Set([a.name.toLowerCase(), ...a.aliases.map(x => x.toLowerCase())]);
    const bNames = new Set([b.name.toLowerCase(), ...b.aliases.map(x => x.toLowerCase())]);
    const intersection = new Set([...aNames].filter(x => bNames.has(x)));
    const union = new Set([...aNames, ...bNames]);
    return union.size > 0 ? intersection.size / union.size : 0;
  }

  private levenshtein(a: string, b: string): number {
    const m = a.length;
    const n = b.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i][j] =
          a[i - 1] === b[j - 1]
            ? dp[i - 1][j - 1]
            : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
    return dp[m][n];
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  private addToAdjacency(a: string, b: string): void {
    if (!this.adjacency.has(a)) this.adjacency.set(a, new Set());
    this.adjacency.get(a)!.add(b);
  }

  private addToEntityFacts(entityId: string, factId: string): void {
    if (!this.entityFacts.has(entityId)) this.entityFacts.set(entityId, new Set());
    this.entityFacts.get(entityId)!.add(factId);
  }

  private generateId(): string {
    return `tg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  // ── Statistics ───────────────────────────────────────────────────────

  getStats(): {
    totalEntities: number;
    totalFacts: number;
    activeFacts: number;
    invalidatedFacts: number;
    totalEpisodes: number;
    avgFactsPerEntity: number;
  } {
    const totalFacts = this.facts.size;
    const activeFacts = Array.from(this.facts.values()).filter(f => f.invalidAt === null).length;
    return {
      totalEntities: this.entities.size,
      totalFacts,
      activeFacts,
      invalidatedFacts: totalFacts - activeFacts,
      totalEpisodes: this.episodes.size,
      avgFactsPerEntity: this.entities.size > 0 ? totalFacts / this.entities.size : 0,
    };
  }
}

// ─── Prescribed Ontology ─────────────────────────────────────────────────────

/**
 * Define entity and edge types upfront (like Pydantic models in Graphiti).
 * Supports both prescribed (developer-defined) and learned (emergent) ontology.
 */
export interface EntityTypeDef {
  name: string;
  /** Required attributes */
  attributes: Record<string, { type: string; required: boolean }>;
  /** Allowed edge predicates from this entity type */
  allowedPredicates?: string[];
}

export interface EdgeTypeDef {
  predicate: string;
  /** Source entity type(s) */
  sourceTypes: string[];
  /** Target entity type(s) */
  targetTypes: string[];
  /** Is this edge type temporal (has validity window)? */
  temporal: boolean;
}

export class OntologyManager {
  private entityTypes = new Map<string, EntityTypeDef>();
  private edgeTypes = new Map<string, EdgeTypeDef>();

  registerEntityType(def: EntityTypeDef): void {
    this.entityTypes.set(def.name, def);
  }

  registerEdgeType(def: EdgeTypeDef): void {
    this.edgeTypes.set(def.predicate, def);
  }

  getEntityType(name: string): EntityTypeDef | undefined {
    return this.entityTypes.get(name);
  }

  getEdgeType(predicate: string): EdgeTypeDef | undefined {
    return this.edgeTypes.get(predicate);
  }

  /**
   * Validate that a fact conforms to the declared ontology.
   */
  validateFact(
    subjectType: string,
    predicate: string,
    objectType: string,
  ): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    const edgeDef = this.edgeTypes.get(predicate);
    if (edgeDef) {
      if (!edgeDef.sourceTypes.includes(subjectType)) {
        errors.push(`Entity type "${subjectType}" cannot be source of predicate "${predicate}"`);
      }
      if (!edgeDef.targetTypes.includes(objectType)) {
        errors.push(`Entity type "${objectType}" cannot be target of predicate "${predicate}"`);
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Describe ontology in a format suitable for LLM context windows.
   * Supports tiered disclosure (compact, standard, detailed, full).
   */
  describe(tier: 'compact' | 'standard' | 'detailed' | 'full' = 'standard'): string {
    const lines: string[] = [];

    if (tier === 'compact') {
      lines.push('Entity types: ' + Array.from(this.entityTypes.keys()).join(', '));
      lines.push('Edge types: ' + Array.from(this.edgeTypes.keys()).join(', '));
    } else {
      for (const [name, def] of this.entityTypes) {
        const attrs = Object.entries(def.attributes)
          .map(([k, v]) => `${k}: ${v.type}${v.required ? '*' : ''}`)
          .join(', ');
        lines.push(`Entity[${name}]: {${attrs}}`);
        if (tier === 'detailed' || tier === 'full') {
          if (def.allowedPredicates?.length) {
            lines.push(`  predicates: ${def.allowedPredicates.join(', ')}`);
          }
        }
      }
      for (const [pred, def] of this.edgeTypes) {
        lines.push(`Edge[${pred}]: ${def.sourceTypes.join('|')} → ${def.targetTypes.join('|')}`);
        if (tier === 'full' && def.temporal) {
          lines.push(`  temporal: yes`);
        }
      }
    }

    return lines.join('\n');
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createTemporalKG(): TemporalFactStore {
  return new TemporalFactStore();
}

export function createOntology(): OntologyManager {
  return new OntologyManager();
}
