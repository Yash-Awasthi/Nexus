/**
 * WebSearchEngine — agentic web search + answer synthesis.
 *
 * Pipeline:
 *   1. classify()   — determine search mode, skip-search, source types
 *   2. research()   — iterative search → scrape → relevance ranking
 *   3. synthesize() — LLM writer produces a cited answer from findings
 *
 * Uses:
 *   - Tavily API for web search (TAVILY_API_KEY env var or explicit key)
 *   - Stealth scraping bridge (optional) for deep content extraction
 *   - ILanguageModel for classification + synthesis
 */

import * as https from "https";
import { ILanguageModel, ChatMessage } from "./interfaces/language-model.interface";
import { getBridgeManager, BridgeManager } from "../runtime/bridge-manager";

// ─── Types ────────────────────────────────────────────────────────────────────

export type SearchMode = "speed" | "balanced" | "quality";

export interface SearchResult {
  title: string;
  url: string;
  content: string;
  score?: number;
}

export interface SearchFinding {
  title: string;
  url: string;
  content: string;
}

export interface WebSearchOutput {
  answer: string;
  findings: SearchFinding[];
  queriesUsed: string[];
  mode: SearchMode;
  skippedSearch: boolean;
}

export interface SearchClassification {
  skipSearch: boolean;
  webSearch: boolean;
  academicSearch: boolean;
  discussionSearch: boolean;
  standaloneQuery: string;
}

export interface SearchEngineOptions {
  llm: ILanguageModel;
  tavilyApiKey?: string;
  /** Max web search iterations per research run */
  maxIterations?: number;
  /** Attempt to deep-scrape top results via the stealth scraping bridge */
  deepScrape?: boolean;
}

// ─── Tavily search client ─────────────────────────────────────────────────────

async function tavilySearch(
  queries: string[],
  apiKey: string,
  opts: { searchDepth?: "basic" | "advanced"; maxResults?: number } = {}
): Promise<SearchResult[]> {
  const results: SearchResult[] = [];
  for (const query of queries) {
    try {
      const body = JSON.stringify({
        api_key: apiKey,
        query,
        search_depth: opts.searchDepth ?? "basic",
        max_results: opts.maxResults ?? 5,
        include_answer: false,
        include_raw_content: false
      });
      const raw = await new Promise<string>((resolve, reject) => {
        const req = https.request(
          {
            hostname: "api.tavily.com",
            path: "/search",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(body)
            }
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
          }
        );
        req.on("error", reject);
        req.write(body);
        req.end();
      });
      const parsed = JSON.parse(raw);
      if (parsed?.results) {
        for (const r of parsed.results) {
          results.push({
            title: r.title ?? "",
            url: r.url ?? "",
            content: r.content ?? r.snippet ?? "",
            score: r.score ?? 1
          });
        }
      }
    } catch {
      // Tavily failure — skip this query
    }
  }
  // Deduplicate by URL
  const seen = new Set<string>();
  return results.filter((r) => {
    if (seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });
}

// ─── Classification ───────────────────────────────────────────────────────────

const CLASSIFIER_PROMPT = `You are a search query classifier. Given a user query and conversation history, determine:
1. Whether to skip web search (answer from knowledge alone)
2. What type of search is needed
3. A standalone reformulation of the query (self-contained, no pronouns referencing prior turns)

Respond as JSON with this exact shape:
{
  "skipSearch": boolean,
  "webSearch": boolean,
  "academicSearch": boolean,
  "discussionSearch": boolean,
  "standaloneQuery": string
}

Skip search for: greetings, simple math, basic definitions you are certain about, conversational responses.
Use academic search for: research papers, scientific topics, technical studies.
Use discussion search for: opinions, recommendations, community experience.
Use web search for: news, current events, product info, anything requiring recent data.`;

async function classify(
  llm: ILanguageModel,
  query: string,
  history: ChatMessage[]
): Promise<SearchClassification> {
  try {
    const result = await llm.generateObject<SearchClassification>({
      messages: [
        { role: "system", content: CLASSIFIER_PROMPT },
        ...history.slice(-4),
        { role: "user", content: query }
      ],
      schema: {
        type: "object",
        properties: {
          skipSearch: { type: "boolean" },
          webSearch: { type: "boolean" },
          academicSearch: { type: "boolean" },
          discussionSearch: { type: "boolean" },
          standaloneQuery: { type: "string" }
        },
        required: ["skipSearch", "webSearch", "standaloneQuery"]
      }
    });
    return {
      skipSearch: result.skipSearch ?? false,
      webSearch: result.webSearch ?? true,
      academicSearch: result.academicSearch ?? false,
      discussionSearch: result.discussionSearch ?? false,
      standaloneQuery: result.standaloneQuery ?? query
    };
  } catch {
    return { skipSearch: false, webSearch: true, academicSearch: false, discussionSearch: false, standaloneQuery: query };
  }
}

// ─── Research loop ────────────────────────────────────────────────────────────

const RESEARCHER_PROMPT = (iteration: number, maxIter: number) => `You are a research agent. Your job is to generate targeted search queries to gather information.
This is iteration ${iteration + 1} of ${maxIter}.
${iteration === 0 ? "Start with broad queries to understand the topic." : "Narrow down based on previous findings — look for gaps."}
${iteration >= maxIter - 1 ? "This is your last chance — generate the most targeted queries possible." : ""}

Generate 1-3 focused search queries. Respond as JSON:
{"queries": ["query1", "query2", "query3"]}

Queries should be SEO-style keywords, not full sentences.`;

async function research(
  llm: ILanguageModel,
  query: string,
  classification: SearchClassification,
  apiKey: string,
  opts: { maxIterations: number; mode: SearchMode; deepScrape: boolean }
): Promise<{ findings: SearchFinding[]; queriesUsed: string[] }> {
  const findings: SearchFinding[] = [];
  const queriesUsed: string[] = [];
  const conversationHistory: ChatMessage[] = [
    { role: "user", content: classification.standaloneQuery }
  ];

  const maxIter = opts.mode === "speed" ? 1 : opts.mode === "balanced" ? 2 : opts.maxIterations;

  for (let i = 0; i < maxIter; i++) {
    // Generate queries for this iteration
    let queries: string[] = [classification.standaloneQuery];
    try {
      const qResult = await llm.generateObject<{ queries: string[] }>({
        messages: [
          { role: "system", content: RESEARCHER_PROMPT(i, maxIter) },
          ...conversationHistory,
          ...(findings.length > 0
            ? [{
                role: "assistant" as const,
                content: `Previous findings summary:\n${findings.slice(-3).map((f) => `- ${f.title}: ${f.content.slice(0, 200)}`).join("\n")}`
              }]
            : [])
        ],
        schema: { type: "object", properties: { queries: { type: "array", items: { type: "string" } } } }
      });
      if (Array.isArray(qResult?.queries) && qResult.queries.length > 0) {
        queries = qResult.queries.slice(0, 3);
      }
    } catch {
      // fallback to original query
    }

    queriesUsed.push(...queries);

    // Execute searches
    const results = await tavilySearch(queries, apiKey, {
      searchDepth: opts.mode === "quality" ? "advanced" : "basic",
      maxResults: opts.mode === "speed" ? 3 : 5
    });

    // Deep scrape top results in quality mode
    if (opts.deepScrape && opts.mode === "quality" && results.length > 0) {
      const topResults = results.slice(0, 2);
      for (const result of topResults) {
        try {
          const mgr = getBridgeManager();
          if (mgr.isRunning("scraping")) {
            const baseUrl = await mgr.url("scraping");
            const scraped = await BridgeManager.post<{
              success: boolean;
              text: string;
            }>(baseUrl, "/fetch", { url: result.url, timeout: 15_000 });
            if (scraped.success && scraped.text) {
              result.content = scraped.text.slice(0, 2000);
            }
          }
        } catch {
          // scraping failed — use snippet
        }
      }
    }

    // Add to findings (deduplicate by URL)
    const existingUrls = new Set(findings.map((f) => f.url));
    for (const r of results) {
      if (!existingUrls.has(r.url)) {
        findings.push({ title: r.title, url: r.url, content: r.content });
        existingUrls.add(r.url);
      }
    }

    // Build context for next iteration
    conversationHistory.push({
      role: "assistant",
      content: `Search results for [${queries.join(", ")}]:\n${results.map((r) => `${r.title}: ${r.content.slice(0, 300)}`).join("\n")}`
    });

    if (findings.length >= 10) break;
  }

  return { findings, queriesUsed };
}

// ─── Answer synthesis ─────────────────────────────────────────────────────────

const WRITER_PROMPT = (mode: SearchMode) => `You are a research writer synthesizing search results into a comprehensive answer.
Mode: ${mode}. ${mode === "speed" ? "Be concise." : mode === "balanced" ? "Balance detail and brevity." : "Be thorough and detailed."}

Rules:
- Cite sources inline using [1], [2] notation matching the provided source list
- If information conflicts across sources, note the discrepancy
- Do not fabricate facts not present in the sources
- Structure the answer clearly with paragraphs or bullets as appropriate`;

// ─── Main WebSearchEngine class ───────────────────────────────────────────────

export class WebSearchEngine {
  private llm: ILanguageModel;
  private tavilyApiKey: string;
  private maxIterations: number;
  private deepScrape: boolean;

  constructor(opts: SearchEngineOptions) {
    this.llm = opts.llm;
    this.tavilyApiKey = opts.tavilyApiKey ?? process.env.TAVILY_API_KEY ?? "";
    this.maxIterations = opts.maxIterations ?? 3;
    this.deepScrape = opts.deepScrape ?? false;
  }

  async search(
    query: string,
    opts: { mode?: SearchMode; history?: ChatMessage[] } = {}
  ): Promise<WebSearchOutput> {
    const mode: SearchMode = opts.mode ?? "balanced";
    const history: ChatMessage[] = opts.history ?? [];

    // Step 1: Classify
    const classification = await classify(this.llm, query, history);

    if (classification.skipSearch) {
      const answer = await this.llm.generateText({
        messages: [...history, { role: "user", content: query }]
      });
      return {
        answer,
        findings: [],
        queriesUsed: [],
        mode,
        skippedSearch: true
      };
    }

    if (!this.tavilyApiKey) {
      return {
        answer: "Search unavailable: TAVILY_API_KEY not configured.",
        findings: [],
        queriesUsed: [query],
        mode,
        skippedSearch: false
      };
    }

    // Step 2: Research
    const { findings, queriesUsed } = await research(
      this.llm,
      query,
      classification,
      this.tavilyApiKey,
      { maxIterations: this.maxIterations, mode, deepScrape: this.deepScrape }
    );

    // Step 3: Synthesize
    const sourceList = findings
      .slice(0, 15)
      .map((f, i) => `[${i + 1}] ${f.title} (${f.url}): ${f.content.slice(0, 500)}`)
      .join("\n\n");

    const answer = await this.llm.generateText({
      messages: [
        { role: "system", content: WRITER_PROMPT(mode) },
        ...history.slice(-4),
        {
          role: "user",
          content: `Query: ${query}\n\nSources:\n${sourceList}`
        }
      ],
      maxTokens: mode === "speed" ? 512 : mode === "balanced" ? 1024 : 2048
    });

    return { answer, findings, queriesUsed, mode, skippedSearch: false };
  }
}
