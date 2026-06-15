// SPDX-License-Identifier: Apache-2.0
/**
 * Researcher routes — web + corpus research agent via @nexus/researcher.
 *
 * POST /api/v1/researcher/research           — run a research query (web + corpus)
 * GET  /api/v1/researcher/:runId/citations   — list SourceReference[]  for a completed run
 *
 * Search backend selection (in priority order):
 *   1. TavilySearchBackend  — when TAVILY_API_KEY is set
 *   2. SearxngSearchBackend — when SEARXNG_URL is set
 *   3. NoopSearchBackend    — deterministic fallback (local dev / CI)
 *
 * Results (including richCitations) are stored in a short-lived in-process
 * run store (capped at 500 entries, oldest evicted).
 */

import { randomUUID } from "crypto";

import { ResearcherAgent, type ResearchRunner, type ResearchRunResult } from "@nexus/agents";
import { BM25Reranker } from "@nexus/reranker";
import {
  CitationIndex,
  ResearchSession,
  WebResearcher,
  type SearchResult,
  type ResearchFinding,
  type SourceReference,
} from "@nexus/researcher";
import type { FastifyInstance } from "fastify";
import { Pool } from "pg";

import { requireAuth } from "../middleware/auth.js";

// ── Search backend factory ────────────────────────────────────────────────────

type WebSearchFn = (query: string) => Promise<SearchResult[]>;

function buildSearchFn(): WebSearchFn {
  // ── Tavily ──────────────────────────────────────────────────────────────────
  if (process.env.TAVILY_API_KEY) {
    const apiKey = process.env.TAVILY_API_KEY;
    return async (query: string): Promise<SearchResult[]> => {
      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: apiKey,
          query,
          search_depth: "basic",
          max_results: 10,
          include_answer: false,
        }),
      });
      if (!res.ok) throw new Error(`Tavily error: ${res.status}`);
      const data = (await res.json()) as {
        results?: { url: string; title: string; content: string; score?: number }[];
      };
      return (data.results ?? []).map((r) => ({
        url: r.url,
        title: r.title,
        snippet: r.content?.slice(0, 300) ?? "",
        score: r.score ?? 0.8,
        source: "web" as const,
      }));
    };
  }

  // ── SearXNG ─────────────────────────────────────────────────────────────────
  if (process.env.SEARXNG_URL) {
    const base = process.env.SEARXNG_URL.replace(/\/$/, "");
    return async (query: string): Promise<SearchResult[]> => {
      const url = `${base}/search?q=${encodeURIComponent(query)}&format=json&engines=google,bing`;
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`SearXNG error: ${res.status}`);
      const data = (await res.json()) as {
        results?: { url: string; title: string; content?: string; score?: number }[];
      };
      return (data.results ?? []).slice(0, 10).map((r, i) => ({
        url: r.url,
        title: r.title,
        snippet: r.content?.slice(0, 300) ?? "",
        score: r.score ?? 1 - i * 0.05,
        source: "web" as const,
      }));
    };
  }

  // ── NoopSearchBackend (deterministic placeholder) ───────────────────────────
  return async (query: string): Promise<SearchResult[]> => [
    {
      url: `https://example.com/search?q=${encodeURIComponent(query)}`,
      title: `[Noop] Results for: ${query}`,
      snippet: `Set TAVILY_API_KEY or SEARXNG_URL to enable real web search. Query: ${query}`,
      score: 0.5,
      source: "web" as const,
    },
  ];
}

// ── Semantic Scholar academic search ─────────────────────────────────────────
// Free-tier: ~100 req/5 min without a key; higher limits with SEMANTIC_SCHOLAR_API_KEY.
// Used as:
//   a) A parallel academic-paper enrichment layer on top of the web search backend.
//   b) The exclusive source for GET /researcher/academic?query=.

interface S2Paper {
  paperId: string;
  title: string;
  year?: number;
  abstract?: string;
  url?: string;
  openAccessPdf?: { url: string } | null;
  authors?: { name: string }[];
}

async function semanticScholarSearch(query: string, limit = 10): Promise<SearchResult[]> {
  const base = "https://api.semanticscholar.org/graph/v1/paper/search";
  const fields = "title,year,authors,abstract,url,openAccessPdf";
  const url = `${base}?query=${encodeURIComponent(query)}&fields=${fields}&limit=${limit}`;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (process.env.SEMANTIC_SCHOLAR_API_KEY) {
    headers["x-api-key"] = process.env.SEMANTIC_SCHOLAR_API_KEY;
  }
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Semantic Scholar error: ${res.status}`);
  const data = (await res.json()) as { data?: S2Paper[] };
  return (data.data ?? []).map((p, i) => ({
    url: p.openAccessPdf?.url ?? p.url ?? `https://www.semanticscholar.org/paper/${p.paperId}`,
    title: p.title,
    snippet:
      p.abstract?.slice(0, 300) ??
      `[${p.year ?? "n.d."}] ${(p.authors ?? [])
        .map((a) => a.name)
        .slice(0, 3)
        .join(", ")}`,
    score: 1 - i * 0.04,
    source: "corpus" as const,
  }));
}

// ── Singleton researcher + BM25 reranker ──────────────────────────────────────

const reranker = new BM25Reranker();

const searchFn = buildSearchFn();

const session = new ResearchSession({
  webResearcher: new WebResearcher({ searchFn, maxResults: 10 }),
  dedupByUrl: true,
});

// ── ResearcherAgent — wraps session as injectable ResearchRunner ───────────────
// Captures allResults + durationMs per call so the route handler can still
// BM25-rerank and build rich CitationIndex from full SearchResult objects.
// Single-threaded Node.js event loop makes the capture variable race-free: each
// awaited call to researcherAgent.research() completes before the next starts.

let _capturedAllResults: SearchResult[] = [];
let _capturedDurationMs = 0;

const _researchRunner: ResearchRunner = async (query: string): Promise<ResearchRunResult> => {
  const combined = await session.research(query);
  _capturedAllResults = combined.allResults;
  _capturedDurationMs = combined.durationMs;
  const synthesis =
    combined.webFindings?.synthesis ??
    combined.corpusFindings?.synthesis ??
    `${combined.allResults.length} result(s) found for: ${query}`;
  return {
    ok: true,
    report: synthesis,
    sources: combined.allResults.map((r) => r.url),
    latencyMs: combined.durationMs,
  };
};

const researcherAgent = new ResearcherAgent({ runner: _researchRunner });

// ── Durable run store (pg) — in-process Map is warm L1 cache ──────────────────

interface RunRecord {
  runId: string;
  query: string;
  finding: ResearchFinding;
  citations: SourceReference[];
  createdAt: string;
}

let _pool: Pool | null = null;
let _schemaReady = false;

function getPool(): Pool | null {
  if (!process.env.DATABASE_URL) return null;
  if (!_pool) _pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return _pool;
}

async function ensureSchema(pool: Pool): Promise<void> {
  if (_schemaReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS research_runs (
      id          text        PRIMARY KEY,
      query       text        NOT NULL,
      result      jsonb       NOT NULL,
      citations   jsonb       NOT NULL DEFAULT '[]'::jsonb,
      created_at  timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS research_runs_query_idx
      ON research_runs (query);
    CREATE INDEX IF NOT EXISTS research_runs_created_at_idx
      ON research_runs (created_at DESC);
  `);
  _schemaReady = true;
}

// In-memory L1 (lost on restart or when cap hit; DB is authoritative)
const runStore = new Map<string, RunRecord>();
const RUN_CAP = 500;

function storeInMemory(record: RunRecord): void {
  if (runStore.size >= RUN_CAP) {
    const oldest = runStore.keys().next().value;
    if (oldest) runStore.delete(oldest);
  }
  runStore.set(record.runId, record);
}

async function persistRun(record: RunRecord): Promise<void> {
  storeInMemory(record);
  const pool = getPool();
  if (!pool) return;
  ensureSchema(pool)
    .then(() =>
      pool.query(
        `INSERT INTO research_runs (id, query, result, citations)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO NOTHING`,
        [
          record.runId,
          record.query,
          JSON.stringify(record.finding),
          JSON.stringify(record.citations),
        ],
      ),
    )
    .catch((e: Error) => console.warn("[researcher] DB persist failed:", e.message));
}

async function loadRun(runId: string): Promise<RunRecord | null> {
  // Check memory first
  const cached = runStore.get(runId);
  if (cached) return cached;

  const pool = getPool();
  if (!pool) return null;
  try {
    await ensureSchema(pool);
    const { rows } = await pool.query<{
      id: string;
      query: string;
      result: ResearchFinding;
      citations: SourceReference[];
      created_at: Date;
    }>(`SELECT id, query, result, citations, created_at FROM research_runs WHERE id = $1`, [runId]);
    if (!rows[0]) return null;
    const r = rows[0];
    return {
      runId: r.id,
      query: r.query,
      finding: r.result,
      citations: Array.isArray(r.citations) ? r.citations : [],
      createdAt: r.created_at.toISOString(),
    };
  } catch (e) {
    console.warn("[researcher] DB load failed:", (e as Error).message);
    return null;
  }
}

// ── Route plugin ──────────────────────────────────────────────────────────────

export async function researcherRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /researcher/research
   *
   * Run a research query across the configured web search backend (and any
   * corpus documents previously loaded into the ResearchSession).
   *
   * Body: {
   *   query:      string;    — the research question
   *   maxResults?: number;   — cap per source (default: 10, max: 50)
   * }
   *
   * Response includes:
   *   runId          — store this to fetch citations later
   *   synthesis      — prose summary
   *   citations      — flat URL list (backward-compat)
   *   richCitations  — SourceReference[] with keys, titles, snippets, accessedAt
   *   results        — raw SearchResult[]
   *   durationMs
   */
  app.post<{
    Body: { query: string; maxResults?: number };
  }>("/researcher/research", { preHandler: requireAuth }, async (request, reply) => {
    const { query, maxResults = 10 } = request.body;

    if (!query || query.trim() === "") {
      return reply.code(400).send({ error: "query is required" });
    }

    // ResearcherAgent orchestrates the session.research() call via _researchRunner,
    // which captures allResults + durationMs in module-level variables for BM25 reranking.
    const agentResult = await researcherAgent.research(query.trim());
    const rawResults = _capturedAllResults;
    const _agentDurationMs = _capturedDurationMs;

    if (!agentResult.report && rawResults.length === 0) {
      return reply.code(502).send({ error: "Research runner returned no results" });
    }

    // BM25 rerank: score each result against the query using title + snippet as text.
    // Reranked order gives higher recall-precision; we re-map IDs back to the
    // original SearchResult objects so all fields (url, source, score, …) are preserved.
    let orderedResults = rawResults;
    if (rawResults.length > 0) {
      const { documents: rerankedDocs } = await reranker.rerank(
        query,
        rawResults.map((r) => ({
          id: r.url,
          text: `${r.title} ${r.snippet}`,
          score: r.score,
        })),
      );
      const byUrl = new Map(rawResults.map((r) => [r.url, r]));
      orderedResults = rerankedDocs
        .map((d) => {
          const orig = byUrl.get(d.id);
          return orig ? { ...orig, score: d.score } : undefined;
        })
        .filter((r): r is SearchResult => r !== undefined);
    }

    // Build a merged CitationIndex from reranked results
    const index = new CitationIndex();
    const accessedAt = new Date().toISOString();
    orderedResults.slice(0, Math.min(maxResults, 50)).forEach((r) => index.add(r, accessedAt));

    const runId = randomUUID();
    // agentResult.report contains the synthesis text from ResearcherAgent
    const synthesis = agentResult.report || `${rawResults.length} result(s) found for: ${query}`;
    // URL list from agent (also built from allResults, same set)
    const urlCitations = agentResult.sources;

    const record: RunRecord = {
      runId,
      query,
      finding: {
        query,
        results: orderedResults,
        synthesis,
        citations: urlCitations,
        richCitations: index.list(),
        durationMs: _agentDurationMs,
      },
      citations: index.list(),
      createdAt: accessedAt,
    };

    await persistRun(record);

    return reply.code(201).send({
      runId,
      query,
      synthesis,
      citations: urlCitations,
      richCitations: index.list(),
      results: orderedResults.slice(0, Math.min(maxResults, 50)).map((r) => ({
        url: r.url,
        title: r.title,
        snippet: r.snippet,
        score: r.score,
        source: r.source,
      })),
      durationMs: _agentDurationMs,
    });
  });

  /**
   * GET /researcher/academic?query=&limit=
   *
   * Dedicated Semantic Scholar academic paper search.
   * Returns structured paper metadata: title, year, authors, abstract, PDF URL.
   * Does not require TAVILY_API_KEY — uses Semantic Scholar REST API (free tier).
   * Raises throughput with SEMANTIC_SCHOLAR_API_KEY (env).
   *
   * Results are BM25-reranked before return so the most relevant papers rank first.
   */
  app.get<{
    Querystring: { query: string; limit?: string };
  }>("/researcher/academic", { preHandler: requireAuth }, async (request, reply) => {
    const { query, limit: limitStr } = request.query;
    if (!query || query.trim() === "") {
      return reply.code(400).send({ error: "query is required" });
    }
    const limit = Math.min(parseInt(limitStr ?? "10", 10) || 10, 50);

    let papers: SearchResult[];
    try {
      papers = await semanticScholarSearch(query.trim(), limit);
    } catch (err) {
      return reply.code(502).send({
        error: "semantic_scholar_error",
        message: err instanceof Error ? err.message : "Semantic Scholar unavailable",
      });
    }

    // BM25-rerank for query relevance
    let ordered = papers;
    if (papers.length > 0) {
      try {
        const { documents } = await reranker.rerank(
          query,
          papers.map((p) => ({ id: p.url, text: `${p.title} ${p.snippet}`, score: p.score })),
        );
        const byUrl = new Map(papers.map((p) => [p.url, p]));
        ordered = documents
          .map((d) => {
            const orig = byUrl.get(d.id);
            return orig ? { ...orig, score: d.score } : undefined;
          })
          .filter((r): r is SearchResult => r !== undefined);
      } catch {
        /* reranker failure is non-fatal */
      }
    }

    reply.header("Cache-Control", "private, max-age=300, stale-while-revalidate=600");
    return reply.send({
      query,
      total: ordered.length,
      papers: ordered,
      powered_by: "Semantic Scholar (semanticscholar.org)",
    });
  });

  /**
   * GET /researcher/:runId/citations
   *
   * Return the SourceReference[] (richCitations) for a completed research run.
   * Runs expire when the process restarts or the in-process cap (500) is hit.
   */
  app.get<{
    Params: { runId: string };
  }>("/researcher/:runId/citations", { preHandler: requireAuth }, async (request, reply) => {
    const record = await loadRun(request.params.runId);
    if (!record) {
      return reply.code(404).send({ error: `Run '${request.params.runId}' not found` });
    }

    return reply.send({
      runId: record.runId,
      query: record.query,
      createdAt: record.createdAt,
      citations: record.citations,
      total: record.citations.length,
      markdownRef: record.citations
        .map((c) => `${c.citationKey} ${c.title} — <${c.url}>`)
        .join("\n"),
    });
  });
}
