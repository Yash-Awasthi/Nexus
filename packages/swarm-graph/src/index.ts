// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/swarm-graph — Graph-based agent swarm construction.
 *
 * Inspired by GPTSwarm's Graph class.
 * Build agent workflows as directed graphs of nodes, with global memory,
 * visualization, and multi-step execution.
 */

import type { LLMRouter } from "@nexus/llm-router";

// ── Types ────────────────────────────────────────────────────────────────────

export interface NodeContext {
  input: string;
  memory: GlobalMemory;
  model: string;
  step: number;
  graphId: string;
}

export interface NodeOutput {
  content: string;
  metadata?: Record<string, unknown>;
}

export interface SwarmConfig {
  domain: string;
  modelAlias?: string;
  maxSteps?: number;
}

// ── Global Memory ────────────────────────────────────────────────────────────

export class GlobalMemory {
  private static instance: GlobalMemory;
  private store: Map<string, unknown> = new Map();
  private history: Array<{ key: string; value: unknown; timestamp: number }> = [];

  static getInstance(): GlobalMemory {
    if (!GlobalMemory.instance) {
      GlobalMemory.instance = new GlobalMemory();
    }
    return GlobalMemory.instance;
  }

  set(key: string, value: unknown): void {
    this.store.set(key, value);
    this.history.push({ key, value, timestamp: Date.now() });
  }

  get<T = unknown>(key: string): T | undefined {
    return this.store.get(key) as T | undefined;
  }

  has(key: string): boolean {
    return this.store.has(key);
  }

  keys(): string[] {
    return Array.from(this.store.keys());
  }

  getAll(): Map<string, unknown> {
    return new Map(this.store);
  }

  clear(): void {
    this.store.clear();
    this.history = [];
  }

  getHistory(): Array<{ key: string; value: unknown; timestamp: number }> {
    return [...this.history];
  }
}

// ── Graph Node ───────────────────────────────────────────────────────────────

export abstract class SwarmNode {
  abstract readonly name: string;
  abstract execute(context: NodeContext): Promise<NodeOutput>;
}

/**
 * LLM-powered node that calls an LLM with a prompt.
 */
export class LLMNode extends SwarmNode {
  readonly name: string;
  private prompt: string;
  private router: LLMRouter;

  constructor(name: string, router: LLMRouter, prompt: string) {
    super();
    this.name = name;
    this.router = router;
    this.prompt = prompt;
  }

  /** Current prompt template (for the self-optimizer to read). */
  get promptText(): string {
    return this.prompt;
  }

  /** Adopt an optimizer-produced variant (replaces the prompt template). */
  applyVariant(variant: { prompt: string }): void {
    this.prompt = variant.prompt;
  }

  async execute(context: NodeContext): Promise<NodeOutput> {
    const fullPrompt = this.prompt
      .replace("{{input}}", context.input)
      .replace("{{domain}}", context.memory.get("domain") ?? "general");

    const resp = await this.router.complete({
      model: context.model,
      messages: [{ role: "user", content: fullPrompt }],
      maxTokens: 2048,
    });

    return { content: resp.content };
  }
}

/**
 * Decision node that routes based on content analysis.
 */
export class DecisionNode extends SwarmNode {
  readonly name: string;
  private router: LLMRouter;
  private routes: Map<string, SwarmNode>;

  constructor(name: string, router: LLMRouter, routes: Map<string, SwarmNode>) {
    super();
    this.name = name;
    this.router = router;
    this.routes = routes;
  }

  async execute(context: NodeContext): Promise<NodeOutput> {
    const routeNames = Array.from(this.routes.keys());
    const prompt = [
      `Based on the following content, select the best next step.`,
      `Available routes: ${routeNames.join(", ")}`,
      `\nContent: ${context.input.slice(0, 500)}`,
      `\nReply with only the route name.`,
    ].join("\n");

    const resp = await this.router.complete({
      model: context.model,
      messages: [{ role: "user", content: prompt }],
      maxTokens: 50,
    });

    const selectedRoute = resp.content.trim();
    const node = this.routes.get(selectedRoute) ?? this.routes.values().next().value;

    if (node) {
      const result = await node.execute(context);
      return result;
    }

    return { content: context.input };
  }
}

/**
 * Aggregation node that combines multiple inputs.
 */
export class AggregateNode extends SwarmNode {
  readonly name: string;
  private router: LLMRouter;
  private prompt: string;

  constructor(name: string, router: LLMRouter, prompt?: string) {
    super();
    this.name = name;
    this.router = router;
    this.prompt =
      prompt ?? "Synthesize the following information into a coherent response:\n\n{{input}}";
  }

  async execute(context: NodeContext): Promise<NodeOutput> {
    const fullPrompt = this.prompt.replace("{{input}}", context.input);
    const resp = await this.router.complete({
      model: context.model,
      messages: [{ role: "user", content: fullPrompt }],
      maxTokens: 2048,
    });
    return { content: resp.content };
  }
}

// ── Swarm Graph ──────────────────────────────────────────────────────────────

export class SwarmGraph {
  private nodes: Map<string, SwarmNode> = new Map();
  private edges: Array<{ from: string; to: string }> = [];
  private inputNodes: string[] = [];
  private outputNodes: string[] = [];
  private config: SwarmConfig;
  private router: LLMRouter;
  private memory: GlobalMemory;

  constructor(config: SwarmConfig, router: LLMRouter) {
    this.config = config;
    this.router = router;
    this.memory = GlobalMemory.getInstance();
    this.memory.set("domain", config.domain);
  }

  /**
   * Add a node to the graph.
   */
  addNode(node: SwarmNode): this {
    this.nodes.set(node.name, node);
    return this;
  }

  /**
   * Add an edge between two nodes.
   */
  addEdge(from: string, to: string): this {
    this.edges.push({ from, to });
    return this;
  }

  /**
   * Set input nodes (entry points).
   */
  setInputNodes(...names: string[]): this {
    this.inputNodes = names;
    return this;
  }

  /**
   * Set output nodes (exit points).
   */
  setOutputNodes(...names: string[]): this {
    this.outputNodes = names;
    return this;
  }

  /**
   * Run the graph with an input.
   */
  async run(
    input: string,
  ): Promise<{ output: string; steps: Array<{ node: string; input: string; output: string }> }> {
    const steps: Array<{ node: string; input: string; output: string }> = [];
    let currentInput = input;
    const maxSteps = this.config.maxSteps ?? 10;

    // Start from input nodes
    let activeNodes = [...this.inputNodes];

    for (let step = 0; step < maxSteps && activeNodes.length > 0; step++) {
      const nextNodes: string[] = [];

      for (const nodeName of activeNodes) {
        const node = this.nodes.get(nodeName);
        if (!node) continue;

        const context: NodeContext = {
          input: currentInput,
          memory: this.memory,
          model: this.config.modelAlias ?? "openai/gpt-4o",
          step,
          graphId: `graph-${Date.now()}`,
        };

        const result = await node.execute(context);
        steps.push({ node: nodeName, input: currentInput, output: result.content });

        // Store in memory
        this.memory.set(`step-${step}-${nodeName}`, result.content);

        // Update input for next nodes
        currentInput = result.content;

        // Find next nodes
        for (const edge of this.edges) {
          if (edge.from === nodeName && this.nodes.has(edge.to)) {
            nextNodes.push(edge.to);
          }
        }
      }

      activeNodes = nextNodes;
    }

    return { output: currentInput, steps };
  }

  /**
   * Visualize the graph as text.
   */
  visualize(): string {
    const lines: string[] = [];
    lines.push(`=== Swarm Graph: ${this.config.domain} ===`);
    lines.push(`Nodes: ${this.nodes.size}`);
    lines.push(`Edges: ${this.edges.length}`);
    lines.push("");

    for (const [name, node] of this.nodes) {
      const isInput = this.inputNodes.includes(name);
      const isOutput = this.outputNodes.includes(name);
      const prefix = isInput ? "▶ " : isOutput ? "■ " : "  ";
      lines.push(`${prefix}${name} (${node.constructor.name})`);
    }

    lines.push("");
    lines.push("Edges:");
    for (const edge of this.edges) {
      lines.push(`  ${edge.from} → ${edge.to}`);
    }

    return lines.join("\n");
  }

  /**
   * Get the memory instance.
   */
  getMemory(): GlobalMemory {
    return this.memory;
  }
}

export default SwarmGraph;

export * from "./optimizer.js";
