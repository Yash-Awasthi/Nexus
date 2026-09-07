// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/deep-research — Multi-step deep research pipeline.
 *
 * Inspired by Onyx's Deep Research: takes a research question, generates
 * sub-questions, searches for evidence across multiple sources, synthesizes
 * findings, and produces a comprehensive report with citations.
 *
 * Pipeline:
 *   1. Question decomposition → sub-questions
 *   2. Parallel evidence gathering per sub-question
 *   3. Source deduplication and relevance scoring
 *   4. Cross-reference validation
 *   5. Report synthesis with citations
 *   6. Confidence scoring per claim
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type ResearchDepth = "quick" | "standard" | "deep";

export interface SubQuestion {
  id: string;
  question: string;
  parentQuestion: string;
  depth: number;
  priority: number;
}

export interface Evidence {
  id: string;
  subQuestionId: string;
  content: string;
  sourceUrl: string;
  sourceTitle: string;
  relevanceScore: number; // 0-1
  confidenceScore: number; // 0-1
  snippet: string;
  retrievedAt: string;
}

export interface Claim {
  id: string;
  text: string;
  evidenceIds: string[];
  confidenceScore: number; // 0-1
  sourceCount: number;
  sourcesAgree: boolean;
}

export interface ResearchReport {
  id: string;
  question: string;
  summary: string;
  sections: ResearchSection[];
  claims: Claim[];
  sources: SourceReference[];
  confidenceScore: number;
  depth: ResearchDepth;
  totalSubQuestions: number;
  totalEvidence: number;
  totalSources: number;
  durationMs: number;
  createdAt: string;
}

export interface ResearchSection {
  title: string;
  content: string;
  claims: string[]; // Claim IDs
  evidenceCount: number;
}

export interface SourceReference {
  url: string;
  title: string;
  evidenceCount: number;
  avgRelevance: number;
}

export interface SearchBackend {
  search(query: string, maxResults: number): Promise<SearchResult[]>;
}

export interface SearchResult {
  url: string;
  title: string;
  snippet: string;
  score: number;
}

export interface LLMBackend {
  complete(messages: Array<{ role: string; content: string }>, maxTokens?: number): Promise<string>;
}

export interface ResearchConfig {
  depth: ResearchDepth;
  maxSubQuestions: number;
  maxEvidencePerQuestion: number;
  minRelevanceScore: number;
  searchBackend: SearchBackend;
  llmBackend: LLMBackend;
}

// ── Depth Settings ───────────────────────────────────────────────────────────

const DEPTH_SETTINGS: Record<ResearchDepth, Partial<ResearchConfig>> = {
  quick: { maxSubQuestions: 3, maxEvidencePerQuestion: 5, minRelevanceScore: 0.3 },
  standard: { maxSubQuestions: 7, maxEvidencePerQuestion: 10, minRelevanceScore: 0.4 },
  deep: { maxSubQuestions: 15, maxEvidencePerQuestion: 20, minRelevanceScore: 0.5 },
};

// ── Deep Research Engine ─────────────────────────────────────────────────────

export class DeepResearchEngine {
  private config: ResearchConfig;

  constructor(config: ResearchConfig) {
    const depthDefaults = DEPTH_SETTINGS[config.depth] ?? DEPTH_SETTINGS.standard;
    this.config = { ...depthDefaults, ...config };
  }

  /**
   * Run the full deep research pipeline.
   */
  async research(question: string): Promise<ResearchReport> {
    const startTime = Date.now();
    const reportId = `report-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Step 1: Decompose question into sub-questions
    const subQuestions = await this.decompose(question);

    // Step 2: Gather evidence for each sub-question in parallel
    const allEvidence = await this.gatherEvidence(subQuestions);

    // Step 3: Deduplicate and score evidence
    const dedupedEvidence = this.deduplicateEvidence(allEvidence);

    // Step 4: Cross-reference and validate
    const claims = this.extractClaims(dedupedEvidence, question);

    // Step 5: Synthesize report
    const { sections, summary } = await this.synthesize(question, claims, dedupedEvidence);

    // Step 6: Build source reference list
    const sources = this.buildSourceList(dedupedEvidence);

    // Step 7: Compute overall confidence
    const confidenceScore = this.computeConfidence(claims);

    return {
      id: reportId,
      question,
      summary,
      sections,
      claims,
      sources,
      confidenceScore,
      depth: this.config.depth,
      totalSubQuestions: subQuestions.length,
      totalEvidence: dedupedEvidence.length,
      totalSources: sources.length,
      durationMs: Date.now() - startTime,
      createdAt: new Date().toISOString(),
    };
  }

  // ── Step 1: Decompose ──────────────────────────────────────────────────────

  private async decompose(question: string): Promise<SubQuestion[]> {
    const prompt = [
      "You are a research planner. Break down the following research question into",
      `${this.config.maxSubQuestions} focused sub-questions that would help answer it comprehensively.`,
      "Each sub-question should target a specific aspect: definitions, history, current state,",
      "key players, technical details, comparisons, controversies, and future outlook.",
      "",
      "Reply with ONLY a JSON array of strings, no explanation:",
      `["sub-question 1", "sub-question 2", ...]`,
      "",
      `Research question: ${question}`,
    ].join("\n");

    const response = await this.config.llmBackend.complete(
      [{ role: "user", content: prompt }],
      1024,
    );

    let questions: string[];
    try {
      const jsonMatch = response.match(/\[[\s\S]*\]/);
      questions = JSON.parse(jsonMatch ? jsonMatch[0] : response);
    } catch {
      questions = [question]; // Fallback: use the original question
    }

    return questions.slice(0, this.config.maxSubQuestions).map((q, i) => ({
      id: `sq-${i}`,
      question: q,
      parentQuestion: question,
      depth: 0,
      priority: this.config.maxSubQuestions - i,
    }));
  }

  // ── Step 2: Gather Evidence ────────────────────────────────────────────────

  private async gatherEvidence(subQuestions: SubQuestion[]): Promise<Evidence[]> {
    const allEvidence: Evidence[] = [];

    // Search for each sub-question in parallel
    const searchResults = await Promise.all(
      subQuestions.map(async (sq) => {
        try {
          const results = await this.config.searchBackend.search(
            sq.question,
            this.config.maxEvidencePerQuestion,
          );
          return { subQuestion: sq, results };
        } catch {
          return { subQuestion: sq, results: [] };
        }
      }),
    );

    // For each search result, extract evidence snippets
    for (const { subQuestion, results } of searchResults) {
      for (const result of results) {
        if (result.score < this.config.minRelevanceScore) continue;

        const evidence: Evidence = {
          id: `ev-${subQuestion.id}-${Math.random().toString(36).slice(2, 8)}`,
          subQuestionId: subQuestion.id,
          content: result.snippet,
          sourceUrl: result.url,
          sourceTitle: result.title,
          relevanceScore: result.score,
          confidenceScore: result.score * 0.8, // Simplified confidence
          snippet: result.snippet.slice(0, 200),
          retrievedAt: new Date().toISOString(),
        };

        allEvidence.push(evidence);
      }
    }

    return allEvidence;
  }

  // ── Step 3: Deduplicate ────────────────────────────────────────────────────

  private deduplicateEvidence(evidence: Evidence[]): Evidence[] {
    const seen = new Map<string, Evidence>();

    for (const ev of evidence) {
      const key = ev.sourceUrl;
      const existing = seen.get(key);
      if (!existing || ev.relevanceScore > existing.relevanceScore) {
        seen.set(key, ev);
      }
    }

    return Array.from(seen.values()).sort((a, b) => b.relevanceScore - a.relevanceScore);
  }

  // ── Step 4: Extract Claims ─────────────────────────────────────────────────

  private extractClaims(evidence: Evidence[], question: string): Claim[] {
    const claims: Claim[] = [];
    const evidenceByQuestion = new Map<string, Evidence[]>();

    for (const ev of evidence) {
      const list = evidenceByQuestion.get(ev.subQuestionId) ?? [];
      list.push(ev);
      evidenceByQuestion.set(ev.subQuestionId, list);
    }

    for (const [sqId, evList] of evidenceByQuestion) {
      if (evList.length === 0) continue;

      const sourcesAgree = this.checkSourceAgreement(evList);
      const confidenceScore = this.computeClaimConfidence(evList, sourcesAgree);

      claims.push({
        id: `claim-${sqId}`,
        text: evList.map((e) => e.content).join(" | "),
        evidenceIds: evList.map((e) => e.id),
        confidenceScore,
        sourceCount: evList.length,
        sourcesAgree,
      });
    }

    return claims;
  }

  private checkSourceAgreement(evidence: Evidence[]): boolean {
    // Simplified: check if evidence from different sources agrees
    const uniqueSources = new Set(evidence.map((e) => e.sourceUrl));
    return uniqueSources.size >= 2; // At least 2 sources
  }

  private computeClaimConfidence(evidence: Evidence[], sourcesAgree: boolean): number {
    const avgRelevance = evidence.reduce((sum, e) => sum + e.relevanceScore, 0) / evidence.length;
    const sourceBonus = sourcesAgree ? 0.2 : 0;
    const countBonus = Math.min(0.2, evidence.length * 0.05);
    return Math.min(1, avgRelevance + sourceBonus + countBonus);
  }

  // ── Step 5: Synthesize ─────────────────────────────────────────────────────

  private async synthesize(
    question: string,
    claims: Claim[],
    evidence: Evidence[],
  ): Promise<{ sections: ResearchSection[]; summary: string }> {
    // Build evidence summary for LLM
    const evidenceText = claims
      .map((c, i) => `[Claim ${i + 1}] Confidence: ${(c.confidenceScore * 100).toFixed(0)}% | Sources: ${c.sourceCount}\n${c.text}`)
      .join("\n\n");

    const prompt = [
      `You are writing a comprehensive research report on: ${question}`,
      "",
      "Based on the following evidence and claims, write a structured report.",
      "Include an executive summary and 3-5 sections.",
      "For each claim, note your confidence level.",
      "",
      "EVIDENCE:",
      evidenceText.slice(0, 8000), // Limit for token budget
      "",
      "Reply with JSON ONLY:",
      '{"summary": "...", "sections": [{"title": "...", "content": "..."}]}',
    ].join("\n");

    const response = await this.config.llmBackend.complete(
      [{ role: "user", content: prompt }],
      4096,
    );

    let parsed: { summary: string; sections: { title: string; content: string }[] };
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : response);
    } catch {
      parsed = {
        summary: response.slice(0, 500),
        sections: [{ title: "Findings", content: response }],
      };
    }

    const sections: ResearchSection[] = (parsed.sections ?? []).map((s, i) => ({
      title: s.title ?? `Section ${i + 1}`,
      content: s.content ?? "",
      claims: claims.slice(i * 2, (i + 1) * 2).map((c) => c.id),
      evidenceCount: evidence.length,
    }));

    return { sections, summary: parsed.summary ?? "" };
  }

  // ── Step 6: Source List ────────────────────────────────────────────────────

  private buildSourceList(evidence: Evidence[]): SourceReference[] {
    const byUrl = new Map<string, SourceReference>();

    for (const ev of evidence) {
      const existing = byUrl.get(ev.sourceUrl);
      if (existing) {
        existing.evidenceCount++;
        existing.avgRelevance = (existing.avgRelevance + ev.relevanceScore) / 2;
      } else {
        byUrl.set(ev.sourceUrl, {
          url: ev.sourceUrl,
          title: ev.sourceTitle,
          evidenceCount: 1,
          avgRelevance: ev.relevanceScore,
        });
      }
    }

    return Array.from(byUrl.values()).sort((a, b) => b.avgRelevance - a.avgRelevance);
  }

  // ── Step 7: Confidence ─────────────────────────────────────────────────────

  private computeConfidence(claims: Claim[]): number {
    if (claims.length === 0) return 0;
    const avg = claims.reduce((sum, c) => sum + c.confidenceScore, 0) / claims.length;
    const multiSourceRatio = claims.filter((c) => c.sourceCount >= 2).length / claims.length;
    return Math.min(1, avg * 0.7 + multiSourceRatio * 0.3);
  }
}

export default DeepResearchEngine;
