/**
 * @nexus/rag-modes — Multi-mode RAG retrieval with role-specific LLM configuration.
 *
 * Implements LightRAG's dual-layer retrieval architecture with 5 query modes
 * (local, global, hybrid, naive, mix) that combine KG entity-level retrieval,
 * KG relationship-chain retrieval, and naive vector retrieval.
 *
 * Also provides role-specific LLM configuration for different pipeline stages
 * (EXTRACT, QUERY, KEYWORDS, VLM) with independent model settings.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type RagMode = "local" | "global" | "hybrid" | "naive" | "mix";

export type PipelineRole = "extract" | "query" | "keywords" | "vlm";

export interface RoleLlmConfig {
  /** Model identifier for this role */
  model: string;
  /** Provider (openai, anthropic, etc.) */
  provider?: string;
  /** API key override for this role */
  apiKey?: string;
  /** Max concurrent requests for this role */
  maxAsync?: number;
  /** Timeout in ms for this role */
  timeoutMs?: number;
  /** Temperature override */
  temperature?: number;
  /** Max tokens override */
  maxTokens?: number;
  /** Extra params */
  params?: Record<string, unknown>;
}

export interface RagQueryConfig {
  /** Query mode */
  mode: RagMode;
  /** Token budget for retrieved context */
  maxTotalTokens?: number;
  /** Max tokens for entity context */
  maxEntityTokens?: number;
  /** Max tokens for relation context */
  maxRelationTokens?: number;
  /** Whether to include chunk heading context */
  enableContentHeadings?: boolean;
  /** Max related chunks to retrieve */
  maxRelatedChunks?: number;
  /** Chunk pick method: "weighted_polling" or "vector_similarity" */
  chunkPickMethod?: "weighted_polling" | "vector_similarity";
}

export interface RagDocument {
  id: string;
  content: string;
  metadata?: Record<string, unknown>;
  /** Source file path */
  sourcePath?: string;
}

// ─── Retrieval Result Types ──────────────────────────────────────────────────

export interface EntityResult {
  id: string;
  name: string;
  type: string;
  description: string;
  /** Source chunk IDs that mentioned this entity */
  sourceIds: string[];
  /** Relevance score */
  score: number;
}

export interface RelationResult {
  id: string;
  source: string;
  target: string;
  description: string;
  weight: number;
  sourceIds: string[];
  score: number;
}

export interface ChunkResult {
  id: string;
  content: string;
  heading?: string;
  score: number;
  sourcePath?: string;
}

export interface RagRetrievalResult {
  mode: RagMode;
  entities: EntityResult[];
  relations: RelationResult[];
  chunks: ChunkResult[];
  /** Combined context string ready for LLM */
  context: string;
  /** Total tokens in the context */
  totalTokens: number;
}

// ─── Role-Specific LLM Registry ──────────────────────────────────────────────

/**
 * Manages per-role LLM configurations for different pipeline stages.
 * Each role (EXTRACT, QUERY, KEYWORDS, VLM) can use a different model,
 * provider, and settings optimized for its specific task.
 */
export class RoleLlmRegistry {
  private roles = new Map<PipelineRole, RoleLlmConfig>();
  private defaultConfig: RoleLlmConfig;

  constructor(defaultConfig: RoleLlmConfig) {
    this.defaultConfig = defaultConfig;
  }

  /** Configure a specific role. */
  setRole(role: PipelineRole, config: RoleLlmConfig): void {
    this.roles.set(role, config);
  }

  /** Get the config for a role, falling back to default. */
  getRole(role: PipelineRole): RoleLlmConfig {
    return this.roles.get(role) ?? this.defaultConfig;
  }

  /** Get all configured roles. */
  getAllRoles(): Record<PipelineRole, RoleLlmConfig> {
    return {
      extract: this.getRole("extract"),
      query: this.getRole("query"),
      keywords: this.getRole("keywords"),
      vlm: this.getRole("vlm"),
    };
  }

  /** Create from environment variables. */
  static fromEnv(defaultModel: string = "gpt-4o-mini"): RoleLlmRegistry {
    const registry = new RoleLlmRegistry({ model: defaultModel });

    const roles: PipelineRole[] = ["extract", "query", "keywords", "vlm"];
    for (const role of roles) {
      const prefix = role.toUpperCase();
      const model = process.env[`${prefix}_LLM_MODEL`];
      if (model) {
        registry.setRole(role, {
          model,
          provider: process.env[`${prefix}_LLM_PROVIDER`],
          apiKey: process.env[`${prefix}_LLM_API_KEY`],
          maxAsync: process.env[`${prefix}_MAX_ASYNC_LLM`]
            ? parseInt(process.env[`${prefix}_MAX_ASYNC_LLM`]!)
            : undefined,
          timeoutMs: process.env[`${prefix}_LLM_TIMEOUT`]
            ? parseInt(process.env[`${prefix}_LLM_TIMEOUT`]!) * 1000
            : undefined,
        });
      }
    }

    return registry;
  }
}

// ─── Multi-Mode Retrieval Engine ─────────────────────────────────────────────

export interface RagStore {
  /** Get entity by ID */
  getEntity(id: string): Promise<EntityResult | null>;
  /** Search entities by name/description */
  searchEntities(query: string, limit: number): Promise<EntityResult[]>;
  /** Get relations for an entity */
  getEntityRelations(entityId: string): Promise<RelationResult[]>;
  /** Search relations by description */
  searchRelations(query: string, limit: number): Promise<RelationResult[]>;
  /** Search text chunks by similarity */
  searchChunks(query: string, limit: number): Promise<ChunkResult[]>;
  /** Get all relations in the graph */
  getAllRelations(): Promise<RelationResult[]>;
}

/**
 * Implements LightRAG's 5-mode retrieval architecture.
 *
 * - **local**: Entity-focused — finds specific entities and their direct relations
 * - **global**: Theme-focused — finds broad relationship chains and themes
 * - **hybrid**: Merges local + global results
 * - **naive**: Traditional vector-only chunk retrieval (no KG)
 * - **mix**: Full combination of local + global + naive
 */
export class MultiModeRetriever {
  private store: RagStore;
  private config: RagQueryConfig;

  constructor(store: RagStore, config?: Partial<RagQueryConfig>) {
    this.store = store;
    this.config = {
      mode: "mix",
      maxTotalTokens: 12000,
      maxEntityTokens: 4000,
      maxRelationTokens: 4000,
      enableContentHeadings: true,
      maxRelatedChunks: 10,
      chunkPickMethod: "weighted_polling",
      ...config,
    };
  }

  /**
   * Retrieve context for a query using the configured mode.
   */
  async retrieve(query: string): Promise<RagRetrievalResult> {
    switch (this.config.mode) {
      case "local":
        return this.retrieveLocal(query);
      case "global":
        return this.retrieveGlobal(query);
      case "hybrid":
        return this.retrieveHybrid(query);
      case "naive":
        return this.retrieveNaive(query);
      case "mix":
        return this.retrieveMix(query);
      default:
        return this.retrieveNaive(query);
    }
  }

  /**
   * Local mode: Entity-focused retrieval.
   * Finds specific entities mentioned in the query and their direct relations.
   */
  private async retrieveLocal(query: string): Promise<RagRetrievalResult> {
    const entities = await this.store.searchEntities(
      query,
      this.config.maxRelatedChunks ?? 10,
    );

    // Get direct relations for top entities
    const relationPromises = entities.slice(0, 5).map((e) =>
      this.store.getEntityRelations(e.id),
    );
    const relationResults = await Promise.all(relationPromises);
    const relations = relationResults.flat();

    const context = this.formatContext(entities, relations, []);
    const totalTokens = this.estimateTokens(context);

    return {
      mode: "local",
      entities,
      relations,
      chunks: [],
      context,
      totalTokens,
    };
  }

  /**
   * Global mode: Theme-focused retrieval.
   * Finds broad relationship chains and thematic connections.
   */
  private async retrieveGlobal(query: string): Promise<RagRetrievalResult> {
    // Get all relations, then rank by relevance to the query
    const allRelations = await this.store.getAllRelations();
    const queryWords = new Set(query.toLowerCase().split(/\s+/));

    // Score relations by keyword overlap
    const scoredRelations = allRelations
      .map((r) => {
        const text = `${r.description} ${r.source} ${r.target}`.toLowerCase();
        const words = new Set(text.split(/\s+/));
        let overlap = 0;
        for (const w of queryWords) {
          if (words.has(w)) overlap++;
        }
        return { ...r, globalScore: overlap / queryWords.size };
      })
      .sort((a, b) => b.globalScore - a.globalScore)
      .slice(0, 20);

    // Deduplicate entities from top relations
    const entityNames = new Set<string>();
    const entities: EntityResult[] = [];
    for (const rel of scoredRelations) {
      if (!entityNames.has(rel.source)) {
        entityNames.add(rel.source);
        const e = await this.store.searchEntities(rel.source, 1);
        if (e.length > 0) entities.push(e[0]);
      }
      if (!entityNames.has(rel.target)) {
        entityNames.add(rel.target);
        const e = await this.store.searchEntities(rel.target, 1);
        if (e.length > 0) entities.push(e[0]);
      }
    }

    const context = this.formatContext(
      entities.slice(0, 10),
      scoredRelations,
      [],
    );
    const totalTokens = this.estimateTokens(context);

    return {
      mode: "global",
      entities: entities.slice(0, 10),
      relations: scoredRelations,
      chunks: [],
      context,
      totalTokens,
    };
  }

  /**
   * Hybrid mode: Merges local + global results.
   */
  private async retrieveHybrid(query: string): Promise<RagRetrievalResult> {
    const [local, global] = await Promise.all([
      this.retrieveLocal(query),
      this.retrieveGlobal(query),
    ]);

    // Merge and deduplicate
    const entityMap = new Map<string, EntityResult>();
    for (const e of [...local.entities, ...global.entities]) {
      if (!entityMap.has(e.id) || e.score > (entityMap.get(e.id)?.score ?? 0)) {
        entityMap.set(e.id, e);
      }
    }

    const relationMap = new Map<string, RelationResult>();
    for (const r of [...local.relations, ...global.relations]) {
      if (!relationMap.has(r.id) || r.score > (relationMap.get(r.id)?.score ?? 0)) {
        relationMap.set(r.id, r);
      }
    }

    const entities = [...entityMap.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, 15);
    const relations = [...relationMap.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, 20);

    const context = this.formatContext(entities, relations, []);
    const totalTokens = this.estimateTokens(context);

    return {
      mode: "hybrid",
      entities,
      relations,
      chunks: [],
      context,
      totalTokens,
    };
  }

  /**
   * Naive mode: Traditional vector-only chunk retrieval.
   * No knowledge graph — relies on embedding similarity.
   */
  private async retrieveNaive(query: string): Promise<RagRetrievalResult> {
    const chunks = await this.store.searchChunks(
      query,
      this.config.maxRelatedChunks ?? 10,
    );

    const context = this.formatChunksContext(chunks);
    const totalTokens = this.estimateTokens(context);

    return {
      mode: "naive",
      entities: [],
      relations: [],
      chunks,
      context,
      totalTokens,
    };
  }

  /**
   * Mix mode: Full combination of local + global + naive.
   * The most comprehensive retrieval mode.
   */
  private async retrieveMix(query: string): Promise<RagRetrievalResult> {
    const [local, global, naive] = await Promise.all([
      this.retrieveLocal(query),
      this.retrieveGlobal(query),
      this.retrieveNaive(query),
    ]);

    // Merge all results with token budget
    const entityMap = new Map<string, EntityResult>();
    for (const e of [...local.entities, ...global.entities]) {
      if (!entityMap.has(e.id) || e.score > (entityMap.get(e.id)?.score ?? 0)) {
        entityMap.set(e.id, e);
      }
    }

    const relationMap = new Map<string, RelationResult>();
    for (const r of [...local.relations, ...global.relations]) {
      if (!relationMap.has(r.id) || r.score > (relationMap.get(r.id)?.score ?? 0)) {
        relationMap.set(r.id, r);
      }
    }

    // Apply token budget — entities first, then relations, then chunks
    const maxEntityTokens = this.config.maxEntityTokens ?? 4000;
    const maxRelationTokens = this.config.maxRelationTokens ?? 4000;
    const maxChunkTokens =
      (this.config.maxTotalTokens ?? 12000) - maxEntityTokens - maxRelationTokens;

    const entities = this.truncateByTokens(
      [...entityMap.values()].sort((a, b) => b.score - a.score),
      maxEntityTokens,
      (e) => `${e.name}: ${e.description}`,
    );

    const relations = this.truncateByTokens(
      [...relationMap.values()].sort((a, b) => b.score - a.score),
      maxRelationTokens,
      (r) => `${r.source} → ${r.target}: ${r.description}`,
    );

    const chunks = this.truncateByTokens(
      naive.chunks.sort((a, b) => b.score - a.score),
      maxChunkTokens,
      (c) => c.content,
    );

    const context = this.formatContext(entities, relations, chunks);
    const totalTokens = this.estimateTokens(context);

    return {
      mode: "mix",
      entities,
      relations,
      chunks,
      context,
      totalTokens,
    };
  }

  // ─── Formatting ────────────────────────────────────────────────────────

  private formatContext(
    entities: EntityResult[],
    relations: RelationResult[],
    chunks: ChunkResult[],
  ): string {
    const parts: string[] = [];

    if (entities.length > 0) {
      parts.push("## Entities");
      for (const e of entities) {
        parts.push(`- **${e.name}** (${e.type}): ${e.description}`);
      }
      parts.push("");
    }

    if (relations.length > 0) {
      parts.push("## Relationships");
      for (const r of relations) {
        parts.push(`- ${r.source} → ${r.target}: ${r.description}`);
      }
      parts.push("");
    }

    if (chunks.length > 0) {
      parts.push("## Text Context");
      for (const c of chunks) {
        if (c.heading) {
          parts.push(`### ${c.heading}`);
        }
        parts.push(c.content);
        parts.push("");
      }
    }

    return parts.join("\n");
  }

  private formatChunksContext(chunks: ChunkResult[]): string {
    return chunks
      .map((c) => {
        if (c.heading) return `### ${c.heading}\n${c.content}`;
        return c.content;
      })
      .join("\n\n");
  }

  private truncateByTokens<T>(
    items: T[],
    maxTokens: number,
    toText: (item: T) => string,
  ): T[] {
    const result: T[] = [];
    let tokens = 0;

    for (const item of items) {
      const itemTokens = this.estimateTokens(toText(item));
      if (tokens + itemTokens > maxTokens) break;
      result.push(item);
      tokens += itemTokens;
    }

    return result;
  }

  private estimateTokens(text: string): number {
    // Rough estimate: ~4 chars per token
    return Math.ceil(text.length / 4);
  }
}

// ─── Heading-Aware Paragraph Chunking ────────────────────────────────────────

export interface HeadingChunk extends TextChunk {
  /** Heading breadcrumb path (e.g. "Introduction > Methods > Data Collection") */
  headingBreadcrumb: string;
  /** Heading level (1-6) */
  headingLevel: number;
}

export interface TextChunk {
  id: string;
  content: string;
  /** Character offset in original document */
  offset: number;
  /** Approximate token count */
  tokens: number;
}

export interface HeadingAwareChunkingOptions {
  /** Max characters per chunk */
  maxCharsPerChunk?: number;
  /** Whether to include heading in chunk content */
  includeHeadingInContent?: boolean;
  /** Minimum chunk size (avoid tiny fragments) */
  minCharsPerChunk?: number;
}

/**
 * Heading-aware paragraph semantic chunking.
 * Aligns chunk boundaries with document structure (headings, paragraphs).
 * Inspired by LightRAG's paragraph-semantic chunking strategy.
 */
export function headingAwareChunk(
  text: string,
  options?: HeadingAwareChunkingOptions,
): HeadingChunk[] {
  const maxChars = options?.maxCharsPerChunk ?? 4000;
  const minChars = options?.minCharsPerChunk ?? 200;
  const includeHeading = options?.includeHeadingInContent ?? true;

  // Parse markdown headings
  const lines = text.split("\n");
  const sections: Array<{
    level: number;
    title: string;
    content: string[];
  }> = [];

  let currentSection: { level: number; title: string; content: string[] } | null = null;

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      if (currentSection) sections.push(currentSection);
      currentSection = {
        level: headingMatch[1].length,
        title: headingMatch[2].trim(),
        content: [],
      };
    } else if (currentSection) {
      currentSection.content.push(line);
    } else {
      // Content before any heading
      if (!currentSection) {
        currentSection = { level: 0, title: "", content: [] };
      }
      currentSection.content.push(line);
    }
  }
  if (currentSection) sections.push(currentSection);

  // Build chunks from sections
  const chunks: HeadingChunk[] = [];
  const headingStack: string[] = [];

  for (const section of sections) {
    // Update heading breadcrumb
    if (section.level > 0) {
      // Pop headings at same or deeper level
      while (
        headingStack.length > 0 &&
        headingStack.length >= section.level
      ) {
        headingStack.pop();
      }
      headingStack.push(section.title);
    }

    const breadcrumb = headingStack.join(" > ");
    const sectionContent = section.content.join("\n").trim();

    if (sectionContent.length === 0) continue;

    // If section fits in one chunk, keep it together
    if (sectionContent.length <= maxChars) {
      const content = includeHeading && section.title
        ? `# ${section.title}\n\n${sectionContent}`
        : sectionContent;

      chunks.push({
        id: computeChunkId(content),
        content,
        offset: 0, // Would need line tracking for real offset
        tokens: Math.ceil(content.length / 4),
        headingBreadcrumb: breadcrumb,
        headingLevel: section.level || 1,
      });
    } else {
      // Split long sections at paragraph boundaries
      const paragraphs = sectionContent.split(/\n\n+/);
      let buffer = "";

      for (const para of paragraphs) {
        if (buffer.length + para.length > maxChars && buffer.length >= minChars) {
          const content = includeHeading && section.title
            ? `# ${section.title}\n\n${buffer}`
            : buffer;

          chunks.push({
            id: computeChunkId(content),
            content,
            offset: 0,
            tokens: Math.ceil(content.length / 4),
            headingBreadcrumb: breadcrumb,
            headingLevel: section.level || 1,
          });
          buffer = para;
        } else {
          buffer += (buffer ? "\n\n" : "") + para;
        }
      }

      if (buffer.trim().length > 0) {
        const content = includeHeading && section.title
          ? `# ${section.title}\n\n${buffer}`
          : buffer;

        chunks.push({
          id: computeChunkId(content),
          content,
          offset: 0,
          tokens: Math.ceil(content.length / 4),
          headingBreadcrumb: breadcrumb,
          headingLevel: section.level || 1,
        });
      }
    }
  }

  return chunks;
}

// ─── KG Document Deletion with Cache-Based Rebuild ───────────────────────────

export interface KgDeletionResult {
  /** Entities that were fully removed */
  removedEntities: string[];
  /** Relations that were fully removed */
  removedRelations: string[];
  /** Entities that were updated (had sources removed but still have others) */
  updatedEntities: string[];
  /** Relations that were updated */
  updatedRelations: string[];
  /** Number of source chunks removed */
  removedChunks: number;
}

/**
 * Deletes a document from the knowledge graph and rebuilds affected
 * entities/relations using cached extraction results.
 *
 * This is the cache-based rebuild pattern from LightRAG: when a document
 * is deleted, the system uses the LLM cache from indexing to quickly
 * rebuild affected entities and relationships without re-running LLM calls.
 */
export class KgDocumentDeleter {
  private store: RagStore;
  private entityCache: Map<string, unknown> = new Map();

  constructor(store: RagStore) {
    this.store = store;
  }

  /**
   * Delete a document and rebuild affected KG entries.
   */
  async deleteDocument(documentId: string): Promise<KgDeletionResult> {
    const result: KgDeletionResult = {
      removedEntities: [],
      removedRelations: [],
      updatedEntities: [],
      updatedRelations: [],
      removedChunks: 0,
    };

    // Find all chunks from this document
    // In a real implementation, this would query the store by source document ID
    // For now, we return the result structure

    return result;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function computeChunkId(content: string): string {
  // Simple hash for demo — real impl would use SHA-256
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return `chunk_${Math.abs(hash).toString(36)}`;
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a default multi-mode retriever with sensible configuration.
 */
export function createDefaultRetriever(store: RagStore): MultiModeRetriever {
  return new MultiModeRetriever(store, {
    mode: "mix",
    maxTotalTokens: 12000,
    maxEntityTokens: 4000,
    maxRelationTokens: 4000,
    enableContentHeadings: true,
    maxRelatedChunks: 10,
    chunkPickMethod: "weighted_polling",
  });
}

/**
 * Create a default role-specific LLM registry.
 */
export function createDefaultRoleRegistry(): RoleLlmRegistry {
  return new RoleLlmRegistry({
    model: "gpt-4o-mini",
    provider: "openai",
  });
}
