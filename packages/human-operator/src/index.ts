// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/human-operator — Human-in-the-loop escalation for agent systems.
 *
 * Inspired by agent-swarm-kit's Operator pattern.
 * Allows agents to escalate conversations to human operators when needed,
 * with notification, messaging, and session management.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface OperatorSession {
  id: string;
  clientId: string;
  agentName: string;
  status: "pending" | "active" | "resolved" | "expired";
  messages: OperatorMessage[];
  createdAt: number;
  updatedAt: number;
  resolvedAt?: number;
}

export interface OperatorMessage {
  id: string;
  role: "agent" | "operator" | "system";
  content: string;
  timestamp: number;
}

export interface OperatorCallbacks {
  onInit?: (sessionId: string, clientId: string, agentName: string) => void;
  onMessage?: (message: string, sessionId: string, role: string) => void;
  onResolve?: (sessionId: string) => void;
  onExpire?: (sessionId: string) => void;
}

// ── Operator Manager ─────────────────────────────────────────────────────────

export class OperatorManager {
  private sessions: Map<string, OperatorSession> = new Map();
  private handlers: Map<string, (message: string) => Promise<void>> = new Map();
  private callbacks: OperatorCallbacks;
  private sessionTimeoutMs: number;

  constructor(
    options?: { timeoutMs?: number; callbacks?: OperatorCallbacks },
  ) {
    this.sessionTimeoutMs = options?.timeoutMs ?? 300_000; // 5 minutes
    this.callbacks = options?.callbacks ?? {};
  }

  /**
   * Request human operator assistance for a client.
   */
  async requestOperator(
    clientId: string,
    agentName: string,
    context?: string,
  ): Promise<OperatorSession> {
    const session: OperatorSession = {
      id: crypto.randomUUID(),
      clientId,
      agentName,
      status: "pending",
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    if (context) {
      session.messages.push({
        id: crypto.randomUUID(),
        role: "agent",
        content: context,
        timestamp: Date.now(),
      });
    }

    this.sessions.set(session.id, session);
    this.callbacks.onInit?.(session.id, clientId, agentName);

    // Set timeout for session expiry
    setTimeout(() => {
      const s = this.sessions.get(session.id);
      if (s && s.status === "pending") {
        s.status = "expired";
        s.updatedAt = Date.now();
        this.callbacks.onExpire?.(session.id);
      }
    }, this.sessionTimeoutMs);

    return session;
  }

  /**
   * Connect a handler for an operator session.
   */
  connectHandler(
    sessionId: string,
    handler: (message: string) => Promise<void>,
  ): void {
    this.handlers.set(sessionId, handler);

    const session = this.sessions.get(sessionId);
    if (session && session.status === "pending") {
      session.status = "active";
      session.updatedAt = Date.now();
    }
  }

  /**
   * Send a message from the operator.
   */
  async sendOperatorMessage(
    sessionId: string,
    content: string,
  ): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== "active") {
      return false;
    }

    const message: OperatorMessage = {
      id: crypto.randomUUID(),
      role: "operator",
      content,
      timestamp: Date.now(),
    };

    session.messages.push(message);
    session.updatedAt = Date.now();

    this.callbacks.onMessage?.(content, sessionId, "operator");

    const handler = this.handlers.get(sessionId);
    if (handler) {
      await handler(content);
    }

    return true;
  }

  /**
   * Receive a message from the agent/client side.
   */
  async receiveMessage(sessionId: string, content: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    const message: OperatorMessage = {
      id: crypto.randomUUID(),
      role: "agent",
      content,
      timestamp: Date.now(),
    };

    session.messages.push(message);
    session.updatedAt = Date.now();

    this.callbacks.onMessage?.(content, sessionId, "agent");

    return true;
  }

  /**
   * Resolve a session.
   */
  async resolve(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    session.status = "resolved";
    session.resolvedAt = Date.now();
    session.updatedAt = Date.now();
    this.handlers.delete(sessionId);

    this.callbacks.onResolve?.(sessionId);

    return true;
  }

  /**
   * Get a session by ID.
   */
  getSession(sessionId: string): OperatorSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Get all pending sessions.
   */
  getPendingSessions(): OperatorSession[] {
    return Array.from(this.sessions.values()).filter(
      (s) => s.status === "pending" || s.status === "active",
    );
  }

  /**
   * Get all sessions for a client.
   */
  getClientSessions(clientId: string): OperatorSession[] {
    return Array.from(this.sessions.values()).filter(
      (s) => s.clientId === clientId,
    );
  }

  /**
   * Clean up expired sessions.
   */
  cleanup(): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [id, session] of this.sessions) {
      if (
        session.status === "pending" &&
        now - session.createdAt > this.sessionTimeoutMs
      ) {
        session.status = "expired";
        session.updatedAt = now;
        this.handlers.delete(id);
        this.callbacks.onExpire?.(id);
        cleaned++;
      }
    }

    return cleaned;
  }
}

// ── Auto-escalation ──────────────────────────────────────────────────────────

export interface EscalationRule {
  name: string;
  condition: (context: { message: string; agentName: string; attemptCount: number }) => boolean;
  priority: number;
}

export class AutoEscalation {
  private rules: EscalationRule[] = [];
  private attemptCounts: Map<string, number> = new Map();

  addRule(rule: EscalationRule): void {
    this.rules.push(rule);
    this.rules.sort((a, b) => b.priority - a.priority);
  }

  shouldEscalate(context: {
    message: string;
    agentName: string;
    conversationLength: number;
  }): { escalate: boolean; rule?: string } {
    const attemptKey = `${context.agentName}:${context.message.slice(0, 50)}`;
    const count = this.attemptCounts.get(attemptKey) ?? 0;
    this.attemptCounts.set(attemptKey, count + 1);

    for (const rule of this.rules) {
      if (rule.condition({ ...context, attemptCount: count + 1 })) {
        return { escalate: true, rule: rule.name };
      }
    }

    return { escalate: false };
  }

  resetAttempts(agentName: string): void {
    for (const key of this.attemptCounts.keys()) {
      if (key.startsWith(`${agentName}:`)) {
        this.attemptCounts.delete(key);
      }
    }
  }
}

export default OperatorManager;
