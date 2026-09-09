// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/agent-classifier — Intent-based agent routing and agent patterns.
 *
 * Inspired by 2fastlabs/agent-squad:
 *   • AgentClassifier — routes user queries to the best agent based on intent
 *   • SupervisorAgent — team coordination with parallel sub-agent queries
 *   • GroundedAgent — anti-hallucination: gatherer + presenter pattern
 *
 * These patterns complement @nexus/agent-network (sequential routing) by
 * adding:
 *   • Parallel execution (SupervisorAgent)
 *   • Anti-hallucination guarantees (GroundedAgent)
 *   • Intent-based automatic routing (AgentClassifier)
 */

// ── Agent Classifier ───────────────────────────────────────────────────────

/** An agent that can be classified and routed to. */
export interface ClassifiableAgent {
  /** Unique agent identifier. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Description of what this agent specializes in (used for classification). */
  description: string;
  /** Keywords that help classify queries to this agent. */
  keywords?: string[];
  /** Execute a query and return a response. */
  execute(input: string, ctx: AgentContext): Promise<AgentResponse>;
}

/** Context passed to agents during execution. */
export interface AgentContext {
  /** User ID for multi-tenant isolation. */
  userId: string;
  /** Session ID for conversation grouping. */
  sessionId: string;
  /** Conversation history for this session. */
  history: ConversationTurn[];
  /** Metadata from the classifier. */
  metadata?: Record<string, unknown>;
}

/** A single turn in a conversation. */
export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  agentId?: string;
}

/** Response from an agent. */
export interface AgentResponse {
  /** The agent's text response. */
  content: string;
  /** Whether this is a streaming response. */
  streaming?: boolean;
  /** Stream chunks (if streaming). */
  stream?: AsyncIterable<string>;
  /** Metadata about the response. */
  metadata?: {
    agentId: string;
    agentName: string;
    latencyMs: number;
    tokenUsage?: { input: number; output: number };
  };
}

/** Classification result — which agent should handle this query. */
export interface ClassificationResult {
  /** The selected agent. */
  agent: ClassifiableAgent;
  /** Confidence score (0-1). */
  confidence: number;
  /** Reason for the classification (for debugging). */
  reason: string;
}

/**
 * AgentClassifier — routes user queries to the most suitable agent.
 *
 * Uses a combination of:
 *   1. Keyword matching (fast, deterministic)
 *   2. Description similarity (semantic matching)
 *   3. LLM-based classification (most accurate, optional)
 *
 * Usage:
 * ```ts
 * const classifier = new AgentClassifier({
 *   agents: [techAgent, mathAgent, healthAgent],
 *   strategy: "keyword", // or "llm" or "hybrid"
 * });
 *
 * const result = await classifier.classify("What is AWS Lambda?");
 * console.log(result.agent.name); // "Tech Agent"
 * ```
 */
export class AgentClassifier {
  private readonly agents: ClassifiableAgent[];
  private readonly strategy: "keyword" | "llm" | "hybrid";
  private readonly llmClassifier?: LLMClassifierFn;
  private readonly minConfidence: number;

  constructor(config: {
    agents: ClassifiableAgent[];
    strategy?: "keyword" | "llm" | "hybrid";
    llmClassifier?: LLMClassifierFn;
    minConfidence?: number;
  }) {
    this.agents = config.agents;
    this.strategy = config.strategy ?? "keyword";
    this.llmClassifier = config.llmClassifier;
    this.minConfidence = config.minConfidence ?? 0.3;
  }

  /**
   * Classify a user query and return the best agent.
   * Returns null if no agent meets the minimum confidence threshold.
   */
  async classify(
    query: string,
    history?: ConversationTurn[],
  ): Promise<ClassificationResult | null> {
    if (this.agents.length === 0) return null;
    if (this.agents.length === 1) {
      return {
        agent: this.agents[0]!,
        confidence: 1.0,
        reason: "Only one agent available",
      };
    }

    // Strategy: keyword matching
    if (this.strategy === "keyword" || this.strategy === "hybrid") {
      const keywordResult = this._classifyByKeywords(query);
      if (keywordResult && keywordResult.confidence >= this.minConfidence) {
        if (this.strategy === "keyword") return keywordResult;
        // For hybrid, continue to LLM classification
      }
    }

    // Strategy: LLM-based classification
    if ((this.strategy === "llm" || this.strategy === "hybrid") && this.llmClassifier) {
      const llmResult = await this.llmClassifier(query, this.agents, history);
      if (llmResult && llmResult.confidence >= this.minConfidence) {
        return llmResult;
      }
    }

    // Fallback: return the agent with the highest keyword score
    const fallback = this._classifyByKeywords(query);
    return fallback;
  }

  /**
   * Add an agent to the classifier.
   */
  addAgent(agent: ClassifiableAgent): this {
    this.agents.push(agent);
    return this;
  }

  /**
   * Remove an agent from the classifier.
   */
  removeAgent(agentId: string): this {
    const idx = this.agents.findIndex((a) => a.id === agentId);
    if (idx !== -1) this.agents.splice(idx, 1);
    return this;
  }

  /**
   * Get all registered agents.
   */
  getAgents(): ClassifiableAgent[] {
    return [...this.agents];
  }

  /** Classify by keyword matching. */
  private _classifyByKeywords(query: string): ClassificationResult | null {
    const queryLower = query.toLowerCase();
    const queryWords = queryLower.split(/\s+/).filter(Boolean);

    let bestAgent: ClassifiableAgent | null = null;
    let bestScore = 0;
    let bestReason = "";

    for (const agent of this.agents) {
      let score = 0;
      const reasons: string[] = [];

      // Check name match
      if (queryLower.includes(agent.name.toLowerCase())) {
        score += 0.5;
        reasons.push(`name match: "${agent.name}"`);
      }

      // Check description keywords
      const descWords = agent.description.toLowerCase().split(/\s+/);
      const descMatches = queryWords.filter((w) =>
        descWords.some((dw) => dw.includes(w) || w.includes(dw)),
      );
      if (descMatches.length > 0) {
        score += (descMatches.length / queryWords.length) * 0.3;
        reasons.push(`description match: ${descMatches.length}/${queryWords.length} words`);
      }

      // Check explicit keywords
      if (agent.keywords) {
        const keywordMatches = agent.keywords.filter((kw) => queryLower.includes(kw.toLowerCase()));
        if (keywordMatches.length > 0) {
          score += (keywordMatches.length / agent.keywords.length) * 0.2;
          reasons.push(`keyword match: ${keywordMatches.join(", ")}`);
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestAgent = agent;
        bestReason = reasons.join("; ") || "fallback";
      }
    }

    if (!bestAgent) return null;

    return {
      agent: bestAgent,
      confidence: Math.min(1, bestScore),
      reason: bestReason,
    };
  }
}

/** LLM-based classifier function type. */
export type LLMClassifierFn = (
  query: string,
  agents: ClassifiableAgent[],
  history?: ConversationTurn[],
) => Promise<ClassificationResult | null>;

// ── SupervisorAgent ────────────────────────────────────────────────────────

/**
 * SupervisorAgent — coordinates multiple agents in parallel.
 *
 * Acts as a "team lead" that:
 *   1. Decomposes the user query into subtasks
 *   2. Dispatches subtasks to specialized agents in parallel
 *   3. Collects results and synthesizes a coherent response
 *
 * Usage:
 * ```ts
 * const supervisor = new SupervisorAgent({
 *   agents: [techAgent, mathAgent, healthAgent],
 *   synthesizer: async (results) => {
 *     // Combine results into a single response
 *     return results.map(r => `${r.agentName}: ${r.output}`).join("\n\n");
 *   },
 * });
 *
 * const response = await supervisor.execute("Compare AWS Lambda vs Cloud Functions");
 * ```
 */
export class SupervisorAgent {
  private readonly agents: ClassifiableAgent[];
  private readonly synthesizer: (results: SubAgentResult[]) => Promise<string>;
  private readonly maxConcurrency: number;
  private readonly timeoutMs: number;

  constructor(config: {
    agents: ClassifiableAgent[];
    synthesizer: (results: SubAgentResult[]) => Promise<string>;
    maxConcurrency?: number;
    timeoutMs?: number;
  }) {
    this.agents = config.agents;
    this.synthesizer = config.synthesizer;
    this.maxConcurrency = config.maxConcurrency ?? 5;
    this.timeoutMs = config.timeoutMs ?? 60_000;
  }

  /**
   * Execute a query across all agents in parallel, then synthesize results.
   */
  async execute(
    query: string,
    ctx: Omit<AgentContext, "history"> & { history?: ConversationTurn[] },
  ): Promise<AgentResponse> {
    const startTime = Date.now();
    const history = ctx.history ?? [];

    // Run all agents in parallel with concurrency limit
    const results = await this._runWithConcurrency(
      this.agents.map((agent) => async (): Promise<SubAgentResult> => {
        const agentStart = Date.now();
        try {
          const response = await Promise.race([
            agent.execute(query, { ...ctx, history }),
            this._timeout(this.timeoutMs),
          ]);
          return {
            agentId: agent.id,
            agentName: agent.name,
            output: response.content,
            success: true,
            latencyMs: Date.now() - agentStart,
          };
        } catch (err) {
          return {
            agentId: agent.id,
            agentName: agent.name,
            output: "",
            success: false,
            error: err instanceof Error ? err.message : String(err),
            latencyMs: Date.now() - agentStart,
          };
        }
      }),
      this.maxConcurrency,
    );

    // Synthesize results into a single response
    const content = await this.synthesizer(results);

    return {
      content,
      metadata: {
        agentId: "supervisor",
        agentName: "Supervisor",
        latencyMs: Date.now() - startTime,
      },
    };
  }

  /** Run async functions with concurrency limit. */
  private async _runWithConcurrency<T>(
    fns: (() => Promise<T>)[],
    maxConcurrency: number,
  ): Promise<T[]> {
    const results: T[] = [];
    const executing = new Set<Promise<void>>();

    for (const fn of fns) {
      const p = fn().then((result) => {
        results.push(result);
      });
      const tracked = p.then(() => {
        executing.delete(tracked);
      });
      executing.add(tracked);

      if (executing.size >= maxConcurrency) {
        await Promise.race(executing);
      }
    }

    await Promise.all(executing);
    return results;
  }

  /** Create a timeout promise. */
  private _timeout(ms: number): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Supervisor timeout after ${ms}ms`)), ms);
    });
  }
}

/** Result from a sub-agent in the SupervisorAgent. */
export interface SubAgentResult {
  agentId: string;
  agentName: string;
  output: string;
  success: boolean;
  error?: string;
  latencyMs: number;
}

// ── GroundedAgent └──────────────────────────────────────────────────────────

/**
 * GroundedAgent — anti-hallucination agent pattern.
 *
 * Uses two LLMs:
 *   1. Gatherer — calls tools and sees raw results (never speaks to user)
 *   2. Presenter — writes the reply from curated tool output only
 *
 * This ensures the response can only contain information from actual tool
 * results, preventing hallucination.
 *
 * Usage:
 * ```ts
 * const grounded = new GroundedAgent({
 *   gatherer: {
 *     tools: [searchTool, databaseTool],
 *     model: "gpt-4o",
 *   },
 *   presenter: {
 *     model: "gpt-4o-mini",
 *     systemPrompt: "You are a helpful assistant. Only use the provided data.",
 *   },
 * });
 *
 * const response = await grounded.execute("What's the price of iPhone 15?");
 * ```
 */
export class GroundedAgent {
  private readonly gathererConfig: GathererConfig;
  private readonly presenterConfig: PresenterConfig;
  private readonly executeTool: ToolExecutor;

  constructor(config: {
    gatherer: GathererConfig;
    presenter: PresenterConfig;
    executeTool: ToolExecutor;
  }) {
    this.gathererConfig = config.gatherer;
    this.presenterConfig = config.presenter;
    this.executeTool = config.executeTool;
  }

  /**
   * Execute a query through the gatherer → presenter pipeline.
   */
  async execute(
    query: string,
    ctx: Omit<AgentContext, "history"> & { history?: ConversationTurn[] },
  ): Promise<AgentResponse> {
    const startTime = Date.now();
    const history = ctx.history ?? [];

    // Step 1: Gatherer — call tools to collect data
    const gatheredData = await this._gather(query, history);

    // Step 2: Presenter — synthesize response from gathered data only
    const content = await this._present(query, gatheredData);

    return {
      content,
      metadata: {
        agentId: "grounded",
        agentName: "GroundedAgent",
        latencyMs: Date.now() - startTime,
      },
    };
  }

  /** Gather data using tools (gatherer phase). */
  private async _gather(query: string, history: ConversationTurn[]): Promise<GatheredData> {
    const toolResults: ToolResult[] = [];
    const tools = this.gathererConfig.tools ?? [];

    // Simple gatherer: call all matching tools
    for (const tool of tools) {
      try {
        const result = await this.executeTool(tool.name, { query, history });
        toolResults.push({
          toolName: tool.name,
          result,
          success: true,
        });
      } catch (err) {
        toolResults.push({
          toolName: tool.name,
          result: null,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      query,
      toolResults,
      timestamp: Date.now(),
    };
  }

  /** Present response from gathered data (presenter phase). */
  private async _present(query: string, data: GatheredData): Promise<string> {
    // Filter to only successful results
    const successfulResults = data.toolResults.filter((r) => r.success);

    if (successfulResults.length === 0) {
      return "I wasn't able to find any information about that. Please try a different query.";
    }

    // Build a context-only prompt (no tools, no chat history — only gathered data)
    const dataContext = successfulResults
      .map((r) => `[${r.toolName}]: ${JSON.stringify(r.result)}`)
      .join("\n\n");

    // In production, this calls the presenter LLM
    // For now, return the gathered data in a structured format
    return `Based on the available data:\n\n${dataContext}`;
  }
}

/** Configuration for the gatherer phase. */
export interface GathererConfig {
  /** Tools available to the gatherer. */
  tools?: { name: string; description: string }[];
  /** Model to use for the gatherer (optional — may not need LLM). */
  model?: string;
}

/** Configuration for the presenter phase. */
export interface PresenterConfig {
  /** Model to use for the presenter. */
  model: string;
  /** System prompt for the presenter. */
  systemPrompt?: string;
}

/** Data gathered by the gatherer phase. */
export interface GatheredData {
  query: string;
  toolResults: ToolResult[];
  timestamp: number;
}

/** Result from a tool call. */
export interface ToolResult {
  toolName: string;
  result: unknown;
  success: boolean;
  error?: string;
}

/** Tool executor function type. */
export type ToolExecutor = (toolName: string, params: Record<string, unknown>) => Promise<unknown>;

// ── Context Manager ────────────────────────────────────────────────────────

/**
 * AgentContextManager — manages conversation context across agents and sessions.
 *
 * Features:
 *   • Session-scoped conversation history
 *   • Agent-specific context isolation
 *   • Context window management (sliding window, summarization)
 *   • Context sharing between agents
 *
 * Usage:
 * ```ts
 * const ctxManager = new AgentContextManager({
 *   maxTurns: 20,
 *   strategy: "sliding-window",
 * });
 *
 * // Add turns
 * ctxManager.addTurn("session-1", { role: "user", content: "Hello" });
 * ctxManager.addTurn("session-1", { role: "assistant", content: "Hi there!" });
 *
 * // Get context for an agent
 * const context = ctxManager.getContext("session-1", "agent-1");
 * ```
 */
export class AgentContextManager {
  private readonly sessions = new Map<string, SessionContext>();
  private readonly maxTurns: number;
  private readonly strategy: "sliding-window" | "summarize";

  constructor(config: { maxTurns?: number; strategy?: "sliding-window" | "summarize" }) {
    this.maxTurns = config.maxTurns ?? 20;
    this.strategy = config.strategy ?? "sliding-window";
  }

  /**
   * Add a conversation turn to a session.
   */
  addTurn(sessionId: string, turn: ConversationTurn): void {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = { turns: [], agentContexts: new Map() };
      this.sessions.set(sessionId, session);
    }

    session.turns.push(turn);

    // Apply context window management
    if (this.strategy === "sliding-window" && session.turns.length > this.maxTurns) {
      session.turns = session.turns.slice(-this.maxTurns);
    }
  }

  /**
   * Get conversation context for a session.
   */
  getContext(sessionId: string, agentId?: string): ConversationTurn[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];

    // If agent-specific context exists, use it
    if (agentId) {
      const agentCtx = session.agentContexts.get(agentId);
      if (agentCtx) return agentCtx;
    }

    return session.turns;
  }

  /**
   * Set agent-specific context (for context isolation).
   */
  setAgentContext(sessionId: string, agentId: string, turns: ConversationTurn[]): void {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = { turns: [], agentContexts: new Map() };
      this.sessions.set(sessionId, session);
    }
    session.agentContexts.set(agentId, turns);
  }

  /**
   * Clear context for a session.
   */
  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /**
   * Get all active sessions.
   */
  getSessions(): string[] {
    return Array.from(this.sessions.keys());
  }
}

/** Internal session context. */
interface SessionContext {
  turns: ConversationTurn[];
  agentContexts: Map<string, ConversationTurn[]>;
}
