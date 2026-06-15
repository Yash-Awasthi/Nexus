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

import {
  CitationIndex,
  ResearchSession,
  WebResearcher,
  type SearchResult,
  type ResearchFinding,
} from "@nexus/researcher";
import { randomUUID } from "crypto";
import type { FastifyInstance } from "fastify";

import { requireAuth } from "../middleware/auth.js";

// ── Search backend factory ────────────────────────────────────────────────────

type WebSearchFn = (query: string) => Promise<SearchResult[]>;

function buildSearchFn(): WebSearchFn {
  // ── Tavily ──────────────────────────────────────────────────────────────────
  if (process.env.TAVILY_API_KEY) {
    const apiKey = process.env.TAVILY_API_KEY;
    return async (query: string): Promise<SearchResult[]> => {
      const res = await fetch("https://api.tavily.com/search", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          api_key:        apiKey,
          query,
          search_depth:   "basic",
          max_results:    10,
          include_answer: false,
        }),
      });
      if (!res.ok) throw new Error(`Tavily error: ${res.status}`);
      const data = await res.json() as {
        results?: Array<{ url: string; title: string; content: string; score?: number }>;
      };
      return (data.results ?? []).map((r) => ({
        url:     r.url,
        title:   r.title,
        snippet: r.content?.slice(0, 300) ?? "",
        score:   r.score ?? 0.8,
        source:  "web" as const,
      }));
    };
  }

  // ── SearXNG ─────────────────────────────────────────────────────────────────
  if (process.env.SEARXNG_URL) {
    const base = process.env.SEARXNG_URL.replace(/\/$/, "");
    return async (query: string): Promise<SearchResult[]> => {
      const url = `${base}/search?q=${encodeURIComponent(query)}&format=json&engines=google,bing`;
      const res = await fetch(url, { headers: { "Accept": "application/json" } });
      if (!res.ok) throw new Error(`SearXNG error: ${res.status}`);
      const data = await res.json() as {
        results?: Array<{ url: string; title: string; content?: string; score?: number }>;
      };
      return (data.results ?? []).slice(0, 10).map((r, i) => ({
        url:     r.url,
        title:   r.title,
        snippet: r.content?.slice(0, 300) ?? "",
        score:   r.score ?? (1 - i * 0.05),
        source:  "web" as const,
      }));
    };
  }

  // ── NoopSearchBackend (deterministic placeholder) ───────────────────────────
  return async (query: string): Promise<SearchResult[]> => [
    {
      url:     `https://example.com/search?q=${encodeURIComponent(query)}`,
      title:   `[Noop] Results for: ${query}`,
      snippet: `Set TAVILY_API_KEY or SEARXNG_URL to enable real web search. Query: ${query}`,
      score:   0.5,
      source:  "web" as const,
    },
  ];
}

// ── Singleton researcher ──────────────────────────────────────────────────────

const searchFn = buildSearchFn();

const session = new ResearchSession({
  webResearcher: new WebResearcher({ searchFn, maxResults: 10 }),
  dedupByUrl: true,
});

// ── In-process run store (cap: 500 entries) ───────────────────────────────────

interface RunRecord {
  runId:      string;
  query:      string;
  finding:    ResearchFinding;
  citations:  ReturnType<CitationIndex["list"]>;
  createdAt:  string;
}

const runStore = new Map<string, RunRecord>();
const RUN_CAP = 500;

function storeRun(record: RunRecord): void {
  if (runStore.size >= RUN_CAP) {
    // Evict oldest
    const oldest = runStore.keys().next().value;
    if (oldest) runStore.delete(oldest);
  }
  runStore.set(record.runId, record);
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

    const combined = await session.research(query.trim());

    // Build a merged CitationIndex from all result sources
    const index = new CitationIndex();
    const accessedAt = new Date().toISOString();
    combined.allResults.slice(0, Math.min(maxResults, 50)).forEach((r) => index.add(r, accessedAt));

    const runId    = randomUUID();
    const synthesis =
      combined.webFindings?.synthesis ??
      combined.corpusFindings?.synthesis ??
      `${combined.allResults.length} result(s) found for: ${query}`;

    const record: RunRecord = {
      runId,
      query,
      finding: {
        query,
        results:      combined.allResults,
        synthesis,
        citations:    combined.citations,
        richCitations: index.list(),
        durationMs:   combined.durationMs,
      },
      citations: index.list(),
      createdAt: accessedAt,
    };

    storeRun(record);

    return reply.code(201).send({
      runId,
      query,
      synthesis,
      citations:     combined.citations,
      richCitations: index.list(),
      results:       combined.allResults.slice(0, Math.min(maxResults, 50)).map((r) => ({
        url:    r.url,
        title:  r.title,
        snippet: r.snippet,
        score:  r.score,
        source: r.source,
      })),
      durationMs:    combined.durationMs,
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
    const record = runStore.get(request.params.runId);
    if (!record) {
      return reply.code(404).send({ error: `Run '${request.params.runId}' not found` });
    }

    return reply.send({
      runId:      record.runId,
      query:      record.query,
      createdAt:  record.createdAt,
      citations:  record.citations,
      total:      record.citations.length,
      markdownRef: new CitationIndex().toMarkdown !== undefined
        ? record.citations.map((c) => `${c.citationKey} ${c.title} — <${c.url}>`).join("\n")
        : "",
    });
  });
}
