// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/agent-network — Multi-agent network with shared state.
 *
 * Inspired by Inngest's AgentKit Network pattern.
 * Provides typed shared state, deterministic routing, and agent handoff.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface AgentConfig<T extends Record<string, unknown>> {
  name: string;
  description?: string;
  systemPrompt: string;
  tools?: Tool<T>[];
  handoffTo?: (state: T) => string | null;
}

export interface Tool<T extends Record<string, unknown>> {
  name: string;
  description: string;
  parameters: Record<string, { type: string; description: string; required?: boolean }>;
  execute: (params: Record<string, unknown>, state: T) => Promise<string>;
}

export interface AgentResult {
  agentName: string;
  output: string;
  toolCalls: Array<{ tool: string; result: string }>;
  durationMs: number;
  handoffTo?: string;
}

export interface NetworkConfig<T extends Record<string, unknown>> {
  name: string;
  description?: string;
  agents: AgentConfig<T>[];
  initialState: T;
  maxIterations?: number;
}

// ── State ────────────────────────────────────────────────────────────────────

export class State<T extends Record<string, unknown>> {
  private data: T;
  private history: Array<{ key: keyof T; value: unknown; timestamp: number }> = [];

  constructor(initial: T) {
    this.data = { ...initial };
  }

  get<K extends keyof T>(key: K): T[K] {
    return this.data[key];
  }

  set<K extends keyof T>(key: K, value: T[K]): void {
    const oldValue = this.data[key];
    this.data[key] = value;
    this.history.push({ key, value, timestamp: Date.now() });
  }

  getAll(): Readonly<T> {
    return this.data;
  }

  getHistory(): Array<{ key: keyof T; value: unknown; timestamp: number }> {
    return [...this.history];
  }

  snapshot(): T {
    return { ...this.data };
  }
}

// ── Network ──────────────────────────────────────────────────────────────────

export class AgentNetwork<T extends Record<string, unknown>> {
  private agents: Map<string, AgentConfig<T>>;
  private state: State<T>;
  private maxIterations: number;
  private executionLog: AgentResult[] = [];

  constructor(config: NetworkConfig<T>) {
    this.agents = new Map(config.agents.map((a) => [a.name, a]));
    this.state = new State(config.initialState);
    this.maxIterations = config.maxIterations ?? 20;
  }

  getState(): State<T> {
    return this.state;
  }

  getAgent(name: string): AgentConfig<T> | undefined {
    return this.agents.get(name);
  }

  /**
   * Execute the network starting from the first agent.
   * Routes through agents based on handoff rules.
   */
  async execute(
    input: string,
    executor: (agent: AgentConfig<T>, state: State<T>, input: string) => Promise<AgentResult>,
  ): Promise<AgentResult[]> {
    const results: AgentResult[] = [];
    const agentNames = Array.from(this.agents.keys());
    let currentAgent = agentNames[0];
    let currentInput = input;
    let iterations = 0;

    while (currentAgent && iterations < this.maxIterations) {
      const agent = this.agents.get(currentAgent);
      if (!agent) break;

      const result = await executor(agent, this.state, currentInput);
      results.push(result);
      this.executionLog.push(result);

      // Check for handoff
      if (agent.handoffTo) {
        const nextAgent = agent.handoffTo(this.state.getAll());
        if (nextAgent && this.agents.has(nextAgent)) {
          currentAgent = nextAgent;
          currentInput = result.output;
          iterations++;
          continue;
        }
      }

      // No handoff — we're done
      break;
    }

    return results;
  }

  /**
   * Route to the best agent for a given input.
   */
  route(input: string): AgentConfig<T> | null {
    const agentNames = Array.from(this.agents.keys());

    // Simple keyword-based routing
    const lowerInput = input.toLowerCase();
    for (const name of agentNames) {
      const agent = this.agents.get(name)!;
      if (agent.description) {
        const words = agent.description.toLowerCase().split(/\s+/);
        const matchCount = words.filter((w) => lowerInput.includes(w)).length;
        if (matchCount > 0) {
          return agent;
        }
      }
    }

    // Default to first agent
    return this.agents.get(agentNames[0]) ?? null;
  }

  getExecutionLog(): AgentResult[] {
    return [...this.executionLog];
  }
}

export default AgentNetwork;
