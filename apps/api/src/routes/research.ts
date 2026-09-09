// SPDX-License-Identifier: Apache-2.0
/**
 * Research surface OWNER — extracted from api-bridge.ts (pass 7).
 *
 * All /api/research* routes, the SSE run stream (/research/:id/stream), the
 * related-questions generation, and the research completion/failure
 * notification emitters live here — the whole feature is findable in this one
 * module instead of inside the legacy bridge monolith.
 *
 * Dependency seam: the stream and related-questions paths need a handful of
 * generic helpers that still live in api-bridge.ts (the legacy file uses them
 * across ~30 endpoints, so relocating them would move "everything else"). They
 * are passed in as narrow, explicitly-typed deps (ResearchBridgeDeps) at the
 * registration site inside apiBridgeRoutes. This module never imports the
 * bridge, and api-bridge exports nothing new to enable the extraction.
 *
 * Behavior is identical to the pre-move code: endpoint paths, request/response
 * shapes, SSE event framing/order, per-user auth (requireAuthWithTier),
 * durability write-throughs (start / done / failed + milestone phase events),
 * stale-running recovery (in lib/research-jobs.ts), the empty-query 400, and
 * the withTimeout / AbortSignal stuck-job guards.
 */

import type { LlmRole } from "@nexus/llm-drivers";
import { WebResearcher, type SearchResult as ResearchSearchResult } from "@nexus/researcher";
import type { FastifyInstance } from "fastify";

import { createNotification } from "../lib/notifications-store.js";
import {
  createResearchJob,
  getResearchJob,
  listResearchJobs,
  recordResearchMilestone,
  updateResearchJob,
} from "../lib/research-jobs.js";
import { appendGraphEvent } from "../lib/session-graph.js";
import { requireAuthWithTier } from "../middleware/auth.js";

/** Cap on a single research LLM call — a hung provider must never leave a job `running` forever. */
const RESEARCH_LLM_TIMEOUT_MS = parseInt(process.env.RESEARCH_LLM_TIMEOUT_MS ?? "90000", 10);

/** Reject `p` if it hasn't settled within `ms` — bounds LLM calls that would otherwise hang forever. */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

/** Human labels for the research phases (used by the session graph). */
const PHASE_LABELS: Record<string, string> = {
  planning: "Planning",
  researching: "Researching",
  synthesis: "Synthesis",
  complete: "Complete",
};
function labelOf(phase: string): string {
  return PHASE_LABELS[phase] ?? phase;
}

/** LLM message shape the research paths exchange with the bridge helpers. */
export interface ResearchMessage {
  role: LlmRole;
  content: string;
}

/** Structural driver surface the synthesis step needs (avoids importing the bridge). */
export interface ResearchDriver {
  complete(opts: {
    model: string;
    messages: ResearchMessage[];
    maxTokens: number;
  }): Promise<{ content: string; usage?: { inputTokens?: number; outputTokens?: number } }>;
}

/**
 * Coerce unknown input to a trimmed string. Hostile bodies (arrays, numbers,
 * `{query: 123}`) and duplicated query params (`?q=a&q=b` → array) must
 * degrade to the existing empty-input semantics — 400 / empty questions —
 * never throw a 500 off `.trim()`.
 */
const asTrimmedString = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/**
 * Narrow seam to generic machinery still owned by api-bridge.ts. Passed by the
 * registration site; keeps this module free of bridge imports.
 */
export interface ResearchBridgeDeps {
  /** Default model for internal LLM calls. */
  defaultModel: string;
  /** SSE response headers (text/event-stream …). */
  sseHeaders: Record<string, string>;
  userMsg: (content: string) => ResearchMessage;
  /** Strip markdown code fences then JSON.parse (balanced-span fallback). */
  parseJsonResponse: (content: string) => unknown;
  /** One-shot LLM completion with automatic cost tracking; returns content. */
  llm: (messages: ResearchMessage[], maxTokens: number) => Promise<string>;
  /** Highest-priority available LLM driver across all registered providers. */
  getDefaultDriver: () => ResearchDriver | undefined;
  trackCost: (model: string, usage?: { inputTokens?: number; outputTokens?: number }) => void;
  /** Shared scraper singleton (Tavily-less fallback search). */
  getScraper: () => { scrape(url: string, opts?: { timeout?: number }): Promise<{ text: string }> };
}

/**
 * Register the deep-research endpoints. Called from apiBridgeRoutes (which owns
 * the deps) at the exact point the inline research block used to live — routes
 * land on the same Fastify instance/scope, so auth hooks and framing are
 * unchanged.
 */
export function registerResearchRoutes(app: FastifyInstance, deps: ResearchBridgeDeps): void {
  // ── Deep-research endpoints ───────────────────────────────────────────────
  // Job persistence + reads live in lib/research-jobs.ts (per-user KV store,
  // survives restarts so deep links and history don't 404). This module only
  // delegates to the store — it owns the routes, the stream, and the emitters.

  app.get("/research", { preHandler: requireAuthWithTier }, async (request, reply) => {
    // Wrapped in {jobs} — deep-research.tsx's history sidebar reads data.jobs.
    return reply.send({ jobs: await listResearchJobs(request.nexusUserId) });
  });

  app.post<{ Body: { query: string; mode?: string } }>(
    "/research",
    { preHandler: requireAuthWithTier },
    async (request, reply) => {
      // Reject empty queries — a durable record with no query can never run
      // and would linger as a phantom `running` job in history.
      const query = asTrimmedString(request.body?.query);
      if (!query)
        return reply.code(400).send({ error: "query_required", message: "query is required" });
      const job = await createResearchJob(request.nexusUserId, query);
      return reply.code(201).send({ id: job.id, status: job.status });
    },
  );

  // Deterministic fallback so related questions are useful even without an LLM
  // key / a working model (deep-research.tsx renders them as follow-up chips).
  const relatedQuestionsFor = async (topic: string): Promise<string[]> => {
    try {
      const out = await withTimeout(
        deps.llm(
          [
            deps.userMsg(
              `Generate 5 concise related follow-up research questions about "${topic}". ` +
                `Reply with JSON only: {"questions":["..."]}.`,
            ),
          ],
          300,
        ),
        RESEARCH_LLM_TIMEOUT_MS,
        "Related questions",
      );
      const p = deps.parseJsonResponse(out) as { questions?: string[] };
      const qs = Array.isArray(p.questions) ? p.questions.filter((q) => q && q !== "...") : [];
      if (qs.length > 0) return qs.slice(0, 5);
    } catch {
      /* fall through to template */
    }
    const t = topic.length > 120 ? `${topic.slice(0, 120)}…` : topic;
    return [
      `What are the key considerations for ${t}?`,
      `How does ${t} compare to the main alternatives?`,
      `What are the common pitfalls when working with ${t}?`,
      `What does recent evidence say about ${t}?`,
      `What are the next steps to apply ${t} in practice?`,
    ];
  };

  app.get<{ Querystring: { q?: string; topic?: string } }>(
    "/research/related-questions",
    async (request, reply) => {
      const topic = asTrimmedString(request.query.q ?? request.query.topic);
      if (!topic) return reply.send({ questions: [] });
      return reply.send({ questions: await relatedQuestionsFor(topic) });
    },
  );

  // POST variant — deep-research.tsx sends { query, report_summary } in the body.
  app.post<{ Body: { query?: string; report_summary?: string } }>(
    "/research/related-questions",
    async (request, reply) => {
      const topic = asTrimmedString(request.body?.query);
      if (!topic) return reply.send({ questions: [] });
      return reply.send({ questions: await relatedQuestionsFor(topic) });
    },
  );

  app.get<{ Params: { id: string } }>(
    "/research/:id",
    { preHandler: requireAuthWithTier },
    async (request, reply) => {
      const job = await getResearchJob(request.nexusUserId, request.params.id);
      if (!job) return reply.code(404).send({ error: "not_found" });
      return reply.send(job);
    },
  );

  app.get<{ Params: { id: string } }>(
    "/research/:id/stream",
    { preHandler: requireAuthWithTier },
    async (request, reply) => {
      const job = await getResearchJob(request.nexusUserId, request.params.id);
      // Status before this run — re-streaming an already-finished job re-runs the
      // research below, and must not push a second completion notification.
      const priorStatus = job?.status;
      reply.hijack();
      // Milestone write-through: mark the run started (bounded KV write, never
      // blocks the SSE handshake).
      if (job) void updateResearchJob(request.nexusUserId, job.id, { status: "running" });
      const raw = reply.raw;
      raw.writeHead(200, deps.sseHeaders);
      const write = (d: unknown) => {
        if (!raw.destroyed) raw.write(`data: ${JSON.stringify(d)}\n\n`);
      };
      const query = job?.query ?? "unknown query";

      // Zero-cost session spider-graph: record the pipeline's structure from
      // events that already flow here — no extra LLM call is ever made to
      // write memory (see lib/session-graph.ts). Fire-and-forget: never
      // delays the SSE stream.
      const sessionId = `research:${job?.id ?? "unknown"}`;
      if (job) {
        void appendGraphEvent(request.nexusUserId, sessionId, "research", {
          title: query.slice(0, 200),
          node: {
            id: "user",
            kind: "user",
            label: "Research query",
            detail: query.slice(0, 300),
            link: `/deep-research?id=${job.id}`,
          },
        });
      }

      // The UI consumes phase_start/phase_done/citation/report/done events —
      // the old handler emitted phase/result which nothing rendered, leaving
      // the page on "Starting…" forever after the backend finished.
      // Persist each phase transition into the durable job record (fire-and-
      // forget — never delays the SSE stream). The record is the source of
      // truth, so a reload mid-run shows real progress instead of a bare
      // "running" and a crash leaves the last reached phase on the record.
      const persistMilestone = (
        phase: string,
        patch: { startedAt?: string; finishedAt?: string; detail?: string; cycleIndex?: number },
      ) => {
        if (!job) return;
        void recordResearchMilestone(request.nexusUserId, job.id, phase, patch);
      };
      const phaseStart = (phase: string, label: string, detail?: string) => {
        write({ type: "phase_start", stepId: phase, phase, label, detail });
        persistMilestone(phase, { startedAt: new Date().toISOString(), detail: label });
        void appendGraphEvent(request.nexusUserId, sessionId, "research", {
          node: { id: `phase:${phase}:start`, kind: "phase", label, detail },
          edge: { from: "last", to: `phase:${phase}:start` },
        });
      };
      const phaseDone = (phase: string, detail?: string, cycleIndex?: number) => {
        write({ type: "phase_done", stepId: phase, phase, detail, cycleIndex });
        persistMilestone(phase, { finishedAt: new Date().toISOString(), detail, cycleIndex });
        void appendGraphEvent(request.nexusUserId, sessionId, "research", {
          node: {
            id: `phase:${phase}:done`,
            kind: "milestone",
            label: `${labelOf(phase)} complete`,
            detail,
          },
          edge: { from: "last", to: `phase:${phase}:done` },
        });
      };
      const emitCitations = (results: ResearchSearchResult[]) => {
        const seen = new Set<string>();
        results.forEach((r, i) => {
          if (seen.has(r.url)) return;
          seen.add(r.url);
          void appendGraphEvent(request.nexusUserId, sessionId, "research", {
            node: {
              id: `citation:${i}`,
              kind: "citation",
              label: (r.title ?? r.url).slice(0, 120),
              link: r.url,
            },
            edge: { from: "last", to: `citation:${i}` },
          });
          write({
            type: "citation",
            id: `c-${i}`,
            title: r.title ?? r.url,
            url: r.url,
            excerpt: r.snippet ?? "",
            cycleIndex: 0,
          });
        });
      };

      phaseStart("planning", "Planning research scope");

      // Build searchFn — use Tavily if key is present, else scraper-based search
      const tavilyKey = process.env.TAVILY_API_KEY;
      const searchFn = tavilyKey
        ? async (q: string): Promise<ResearchSearchResult[]> => {
            phaseStart("researching", `Searching Tavily for: "${q}"`);
            const r = await fetch("https://api.tavily.com/search", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ api_key: tavilyKey, query: q, max_results: 6 }),
              // Same stuck-job guard as the synthesis call — a hung upstream must
              // fail the phase, not leave the job `running` forever.
              signal: AbortSignal.timeout(15_000),
            });
            if (!r.ok) {
              phaseDone("researching", "Tavily request failed", 0);
              return [];
            }
            const data = (await r.json()) as {
              results?: { url: string; title?: string; content?: string; score?: number }[];
            };
            const mapped = (data.results ?? []).map((x) => ({
              url: x.url,
              title: x.title ?? x.url,
              snippet: x.content ?? "",
              score: x.score ?? 0,
              source: "web" as const,
            }));
            phaseDone("researching", `${mapped.length} sources found`, 0);
            return mapped;
          }
        : async (q: string): Promise<ResearchSearchResult[]> => {
            phaseStart("researching", `Searching the web for: "${q}"`);
            // Fallback: search DuckDuckGo HTML (no key needed) and parse result URLs
            try {
              const html = await deps
                .getScraper()
                .scrape(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, {
                  timeout: 10_000,
                });
              const urls = [...html.text.matchAll(/https?:\/\/[^\s"')>]+/g)]
                .map((m) => m[0])
                .filter((u) => !u.includes("duckduckgo"))
                .slice(0, 4);
              phaseDone("researching", `${urls.length} sources found`, 0);
              return urls.map((url) => ({
                url,
                title: url,
                snippet: "",
                score: 0.5,
                source: "web" as const,
              }));
            } catch {
              phaseDone("researching", "search failed", 0);
              return [];
            }
          };

      // Usage of the synthesis call — captured for the job's persisted stats.
      let synthesisUsage: { inputTokens?: number; outputTokens?: number } | undefined;

      // Build synthesizeFn — use first available LLM driver
      const synthesizeFn = async (q: string, results: ResearchSearchResult[]): Promise<string> => {
        phaseStart("synthesis", "Synthesising findings with LLM");
        const driver = deps.getDefaultDriver();
        if (!driver || results.length === 0) {
          return results.length > 0
            ? `Found ${results.length} results for "${q}". Top source: ${results[0]?.url}`
            : `No results found for "${q}". Configure TAVILY_API_KEY for web search.`;
        }
        const context = results
          .slice(0, 5)
          .map((r) => `Source: ${r.url}\n${r.snippet}`)
          .join("\n\n");
        // Bounded — a hung provider used to leave the job `running` forever.
        const res = await withTimeout(
          driver.complete({
            model: deps.defaultModel,
            messages: [
              {
                role: "system" as LlmRole,
                content:
                  "You are a research assistant. Synthesise the provided search results into a clear, factual summary.",
              },
              {
                role: "user" as LlmRole,
                content: `Research question: ${q}\n\nSearch results:\n${context}\n\nProvide a concise synthesis.`,
              },
            ],
            maxTokens: 1024,
          }),
          RESEARCH_LLM_TIMEOUT_MS,
          "Research synthesis",
        );
        synthesisUsage = res.usage;
        deps.trackCost(deps.defaultModel, res.usage);
        return res.content;
      };

      try {
        const researcher = new WebResearcher({ searchFn, synthesizeFn, maxResults: 6 });
        const finding = await researcher.research(query);
        emitCitations(finding.results);
        phaseDone("synthesis", undefined, 0);
        phaseStart("complete", "Research complete");
        // Write-through on completion: the persisted record is the single source
        // for deep links / history — the dashboard and /deep-research?id= read
        // this, not process memory.
        if (job) {
          await updateResearchJob(request.nexusUserId, job.id, {
            status: "done",
            result: finding.synthesis,
            report: finding.synthesis,
            sources: finding.results.map((r) => ({
              url: r.url,
              title: r.title ?? r.url,
              snippet: r.snippet ?? "",
              score: r.score ?? 0,
              source: r.source,
            })),
            citations: finding.results.map((r, i) => ({
              id: `c-${i}`,
              title: r.title ?? r.url,
              url: r.url,
              excerpt: r.snippet ?? "",
              cycleIndex: 0,
            })),
            cycles: 1,
            durationMs: finding.durationMs,
            stats: {
              requests: 1,
              tokens: (synthesisUsage?.inputTokens ?? 0) + (synthesisUsage?.outputTokens ?? 0),
            },
          });
          // Related questions belong to the job record (deep-link fidelity) but
          // must not slow the stream — generated in the background, bounded by
          // the RESEARCH_LLM_TIMEOUT_MS guard, best-effort write-through.
          void relatedQuestionsFor(query).then((qs) => {
            if (qs.length > 0) {
              void updateResearchJob(request.nexusUserId, job.id, { relatedQuestions: qs });
            }
          });
        }
        write({ type: "report", content: finding.synthesis });
        void appendGraphEvent(request.nexusUserId, sessionId, "research", {
          node: {
            id: "report",
            kind: "report",
            label: "Report ready",
            detail: `${finding.synthesis.length} chars`,
            link: `/deep-research?id=${job?.id}`,
          },
          edge: { from: "last", to: "report" },
        });
        write({ type: "done", totalMs: finding.durationMs });
        void appendGraphEvent(request.nexusUserId, sessionId, "research", {
          node: {
            id: "done",
            kind: "milestone",
            label: "Research complete",
            detail: `${finding.durationMs}ms`,
            link: `/deep-research?id=${job?.id}`,
          },
          edge: { from: "last", to: "done" },
        });
        if (job && priorStatus !== "done") {
          await createNotification(request.nexusUserId, {
            type: "research",
            title: "Research complete",
            message: `“${query.length > 90 ? `${query.slice(0, 90)}…` : query}” — report ready`,
            link: `/deep-research?id=${job.id}`,
          });
        }
      } catch (err) {
        if (job) {
          // Write-through on failure — the error state survives restarts too.
          await updateResearchJob(request.nexusUserId, job.id, {
            status: "error",
            error: String(err).slice(0, 2000),
          });
          if (priorStatus !== "error") {
            await createNotification(request.nexusUserId, {
              type: "research",
              title: "Research failed",
              message: `“${query.length > 90 ? `${query.slice(0, 90)}…` : query}” — ${String(err).slice(0, 160)}`,
              link: `/deep-research?id=${job.id}`,
            });
          }
        }
        void appendGraphEvent(request.nexusUserId, sessionId, "research", {
          node: {
            id: "error",
            kind: "error",
            label: "Research failed",
            detail: String(err).slice(0, 300),
            link: `/deep-research?id=${job?.id}`,
          },
          edge: { from: "last", to: "error" },
        });
        write({ type: "error", message: String(err) });
      }
      raw.end();
    },
  );
}
