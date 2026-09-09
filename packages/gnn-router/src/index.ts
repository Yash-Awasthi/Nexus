// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/gnn-router — Graph Neural Network based LLM routing.
 *
 * Uses a simplified GNN-inspired scoring model to route requests
 * to the best LLM provider based on task characteristics.
 */

import type { LLMRouter } from "@nexus/llm-router";

export interface TaskFeatures {
  taskType: string;
  complexityScore: number;
  domainTags: string[];
  tokenEstimate: number;
  previousProviders?: string[];
}

interface ProviderScore {
  provider: string;
  model: string;
  score: number;
  latencyP50: number;
  costPerToken: number;
  successRate: number;
}

const TASK_TYPE_EMBEDDINGS: Record<string, number[]> = {
  "code-generation": [0.9, 0.3, 0.1, 0.8, 0.2],
  "code-review": [0.85, 0.4, 0.15, 0.7, 0.3],
  analysis: [0.5, 0.8, 0.6, 0.9, 0.1],
  "creative-writing": [0.2, 0.6, 0.9, 0.3, 0.7],
  summarization: [0.3, 0.5, 0.4, 0.6, 0.2],
  chat: [0.4, 0.2, 0.7, 0.4, 0.5],
  "data-extraction": [0.7, 0.7, 0.2, 0.8, 0.1],
  translation: [0.4, 0.3, 0.5, 0.5, 0.6],
  "math-reasoning": [0.6, 0.9, 0.1, 0.95, 0.05],
  default: [0.5, 0.5, 0.5, 0.5, 0.5],
};

export class GNNRouter {
  private providerHistory: Map<string, { latency: number; success: boolean; cost: number }[]> =
    new Map();
  private readonly decayFactor = 0.95;
  private readonly historySize = 100;

  constructor(private router: LLMRouter) {}

  async route(task: TaskFeatures, availableAliases: string[]): Promise<string> {
    const taskEmbedding = this.getTaskEmbedding(task);
    const scores = await this.scoreProviders(taskEmbedding, availableAliases);
    scores.sort((a, b) => b.score - a.score);
    return `${scores[0].provider}:${scores[0].model}`;
  }

  private getTaskEmbedding(task: TaskFeatures): number[] {
    const base = TASK_TYPE_EMBEDDINGS[task.taskType] || TASK_TYPE_EMBEDDINGS["default"];
    return base.map((v, i) => {
      let val = v * 0.6;
      val += Math.min(task.complexityScore, 1) * 0.3 * (i % 2 === 0 ? 1 : -1);
      val += Math.min(task.tokenEstimate / 4096, 1) * 0.1 * (i % 3 === 0 ? 1 : -1);
      return val;
    });
  }

  private async scoreProviders(
    taskEmbedding: number[],
    aliases: string[],
  ): Promise<ProviderScore[]> {
    const scores: ProviderScore[] = [];

    for (const alias of aliases) {
      const history = this.providerHistory.get(alias) || [];
      const recentHistory = history.slice(-this.historySize);

      const successRate =
        recentHistory.length > 0
          ? recentHistory.filter((h) => h.success).length / recentHistory.length
          : 0.5;

      const latencyP50 =
        recentHistory.length > 0
          ? this.percentile(
              recentHistory.map((h) => h.latency),
              50,
            )
          : 2000;

      const costPerToken =
        recentHistory.length > 0
          ? recentHistory.reduce((sum, h) => sum + h.cost, 0) / recentHistory.length
          : 0.00001;

      const taskScore = this.dotProduct(taskEmbedding, this.providerBiasVector(alias));

      const latencyScore = 1 / (1 + latencyP50 / 5000);
      const costScore = 1 / (1 + costPerToken * 100000);
      const qualityScore = successRate;

      const totalScore =
        taskScore * 0.35 + qualityScore * 0.3 + latencyScore * 0.2 + costScore * 0.15;

      const [provider, model] = alias.includes(":") ? alias.split(":") : [alias, alias];

      scores.push({
        provider,
        model,
        score: totalScore,
        latencyP50,
        costPerToken,
        successRate,
      });
    }

    return scores;
  }

  private providerBiasVector(alias: string): number[] {
    let hash = 0;
    for (let i = 0; i < alias.length; i++) {
      hash = ((hash << 5) - hash + alias.charCodeAt(i)) | 0;
    }
    const seed = Math.abs(hash);
    return Array.from({ length: 5 }, (_, i) => (Math.sin(seed * (i + 1) * 0.1) + 1) / 2);
  }

  private dotProduct(a: number[], b: number[]): number {
    return a.reduce((sum, v, i) => sum + v * (b[i] || 0), 0);
  }

  private percentile(values: number[], p: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
  }

  recordOutcome(alias: string, latencyMs: number, success: boolean, cost: number): void {
    if (!this.providerHistory.has(alias)) {
      this.providerHistory.set(alias, []);
    }
    const history = this.providerHistory.get(alias)!;
    history.push({ latency: latencyMs, success, cost });
    if (history.length > this.historySize * 2) {
      this.providerHistory.set(alias, history.slice(-this.historySize));
    }
  }
}

export default GNNRouter;
