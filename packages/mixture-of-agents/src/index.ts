// SPDX-License-Identifier: Apache-2.0
/**
 * Mixture of Agents (MoA) — layered proposer/aggregator architecture.
 *
 * Inspired by Together AI's MoA: multiple proposer agents generate independent
 * answers, then aggregator agents synthesize them layer by layer. Each layer
 * refines the output, producing higher quality than any single agent.
 */

export interface MoAAgent {
  id: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
}

export interface MoALayerConfig {
  proposers: MoAAgent[];
  aggregator: MoAAgent;
}

export interface MoAResult {
  answer: string;
  layers: LayerResult[];
  totalTokens: number;
  agentResponses: Map<string, string>;
}

export interface LayerResult {
  layerIndex: number;
  proposerResponses: Map<string, string>;
  aggregated: string;
}

export interface MoAConfig {
  layers: MoALayerConfig[];
  llmCaller: (
    model: string,
    messages: Array<{ role: string; content: string }>,
    options?: { temperature?: number; maxTokens?: number },
  ) => Promise<string>;
}

/**
 * Mixture of Agents engine — multi-layer proposer/aggregator pipeline.
 */
export class MixtureOfAgents {
  private config: MoAConfig;

  constructor(config: MoAConfig) {
    this.config = config;
  }

  /**
   * Run the MoA pipeline: for each layer, proposers generate answers,
   * then the aggregator synthesizes them into a single output.
   */
  async run(query: string): Promise<MoAResult> {
    const layers: LayerResult[] = [];
    const agentResponses = new Map<string, string>();
    let totalTokens = 0;
    let currentInput = query;

    for (let i = 0; i < this.config.layers.length; i++) {
      const layerConfig = this.config.layers[i]!;

      // Phase 1: Proposers generate independent answers
      const proposerResponses = new Map<string, string>();
      const proposals = await Promise.all(
        layerConfig.proposers.map(async (proposer) => {
          const messages = [
            {
              role: "system",
              content:
                proposer.systemPrompt ??
                "You are a helpful assistant. Answer the following question thoroughly.",
            },
            { role: "user", content: currentInput },
          ];
          const response = await this.config.llmCaller(proposer.model, messages, {
            temperature: proposer.temperature ?? 0.7,
            maxTokens: proposer.maxTokens ?? 2048,
          });
          proposerResponses.set(proposer.id, response);
          agentResponses.set(`layer${i}_${proposer.id}`, response);
          return response;
        }),
      );

      // Phase 2: Aggregator synthesizes
      const proposalsText = proposals.map((p, idx) => `[Proposal ${idx + 1}]: ${p}`).join("\n\n");

      const aggregatorMessages = [
        {
          role: "system",
          content:
            layerConfig.aggregator.systemPrompt ??
            "You are an expert synthesizer. Combine the following proposals into one comprehensive, accurate answer. Remove redundancy and ensure completeness.",
        },
        {
          role: "user",
          content: `Original question: ${currentInput}\n\nProposals:\n${proposalsText}\n\nSynthesize into one best answer:`,
        },
      ];

      const aggregated = await this.config.llmCaller(
        layerConfig.aggregator.model,
        aggregatorMessages,
        {
          temperature: layerConfig.aggregator.temperature ?? 0.3,
          maxTokens: layerConfig.aggregator.maxTokens ?? 4096,
        },
      );

      agentResponses.set(`layer${i}_aggregator`, aggregated);

      layers.push({
        layerIndex: i,
        proposerResponses,
        aggregated,
      });

      // Feed aggregated output as input to next layer
      currentInput = `Previous synthesis: ${aggregated}\n\nOriginal question: ${query}\n\nRefine and improve the answer:`;
    }

    return {
      answer: currentInput.startsWith("Previous synthesis:")
        ? layers[layers.length - 1]!.aggregated
        : currentInput,
      layers,
      totalTokens,
      agentResponses,
    };
  }
}
