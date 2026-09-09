// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/agent-audit-handlers — Framework-specific audit capture handlers.
 *
 * Inspired by air-trust's drop-in wrappers that capture prompts, completions,
 * tool calls, intermediate reasoning, token counts, latency, and error states
 * from popular agent frameworks — all written to the same HMAC audit chain.
 *
 * Features:
 *   • AuditCaptureHandler   — generic capture handler interface
 *   • LangChainHandler      — drop-in callback for LangChain
 *   • CrewAIHandler         — drop-in callback for CrewAI
 *   • OpenAIHandler         — drop-in handler for OpenAI Agents SDK
 *   • AutoGenHandler        — drop-in handler for AutoGen
 *   • HaystackHandler       — drop-in handler for Haystack
 *   • ADKHandler            — drop-in handler for Google ADK
 *   • UnifiedEventFactory   — normalize framework events into audit entries
 *   • AuditCollector        — aggregate events into structured episodes
 */

// ── Types ─────────────────────────────────────────────────────────────────────

/** Event types captured from agent frameworks. */
export type AuditEventType =
  | "prompt"
  | "completion"
  | "tool_call"
  | "tool_result"
  | "error"
  | "session_start"
  | "session_end"
  | "reasoning"
  | "guardrail_check"
  | "human_intervention";

/** A normalized audit event from any framework. */
export interface AuditEvent {
  /** Unique event ID. */
  id: string;
  /** Type of event. */
  eventType: AuditEventType;
  /** Framework that produced this event. */
  framework: string;
  /** Name of the agent/chain/pipeline. */
  agentName?: string;
  /** Session/run ID for grouping. */
  sessionId: string;
  /** Timestamp (ISO-8601). */
  timestamp: string;
  /** Input prompt or message. */
  input?: string;
  /** Output completion or result. */
  output?: string;
  /** Tool name (for tool_call/tool_result events). */
  toolName?: string;
  /** Tool input arguments. */
  toolInput?: Record<string, unknown>;
  /** Tool output result. */
  toolOutput?: unknown;
  /** Token usage. */
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  /** Latency in ms. */
  latencyMs?: number;
  /** Model used. */
  model?: string;
  /** Error details. */
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
  /** Arbitrary metadata. */
  metadata?: Record<string, unknown>;
}

/** Handler interface that all framework handlers implement. */
export interface AuditCaptureHandler {
  /** Framework name. */
  readonly framework: string;
  /** Initialize the handler with a callback for events. */
  initialize(callback: (event: AuditEvent) => void): void;
  /** Handle a raw framework event. */
  handleEvent(rawEvent: unknown): void;
  /** Shutdown cleanup. */
  shutdown(): Promise<void>;
}

/** Episode groups related events into a single audit trail entry. */
export interface AuditEpisode {
  /** Episode ID. */
  id: string;
  /** Session/run ID. */
  sessionId: string;
  /** Framework name. */
  framework: string;
  /** Agent name. */
  agentName?: string;
  /** Start timestamp. */
  startedAt: string;
  /** End timestamp. */
  endedAt?: string;
  /** All events in this episode. */
  events: AuditEvent[];
  /** Summary metrics. */
  metrics: {
    totalEvents: number;
    totalTokens: number;
    totalLatencyMs: number;
    toolCalls: number;
    errors: number;
  };
}

// ── Unified Event Factory ─────────────────────────────────────────────────────

let _eventSeq = 0;

/**
 * Creates normalized AuditEvent objects from raw framework data.
 */
export class UnifiedEventFactory {
  private callback?: (event: AuditEvent) => void;

  setCallback(cb: (event: AuditEvent) => void): void {
    this.callback = cb;
  }

  /** Create a normalized event. */
  create(params: {
    eventType: AuditEventType;
    framework: string;
    sessionId: string;
    agentName?: string;
    input?: string;
    output?: string;
    toolName?: string;
    toolInput?: Record<string, unknown>;
    toolOutput?: unknown;
    usage?: AuditEvent["usage"];
    latencyMs?: number;
    model?: string;
    error?: AuditEvent["error"];
    metadata?: Record<string, unknown>;
  }): AuditEvent {
    const event: AuditEvent = {
      id: `evt-${Date.now()}-${++_eventSeq}`,
      eventType: params.eventType,
      framework: params.framework,
      agentName: params.agentName,
      sessionId: params.sessionId,
      timestamp: new Date().toISOString(),
      input: params.input,
      output: params.output,
      toolName: params.toolName,
      toolInput: params.toolInput,
      toolOutput: params.toolOutput,
      usage: params.usage,
      latencyMs: params.latencyMs,
      model: params.model,
      error: params.error,
      metadata: params.metadata,
    };

    this.callback?.(event);
    return event;
  }
}

// ── Audit Collector ───────────────────────────────────────────────────────────

/**
 * Collects events into episodes for batch audit writing.
 */
export class AuditCollector {
  private episodes = new Map<string, AuditEpisode>();
  private factory: UnifiedEventFactory;

  constructor(factory?: UnifiedEventFactory) {
    this.factory = factory ?? new UnifiedEventFactory();
  }

  /** Start tracking a new episode. */
  startEpisode(sessionId: string, framework: string, agentName?: string): void {
    this.episodes.set(sessionId, {
      id: `ep-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sessionId,
      framework,
      agentName,
      startedAt: new Date().toISOString(),
      events: [],
      metrics: { totalEvents: 0, totalTokens: 0, totalLatencyMs: 0, toolCalls: 0, errors: 0 },
    });
  }

  /** Record an event in an episode. */
  recordEvent(event: AuditEvent): void {
    const episode = this.episodes.get(event.sessionId);
    if (!episode) return;

    episode.events.push(event);
    episode.metrics.totalEvents++;

    if (event.usage) {
      episode.metrics.totalTokens += event.usage.totalTokens;
    }
    if (event.latencyMs) {
      episode.metrics.totalLatencyMs += event.latencyMs;
    }
    if (event.eventType === "tool_call") {
      episode.metrics.toolCalls++;
    }
    if (event.eventType === "error") {
      episode.metrics.errors++;
    }
  }

  /** End an episode and return it. */
  endEpisode(sessionId: string): AuditEpisode | undefined {
    const episode = this.episodes.get(sessionId);
    if (episode) {
      episode.endedAt = new Date().toISOString();
      this.episodes.delete(sessionId);
    }
    return episode;
  }

  /** Get all active episodes. */
  getActiveEpisodes(): AuditEpisode[] {
    return [...this.episodes.values()];
  }

  /** Get the event factory. */
  getFactory(): UnifiedEventFactory {
    return this.factory;
  }
}

// ── LangChain Handler ─────────────────────────────────────────────────────────

/**
 * Drop-in handler for LangChain callbacks.
 *
 * Usage:
 * ```ts
 * const handler = new LangChainHandler("session-123");
 * handler.initialize((event) => auditCollector.recordEvent(event));
 * chain.invoke(input, { callbacks: [handler.asLangChainCallback()] });
 * ```
 */
export class LangChainHandler implements AuditCaptureHandler {
  readonly framework = "langchain";
  private callback?: (event: AuditEvent) => void;
  private factory = new UnifiedEventFactory();
  private sessionId: string;
  private agentName?: string;

  constructor(sessionId: string, agentName?: string) {
    this.sessionId = sessionId;
    this.agentName = agentName;
  }

  initialize(callback: (event: AuditEvent) => void): void {
    this.callback = callback;
    this.factory.setCallback(callback);
  }

  handleEvent(rawEvent: unknown): void {
    // Handle LangChain callback events
    const evt = rawEvent as Record<string, unknown>;
    const eventName = (evt.event as string) ?? "unknown";

    if (eventName === "on_llm_start") {
      const prompts = (evt.prompts as string[]) ?? [];
      this.factory.create({
        eventType: "prompt",
        framework: this.framework,
        sessionId: this.sessionId,
        agentName: this.agentName,
        input: prompts[0] ?? "",
        model: (evt.name as string) ?? undefined,
        metadata: { runId: evt.runId },
      });
    } else if (eventName === "on_llm_end") {
      const response = evt.response as Record<string, unknown> | undefined;
      const generations = (response?.generations as unknown[][]) ?? [];
      const output = generations[0]?.[0] as Record<string, unknown> | undefined;
      this.factory.create({
        eventType: "completion",
        framework: this.framework,
        sessionId: this.sessionId,
        agentName: this.agentName,
        output: (output?.text as string) ?? "",
        model: (evt.name as string) ?? undefined,
      });
    } else if (eventName === "on_tool_start") {
      this.factory.create({
        eventType: "tool_call",
        framework: this.framework,
        sessionId: this.sessionId,
        agentName: this.agentName,
        toolName: (evt.name as string) ?? undefined,
        input: (evt.input as string) ?? undefined,
        toolInput:
          typeof evt.input === "object" ? (evt.input as Record<string, unknown>) : undefined,
      });
    } else if (eventName === "on_tool_end") {
      this.factory.create({
        eventType: "tool_result",
        framework: this.framework,
        sessionId: this.sessionId,
        agentName: this.agentName,
        toolName: (evt.name as string) ?? undefined,
        toolOutput: evt.output,
      });
    } else if (eventName === "on_error") {
      this.factory.create({
        eventType: "error",
        framework: this.framework,
        sessionId: this.sessionId,
        agentName: this.agentName,
        error: {
          name: "LangChainError",
          message: (evt.error as string) ?? "Unknown error",
        },
      });
    }
  }

  /** Get a LangChain-compatible callback object. */
  asLangChainCallback(): Record<string, (...args: unknown[]) => void> {
    return {
      handleLLMStart: (...args: unknown[]) =>
        this.handleEvent({ event: "on_llm_start", ...(args[0] as object) }),
      handleLLMEnd: (...args: unknown[]) =>
        this.handleEvent({ event: "on_llm_end", ...(args[0] as object) }),
      handleToolStart: (...args: unknown[]) =>
        this.handleEvent({ event: "on_tool_start", ...(args[0] as object) }),
      handleToolEnd: (...args: unknown[]) =>
        this.handleEvent({ event: "on_tool_end", ...(args[0] as object) }),
      handleError: (...args: unknown[]) =>
        this.handleEvent({ event: "on_error", ...(args[0] as object) }),
    };
  }

  async shutdown(): Promise<void> {
    this.callback = undefined;
  }
}

// ── CrewAI Handler ────────────────────────────────────────────────────────────

/**
 * Drop-in handler for CrewAI callbacks.
 */
export class CrewAIHandler implements AuditCaptureHandler {
  readonly framework = "crewai";
  private callback?: (event: AuditEvent) => void;
  private factory = new UnifiedEventFactory();
  private sessionId: string;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  initialize(callback: (event: AuditEvent) => void): void {
    this.callback = callback;
    this.factory.setCallback(callback);
  }

  handleEvent(rawEvent: unknown): void {
    const evt = rawEvent as Record<string, unknown>;
    const eventType = (evt.type as string) ?? "unknown";

    if (eventType === "crew_start") {
      this.factory.create({
        eventType: "session_start",
        framework: this.framework,
        sessionId: this.sessionId,
        agentName: (evt.crew_name as string) ?? undefined,
        metadata: { agents: evt.agents, tasks: evt.tasks },
      });
    } else if (eventType === "agent_action") {
      this.factory.create({
        eventType: "tool_call",
        framework: this.framework,
        sessionId: this.sessionId,
        agentName: (evt.agent as string) ?? undefined,
        toolName: (evt.tool as string) ?? undefined,
        toolInput: (evt.tool_input as Record<string, unknown>) ?? undefined,
      });
    } else if (eventType === "agent_completion") {
      this.factory.create({
        eventType: "completion",
        framework: this.framework,
        sessionId: this.sessionId,
        agentName: (evt.agent as string) ?? undefined,
        output: (evt.output as string) ?? undefined,
        usage: evt.usage as AuditEvent["usage"],
        model: (evt.model as string) ?? undefined,
      });
    }
  }

  async shutdown(): Promise<void> {
    this.callback = undefined;
  }
}

// ── OpenAI Agents SDK Handler ─────────────────────────────────────────────────

/**
 * Drop-in handler for OpenAI Agents SDK events.
 */
export class OpenAIHandler implements AuditCaptureHandler {
  readonly framework = "openai-agents";
  private callback?: (event: AuditEvent) => void;
  private factory = new UnifiedEventFactory();
  private sessionId: string;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  initialize(callback: (event: AuditEvent) => void): void {
    this.callback = callback;
    this.factory.setCallback(callback);
  }

  handleEvent(rawEvent: unknown): void {
    const evt = rawEvent as Record<string, unknown>;
    const eventType = (evt.type as string) ?? "unknown";

    if (eventType === "message.created") {
      this.factory.create({
        eventType: "prompt",
        framework: this.framework,
        sessionId: this.sessionId,
        input: (evt.content as string) ?? undefined,
        model: (evt.model as string) ?? undefined,
        metadata: { messageId: evt.id },
      });
    } else if (eventType === "message.completed") {
      this.factory.create({
        eventType: "completion",
        framework: this.framework,
        sessionId: this.sessionId,
        output: (evt.content as string) ?? undefined,
        usage: evt.usage as AuditEvent["usage"],
      });
    } else if (eventType === "tool.called") {
      this.factory.create({
        eventType: "tool_call",
        framework: this.framework,
        sessionId: this.sessionId,
        toolName: (evt.name as string) ?? undefined,
        toolInput: (evt.arguments as Record<string, unknown>) ?? undefined,
      });
    } else if (eventType === "tool.result") {
      this.factory.create({
        eventType: "tool_result",
        framework: this.framework,
        sessionId: this.sessionId,
        toolName: (evt.name as string) ?? undefined,
        toolOutput: evt.result,
      });
    } else if (eventType === "error") {
      this.factory.create({
        eventType: "error",
        framework: this.framework,
        sessionId: this.sessionId,
        error: {
          name: (evt.name as string) ?? "AgentError",
          message: (evt.message as string) ?? "Unknown error",
        },
      });
    }
  }

  async shutdown(): Promise<void> {
    this.callback = undefined;
  }
}

// ── AutoGen Handler ───────────────────────────────────────────────────────────

/**
 * Drop-in handler for AutoGen events.
 */
export class AutoGenHandler implements AuditCaptureHandler {
  readonly framework = "autogen";
  private callback?: (event: AuditEvent) => void;
  private factory = new UnifiedEventFactory();
  private sessionId: string;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  initialize(callback: (event: AuditEvent) => void): void {
    this.callback = callback;
    this.factory.setCallback(callback);
  }

  handleEvent(rawEvent: unknown): void {
    const evt = rawEvent as Record<string, unknown>;
    const eventType = (evt.type as string) ?? "unknown";

    if (eventType === "message_sent") {
      this.factory.create({
        eventType: "completion",
        framework: this.framework,
        sessionId: this.sessionId,
        agentName: (evt.sender as string) ?? undefined,
        output: (evt.content as string) ?? undefined,
        metadata: { recipient: evt.recipient },
      });
    } else if (eventType === "tool_call") {
      this.factory.create({
        eventType: "tool_call",
        framework: this.framework,
        sessionId: this.sessionId,
        agentName: (evt.sender as string) ?? undefined,
        toolName: (evt.tool_name as string) ?? undefined,
        toolInput: (evt.arguments as Record<string, unknown>) ?? undefined,
      });
    }
  }

  async shutdown(): Promise<void> {
    this.callback = undefined;
  }
}

// ── Haystack Handler ──────────────────────────────────────────────────────────

/**
 * Drop-in handler for Haystack pipeline events.
 */
export class HaystackHandler implements AuditCaptureHandler {
  readonly framework = "haystack";
  private callback?: (event: AuditEvent) => void;
  private factory = new UnifiedEventFactory();
  private sessionId: string;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  initialize(callback: (event: AuditEvent) => void): void {
    this.callback = callback;
    this.factory.setCallback(callback);
  }

  handleEvent(rawEvent: unknown): void {
    const evt = rawEvent as Record<string, unknown>;
    const eventType = (evt.type as string) ?? "unknown";

    if (eventType === "pipeline_run") {
      this.factory.create({
        eventType: "session_start",
        framework: this.framework,
        sessionId: this.sessionId,
        agentName: (evt.pipeline_name as string) ?? undefined,
        metadata: { components: evt.components },
      });
    } else if (eventType === "component_run") {
      this.factory.create({
        eventType: "completion",
        framework: this.framework,
        sessionId: this.sessionId,
        agentName: (evt.component_name as string) ?? undefined,
        output: JSON.stringify(evt.output),
        latencyMs: (evt.latency_ms as number) ?? undefined,
      });
    }
  }

  async shutdown(): Promise<void> {
    this.callback = undefined;
  }
}

// ── Google ADK Handler ────────────────────────────────────────────────────────

/**
 * Drop-in handler for Google ADK agent events.
 */
export class ADKHandler implements AuditCaptureHandler {
  readonly framework = "google-adk";
  private callback?: (event: AuditEvent) => void;
  private factory = new UnifiedEventFactory();
  private sessionId: string;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  initialize(callback: (event: AuditEvent) => void): void {
    this.callback = callback;
    this.factory.setCallback(callback);
  }

  handleEvent(rawEvent: unknown): void {
    const evt = rawEvent as Record<string, unknown>;
    const eventType = (evt.type as string) ?? "unknown";

    if (eventType === "agent_start") {
      this.factory.create({
        eventType: "session_start",
        framework: this.framework,
        sessionId: this.sessionId,
        agentName: (evt.agent_name as string) ?? undefined,
      });
    } else if (eventType === "model_request") {
      this.factory.create({
        eventType: "prompt",
        framework: this.framework,
        sessionId: this.sessionId,
        agentName: (evt.agent_name as string) ?? undefined,
        input: (evt.prompt as string) ?? undefined,
        model: (evt.model as string) ?? undefined,
      });
    } else if (eventType === "model_response") {
      this.factory.create({
        eventType: "completion",
        framework: this.framework,
        sessionId: this.sessionId,
        agentName: (evt.agent_name as string) ?? undefined,
        output: (evt.response as string) ?? undefined,
        usage: evt.usage as AuditEvent["usage"],
      });
    } else if (eventType === "tool_invocation") {
      this.factory.create({
        eventType: "tool_call",
        framework: this.framework,
        sessionId: this.sessionId,
        agentName: (evt.agent_name as string) ?? undefined,
        toolName: (evt.tool_name as string) ?? undefined,
        toolInput: (evt.args as Record<string, unknown>) ?? undefined,
      });
    }
  }

  async shutdown(): Promise<void> {
    this.callback = undefined;
  }
}

// ── Handler Registry ──────────────────────────────────────────────────────────

/**
 * Registry of all available framework handlers.
 */
export const HANDLER_REGISTRY: Record<
  string,
  new (sessionId: string, agentName?: string) => AuditCaptureHandler
> = {
  langchain: LangChainHandler,
  crewai: CrewAIHandler,
  "openai-agents": OpenAIHandler,
  autogen: AutoGenHandler,
  haystack: HaystackHandler,
  "google-adk": ADKHandler,
};

/**
 * Create a handler by framework name.
 */
export function createAuditHandler(
  framework: string,
  sessionId: string,
  agentName?: string,
): AuditCaptureHandler {
  const HandlerClass = HANDLER_REGISTRY[framework];
  if (!HandlerClass) {
    throw new Error(
      `Unknown framework: ${framework}. Available: ${Object.keys(HANDLER_REGISTRY).join(", ")}`,
    );
  }
  return new HandlerClass(sessionId, agentName);
}
