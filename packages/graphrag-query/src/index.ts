// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/graphrag-query — GraphRAG query with community reports.
 *
 * Inspired by Microsoft's GraphRAG.
 * Provides hierarchical community-based retrieval for question answering,
 * with dynamic community selection and map-reduce summarization.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface CommunityReport {
  id: string;
  communityId: string;
  level: number;
  title: string;
  summary: string;
  fullContent: string;
  rank: number;
  rating: number;
  findings: string[];
  entities: string[];
  createdAt: number;
}

export interface GraphRAGQueryResult {
  answer: string;
  communitiesUsed: CommunityReport[];
  context: string;
  durationMs: number;
}

// ── GraphRAG Query Engine ────────────────────────────────────────────────────

export interface QueryRouter {
  complete(params: { model: string; messages: Array<{ role: string; content: string }>; maxTokens?: number }): Promise<{ content: string }>;
}

export class GraphRAGQueryEngine {
  private reports: Map<string, CommunityReport> = new Map();
  private router: QueryRouter;
  private modelAlias: string;

  constructor(router: QueryRouter, modelAlias: string) {
    this.router = router;
    this.modelAlias = modelAlias;
  }

  /**
   * Add a community report.
   */
  addReport(report: CommunityReport): void {
    this.reports.set(report.id, report);
  }

  /**
   * Add multiple reports.
   */
  addReports(reports: CommunityReport[]): void {
    for (const report of reports) {
      this.reports.set(report.id, report);
    }
  }

  /**
   * Query with community-based retrieval.
   */
  async query(question: string, options?: {
    communityLevel?: number;
    maxCommunities?: number;
    dynamicSelection?: boolean;
  }): Promise<GraphRAGQueryResult> {
    const start = Date.now();
    const level = options?.communityLevel ?? 0;
    const maxCommunities = options?.maxCommunities ?? 5;

    // 1. Select relevant communities
    let selectedCommunities = this.selectCommunities(question, level, maxCommunities);

    if (options?.dynamicSelection && selectedCommunities.length > 0) {
      selectedCommunities = await this.dynamicSelect(question, selectedCommunities);
    }

    // 2. Map: summarize each community's relevance
    const communitySummaries = await this.mapPhase(question, selectedCommunities);

    // 3. Reduce: synthesize all summaries into final answer
    const answer = await this.reducePhase(question, communitySummaries);

    // Build context
    const context = selectedCommunities
      .map((c) => `[${c.title}] ${c.summary.slice(0, 200)}`)
      .join("\n\n");

    return {
      answer,
      communitiesUsed: selectedCommunities,
      context,
      durationMs: Date.now() - start,
    };
  }

  /**
   * Get all community reports at a level.
   */
  getReportsAtLevel(level: number): CommunityReport[] {
    return Array.from(this.reports.values()).filter((r) => r.level === level);
  }

  /**
   * Get all reports.
   */
  getAllReports(): CommunityReport[] {
    return Array.from(this.reports.values());
  }

  // ── Phase 1: Community Selection ──────────────────────────────────────

  private selectCommunities(query: string, level: number, max: number): CommunityReport[] {
    const atLevel = this.getReportsAtLevel(level);

    // Simple keyword relevance scoring
    const queryWords = new Set(query.toLowerCase().split(/\s+/));

    const scored = atLevel.map((report) => {
      const reportWords = new Set(
        `${report.title} ${report.summary} ${report.entities.join(" ")}`.toLowerCase().split(/\s+/),
      );
      const overlap = [...queryWords].filter((w) => reportWords.has(w)).length;
      const score = overlap / queryWords.size + report.rating * 0.1;
      return { report, score };
    });

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, max)
      .map((s) => s.report);
  }

  // ── Phase 2: Dynamic Selection ────────────────────────────────────────

  private async dynamicSelect(
    query: string,
    candidates: CommunityReport[],
  ): Promise<CommunityReport[]> {
    const summaries = candidates
      .map((c, i) => `${i + 1}. "${c.title}": ${c.summary.slice(0, 150)}`)
      .join("\n");

    const prompt = [
      `Select the most relevant communities for this question.`,
      `Question: ${query}\n`,
      `Communities:\n${summaries}\n`,
      `Return the numbers of the top 3 most relevant communities, comma-separated.`,
    ].join("\n");

    const resp = await this.router.complete({
      model: this.modelAlias,
      messages: [{ role: "user", content: prompt }],
      maxTokens: 50,
    });

    const indices = resp.content
      .split(/[\s,]+/)
      .map((s) => parseInt(s, 10) - 1)
      .filter((i) => i >= 0 && i < candidates.length);

    return indices.map((i) => candidates[i]!).filter(Boolean);
  }

  // ── Phase 3: Map ──────────────────────────────────────────────────────

  private async mapPhase(
    query: string,
    communities: CommunityReport[],
  ): Promise<string[]> {
    const results = await Promise.all(
      communities.map(async (community) => {
        const prompt = [
          `You are analyzing a community report for relevance to a question.`,
          `Question: ${query}\n`,
          `Community: "${community.title}"`,
          `Summary: ${community.summary}`,
          `\nWhat information from this community is relevant to the question?`,
          `Provide a brief, focused summary of relevant facts.`,
        ].join("\n");

        const resp = await this.router.complete({
          model: this.modelAlias,
          messages: [{ role: "user", content: prompt }],
          maxTokens: 512,
        });

        return resp.content;
      }),
    );

    return results;
  }

  // ── Phase 4: Reduce ───────────────────────────────────────────────────

  private async reducePhase(query: string, summaries: string[]): Promise<string> {
    const combinedSummaries = summaries
      .map((s, i) => `Source ${i + 1}:\n${s}`)
      .join("\n\n");

    const prompt = [
      `Synthesize the following community summaries into a comprehensive answer.`,
      `Question: ${query}\n`,
      `Community summaries:\n${combinedSummaries}\n`,
      `Provide a clear, well-organized answer that integrates information from all sources.`,
      `If there are contradictions, note them.`,
    ].join("\n");

    const resp = await this.router.complete({
      model: this.modelAlias,
      messages: [{ role: "user", content: prompt }],
      maxTokens: 2048,
    });

    return resp.content;
  }
}

export default GraphRAGQueryEngine;

// ── GraphRAG indexing pipeline ─────────────────────────────────────────────────
export {
  buildGraphRagIndex,
  makeCommunitySummarizer,
  parseSummaryJson,
  mergeGraphEntities,
} from "./index-graphrag.js";
export type {
  EntityExtraction,
  RelationExtraction,
  IndexedEntity,
  IndexedRelation,
  CommunityInput,
  CommunityReportSummary,
  IndexRouter,
  GraphRagIndexOptions,
  GraphRagIndexResult,
  MergeGraphOptions,
  MergedGraph,
} from "./index-graphrag.js";

// ── Local search (entity-anchored, graphrag dual-mode parity) ─────────────────
export { LocalSearchEngine } from "./local-search.js";
export type { LocalSearchResult, LocalSearchOptions } from "./local-search.js";

export { createGraphRagMcpServer } from "./mcp-server.js";
export type { GraphRagMcpServerOptions } from "./mcp-server.js";
