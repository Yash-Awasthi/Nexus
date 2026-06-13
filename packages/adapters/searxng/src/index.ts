// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/adapter-searxng — Web search via self-hosted SearXNG metasearch engine.
 *
 * Requires a SearXNG instance reachable at SEARXNG_BASE_URL
 * (default: http://localhost:4000).  In the Nexus docker-compose stack the
 * `searxng` service is mapped to port 4000 on the host.
 *
 * Task types
 * ----------
 *   searxng.search   — Full-text metasearch across configured engines
 *   searxng.suggest  — Autocomplete / query suggestions
 */

import { defineAdapter, AdapterHttpError, type IExecutionContext } from "@nexus/plugin-sdk";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = "http://localhost:4000";

// ---------------------------------------------------------------------------
// Task payload types
// ---------------------------------------------------------------------------

export type SearXNGCategory =
  | "general"
  | "images"
  | "videos"
  | "news"
  | "science"
  | "it"
  | "files"
  | "social media"
  | "map";

export interface SearXNGSearchTask {
  taskType: "searxng.search";
  /** Search query */
  query: string;
  /** SearXNG categories to search (default: ["general"]) */
  categories?: SearXNGCategory[];
  /** Specific engine names to restrict to (default: all enabled engines) */
  engines?: string[];
  /** BCP-47 language code, e.g. "en-US" (default: "en-US") */
  language?: string;
  /** 1-based page number (default: 1) */
  page?: number;
  /** Override instance base URL (falls back to SEARXNG_BASE_URL → DEFAULT_BASE_URL) */
  baseUrl?: string;
  /** Safesearch: 0 = off, 1 = moderate, 2 = strict */
  safesearch?: 0 | 1 | 2;
}

export interface SearXNGSuggestTask {
  taskType: "searxng.suggest";
  /** Partial query for autocomplete */
  query: string;
  /** Override instance base URL */
  baseUrl?: string;
}

export type SearXNGTask = SearXNGSearchTask | SearXNGSuggestTask;

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface SearXNGSearchResult {
  query: string;
  results: SearXNGResultItem[];
  answers: string[];
  corrections: string[];
  suggestions: string[];
  infoboxes: SearXNGInfobox[];
  numberOfResults: number;
}

export interface SearXNGResultItem {
  title: string;
  url: string;
  content: string;
  engine: string;
  score: number;
  category: string;
  publishedDate?: string;
  thumbnail?: string;
}

export interface SearXNGInfobox {
  infobox: string;
  content: string;
  urls: { title: string; url: string }[];
}

export interface SearXNGSuggestResult {
  query: string;
  suggestions: string[];
}

// ---------------------------------------------------------------------------
// Raw API response shapes (SearXNG JSON API)
// ---------------------------------------------------------------------------

interface RawResult {
  title?: string;
  url?: string;
  content?: string;
  engine?: string;
  score?: number;
  category?: string;
  publishedDate?: string;
  thumbnail?: string;
  [key: string]: unknown;
}

interface RawInfobox {
  infobox?: string;
  content?: string;
  urls?: { title?: string; url?: string }[];
  [key: string]: unknown;
}

interface RawSearchResponse {
  results?: RawResult[];
  answers?: string[];
  corrections?: string[];
  suggestions?: string[];
  infoboxes?: RawInfobox[];
  number_of_results?: number;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

async function execute(
  task: SearXNGTask,
  ctx: IExecutionContext,
): Promise<SearXNGSearchResult | SearXNGSuggestResult> {
  // Resolve base URL: task override → env var → default
  const resolvedBase =
    ("baseUrl" in task && task.baseUrl) ||
    ctx.environment["SEARXNG_BASE_URL"] ||
    process.env.SEARXNG_BASE_URL ||
    DEFAULT_BASE_URL;

  const baseUrl = resolvedBase.replace(/\/$/, "");

  // ── searxng.suggest ───────────────────────────────────────────────────────

  if (task.taskType === "searxng.suggest") {
    ctx.logger.info("searxng.suggest", { query: task.query });

    const url = new URL("/autocompleter", baseUrl);
    url.searchParams.set("q", task.query);

    const res = await fetch(url.toString(), {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      throw new AdapterHttpError("nexus-adapter-searxng", res.status, await res.text());
    }

    // SearXNG autocomplete returns either a plain string[] or an OpenSearch
    // Suggestions array [[query], [suggestion, ...], [description, ...], [url, ...]]
    const raw: unknown = await res.json();
    let suggestions: string[];
    if (Array.isArray(raw)) {
      // OpenSearch format: raw[1] is the suggestions array
      const inner = Array.isArray(raw[1]) ? raw[1] : raw;
      suggestions = inner.filter((v): v is string => typeof v === "string").slice(0, 10);
    } else {
      suggestions = [];
    }

    return { query: task.query, suggestions };
  }

  // ── searxng.search ────────────────────────────────────────────────────────

  ctx.logger.info("searxng.search", {
    query: task.query,
    categories: task.categories,
    page: task.page ?? 1,
  });

  const url = new URL("/search", baseUrl);
  url.searchParams.set("q", task.query);
  url.searchParams.set("format", "json");
  url.searchParams.set("language", task.language ?? "en-US");
  url.searchParams.set("pageno", String(task.page ?? 1));
  url.searchParams.set("safesearch", String(task.safesearch ?? 0));

  if (task.categories?.length) {
    url.searchParams.set("categories", task.categories.join(","));
  }
  if (task.engines?.length) {
    url.searchParams.set("engines", task.engines.join(","));
  }

  const res = await fetch(url.toString(), {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new AdapterHttpError("nexus-adapter-searxng", res.status, await res.text());
  }

  const raw = (await res.json()) as RawSearchResponse;

  const results: SearXNGResultItem[] = (raw.results ?? []).map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    content: r.content ?? "",
    engine: r.engine ?? "",
    score: typeof r.score === "number" ? r.score : 0,
    category: r.category ?? "general",
    ...(r.publishedDate != null ? { publishedDate: r.publishedDate } : {}),
    ...(r.thumbnail != null ? { thumbnail: r.thumbnail } : {}),
  }));

  const infoboxes: SearXNGInfobox[] = (raw.infoboxes ?? []).map((box) => ({
    infobox: box.infobox ?? "",
    content: box.content ?? "",
    urls: (box.urls ?? []).map((u) => ({
      title: u.title ?? "",
      url: u.url ?? "",
    })),
  }));

  return {
    query: task.query,
    results,
    answers: (raw.answers ?? []).filter((a): a is string => typeof a === "string"),
    corrections: (raw.corrections ?? []).filter((c): c is string => typeof c === "string"),
    suggestions: (raw.suggestions ?? []).filter((s): s is string => typeof s === "string"),
    infoboxes,
    numberOfResults: raw.number_of_results ?? results.length,
  };
}

// ---------------------------------------------------------------------------
// Adapter export
// ---------------------------------------------------------------------------

export const searxngAdapter = defineAdapter<
  SearXNGTask,
  SearXNGSearchResult | SearXNGSuggestResult
>({
  name: "nexus-adapter-searxng",
  version: "0.1.0",
  capabilities: ["search.web"],
  taskTypes: ["searxng.search", "searxng.suggest"],
  execute,
});

export default searxngAdapter;
