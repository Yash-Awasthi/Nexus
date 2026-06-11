// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/adapter-tavily — Web search via Tavily API.
 * Task types: tavily.search, tavily.extract
 */

import { defineAdapter, requireEnv, AdapterHttpError, type IExecutionContext } from "@nexus/plugin-sdk";

const TAVILY_BASE = "https://api.tavily.com";

export interface TavilySearchTask {
  taskType: "tavily.search";
  query: string;
  searchDepth?: "basic" | "advanced";
  includeAnswer?: boolean;
  includeRawContent?: boolean;
  maxResults?: number;
  includeDomains?: string[];
  excludeDomains?: string[];
}

export interface TavilyExtractTask {
  taskType: "tavily.extract";
  urls: string[];
}

export type TavilyTask = TavilySearchTask | TavilyExtractTask;

export interface TavilySearchResult {
  answer?: string;
  query: string;
  results: Array<{ title: string; url: string; content: string; score: number; rawContent?: string }>;
  responseTime: number;
}

export interface TavilyExtractResult {
  results: Array<{ url: string; rawContent: string }>;
  failedResults: string[];
}

async function execute(task: TavilyTask, ctx: IExecutionContext): Promise<TavilySearchResult | TavilyExtractResult> {
  const apiKey = requireEnv(ctx, "TAVILY_API_KEY");

  if (task.taskType === "tavily.search") {
    ctx.logger.info("tavily.search", { query: task.query });
    const response = await fetch(`${TAVILY_BASE}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey, query: task.query,
        search_depth: task.searchDepth ?? "basic",
        include_answer: task.includeAnswer ?? true,
        include_raw_content: task.includeRawContent ?? false,
        max_results: task.maxResults ?? 5,
        include_domains: task.includeDomains ?? [],
        exclude_domains: task.excludeDomains ?? [],
      }),
    });
    if (!response.ok) throw new AdapterHttpError("nexus-adapter-tavily", response.status, await response.text());
    return response.json() as Promise<TavilySearchResult>;
  }

  ctx.logger.info("tavily.extract", { urlCount: task.urls.length });
  const response = await fetch(`${TAVILY_BASE}/extract`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: apiKey, urls: task.urls }),
  });
  if (!response.ok) throw new AdapterHttpError("nexus-adapter-tavily", response.status, await response.text());
  return response.json() as Promise<TavilyExtractResult>;
}

export const tavilyAdapter = defineAdapter<TavilyTask, TavilySearchResult | TavilyExtractResult>({
  name: "nexus-adapter-tavily",
  version: "0.1.0",
  capabilities: ["search.web"],
  taskTypes: ["tavily.search", "tavily.extract"],
  execute,
});
export default tavilyAdapter;
