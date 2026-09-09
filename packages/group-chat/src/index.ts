// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/group-chat — Multi-agent group chat patterns.
 *
 * Inspired by AutoGen's GroupChat implementations.
 * Provides Selector, RoundRobin, Swarm, and DiGraph group chat strategies
 * for orchestrating multi-agent conversations.
 */

import type { LLMRouter, LLMMessage } from "@nexus/llm-router";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ChatAgent {
  name: string;
  description: string;
  systemPrompt: string;
  execute: (messages: ChatMessage[], state: Record<string, unknown>) => Promise<string>;
}

export interface ChatMessage {
  role: string;
  content: string;
  timestamp: number;
  agentName?: string;
  type: "message" | "tool_call" | "tool_result" | "termination";
}

export interface TerminationCondition {
  maxTurns?: number;
  maxMessages?: number;
  custom?: (messages: ChatMessage[]) => boolean;
}

export interface GroupChatResult {
  messages: ChatMessage[];
  totalTurns: number;
  terminatedBy: string;
  durationMs: number;
}

// ── Selector Group Chat ──────────────────────────────────────────────────────

/**
 * LLM-based selector chooses the next speaker based on conversation context.
 */
export class SelectorGroupChat {
  private participants: ChatAgent[];
  private router: LLMRouter;
  private selectorAlias: string;
  private termination: TerminationCondition;
  private allowRepeated: boolean;

  constructor(
    participants: ChatAgent[],
    router: LLMRouter,
    options: {
      selectorAlias: string;
      termination?: TerminationCondition;
      allowRepeatedSpeaker?: boolean;
    },
  ) {
    this.participants = participants;
    this.router = router;
    this.selectorAlias = options.selectorAlias;
    this.termination = options.termination ?? { maxTurns: 10 };
    this.allowRepeated = options.allowRepeatedSpeaker ?? false;
  }

  async run(initialMessage: string): Promise<GroupChatResult> {
    const messages: ChatMessage[] = [
      { role: "user", content: initialMessage, timestamp: Date.now(), type: "message" },
    ];
    const start = Date.now();
    let lastSpeaker = "";

    for (let turn = 0; turn < (this.termination.maxTurns ?? 100); turn++) {
      // Select next speaker
      const speaker = await this.selectSpeaker(messages, lastSpeaker);
      if (!speaker) {
        return {
          messages,
          totalTurns: turn,
          terminatedBy: "no-speaker",
          durationMs: Date.now() - start,
        };
      }

      // Execute
      const response = await speaker.execute(messages, {});
      messages.push({
        role: speaker.name,
        content: response,
        timestamp: Date.now(),
        agentName: speaker.name,
        type: "message",
      });

      lastSpeaker = speaker.name;

      // Check termination
      if (this.shouldTerminate(messages)) {
        return {
          messages,
          totalTurns: turn + 1,
          terminatedBy: "condition",
          durationMs: Date.now() - start,
        };
      }
    }

    return {
      messages,
      totalTurns: this.termination.maxTurns ?? 100,
      terminatedBy: "max-turns",
      durationMs: Date.now() - start,
    };
  }

  private async selectSpeaker(
    messages: ChatMessage[],
    lastSpeaker: string,
  ): Promise<ChatAgent | null> {
    const agentDescriptions = this.participants
      .map((a) => `<agent name="${a.name}">\n${a.description}\n</agent>`)
      .join("\n\n");

    const conversation = messages
      .slice(-10)
      .map((m) => `${m.role}: ${m.content.slice(0, 200)}`)
      .join("\n");

    const prompt = [
      `Select the next speaker from the available agents.\n\n`,
      `Available agents:\n${agentDescriptions}\n\n`,
      `Conversation so far:\n${conversation}\n\n`,
      lastSpeaker ? `Last speaker: ${lastSpeaker}\n\n` : "",
      `Reply with the agent name only.`,
    ].join("");

    const resp = await this.router.complete({
      model: this.selectorAlias,
      messages: [{ role: "user", content: prompt }],
      maxTokens: 50,
    });

    const selectedName = resp.content.trim();
    return this.participants.find((a) => a.name === selectedName) ?? null;
  }

  private shouldTerminate(messages: ChatMessage[]): boolean {
    if (this.termination.maxMessages && messages.length >= this.termination.maxMessages) {
      return true;
    }
    if (this.termination.custom) {
      return this.termination.custom(messages);
    }
    // Check for termination message
    const last = messages[messages.length - 1];
    if (last?.type === "termination") return true;
    return false;
  }
}

// ── Round Robin Group Chat ───────────────────────────────────────────────────

/**
 * Agents take turns in a fixed round-robin order.
 */
export class RoundRobinGroupChat {
  private participants: ChatAgent[];
  private termination: TerminationCondition;

  constructor(participants: ChatAgent[], options?: { termination?: TerminationCondition }) {
    this.participants = participants;
    this.termination = options?.termination ?? { maxTurns: 10 };
  }

  async run(initialMessage: string): Promise<GroupChatResult> {
    const messages: ChatMessage[] = [
      { role: "user", content: initialMessage, timestamp: Date.now(), type: "message" },
    ];
    const start = Date.now();

    for (let turn = 0; turn < (this.termination.maxTurns ?? 100); turn++) {
      const agent = this.participants[turn % this.participants.length]!;
      const response = await agent.execute(messages, {});

      messages.push({
        role: agent.name,
        content: response,
        timestamp: Date.now(),
        agentName: agent.name,
        type: "message",
      });

      if (this.shouldTerminate(messages)) {
        return {
          messages,
          totalTurns: turn + 1,
          terminatedBy: "condition",
          durationMs: Date.now() - start,
        };
      }
    }

    return {
      messages,
      totalTurns: this.termination.maxTurns ?? 100,
      terminatedBy: "max-turns",
      durationMs: Date.now() - start,
    };
  }

  private shouldTerminate(messages: ChatMessage[]): boolean {
    if (this.termination.maxMessages && messages.length >= this.termination.maxMessages) {
      return true;
    }
    if (this.termination.custom) {
      return this.termination.custom(messages);
    }
    return false;
  }
}

// ── Swarm Group Chat ─────────────────────────────────────────────────────────

/**
 * Agents hand off to each other based on their responses.
 * Each agent can suggest the next speaker via a handoff pattern.
 */
export class SwarmGroupChat {
  private participants: ChatAgent[];
  private termination: TerminationCondition;
  private handoffMap: Map<string, string[]> = new Map();

  constructor(
    participants: ChatAgent[],
    options?: {
      termination?: TerminationCondition;
      handoffs?: Record<string, string[]>;
    },
  ) {
    this.participants = participants;
    this.termination = options?.termination ?? { maxTurns: 10 };
    if (options?.handoffs) {
      for (const [agent, targets] of Object.entries(options.handoffs)) {
        this.handoffMap.set(agent, targets);
      }
    }
  }

  async run(initialMessage: string, startAgent?: string): Promise<GroupChatResult> {
    const messages: ChatMessage[] = [
      { role: "user", content: initialMessage, timestamp: Date.now(), type: "message" },
    ];
    const start = Date.now();
    let currentAgentName = startAgent ?? this.participants[0]!.name;

    for (let turn = 0; turn < (this.termination.maxTurns ?? 100); turn++) {
      const agent = this.participants.find((a) => a.name === currentAgentName);
      if (!agent) break;

      const response = await agent.execute(messages, {});

      messages.push({
        role: agent.name,
        content: response,
        timestamp: Date.now(),
        agentName: agent.name,
        type: "message",
      });

      if (this.shouldTerminate(messages)) {
        return {
          messages,
          totalTurns: turn + 1,
          terminatedBy: "condition",
          durationMs: Date.now() - start,
        };
      }

      // Handoff: find next agent
      const handoffs = this.handoffMap.get(agent.name);
      if (handoffs && handoffs.length > 0) {
        // Simple: pick the first available handoff target
        currentAgentName = handoffs[0]!;
      } else {
        // Default: next in list
        const idx = this.participants.findIndex((a) => a.name === agent.name);
        currentAgentName = this.participants[(idx + 1) % this.participants.length]!.name;
      }
    }

    return {
      messages,
      totalTurns: this.termination.maxTurns ?? 100,
      terminatedBy: "max-turns",
      durationMs: Date.now() - start,
    };
  }

  private shouldTerminate(messages: ChatMessage[]): boolean {
    if (this.termination.maxMessages && messages.length >= this.termination.maxMessages) {
      return true;
    }
    if (this.termination.custom) {
      return this.termination.custom(messages);
    }
    return false;
  }
}

// ── DiGraph Group Chat ───────────────────────────────────────────────────────

/**
 * Agents follow a directed graph for conversation flow.
 */
export class DiGraphGroupChat {
  private participants: Map<string, ChatAgent>;
  private edges: Map<string, string[]>;
  private startNode: string;
  private endNodes: Set<string>;
  private termination: TerminationCondition;

  constructor(
    participants: ChatAgent[],
    edges: Array<[string, string]>,
    options: {
      startNode: string;
      endNodes: string[];
      termination?: TerminationCondition;
    },
  ) {
    this.participants = new Map(participants.map((a) => [a.name, a]));
    this.edges = new Map();
    for (const [from, to] of edges) {
      if (!this.edges.has(from)) this.edges.set(from, []);
      this.edges.get(from)!.push(to);
    }
    this.startNode = options.startNode;
    this.endNodes = new Set(options.endNodes);
    this.termination = options.termination ?? { maxTurns: 20 };
  }

  async run(initialMessage: string): Promise<GroupChatResult> {
    const messages: ChatMessage[] = [
      { role: "user", content: initialMessage, timestamp: Date.now(), type: "message" },
    ];
    const start = Date.now();
    let currentNode = this.startNode;

    for (let turn = 0; turn < (this.termination.maxTurns ?? 100); turn++) {
      const agent = this.participants.get(currentNode);
      if (!agent) break;

      const response = await agent.execute(messages, {});
      messages.push({
        role: agent.name,
        content: response,
        timestamp: Date.now(),
        agentName: agent.name,
        type: "message",
      });

      // Check if we've reached an end node
      if (this.endNodes.has(currentNode)) {
        return {
          messages,
          totalTurns: turn + 1,
          terminatedBy: "end-node",
          durationMs: Date.now() - start,
        };
      }

      // Follow the graph edge
      const nextNodes = this.edges.get(currentNode);
      if (!nextNodes || nextNodes.length === 0) {
        return {
          messages,
          totalTurns: turn + 1,
          terminatedBy: "no-edge",
          durationMs: Date.now() - start,
        };
      }

      currentNode = nextNodes[0]!;
    }

    return {
      messages,
      totalTurns: this.termination.maxTurns ?? 100,
      terminatedBy: "max-turns",
      durationMs: Date.now() - start,
    };
  }
}

export default SelectorGroupChat;
