/**
 * Agent Communication Bus
 *
 * Multi-agent coordination substrate: inter-agent messaging, task delegation,
 * capability discovery, and results routing.
 */

import type { IEventBus } from "./event-bus.js";
import type { ILogger } from "./interfaces/logger.interface.js";
import type { IEventStore } from "./interfaces/persistence.interface.js";
import type { MemoryStore } from "./memory-store.js";

// ─── Types ───────────────────────────────────────────────────────────

export interface AgentMessage {
  id: string;
  from: string;
  to?: string; // undefined = broadcast
  type: "request" | "response" | "broadcast" | "delegation" | "result" | "error";
  subject: string;
  body: unknown;
  correlationId?: string;
  timestamp: Date;
  ttlMs?: number;
}

export interface AgentCapability {
  agentId: string;
  name: string;
  actions: string[];
  status: "idle" | "busy" | "offline";
  metadata?: Record<string, unknown>;
}

export interface DelegationRequest {
  id: string;
  fromAgent: string;
  targetCapability: string;
  task: unknown;
  timeoutMs: number;
}

export interface DelegationResult {
  requestId: string;
  success: boolean;
  output?: unknown;
  error?: string;
  durationMs: number;
}

export interface IAgentBus {
  send(message: Omit<AgentMessage, "id" | "timestamp">): Promise<string>;
  registerCapability(agentId: string, actions: string[], metadata?: Record<string, unknown>): Promise<void>;
  unregisterCapability(agentId: string): Promise<void>;
  findAgents(action: string): Promise<AgentCapability[]>;
  delegate(request: DelegationRequest): Promise<DelegationResult>;
  getMessages(options?: { since?: Date; limit?: number }): Promise<AgentMessage[]>;
  getCapabilities(): Promise<AgentCapability[]>;
}

export interface AgentBusOptions {
  /**
   * Maximum number of messages retained in the in-memory ring buffer.
   * Oldest messages are evicted when the cap is reached.
   * Defaults to 1 000.
   */
  maxMessages?: number;
}

// ─── Implementation ──────────────────────────────────────────────────

export class AgentBus implements IAgentBus {
  private messages: AgentMessage[] = [];
  private capabilities = new Map<string, AgentCapability>();
  private handlers = new Map<string, (msg: AgentMessage) => Promise<unknown>>();
  private nextId = 0;
  private logger?: ILogger;
  private readonly maxMessages: number;

  constructor(
    private eventBus: IEventBus,
    private eventStore?: IEventStore,
    private memoryStore?: MemoryStore,
    logger?: ILogger,
    options?: AgentBusOptions
  ) {
    this.logger = logger;
    this.maxMessages = options?.maxMessages ?? 1_000;
  }

  async send(message: Omit<AgentMessage, "id" | "timestamp">): Promise<string> {
    const id = `msg-${Date.now()}-${++this.nextId}`;
    const full: AgentMessage = {
      ...message,
      id,
      timestamp: new Date()
    };
    this.messages.push(full);
    // Evict expired TTL messages, then enforce the ring-buffer cap
    this._evictExpired();
    if (this.messages.length > this.maxMessages) {
      this.messages.splice(0, this.messages.length - this.maxMessages);
    }
    await this.eventBus.publish("agent_message", full);
    if (this.eventStore) {
      await this.eventStore.saveEvent("agent_message", full);
    }
    if (this.memoryStore) {
      await this.memoryStore.store({
        type: "observation",
        key: `agent:msg:${full.subject}`,
        value: full.body,
        tags: ["agent-bus", `from:${full.from}`, `type:${full.type}`],
        agentId: full.from,
        ttlMs: 24 * 60 * 60 * 1000
      });
    }

    // Route to specific agent handler
    if (full.to && this.handlers.has(full.to)) {
      const handler = this.handlers.get(full.to)!;
      handler(full).catch((err) => {
        if (this.logger) {
          this.logger.error(`[agent-bus] Handler for ${full.to} failed`, err);
        } else {
          console.error(`[agent-bus] Handler for ${full.to} failed:`, err);
        }
      });
    }

    return id;
  }

  async registerCapability(
    agentId: string,
    actions: string[],
    metadata?: Record<string, unknown>
  ): Promise<void> {
    this.capabilities.set(agentId, {
      agentId,
      name: agentId,
      actions,
      status: "idle",
      metadata
    });
    await this.eventBus.publish("agent_registered", { agentId, actions });
  }

  async unregisterCapability(agentId: string): Promise<void> {
    this.capabilities.delete(agentId);
    await this.eventBus.publish("agent_unregistered", { agentId });
  }

  async findAgents(action: string): Promise<AgentCapability[]> {
    return Array.from(this.capabilities.values()).filter(
      (c) => c.status !== "offline" && c.actions.includes(action)
    );
  }

  async delegate(request: DelegationRequest): Promise<DelegationResult> {
    const started = Date.now();
    const agents = await this.findAgents(request.targetCapability);
    if (agents.length === 0) {
      return {
        requestId: request.id,
        success: false,
        error: `No available agents with capability: ${request.targetCapability}`,
        durationMs: Date.now() - started
      };
    }

    // Pick first available agent (round-robin would be better, but keep it simple)
    const target = agents[0];
    if (!target) {
      return { requestId: request.id, success: false, error: "Internal: no agent available", durationMs: Date.now() - started };
    }

    // Mark agent as busy
    target.status = "busy";
    this.capabilities.set(target.agentId, target);

    // Set up subscription BEFORE sending to avoid race condition
    let sub: { unsubscribe: () => void } | null = null;
    const result = await new Promise<DelegationResult>((resolve) => {
      const timeout = setTimeout(() => {
        // Ensure subscription is cleaned up on timeout to prevent leaks
        if (sub) {
          try { sub.unsubscribe(); } catch { /* ignore */ }
        }
        resolve({
          requestId: request.id,
          success: false,
          error: `Delegation timeout after ${request.timeoutMs}ms`,
          durationMs: Date.now() - started
        });
      }, request.timeoutMs);

      // Listen for response before sending the delegation
      sub = this.eventBus.subscribe("agent_message", async (msg: AgentMessage) => {
        if (msg.correlationId === request.id && msg.from === target.agentId) {
          clearTimeout(timeout);
          if (sub) {
            try { sub.unsubscribe(); } catch { /* ignore */ }
          }
          resolve({
            requestId: request.id,
            success: msg.type !== "error",
            output: msg.type === "result" ? msg.body : undefined,
            error: msg.type === "error" ? String(msg.body) : undefined,
            durationMs: Date.now() - started
          });
        }
      });

      // Send delegation message AFTER subscription is set up
      this.send({
        from: "agent-bus",
        to: target.agentId,
        type: "delegation",
        subject: request.targetCapability,
        body: request.task,
        correlationId: request.id
      }).catch(() => {}); // fire-and-forget, errors handled via timeout
    });

    // Mark agent as idle again
    target.status = "idle";
    this.capabilities.set(target.agentId, target);

    // Auto-store delegation result in MemoryStore
    if (this.memoryStore) {
      await this.memoryStore.store({
        type: result.success ? "result" : "error",
        key: `agent:delegation:${request.id}`,
        value: { request, result },
        tags: ["agent-bus", "delegation", `capability:${request.targetCapability}`],
        agentId: target.agentId,
        ttlMs: 7 * 24 * 60 * 60 * 1000
      });
    }

    return result;
  }

  registerHandler(agentId: string, handler: (msg: AgentMessage) => Promise<unknown>): void {
    this.handlers.set(agentId, handler);
  }

  unregisterHandler(agentId: string): void {
    this.handlers.delete(agentId);
  }

  /** Remove messages whose ttlMs has expired from the ring buffer. */
  private _evictExpired(): void {
    const now = Date.now();
    this.messages = this.messages.filter(
      (m) => !m.ttlMs || now - m.timestamp.getTime() <= m.ttlMs
    );
  }

  async getMessages(options?: { since?: Date; limit?: number }): Promise<AgentMessage[]> {
    // Sweep expired messages on every read so callers never see stale entries
    this._evictExpired();
    let result = this.messages;
    if (options?.since) {
      // Use > instead of >= to avoid including messages created at the exact same millisecond
      result = result.filter((m) => m.timestamp.getTime() > options.since!.getTime());
    }
    if (options?.limit) {
      result = result.slice(-options.limit);
    }
    return result;
  }

  async getCapabilities(): Promise<AgentCapability[]> {
    return Array.from(this.capabilities.values());
  }
}

// ─── Built-in Agent Handlers ─────────────────────────────────────────

export class TaskDelegationAgent {
  constructor(private bus: AgentBus) {
    this.bus.registerHandler("task-delegator", this.handleMessage.bind(this));
  }

  private async handleMessage(msg: AgentMessage): Promise<void> {
    if (msg.type !== "delegation") return;

    const body = msg.body as Record<string, unknown>;
    const targetAction = body.action as string;
    const payload = body.payload;

    const agents = await this.bus.findAgents(targetAction);
    if (agents.length > 0) {
      await this.bus.send({
        from: "task-delegator",
        to: msg.from,
        type: "result",
        subject: `delegated:${targetAction}`,
        body: { delegated: true, target: agents[0]?.agentId, payload },
        correlationId: msg.correlationId
      });
    } else {
      await this.bus.send({
        from: "task-delegator",
        to: msg.from,
        type: "error",
        subject: `delegation_failed:${targetAction}`,
        body: `No agent found for action: ${targetAction}`,
        correlationId: msg.correlationId
      });
    }
  }
}
