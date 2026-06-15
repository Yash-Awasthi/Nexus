// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/agents — Librarian, Researcher, and FileExplorer specialized agents.
 *
 * All three agents are fully injectable — they accept minimal structural
 * interfaces compatible with @nexus/memory, @nexus/knowledge-graph, and
 * @nexus/hooks without creating hard inter-package dependencies.
 *
 * LibrarianAgent   — semantic memory recall + KG entity queries + context
 *                    assembly within a token budget
 * ResearcherAgent  — orchestrates an injectable research runner, stores the
 *                    report in memory, and ingests findings into the KG
 * FileExplorerAgent — read / edit / list files with full hook lifecycle
 *                    (file.before_edit / file.after_edit); respects abort
 *
 * Wire the real implementations in production:
 *   new LibrarianAgent({
 *     memory: memoryManager,
 *     kg:     knowledgeGraph,
 *     hooks:  globalHooks,
 *   })
 *
 * Use null stubs in tests — every dependency is optional or swappable.
 */

// ── Shared error ───────────────────────────────────────────────────────────────

export type AgentErrorCode =
  | "RECALL_FAILED"
  | "RESEARCH_FAILED"
  | "INGEST_FAILED"
  | "FILE_READ_FAILED"
  | "FILE_WRITE_FAILED"
  | "FILE_LIST_FAILED"
  | "HOOK_EMIT_FAILED";

/** Agent error. */
export class AgentError extends Error {
  readonly code: AgentErrorCode;
  readonly context?: Record<string, unknown>;

  constructor(code: AgentErrorCode, message: string, context?: Record<string, unknown>) {
    super(message);
    this.name = "AgentError";
    this.code = code;
    this.context = context;
  }
}

// ── Shared minimal dependency interfaces ──────────────────────────────────────

/**
 * Minimal memory interface — structurally compatible with @nexus/memory
 * MemoryManager.  Only the methods used by agents are declared.
 */
export interface AgentMemory {
  recall(
    query: string,
    limit?: number,
    filter?: Record<string, unknown>,
  ): Promise<AgentMemorySearchResult[]>;
  remember?(text: string, metadata?: Record<string, unknown>): Promise<unknown>;
}

/** Agent memory search result interface definition. */
export interface AgentMemorySearchResult {
  entry: {
    id: string;
    text: string;
    metadata: Record<string, unknown>;
    createdAt: number;
  };
  /** Cosine similarity in [0, 1] */
  score: number;
}

/**
 * Minimal KG interface — structurally compatible with @nexus/knowledge-graph
 * KnowledgeGraph.  Only the methods used by agents are declared.
 */
export interface AgentKG {
  queryNodes(query?: {
    nameContains?: string;
    type?: string;
    minConfidence?: number;
    limit?: number;
  }): Promise<AgentKGNode[]>;
  findRelated?(
    nodeId: string,
    opts?: { direction?: "outbound" | "inbound" | "both"; limit?: number },
  ): Promise<AgentRelatedResult>;
  ingest?(text: string, opts?: Record<string, unknown>): Promise<unknown>;
}

/** Agent kg node interface definition. */
export interface AgentKGNode {
  id: string;
  name: string;
  type: string;
  confidence: number;
  sources: string[];
}

/** Agent kg edge interface definition. */
export interface AgentKGEdge {
  id: string;
  subjectId: string;
  predicate: string;
  objectId: string;
  confidence: number;
}

/** Agent related result interface definition. */
export interface AgentRelatedResult {
  outbound: AgentKGEdge[];
  inbound: AgentKGEdge[];
  nodes: AgentKGNode[];
}

/**
 * Minimal hook emitter — structurally compatible with @nexus/hooks
 * HookRegistry.emit.
 */
export interface AgentHooks {
  emit(
    event: string,
    payload: Record<string, unknown>,
  ): Promise<{ handled: number; aborted: boolean; errors: unknown[] }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// LibrarianAgent
// ─────────────────────────────────────────────────────────────────────────────

export interface LibrarianConfig {
  memory: AgentMemory;
  /** Optional KG for entity-level recall */
  kg?: AgentKG;
  /** Optional hook emitter for agent.observe events */
  hooks?: AgentHooks;
  /** Display name used in hook payloads (default: "librarian") */
  name?: string;
  /** Default number of memory results to fetch (default: 5) */
  defaultRecallLimit?: number;
  /** Max KG nodes to return per query (default: 10) */
  defaultNodeLimit?: number;
  /**
   * Approximate chars-per-token ratio for contextText budget trimming.
   * Default: 4 (matches llm-utils estimateTokens convention).
   */
  charsPerToken?: number;
}

/** Librarian recall options interface definition. */
export interface LibrarianRecallOptions {
  /** Override default recall limit for memory results */
  limit?: number;
  /** Override default node limit for KG results */
  nodeLimit?: number;
  /** Only return memory results with score >= this threshold (default: 0) */
  minScore?: number;
  /** Metadata filter forwarded to memory.recall */
  filter?: Record<string, unknown>;
  /** Max context tokens to include in contextText (default: 2048) */
  maxContextTokens?: number;
}

/** Librarian recall result interface definition. */
export interface LibrarianRecallResult {
  /** Memory entries ordered by descending score */
  memories: AgentMemorySearchResult[];
  /** KG entities matching the query, ordered by confidence */
  entities: AgentKGNode[];
  /** Assembled plain-text context ready for injection into a prompt */
  contextText: string;
  /**
   * If the KG lookup failed, the error message is exposed here.
   * memories and contextText are still populated from the memory store.
   */
  kgError?: string;
}

/** Token estimate: ceil(chars / charsPerToken) */
function estimateTokens(text: string, charsPerToken: number): number {
  return Math.ceil(text.length / charsPerToken);
}

/** Librarian agent. */
export class LibrarianAgent {
  private readonly memory: AgentMemory;
  private readonly kg?: AgentKG;
  private readonly hooks?: AgentHooks;
  private readonly name: string;
  private readonly defaultRecallLimit: number;
  private readonly defaultNodeLimit: number;
  private readonly charsPerToken: number;

  constructor(config: LibrarianConfig) {
    this.memory = config.memory;
    this.kg = config.kg;
    this.hooks = config.hooks;
    this.name = config.name ?? "librarian";
    this.defaultRecallLimit = config.defaultRecallLimit ?? 5;
    this.defaultNodeLimit = config.defaultNodeLimit ?? 10;
    this.charsPerToken = config.charsPerToken ?? 4;
  }

  /**
   * Recall relevant memories and KG entities for a query, then assemble
   * them into a single context string trimmed to `maxContextTokens`.
   */
  async recall(query: string, opts: LibrarianRecallOptions = {}): Promise<LibrarianRecallResult> {
    const limit = opts.limit ?? this.defaultRecallLimit;
    const nodeLimit = opts.nodeLimit ?? this.defaultNodeLimit;
    const minScore = opts.minScore ?? 0;
    const maxContextTokens = opts.maxContextTokens ?? 2048;

    // ── 1. Emit observe start ───────────────────────────────────────────────
    await this._emit("agent.observe", {
      agent: this.name,
      action: "recall.start",
      query,
      limit,
      nodeLimit,
    });

    // ── 2. Semantic memory recall ───────────────────────────────────────────
    let memories: AgentMemorySearchResult[];
    try {
      const raw = await this.memory.recall(query, limit, opts.filter);
      memories = raw.filter((r) => r.score >= minScore);
    } catch (cause) {
      throw new AgentError("RECALL_FAILED", `Memory recall failed: ${String(cause)}`, {
        query,
      });
    }

    // ── 3. KG entity lookup ─────────────────────────────────────────────────
    let entities: AgentKGNode[] = [];
    let kgError: string | undefined;
    if (this.kg) {
      try {
        entities = await this.kg.queryNodes({
          nameContains: query,
          limit: nodeLimit,
        });
        // Sort by descending confidence
        entities = [...entities].sort((a, b) => b.confidence - a.confidence);
      } catch (err) {
        // KG failures are non-fatal — proceed with memories only; expose the error
        entities = [];
        kgError = String(err);
      }
    }

    // ── 4. Assemble context string ──────────────────────────────────────────
    const contextText = this._assembleContext(memories, entities, maxContextTokens);

    // ── 5. Emit observe done ────────────────────────────────────────────────
    await this._emit("agent.observe", {
      agent: this.name,
      action: "recall.done",
      query,
      memoriesReturned: memories.length,
      entitiesReturned: entities.length,
      contextTokens: estimateTokens(contextText, this.charsPerToken),
    });

    return { memories, entities, contextText, kgError };
  }

  /**
   * Keyword-index search: recalls candidates then re-ranks by query term
   * frequency (TF) in the memory text.  Supplements semantic recall when
   * embeddings are weak or unavailable.
   *
   * The candidate pool is fetched with a 3× limit to ensure enough results
   * for re-ranking before slicing back to the configured limit.
   */
  async keywordSearch(
    query: string,
    opts: LibrarianRecallOptions = {},
  ): Promise<LibrarianRecallResult> {
    const finalLimit = opts.limit ?? this.defaultRecallLimit;
    // Fetch a larger candidate pool for re-ranking
    const candidateLimit = finalLimit * 3;
    const rawResult = await this.recall(query, { ...opts, limit: candidateLimit });

    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

    // TF-score each memory by counting how many times each query term appears
    const scored = rawResult.memories.map((m) => {
      const textLower = m.entry.text.toLowerCase();
      const tf = terms.reduce((sum, term) => {
        let count = 0;
        let pos = 0;
        while ((pos = textLower.indexOf(term, pos)) !== -1) {
          count++;
          pos += term.length;
        }
        return sum + count;
      }, 0);
      return { mem: m, tf };
    });

    // Sort by TF DESC, then by semantic score DESC as tie-breaker
    scored.sort((a, b) => b.tf - a.tf || b.mem.score - a.mem.score);

    const memories = scored.slice(0, finalLimit).map((s) => s.mem);
    const maxContextTokens = opts.maxContextTokens ?? 2048;
    const contextText = this._assembleContext(memories, rawResult.entities, maxContextTokens);

    return { ...rawResult, memories, contextText };
  }

  private _assembleContext(
    memories: AgentMemorySearchResult[],
    entities: AgentKGNode[],
    maxTokens: number,
  ): string {
    const lines: string[] = [];
    let tokensUsed = 0;

    if (memories.length > 0) {
      lines.push("## Relevant Memories");
      for (const { entry, score } of memories) {
        const line = `- [score: ${score.toFixed(3)}] ${entry.text}`;
        const lineTokens = estimateTokens(line + "\n", this.charsPerToken);
        if (tokensUsed + lineTokens > maxTokens) break;
        lines.push(line);
        tokensUsed += lineTokens;
      }
    }

    if (entities.length > 0) {
      const header = "\n## Known Entities";
      const headerTokens = estimateTokens(header + "\n", this.charsPerToken);
      if (tokensUsed + headerTokens <= maxTokens) {
        lines.push(header);
        tokensUsed += headerTokens;
        for (const entity of entities) {
          const line = `- ${entity.name} (${entity.type}, confidence: ${entity.confidence.toFixed(2)})`;
          const lineTokens = estimateTokens(line + "\n", this.charsPerToken);
          if (tokensUsed + lineTokens > maxTokens) break;
          lines.push(line);
          tokensUsed += lineTokens;
        }
      }
    }

    return lines.join("\n");
  }

  private async _emit(event: string, payload: Record<string, unknown>): Promise<void> {
    if (!this.hooks) return;
    try {
      await this.hooks.emit(event, payload);
    } catch {
      // Hook errors are non-fatal
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ResearcherAgent
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimal interface for a research runner.
 * Compatible with @nexus/adapter-deep-research's execute() output shape.
 */
export interface ResearchRunner {
  (
    query: string,
    opts?: ResearchRunOptions,
  ): Promise<ResearchRunResult>;
}

/** Research run options interface definition. */
export interface ResearchRunOptions {
  /** Max gap-fill iterations (default: 2) */
  maxIterations?: number;
  /** Results per search query (default: 5) */
  resultsPerQuery?: number;
}

/** Research run result interface definition. */
export interface ResearchRunResult {
  /** Full Markdown report */
  report: string;
  /** Source URLs referenced in the report */
  sources: string[];
  /** Total latency in milliseconds */
  latencyMs?: number;
  /** Whether the runner completed without error */
  ok: boolean;
  error?: string;
}

/** Researcher config interface definition. */
export interface ResearcherConfig {
  /** Injectable research execution function */
  runner: ResearchRunner;
  /** Optional memory store — if provided, the report is persisted */
  memory?: AgentMemory;
  /** Optional KG — if provided, the report text is ingested */
  kg?: AgentKG;
  /** Optional hook emitter */
  hooks?: AgentHooks;
  /** Display name (default: "researcher") */
  name?: string;
}

/** Research options interface definition. */
export interface ResearchOptions extends ResearchRunOptions {
  /**
   * Extra metadata to attach to the memory entry when persisting the report.
   * Merged with { agent, query, sources }.
   */
  metadata?: Record<string, unknown>;
  /** Skip storing the report in memory even if a memory store is wired */
  skipMemory?: boolean;
  /** Skip ingesting into the KG even if a KG is wired */
  skipKG?: boolean;
}

/** Research result interface definition. */
export interface ResearchResult {
  query: string;
  report: string;
  sources: string[];
  latencyMs: number;
  /** true if the report was stored in memory */
  storedInMemory: boolean;
  /** true if the report was ingested into the KG */
  ingestedIntoKG: boolean;
  ok: boolean;
  error?: string;
}

/** Researcher agent. */
export class ResearcherAgent {
  private readonly runner: ResearchRunner;
  private readonly memory?: AgentMemory;
  private readonly kg?: AgentKG;
  private readonly hooks?: AgentHooks;
  private readonly name: string;
  /**
   * Tracks queries already ingested into the KG to prevent duplicate ingestion
   * within the lifetime of this agent instance.
   */
  private readonly _ingestedQueries = new Set<string>();

  constructor(config: ResearcherConfig) {
    this.runner = config.runner;
    this.memory = config.memory;
    this.kg = config.kg;
    this.hooks = config.hooks;
    this.name = config.name ?? "researcher";
  }

  async research(query: string, opts: ResearchOptions = {}): Promise<ResearchResult> {
    const startMs = Date.now();

    // ── 1. Emit start ───────────────────────────────────────────────────────
    await this._emit("agent.observe", {
      agent: this.name,
      action: "research.start",
      query,
      maxIterations: opts.maxIterations,
    });

    // ── 2. Run research ─────────────────────────────────────────────────────
    let runResult: ResearchRunResult;
    try {
      runResult = await this.runner(query, {
        maxIterations: opts.maxIterations,
        resultsPerQuery: opts.resultsPerQuery,
      });
    } catch (cause) {
      throw new AgentError("RESEARCH_FAILED", `Research runner failed: ${String(cause)}`, {
        query,
      });
    }

    const latencyMs = runResult.latencyMs ?? Date.now() - startMs;
    let storedInMemory = false;
    let ingestedIntoKG = false;

    // ── 3. Persist to memory ────────────────────────────────────────────────
    if (this.memory?.remember && !opts.skipMemory && runResult.ok) {
      try {
        await this.memory.remember(runResult.report, {
          agent: this.name,
          query,
          sources: runResult.sources,
          ...opts.metadata,
        });
        storedInMemory = true;
      } catch {
        // Memory failures are non-fatal
      }
    }

    // ── 4. Ingest into KG (with dedup) ──────────────────────────────────────
    if (this.kg?.ingest && !opts.skipKG && runResult.ok) {
      if (this._ingestedQueries.has(query)) {
        // Already ingested this query — skip to avoid duplicate KG entries
        ingestedIntoKG = false;
      } else {
        try {
          await this.kg.ingest(runResult.report, { source: query });
          this._ingestedQueries.add(query);
          ingestedIntoKG = true;
        } catch {
          // KG failures are non-fatal
        }
      }
    }

    // ── 5. Emit done ────────────────────────────────────────────────────────
    await this._emit("agent.observe", {
      agent: this.name,
      action: "research.done",
      query,
      ok: runResult.ok,
      latencyMs,
      storedInMemory,
      ingestedIntoKG,
    });

    return {
      query,
      report: runResult.report,
      sources: runResult.sources,
      latencyMs,
      storedInMemory,
      ingestedIntoKG,
      ok: runResult.ok,
      error: runResult.error,
    };
  }

  private async _emit(event: string, payload: Record<string, unknown>): Promise<void> {
    if (!this.hooks) return;
    try {
      await this.hooks.emit(event, payload);
    } catch {
      // Hook errors are non-fatal
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FileExplorerAgent
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Injectable filesystem abstraction — swappable between Node fs/promises,
 * mocks, in-memory stores, or remote filesystems.
 */
export interface AgentFileSystem {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  listDir(dir: string): Promise<string[]>;
  exists?(path: string): Promise<boolean>;
}

/** File explorer config interface definition. */
export interface FileExplorerConfig {
  fs: AgentFileSystem;
  /** Optional hook emitter */
  hooks?: AgentHooks;
  /** Display name (default: "file-explorer") */
  name?: string;
}

/** File info interface definition. */
export interface FileInfo {
  /** Absolute or relative path returned by listDir */
  path: string;
  /** Entry name (last path segment) */
  name: string;
  /**
   * TF relevance score computed when `ListOptions.query` is provided.
   * Higher is more relevant. Absent when no query was given.
   */
  score?: number;
}

/** Edit result interface definition. */
export interface EditResult {
  ok: boolean;
  /** Path of the edited file */
  path: string;
  /** Number of bytes written (length of content UTF-8) */
  bytesWritten?: number;
  /** true when a hook aborted the edit before the write occurred */
  aborted?: boolean;
  error?: string;
}

/** List options interface definition. */
export interface ListOptions {
  /**
   * Simple glob-style filter: only include entries whose name contains this
   * substring (case-insensitive).  Leave undefined to return all entries.
   */
  pattern?: string;
  /**
   * When provided, results are ranked by TF (term frequency) score: the
   * number of times query terms appear in the file path/name segments.
   * Results are returned in descending score order with a `score` field.
   */
  query?: string;
}

/** File explorer agent. */
export class FileExplorerAgent {
  private readonly fs: AgentFileSystem;
  private readonly hooks?: AgentHooks;
  private readonly name: string;

  constructor(config: FileExplorerConfig) {
    this.fs = config.fs;
    this.hooks = config.hooks;
    this.name = config.name ?? "file-explorer";
  }

  /** Read a file and return its content as a UTF-8 string. */
  async readFile(path: string): Promise<string> {
    try {
      return await this.fs.readFile(path);
    } catch (cause) {
      throw new AgentError("FILE_READ_FAILED", `Failed to read file: ${String(cause)}`, { path });
    }
  }

  /**
   * Write new content to a file.
   *
   * Lifecycle:
   *   1. Emit `file.before_edit` — if any handler returns `{ abort: true }`,
   *      the write is skipped and `{ ok: false, aborted: true }` is returned.
   *   2. Write the file via the injected `AgentFileSystem`.
   *   3. Emit `file.after_edit` with bytes written.
   */
  async editFile(path: string, content: string): Promise<EditResult> {
    // ── 1. Before-edit hook ─────────────────────────────────────────────────
    if (this.hooks) {
      let emitResult: { handled: number; aborted: boolean; errors: unknown[] };
      try {
        emitResult = await this.hooks.emit("file.before_edit", {
          agent: this.name,
          path,
          newSize: content.length,
        });
      } catch (cause) {
        throw new AgentError(
          "HOOK_EMIT_FAILED",
          `Hook emit failed: ${String(cause)}`,
          { path },
        );
      }

      if (emitResult.aborted) {
        return { ok: false, path, aborted: true };
      }
    }

    // ── 2. Write ────────────────────────────────────────────────────────────
    const bytesWritten = Buffer.byteLength(content, "utf8");
    try {
      await this.fs.writeFile(path, content);
    } catch (cause) {
      throw new AgentError("FILE_WRITE_FAILED", `Failed to write file: ${String(cause)}`, {
        path,
      });
    }

    // ── 3. After-edit hook ──────────────────────────────────────────────────
    if (this.hooks) {
      try {
        await this.hooks.emit("file.after_edit", {
          agent: this.name,
          path,
          bytesWritten,
        });
      } catch {
        // After-edit failures are non-fatal
      }
    }

    return { ok: true, path, bytesWritten };
  }

  /**
   * List entries in a directory, optionally filtered by name substring.
   */
  async listFiles(dir: string, opts: ListOptions = {}): Promise<FileInfo[]> {
    let entries: string[];
    try {
      entries = await this.fs.listDir(dir);
    } catch (cause) {
      throw new AgentError("FILE_LIST_FAILED", `Failed to list directory: ${String(cause)}`, {
        dir,
      });
    }

    const pattern = opts.pattern?.toLowerCase();
    const filtered = pattern
      ? entries.filter((e) => {
          const name = e.split("/").pop() ?? e;
          return name.toLowerCase().includes(pattern);
        })
      : entries;

    // TF-scored ranking when query is provided
    if (opts.query) {
      const terms = opts.query.toLowerCase().split(/\s+/).filter(Boolean);
      const scored: FileInfo[] = filtered.map((e) => {
        // Split path into word segments for TF counting
        const segments = e.toLowerCase().split(/[/._\-\s]+/).filter(Boolean);
        const score = terms.reduce((sum, term) => {
          return sum + segments.filter((seg) => seg.includes(term)).length;
        }, 0);
        return { path: e, name: e.split("/").pop() ?? e, score };
      });
      return scored.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    }

    return filtered.map((e) => ({
      path: e,
      name: e.split("/").pop() ?? e,
    }));
  }
}
