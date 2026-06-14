// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/adapter-deep-research — Iterative deep research pipeline.
 *
 * Pipeline
 * --------
 *   1. Planner   (llama-3.3-70b) — decompose topic into parallel search queries
 *   2. Search    (Tavily)         — execute all queries in parallel
 *   3. Evaluator (llama-3.1-8b)  — identify knowledge gaps in gathered evidence
 *   4. Re-search (Tavily)         — fill gaps with targeted follow-up queries
 *   5. Synthesizer (llama-3.3-70b) — produce a cited Markdown report
 *
 * Env vars required on the execution context:
 *   GROQ_API_KEY    — Groq API key
 *   TAVILY_API_KEY  — Tavily search API key
 *
 * Task type: "deep-research.run"
 */

import { defineAdapter, requireEnv, AdapterHttpError, type IExecutionContext } from "@nexus/plugin-sdk";

// ── External API constants ────────────────────────────────────────────────────

const GROQ_API = "https://api.groq.com/openai/v1/chat/completions";
const TAVILY_API = "https://api.tavily.com/search";

const MODEL_LARGE = "llama-3.3-70b-versatile";
const MODEL_FAST = "llama-3.1-8b-instant";

// ── Public types ──────────────────────────────────────────────────────────────

export interface DeepResearchTask {
  taskType: "deep-research.run";
  /** The research topic or question */
  query: string;
  /**
   * Max gap-fill iterations after the initial search round (default: 2).
   * Each iteration fires targeted follow-up searches for identified gaps.
   */
  maxIterations?: number;
  /** Tavily results per query (default: 5, max: 10) */
  resultsPerQuery?: number;
}

export interface ResearchCitation {
  /** 1-based citation index, matching [N] markers in the report */
  index: number;
  title: string;
  url: string;
  /** Short snippet from the source */
  snippet: string;
}

export interface ResearchIteration {
  iteration: number;
  /** Search queries issued this round */
  queries: string[];
  /** Number of new unique sources retrieved */
  newSourceCount: number;
}

export interface DeepResearchResult {
  ok: boolean;
  /** Full Markdown report with inline [N] citations */
  report: string;
  citations: ResearchCitation[];
  iterations: ResearchIteration[];
  totalSources: number;
  totalLatencyMs: number;
  tokenUsage: { promptTokens: number; completionTokens: number };
  error?: string;
}

// ── Internal types ────────────────────────────────────────────────────────────

interface GroqChatResponse {
  choices: { message: { content: string | null } }[];
  usage?: { prompt_tokens: number; completion_tokens: number };
}

interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score: number;
}

interface TavilyResponse {
  results: TavilyResult[];
  answer?: string;
}

interface GatheredSource {
  title: string;
  url: string;
  snippet: string;
}

// ── Groq helper ───────────────────────────────────────────────────────────────

async function callGroq(
  systemPrompt: string,
  userContent: string,
  model: string,
  apiKey: string,
  maxTokens = 2048,
  temperature = 0.3,
): Promise<{ content: string; promptTokens: number; completionTokens: number }> {
  const res = await fetch(GROQ_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Groq API error ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = (await res.json()) as GroqChatResponse;
  return {
    content: data.choices[0]?.message?.content ?? "",
    promptTokens: data.usage?.prompt_tokens ?? 0,
    completionTokens: data.usage?.completion_tokens ?? 0,
  };
}

// ── Tavily search helper ──────────────────────────────────────────────────────

async function searchTavily(
  query: string,
  apiKey: string,
  maxResults: number,
): Promise<TavilyResult[]> {
  const res = await fetch(TAVILY_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      search_depth: "basic",
      include_answer: false,
      max_results: maxResults,
      include_domains: [],
      exclude_domains: [],
    }),
  });

  if (!res.ok) {
    throw new AdapterHttpError("nexus-adapter-deep-research", res.status, await res.text());
  }

  const data = (await res.json()) as TavilyResponse;
  return data.results ?? [];
}

// ── Query parser ──────────────────────────────────────────────────────────────

function parseQueries(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => line.replace(/^\s*\d+[.)]\s*/, "").trim())
    .filter((line) => line.length > 0)
    .slice(0, 8); // safety cap
}

// ── Gap parser ────────────────────────────────────────────────────────────────

function parseGaps(raw: string): string[] {
  const noGapPattern = /no gaps?|none|sufficient|covered|adequate/i;
  if (noGapPattern.test(raw)) return [];
  return raw
    .split("\n")
    .map((line) => line.replace(/^\s*[\d]+[.)]\s*/, "").replace(/^[-•*]\s*/, "").trim())
    .filter((line) => line.length > 8) // ignore trivially short lines
    .slice(0, 5); // max 5 gap queries per iteration
}

// ── Source deduplication ──────────────────────────────────────────────────────

function mergeSources(existing: GatheredSource[], newResults: TavilyResult[]): GatheredSource[] {
  const seenUrls = new Set(existing.map((s) => s.url));
  const added: GatheredSource[] = [];

  for (const r of newResults) {
    if (!seenUrls.has(r.url)) {
      seenUrls.add(r.url);
      added.push({
        title: r.title ?? "Untitled",
        url: r.url,
        snippet: (r.content ?? "").slice(0, 400),
      });
    }
  }

  return [...existing, ...added];
}

// ── Evidence formatter (for LLM context) ─────────────────────────────────────

function formatEvidence(sources: GatheredSource[]): string {
  return sources
    .map(
      (s, i) =>
        `[${i + 1}] ${s.title}\nURL: ${s.url}\nSnippet: ${s.snippet}`,
    )
    .join("\n\n");
}

// ── System prompts ────────────────────────────────────────────────────────────

const PLANNER_SYSTEM = [
  "You are an expert research librarian.",
  "Given a research topic, generate 3-6 specific, distinct search queries that together",
  "will comprehensively cover all major aspects of the topic.",
  "Format your response as a numbered list, one query per line.",
  "Output ONLY the numbered list — no preamble, no explanation.",
].join(" ");

const EVALUATOR_SYSTEM = [
  "You are a rigorous academic research evaluator.",
  "Given a research topic and collected evidence, identify the most important knowledge gaps",
  "that are NOT yet covered by the evidence.",
  "List each gap as a short, targeted search query (1 sentence each).",
  "Format: numbered list, one gap/query per line.",
  "If the evidence is already comprehensive, respond with exactly: 'No gaps.'",
  "Output ONLY the list or 'No gaps.' — no preamble.",
].join(" ");

const SYNTHESIZER_SYSTEM = [
  "You are an expert research analyst and writer.",
  "Given a research topic and collected evidence with source numbers [N],",
  "write a comprehensive, well-structured Markdown report.",
  "Requirements:",
  "- Use ## headings to organize major sections",
  "- Cite sources inline as [N] where N matches the evidence numbering",
  "- Every factual claim must have at least one citation",
  "- End with a '## Summary' section",
  "- Be objective, precise, and thorough",
  "Output ONLY the Markdown report.",
].join(" ");

// ── Main pipeline ─────────────────────────────────────────────────────────────

export async function runDeepResearch(
  task: DeepResearchTask,
  groqKey: string,
  tavilyKey: string,
): Promise<DeepResearchResult> {
  const start = Date.now();
  const maxIter = task.maxIterations ?? 2;
  const resultsPerQuery = Math.min(task.resultsPerQuery ?? 5, 10);

  const totalUsage = { promptTokens: 0, completionTokens: 0 };
  const iterationRecords: ResearchIteration[] = [];
  let sources: GatheredSource[] = [];

  function addUsage(u: { promptTokens: number; completionTokens: number }): void {
    totalUsage.promptTokens += u.promptTokens;
    totalUsage.completionTokens += u.completionTokens;
  }

  // ── Step 1: Plan initial queries ─────────────────────────────────────────

  const planResult = await callGroq(
    PLANNER_SYSTEM,
    `Research topic: ${task.query}`,
    MODEL_LARGE,
    groqKey,
    512,
    0.4,
  );
  addUsage(planResult);

  const initialQueries = parseQueries(planResult.content);

  // ── Step 2: Initial parallel search ──────────────────────────────────────

  const initialResults = await Promise.all(
    initialQueries.map((q) => searchTavily(q, tavilyKey, resultsPerQuery)),
  );

  const allInitialResults = initialResults.flat();
  sources = mergeSources([], allInitialResults);

  iterationRecords.push({
    iteration: 0,
    queries: initialQueries,
    newSourceCount: sources.length,
  });

  // ── Steps 3-N: Gap evaluation → re-search ────────────────────────────────

  for (let iter = 1; iter <= maxIter; iter++) {
    const evalResult = await callGroq(
      EVALUATOR_SYSTEM,
      [
        `Research topic: ${task.query}`,
        `\nEvidence collected so far:\n${formatEvidence(sources)}`,
      ].join("\n"),
      MODEL_FAST,
      groqKey,
      512,
      0.2,
    );
    addUsage(evalResult);

    const gapQueries = parseGaps(evalResult.content);

    if (gapQueries.length === 0) break; // no gaps — done early

    const gapResults = await Promise.all(
      gapQueries.map((q) => searchTavily(q, tavilyKey, resultsPerQuery)),
    );

    const prevCount = sources.length;
    sources = mergeSources(sources, gapResults.flat());

    iterationRecords.push({
      iteration: iter,
      queries: gapQueries,
      newSourceCount: sources.length - prevCount,
    });
  }

  // ── Step 4: Synthesize report ─────────────────────────────────────────────

  const synthResult = await callGroq(
    SYNTHESIZER_SYSTEM,
    [
      `Research topic: ${task.query}`,
      `\n\nEvidence (${sources.length} sources):\n${formatEvidence(sources)}`,
    ].join("\n"),
    MODEL_LARGE,
    groqKey,
    4096,
    0.5,
  );
  addUsage(synthResult);

  const citations: ResearchCitation[] = sources.map((s, i) => ({
    index: i + 1,
    title: s.title,
    url: s.url,
    snippet: s.snippet,
  }));

  return {
    ok: true,
    report: synthResult.content.trim(),
    citations,
    iterations: iterationRecords,
    totalSources: sources.length,
    totalLatencyMs: Date.now() - start,
    tokenUsage: totalUsage,
  };
}

// ── Adapter wiring ────────────────────────────────────────────────────────────

async function execute(
  task: DeepResearchTask,
  ctx: IExecutionContext,
): Promise<DeepResearchResult> {
  const groqKey = requireEnv(ctx, "GROQ_API_KEY");
  const tavilyKey = requireEnv(ctx, "TAVILY_API_KEY");

  ctx.logger.info("deep-research.run", { query: task.query });

  return runDeepResearch(task, groqKey, tavilyKey);
}

export const deepResearchAdapter = defineAdapter<DeepResearchTask, DeepResearchResult>({
  name: "nexus-adapter-deep-research",
  version: "0.1.0",
  capabilities: ["search.web", "llm.inference"],
  taskTypes: ["deep-research.run"],
  execute,
});

export default deepResearchAdapter;
