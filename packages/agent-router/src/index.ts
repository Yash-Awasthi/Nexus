// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/agent-router — Classifier-based agent routing.
 *
 * Inspired by agent-squad's Classifier pattern.
 * Uses LLM-based classification to route user queries to the best agent,
 * with conversation history awareness for follow-up detection.
 */

import type { LLMRouter, LLMMessage } from "@nexus/llm-router";

// ── Types ────────────────────────────────────────────────────────────────────

export interface AgentDescription {
  name: string;
  description: string;
  capabilities: string[];
}

export interface ClassifierResult {
  selectedAgent: string;
  confidence: number;
  reasoning: string;
}

export interface ConversationEntry {
  role: "user" | "assistant";
  content: string;
  agentName?: string;
  timestamp: number;
}

// ── Classifier ───────────────────────────────────────────────────────────────

export class AgentClassifier {
  private history: ConversationEntry[] = [];
  private maxHistory = 20;

  constructor(
    private router: LLMRouter,
    private classifierAlias: string,
  ) {}

  /**
   * Classify a user message and select the best agent.
   */
  async classify(
    userMessage: string,
    agents: AgentDescription[],
    options?: { systemOverride?: string },
  ): Promise<ClassifierResult> {
    const agentDescriptions = agents
      .map(
        (a) =>
          `<agent name="${a.name}">\n${a.description}\nCapabilities: ${a.capabilities.join(", ")}\n</agent>`,
      )
      .join("\n\n");

    const historyContext = this.buildHistoryContext();

    const systemPrompt = options?.systemOverride ?? this.defaultSystemPrompt;
    const userPrompt = [
      historyContext ? `Previous conversation:\n${historyContext}\n\n` : "",
      `Available agents:\n<agents>\n${agentDescriptions}\n</agents>\n\n`,
      `User message: "${userMessage}"\n\n`,
      `Select the best agent for this message. Reply with JSON:\n`,
      `{"agent": "<agent-name>", "confidence": 0.0-1.0, "reasoning": "brief explanation"}`,
    ].join("");

    const resp = await this.router.complete({
      model: this.classifierAlias,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      maxTokens: 256,
    });

    // Parse response
    let result: ClassifierResult;
    try {
      const jsonMatch = resp.content.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : resp.content);
      result = {
        selectedAgent: parsed.agent ?? agents[0]?.name ?? "unknown",
        confidence: Math.max(0, Math.min(1, parsed.confidence ?? 0.5)),
        reasoning: parsed.reasoning ?? "",
      };
    } catch {
      result = {
        selectedAgent: agents[0]?.name ?? "unknown",
        confidence: 0.3,
        reasoning: "Failed to parse classifier response",
      };
    }

    // Record in history
    this.history.push({
      role: "user",
      content: userMessage,
      timestamp: Date.now(),
    });

    return result;
  }

  /**
   * Record an agent response in conversation history.
   */
  recordResponse(agentName: string, response: string): void {
    this.history.push({
      role: "assistant",
      content: response,
      agentName,
      timestamp: Date.now(),
    });

    // Trim history
    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(-this.maxHistory);
    }
  }

  /**
   * Clear conversation history.
   */
  clearHistory(): void {
    this.history = [];
  }

  /**
   * Get conversation history.
   */
  getHistory(): ConversationEntry[] {
    return [...this.history];
  }

  private buildHistoryContext(): string {
    if (this.history.length === 0) return "";

    return this.history
      .slice(-10)
      .map((entry) => {
        const agentInfo = entry.agentName ? ` (agent: ${entry.agentName})` : "";
        return `${entry.role}${agentInfo}: ${entry.content.slice(0, 200)}`;
      })
      .join("\n");
  }

  private defaultSystemPrompt = [
    "You are AgentMatcher, an intelligent assistant designed to analyze user queries ",
    "and match them with the most suitable agent. Your task is to understand the user's ",
    "request, identify key entities and intents, and determine which agent would be ",
    "best equipped to handle the query.\n\n",
    "Important: The user's input may be a follow-up response to a previous interaction. ",
    "The conversation history is provided. If the user's input appears to be a continuation ",
    "of the previous conversation, select the same agent as before.\n\n",
    'Reply with JSON only: {"agent": "<name>", "confidence": 0.0-1.0, "reasoning": "brief"}',
  ].join("");
}

// ── Supervisor ───────────────────────────────────────────────────────────────

export interface SupervisorConfig<T extends Record<string, unknown>> {
  classifier: AgentClassifier;
  agents: Map<string, { name: string; execute: (input: string, state: T) => Promise<string> }>;
  maxIterations?: number;
}

export class AgentSupervisor<T extends Record<string, unknown>> {
  private config: SupervisorConfig<T>;
  private maxIterations: number;

  constructor(config: SupervisorConfig<T>) {
    this.config = config;
    this.maxIterations = config.maxIterations ?? 10;
  }

  /**
   * Process a user message through the supervisor.
   * Classifies the intent, routes to the best agent, and handles follow-ups.
   */
  async process(
    userMessage: string,
    state: T,
  ): Promise<{
    agentName: string;
    response: string;
    confidence: number;
  }> {
    const agentDescriptions: AgentDescription[] = Array.from(this.config.agents.values()).map(
      (a) => ({
        name: a.name,
        description: a.name,
        capabilities: [],
      }),
    );

    const classification = await this.config.classifier.classify(userMessage, agentDescriptions);

    const agent = this.config.agents.get(classification.selectedAgent);
    if (!agent) {
      return {
        agentName: "unknown",
        response: "I'm not sure which agent can help with that.",
        confidence: classification.confidence,
      };
    }

    const response = await agent.execute(userMessage, state);

    this.config.classifier.recordResponse(agent.name, response);

    return {
      agentName: agent.name,
      response,
      confidence: classification.confidence,
    };
  }
}

export default AgentClassifier;
