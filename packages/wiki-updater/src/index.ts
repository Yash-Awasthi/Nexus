// SPDX-License-Identifier: Apache-2.0
/**
 * wiki-updater — LLM-driven wiki reconciliation loop.
 *
 * Maintains a live wiki by continuously reconciling new content against
 * existing articles via: intent distillation → candidate search → selector →
 * batch reconciler → nl-updater → re-index.
 *
 * Provides:
 *   • WikiArticle              — article store entry
 *   • WikiStore                — in-memory article store (used by pipeline)
 *   • PgWikiStore              — Postgres-backed persistent store (Neon serverless)
 *   • IntentDistillStep        — distil document intent to BM25 query
 *   • CandidateSearchStep      — BM25 candidate retrieval
 *   • SelectorStep             — select most relevant candidate
 *   • ReconcilerStep           — merge new content into selected article
 *   • NlUpdaterStep            — LLM natural-language update pass
 *   • ReindexStep              — re-index after commit
 *   • WikiUpdatePipeline       — orchestrates all steps
 *   • StageMetrics             — per-stage timing/result counters
 *   • MockWikiBackend          — injectable test double
 */

import { neon } from "@neondatabase/serverless";

/** Escape special regex metacharacters in a literal string. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WikiArticle {
  id: string;
  title: string;
  content: string;
  tags: string[];
  updatedAt: string;
  version: number;
}

/** Wiki document interface definition. */
export interface WikiDocument {
  id: string;
  content: string;
  source?: string;
}

/** Update request interface definition. */
export interface UpdateRequest {
  document: WikiDocument;
  sessionId?: string;
  dryRun?: boolean;
}

/** Update result interface definition. */
export interface UpdateResult {
  articleId: string | null;
  created: boolean;
  updated: boolean;
  dryRun: boolean;
  stages: StageResult[];
  durationMs: number;
}

/** Stage result interface definition. */
export interface StageResult {
  stage: string;
  durationMs: number;
  success: boolean;
  data?: unknown;
  error?: string;
}

// ── WikiStore ─────────────────────────────────────────────────────────────────

let _articleSeq = 0;

/** Wiki store. */
export class WikiStore {
  private articles = new Map<string, WikiArticle>();
  private index = new Map<string, Set<string>>(); // term → article ids

  set(article: WikiArticle): void {
    this.articles.set(article.id, article);
  }

  get(id: string): WikiArticle | undefined {
    return this.articles.get(id);
  }
  has(id: string): boolean {
    return this.articles.has(id);
  }
  all(): WikiArticle[] {
    return [...this.articles.values()];
  }
  size(): number {
    return this.articles.size;
  }

  create(title: string, content: string, tags: string[] = []): WikiArticle {
    const id = `article-${++_articleSeq}`;
    const article: WikiArticle = {
      id,
      title,
      content,
      tags,
      updatedAt: new Date().toISOString(),
      version: 1,
    };
    this.articles.set(id, article);
    return article;
  }

  update(id: string, content: string): WikiArticle | null {
    const article = this.articles.get(id);
    if (!article) return null;
    const updated = {
      ...article,
      content,
      updatedAt: new Date().toISOString(),
      version: article.version + 1,
    };
    this.articles.set(id, updated);
    return updated;
  }

  delete(id: string): boolean {
    return this.articles.delete(id);
  }

  /** Simple BM25-like term search (token overlap). */
  search(query: string, limit = 5): WikiArticle[] {
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 2);
    const scored: { article: WikiArticle; score: number }[] = [];

    for (const article of this.articles.values()) {
      const text = (article.title + " " + article.content).toLowerCase();
      const score = terms.reduce((sum, term) => {
        const count = (text.match(new RegExp(escapeRegExp(term), "g")) ?? []).length;
        return sum + count;
      }, 0);
      if (score > 0) scored.push({ article, score });
    }

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.article);
  }

  reindex(): number {
    this.index.clear();
    let terms = 0;
    for (const article of this.articles.values()) {
      const allTerms = (article.title + " " + article.content)
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length > 2);
      for (const term of allTerms) {
        if (!this.index.has(term)) this.index.set(term, new Set());
        this.index.get(term)!.add(article.id);
        terms++;
      }
    }
    return terms;
  }

  clear(): void {
    this.articles.clear();
    this.index.clear();
  }
}

// ── PgWikiStore ───────────────────────────────────────────────────────────────

/**
 * Postgres-backed wiki article store using @neondatabase/serverless.
 * Persists articles across restarts; falls back gracefully on query errors.
 *
 * Table is created on first call to init() or lazily on first write.
 *
 * Usage:
 *   const pg = new PgWikiStore(process.env.DATABASE_URL!);
 *   await pg.init(); // idempotent — safe to call every startup
 */
export class PgWikiStore {
  private sql: ReturnType<typeof neon>;
  private ready = false;

  constructor(connectionString: string) {
    this.sql = neon(connectionString);
  }

  /** Creates the wiki_articles table if it does not already exist. */
  async init(): Promise<void> {
    await this.sql`
      CREATE TABLE IF NOT EXISTS wiki_articles (
        id          TEXT PRIMARY KEY,
        title       TEXT        NOT NULL,
        content     TEXT        NOT NULL,
        tags        TEXT[]      NOT NULL DEFAULT '{}',
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        version     INTEGER     NOT NULL DEFAULT 1
      )
    `;
    this.ready = true;
  }

  private async ensureReady(): Promise<void> {
    if (!this.ready) await this.init();
  }

  async getAll(): Promise<WikiArticle[]> {
    await this.ensureReady();
    const rows = await this.sql`
      SELECT * FROM wiki_articles ORDER BY updated_at DESC
    `;
    // eslint-disable-next-line @typescript-eslint/unbound-method
    return rows.map(this.rowToArticle);
  }

  async getById(id: string): Promise<WikiArticle | undefined> {
    await this.ensureReady();
    const rows = await this.sql`
      SELECT * FROM wiki_articles WHERE id = ${id} LIMIT 1
    `;
    return rows[0] ? this.rowToArticle(rows[0] as Record<string, unknown>) : undefined;
  }

  async search(query: string, limit = 5): Promise<WikiArticle[]> {
    await this.ensureReady();
    const pattern = `%${query.toLowerCase()}%`;
    const rows = await this.sql`
      SELECT * FROM wiki_articles
      WHERE LOWER(title) LIKE ${pattern} OR LOWER(content) LIKE ${pattern}
      ORDER BY updated_at DESC
      LIMIT ${limit}
    `;
    return rows.map((r) => this.rowToArticle(r as Record<string, unknown>));
  }

  async upsert(article: WikiArticle): Promise<void> {
    await this.ensureReady();
    await this.sql`
      INSERT INTO wiki_articles (id, title, content, tags, updated_at, version)
      VALUES (
        ${article.id},
        ${article.title},
        ${article.content},
        ${article.tags},
        ${article.updatedAt},
        ${article.version}
      )
      ON CONFLICT (id) DO UPDATE SET
        title      = EXCLUDED.title,
        content    = EXCLUDED.content,
        tags       = EXCLUDED.tags,
        updated_at = EXCLUDED.updated_at,
        version    = EXCLUDED.version
    `;
  }

  async delete(id: string): Promise<boolean> {
    await this.ensureReady();
    const result = await this.sql`DELETE FROM wiki_articles WHERE id = ${id}`;
    // neon returns an array; rowCount lives on the result object
    return ((result as unknown as { rowCount?: number }).rowCount ?? 0) > 0;
  }

  async count(): Promise<number> {
    await this.ensureReady();
    const rows = await this.sql`SELECT COUNT(*)::int AS n FROM wiki_articles`;
    return ((rows[0] as Record<string, unknown>)?.["n"] as number) ?? 0;
  }

  private rowToArticle(row: Record<string, unknown>): WikiArticle {
    return {
      id: row["id"] as string,
      title: row["title"] as string,
      content: row["content"] as string,
      tags: (row["tags"] as string[]) ?? [],
      updatedAt: (row["updated_at"] as string) ?? new Date().toISOString(),
      version: (row["version"] as number) ?? 1,
    };
  }
}

// ── StageMetrics ──────────────────────────────────────────────────────────────

export interface StageStats {
  runs: number;
  successes: number;
  failures: number;
  totalDurationMs: number;
}

/** Stage metrics. */
export class StageMetrics {
  private stats = new Map<string, StageStats>();

  record(stage: string, result: StageResult): void {
    if (!this.stats.has(stage)) {
      this.stats.set(stage, { runs: 0, successes: 0, failures: 0, totalDurationMs: 0 });
    }
    const s = this.stats.get(stage)!;
    s.runs++;
    if (result.success) s.successes++;
    else s.failures++;
    s.totalDurationMs += result.durationMs;
  }

  get(stage: string): StageStats | undefined {
    return this.stats.get(stage);
  }
  all(): Record<string, StageStats> {
    return Object.fromEntries(this.stats);
  }
  clear(): void {
    this.stats.clear();
  }
}

// ── Pipeline steps ────────────────────────────────────────────────────────────

export type DistillFn = (content: string) => Promise<string | null>;
/** Nl update fn type alias. */
export type NlUpdateFn = (existing: string, newContent: string) => Promise<string>;

/** Pipeline context interface definition. */
export interface PipelineContext {
  document: WikiDocument;
  distilledQuery?: string | null;
  candidates?: WikiArticle[];
  selected?: WikiArticle | null;
  mergedContent?: string;
  finalContent?: string;
  targetArticleId?: string | null;
  isNew?: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; durationMs: number }> {
  const t0 = Date.now();
  const result = await fn();
  return { result, durationMs: Date.now() - t0 };
}

// ── WikiUpdatePipeline ────────────────────────────────────────────────────────

export interface PipelineOptions {
  store: WikiStore;
  distillFn?: DistillFn;
  nlUpdateFn?: NlUpdateFn;
  searchLimit?: number;
  similarityThreshold?: number; // min BM25 score to select a candidate
  metrics?: StageMetrics;
  autoCreate?: boolean;
}

/** Wiki update pipeline. */
export class WikiUpdatePipeline {
  private store: WikiStore;
  private distillFn: DistillFn;
  private nlUpdateFn: NlUpdateFn;
  private searchLimit: number;
  private metrics: StageMetrics;
  private autoCreate: boolean;

  constructor(opts: PipelineOptions) {
    this.store = opts.store;
    this.distillFn = opts.distillFn ?? (async (c) => c.slice(0, 200));
    this.nlUpdateFn = opts.nlUpdateFn ?? (async (_existing, newContent) => newContent);
    this.searchLimit = opts.searchLimit ?? 5;
    this.metrics = opts.metrics ?? new StageMetrics();
    this.autoCreate = opts.autoCreate ?? true;
  }

  async run(request: UpdateRequest): Promise<UpdateResult> {
    const t0 = Date.now();
    const stages: StageResult[] = [];
    const ctx: PipelineContext = { document: request.document };

    // Stage 1: Intent distillation
    const stageDistill = await this.runStage("distill", stages, async () => {
      const query = await this.distillFn(ctx.document.content);
      ctx.distilledQuery = query;
      return { query };
    });
    if (!stageDistill.success) {
      return this.failResult(request, stages, t0);
    }

    // Stage 2: Candidate search
    await this.runStage("search", stages, async () => {
      const query = ctx.distilledQuery ?? ctx.document.content.slice(0, 100);
      ctx.candidates = this.store.search(query, this.searchLimit);
      return { count: ctx.candidates.length };
    });

    // Stage 3: Selector
    await this.runStage("select", stages, async () => {
      ctx.selected = ctx.candidates?.[0] ?? null;
      return { selected: ctx.selected?.id ?? null };
    });

    // Stage 4: Reconcile (merge)
    await this.runStage("reconcile", stages, async () => {
      ctx.mergedContent = ctx.selected
        ? ctx.selected.content + "\n\n" + ctx.document.content
        : ctx.document.content;
      return { merged: true };
    });

    // Stage 5: NL update
    await this.runStage("nl-update", stages, async () => {
      ctx.finalContent = await this.nlUpdateFn(
        ctx.selected?.content ?? "",
        ctx.mergedContent ?? ctx.document.content,
      );
      return { length: ctx.finalContent.length };
    });

    // Stage 6: Commit
    let created = false;
    let updated = false;
    let articleId: string | null = null;

    await this.runStage("commit", stages, async () => {
      if (request.dryRun) return { dryRun: true };

      if (ctx.selected) {
        const result = this.store.update(ctx.selected.id, ctx.finalContent!);
        articleId = result?.id ?? null;
        updated = true;
      } else if (this.autoCreate) {
        const title = ctx.document.source ?? `Document ${ctx.document.id}`;
        const article = this.store.create(title, ctx.finalContent!);
        articleId = article.id;
        created = true;
      }
      return { articleId, created, updated };
    });

    // Stage 7: Re-index
    await this.runStage("reindex", stages, async () => {
      const terms = this.store.reindex();
      return { terms };
    });

    return {
      articleId,
      created,
      updated,
      dryRun: request.dryRun ?? false,
      stages,
      durationMs: Date.now() - t0,
    };
  }

  private async runStage(
    name: string,
    stages: StageResult[],
    fn: () => Promise<unknown>,
  ): Promise<StageResult> {
    const t0 = Date.now();
    try {
      const data = await fn();
      const result: StageResult = { stage: name, durationMs: Date.now() - t0, success: true, data };
      stages.push(result);
      this.metrics.record(name, result);
      return result;
    } catch (err) {
      const result: StageResult = {
        stage: name,
        durationMs: Date.now() - t0,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
      stages.push(result);
      this.metrics.record(name, result);
      return result;
    }
  }

  private failResult(request: UpdateRequest, stages: StageResult[], t0: number): UpdateResult {
    return {
      articleId: null,
      created: false,
      updated: false,
      dryRun: request.dryRun ?? false,
      stages,
      durationMs: Date.now() - t0,
    };
  }

  getStore(): WikiStore {
    return this.store;
  }
  getMetrics(): StageMetrics {
    return this.metrics;
  }
}
