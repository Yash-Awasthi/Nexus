// SPDX-License-Identifier: Apache-2.0
/**
 * Node self-optimization — the unported half of GPTSwarm for @nexus/swarm-graph.
 *
 * swarm-graph already models GPTSwarm's graph construction (LLM/Decision/
 * Aggregate nodes, SwarmGraph). The repo's other half is its optimizer:
 * `swarm/optimizer/node_optimizer/node_optimization.py`. The *shipped* code
 * (not the paper's bandit framing) is a self-improvement pass over one node:
 *
 *   1. take the node's recent examples (last `historyWindow` outcomes),
 *   2. build candidate (prompt, demonstrations) variants — the current
 *      variant, demonstrations extended with the positive examples, and a
 *      prompt revised from the negative examples,
 *   3. evaluate every candidate against the recent history and adopt the
 *      highest-scoring one.
 *
 * Deviations, documented honestly: gptswarm caps oversized demonstration sets
 * with `random.sample`; here the most-recent demonstrations are kept so the
 * pass is deterministic to test. gptswarm reads examples from each node's
 * memory store; here the caller supplies the recent outcomes.
 *
 * The two LLM seams (`revisePrompt`, `score`) are plain injected functions so
 * the module is provider-agnostic and fully deterministic under test.
 */

/** One recorded outcome for the node being optimized. */
export interface OptimizerExample {
  /** The task the node was asked to perform. */
  task: string;
  /** Whether the node's output was judged correct. */
  success: boolean;
}

/** A prompt + demonstrations pairing (gptswarm's candidate unit). */
export interface NodeVariant {
  prompt: string;
  /** Few-shot demonstrations appended to the prompt. */
  demonstrations: string[];
}

export interface NodeOptimizerConfig {
  /** The node's current variant. */
  current: NodeVariant;
  /** Recent task outcomes, oldest first. */
  examples: readonly OptimizerExample[];
  /** gptswarm `get_new_prompt` seam: revise the prompt from failed tasks. */
  revisePrompt: (negativeTasks: readonly string[]) => Promise<string>;
  /** gptswarm `evaluate` seam: score a candidate variant (higher = better). */
  score: (variant: NodeVariant) => Promise<number>;
  /** How many recent examples to learn from. Default 4 (gptswarm `[-4:]`). */
  historyWindow?: number;
  /** Cap on demonstrations after positive-example extension. Default 6. */
  maxDemonstrations?: number;
  /** Extend demonstrations with positive examples. Default true. */
  learnDemonstrations?: boolean;
  /** Generate a revised prompt from negative examples. Default true. */
  learnPrompt?: boolean;
}

export interface OptimizerOutcome {
  /** The adopted variant (== current when nothing improved / nothing to learn). */
  variant: NodeVariant;
  /** Whether a different variant was adopted. */
  adopted: boolean;
  /** Every candidate that was scored, for inspectability. */
  candidates: NodeVariant[];
}

/**
 * Run one self-optimization pass over a node variant: candidate construction
 * → evaluation → adopt the best. Returns the current variant unchanged when
 * there is only one candidate (nothing to learn from).
 */
export async function optimizeNodeVariant(config: NodeOptimizerConfig): Promise<OptimizerOutcome> {
  const {
    current,
    examples,
    revisePrompt,
    score,
    historyWindow = 4,
    maxDemonstrations = 6,
    learnDemonstrations = true,
    learnPrompt = true,
  } = config;

  const recent = examples.slice(-historyWindow);
  const positive = recent.filter((e) => e.success).map((e) => e.task);
  const negative = recent.filter((e) => !e.success).map((e) => e.task);

  const variants: NodeVariant[] = [current];
  const candidate = (prompt: string, demonstrations: string[]): NodeVariant => {
    const capped =
      demonstrations.length > maxDemonstrations
        ? demonstrations.slice(demonstrations.length - maxDemonstrations)
        : demonstrations;
    return { prompt, demonstrations: capped };
  };

  if (learnDemonstrations && positive.length > 0) {
    variants.push(candidate(current.prompt, [...current.demonstrations, ...positive]));
  }
  if (learnPrompt && negative.length > 0) {
    const revised = await revisePrompt(negative);
    variants.push(candidate(revised, current.demonstrations));
    if (learnDemonstrations && positive.length > 0) {
      variants.push(candidate(revised, [...current.demonstrations, ...positive]));
    }
  }

  if (variants.length === 1) {
    return { variant: current, adopted: false, candidates: variants };
  }

  const scored = await Promise.all(
    variants.map(async (variant) => ({ variant, points: await score(variant) })),
  );
  let best = scored[0]!;
  for (const entry of scored) {
    if (entry.points > best.points) best = entry;
  }

  const adopted =
    best.variant.prompt !== current.prompt ||
    best.variant.demonstrations.length !== current.demonstrations.length ||
    best.variant.demonstrations.some((d, i) => d !== current.demonstrations[i]);
  return { variant: best.variant, adopted, candidates: variants };
}
