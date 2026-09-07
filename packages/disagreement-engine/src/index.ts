/**
 * Disagreement Engine — 3-model structured disagreement with minority reports.
 *
 * Extracted from MAGI: three LLMs with different personas vote, debate, and
 * critique each other to produce a Decision Dossier with ruling, confidence,
 * minority report, and full trace.
 */

export interface ModelNode {
  id: string;
  model: string;
  persona: string;
  temperature?: number;
}

export interface Decision {
  query: string;
  ruling: string;
  confidence: number;
  minorityReport: string | null;
  protocolUsed: string;
  nodeResponses: Map<string, string>;
  votes: Map<string, string>;
  trace: TraceEntry[];
  timestamp: number;
}

export interface TraceEntry {
  phase: string;
  nodeId: string;
  content: string;
  timestamp: number;
}

export interface DisagreementConfig {
  timeoutMs: number;
  maxCritiqueRounds: number;
  majorityThreshold: number;
}

const DEFAULT_CONFIG: DisagreementConfig = {
  timeoutMs: 60_000,
  maxCritiqueRounds: 3,
  majorityThreshold: 2,
};

// Default personas
export const MELCHIOR: ModelNode = {
  id: 'melchior',
  model: 'claude-sonnet-4-6',
  persona: 'Analytical and methodical. Focuses on logic and evidence.',
};

export const BALTHASAR: ModelNode = {
  id: 'balthasar',
  model: 'gpt-4o',
  persona: 'Creative and contrarian. Challenges assumptions and finds edge cases.',
};

export const CASPER: ModelNode = {
  id: 'casper',
  model: 'gemini-3.6-flash',
  persona: 'Pragmatic and practical. Focuses on real-world applicability.',
};

/**
 * Disagreement Engine — queries 3 models, collects votes, identifies minority.
 */
export class DisagreementEngine {
  private nodes: ModelNode[];
  private config: DisagreementConfig;
  private llmCaller: (model: string, prompt: string) => Promise<string>;

  constructor(
    llmCaller: (model: string, prompt: string) => Promise<string>,
    nodes: ModelNode[] = [MELCHIOR, BALTHASAR, CASPER],
    config: Partial<DisagreementConfig> = {}
  ) {
    this.nodes = nodes;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.llmCaller = llmCaller;
  }

  /**
   * Query all models and vote.
   */
  async vote(query: string): Promise<Decision> {
    const trace: TraceEntry[] = [];
    const nodeResponses = new Map<string, string>();
    const votes = new Map<string, string>();

    // Phase 1: Independent responses
    const responses = await Promise.all(
      this.nodes.map(async (node) => {
        const prompt = `You are ${node.persona}\n\nQuestion: ${query}\n\nProvide your answer:`;
        const response = await this.llmCaller(node.model, prompt);
        nodeResponses.set(node.id, response);
        trace.push({ phase: 'response', nodeId: node.id, content: response, timestamp: Date.now() });
        return { node, response };
      })
    );

    // Phase 2: Cross-review (each sees others' responses)
    for (const { node, response } of responses) {
      const otherResponses = responses
        .filter((r) => r.node.id !== node.id)
        .map((r) => `[${r.node.id}]: ${r.response}`)
        .join('\n\n');

      const votePrompt = `You are ${node.persona}\n\nYour answer: ${response}\n\nOther answers:\n${otherResponses}\n\nVote for the best answer by returning ONLY the node id (${this.nodes.map((n) => n.id).join(', ')}):`;
      const voteResult = await this.llmCaller(node.model, votePrompt);
      votes.set(node.id, voteResult.trim().toLowerCase());
      trace.push({ phase: 'vote', nodeId: node.id, content: voteResult, timestamp: Date.now() });
    }

    // Tally votes
    const tally = new Map<string, number>();
    for (const vote of votes.values()) {
      tally.set(vote, (tally.get(vote) ?? 0) + 1);
    }

    // Find majority
    let majority = '';
    let maxVotes = 0;
    for (const [candidate, count] of tally) {
      if (count > maxVotes) {
        maxVotes = count;
        majority = candidate;
      }
    }

    const hasMajority = maxVotes >= this.config.majorityThreshold;
    const winnerNode = this.nodes.find((n) => n.id === majority);

    // Minority report
    const minorityIds = this.nodes
      .filter((n) => votes.get(n.id) !== majority)
      .map((n) => n.id);
    const minorityReport = minorityIds.length > 0
      ? `Minority voted for: ${minorityIds.join(', ')} (dissenting opinion)`
      : null;

    return {
      query,
      ruling: nodeResponses.get(majority) ?? '',
      confidence: maxVotes / this.nodes.length,
      minorityReport,
      protocolUsed: hasMajority ? 'vote' : 'vote_no_majority',
      nodeResponses,
      votes,
      trace,
      timestamp: Date.now(),
    };
  }

  /**
   * Critique protocol — models critique each other's answers.
   */
  async critique(query: string, maxRounds?: number): Promise<Decision> {
    const rounds = maxRounds ?? this.config.maxCritiqueRounds;
    const trace: TraceEntry[] = [];
    const nodeResponses = new Map<string, string>();

    // Get initial responses
    const responses = await Promise.all(
      this.nodes.map(async (node) => {
        const prompt = `You are ${node.persona}\n\nQuestion: ${query}\n\nProvide your answer:`;
        const response = await this.llmCaller(node.model, prompt);
        nodeResponses.set(node.id, response);
        return { node, response };
      })
    );

    // Critique rounds
    let currentResponses = responses;
    for (let round = 0; round < rounds; round++) {
      const newResponses = await Promise.all(
        this.nodes.map(async (node) => {
          const others = currentResponses
            .filter((r) => r.node.id !== node.id)
            .map((r) => `[${r.node.id}]: ${r.response}`)
            .join('\n\n');

          const critiquePrompt = `You are ${node.persona}\n\nYour previous answer: ${nodeResponses.get(node.id)}\n\nOther answers:\n${others}\n\nCritique the other answers and refine your own. Provide your FINAL answer:`;
          const refined = await this.llmCaller(node.model, critiquePrompt);
          nodeResponses.set(node.id, refined);
          trace.push({ phase: `critique_round_${round}`, nodeId: node.id, content: refined, timestamp: Date.now() });
          return { node, response: refined };
        })
      );
      currentResponses = newResponses;
    }

    // Final vote
    const votes = new Map<string, string>();
    for (const { node, response } of currentResponses) {
      const others = currentResponses
        .filter((r) => r.node.id !== node.id)
        .map((r) => `[${r.node.id}]: ${r.response}`)
        .join('\n\n');

      const votePrompt = `After ${rounds} rounds of critique, vote for the best FINAL answer.\n\nYour answer: ${response}\n\nOthers:\n${others}\n\nReturn ONLY the node id:`;
      const voteResult = await this.llmCaller(node.model, votePrompt);
      votes.set(node.id, voteResult.trim().toLowerCase());
    }

    const tally = new Map<string, number>();
    for (const vote of votes.values()) {
      tally.set(vote, (tally.get(vote) ?? 0) + 1);
    }

    let majority = '';
    let maxVotes = 0;
    for (const [candidate, count] of tally) {
      if (count > maxVotes) {
        maxVotes = count;
        majority = candidate;
      }
    }

    const minorityIds = this.nodes.filter((n) => votes.get(n.id) !== majority).map((n) => n.id);

    return {
      query,
      ruling: nodeResponses.get(majority) ?? '',
      confidence: maxVotes / this.nodes.length,
      minorityReport: minorityIds.length > 0 ? `Minority: ${minorityIds.join(', ')}` : null,
      protocolUsed: 'critique',
      nodeResponses,
      votes,
      trace,
      timestamp: Date.now(),
    };
  }
}
