// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/agent-protocol — Binary wire protocol for agent harness communication.
 *
 * Inspired by jcode's harness API protocol.
 * Provides typed message framing, session management, and permission
 * control for agent-harness communication.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type PermissionDecision = "allow" | "allow_always" | "deny";

export type ErrorCode =
  "unsupported_version" | "unknown_request" | "unknown_session" | "invalid_request" | "internal";

export interface SessionInfo {
  sessionId: string;
  workingDir?: string;
  title?: string;
  status: string;
  transcriptBytes?: number;
  archived?: boolean;
  archivedAtMs?: number;
}

export interface ModelRouteInfo {
  model: string;
  provider: string;
  apiMethod: string;
  available: boolean;
  detail: string;
}

export interface HistoryMessage {
  role: "user" | "assistant" | "tool";
  content: string;
}

export interface AgentRequest {
  type: string;
  sessionId: string;
  payload: unknown;
  requestId: string;
}

export interface AgentResponse {
  requestId: string;
  success: boolean;
  data?: unknown;
  error?: { code: ErrorCode; message: string };
}

// ── Protocol Frame ───────────────────────────────────────────────────────────

export interface ProtocolFrame {
  v: number; // protocol version
  tag: string;
  data: unknown;
  sessionId?: string;
}

const API_VERSION = 1;

/**
 * Encode a message into a protocol frame.
 */
export function encodeFrame(tag: string, data: unknown, sessionId?: string): ProtocolFrame {
  return {
    v: API_VERSION,
    tag,
    data,
    sessionId,
  };
}

/**
 * Decode and validate a protocol frame.
 */
export function decodeFrame(raw: unknown): {
  frame: ProtocolFrame;
  valid: boolean;
  error?: string;
} {
  if (!raw || typeof raw !== "object") {
    return {
      frame: { v: 0, tag: "", data: null },
      valid: false,
      error: "Invalid frame: not an object",
    };
  }

  const obj = raw as Record<string, unknown>;

  if (typeof obj.v !== "number" || obj.v !== API_VERSION) {
    return {
      frame: { v: (obj.v as number) ?? 0, tag: (obj.tag as string) ?? "", data: obj.data },
      valid: false,
      error: `Unsupported protocol version: ${obj.v}`,
    };
  }

  if (typeof obj.tag !== "string") {
    return {
      frame: { v: obj.v as number, tag: "", data: obj.data },
      valid: false,
      error: "Missing or invalid tag",
    };
  }

  return {
    frame: {
      v: obj.v as number,
      tag: obj.tag as string,
      data: obj.data,
      sessionId: obj.sessionId as string | undefined,
    },
    valid: true,
  };
}

// ── Session Manager ──────────────────────────────────────────────────────────

export class ProtocolSessionManager {
  private sessions: Map<string, SessionInfo> = new Map();
  private transcripts: Map<string, HistoryMessage[]> = new Map();

  /**
   * Create a new session.
   */
  createSession(config?: { workingDir?: string; title?: string }): SessionInfo {
    const sessionId = `ses-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const session: SessionInfo = {
      sessionId,
      workingDir: config?.workingDir,
      title: config?.title,
      status: "active",
      transcriptBytes: 0,
    };

    this.sessions.set(sessionId, session);
    this.transcripts.set(sessionId, []);

    return session;
  }

  /**
   * Get a session by ID.
   */
  getSession(sessionId: string): SessionInfo | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * List all sessions.
   */
  listSessions(): SessionInfo[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Archive a session.
   */
  archiveSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    session.archived = true;
    session.archivedAtMs = Date.now();
    session.status = "archived";
    return true;
  }

  /**
   * Delete a session.
   */
  deleteSession(sessionId: string): boolean {
    this.sessions.delete(sessionId);
    this.transcripts.delete(sessionId);
    return true;
  }

  /**
   * Add a message to a session transcript.
   */
  addMessage(sessionId: string, message: HistoryMessage): boolean {
    const transcript = this.transcripts.get(sessionId);
    if (!transcript) return false;

    transcript.push(message);

    const session = this.sessions.get(sessionId);
    if (session) {
      session.transcriptBytes = (session.transcriptBytes ?? 0) + JSON.stringify(message).length;
    }

    return true;
  }

  /**
   * Get transcript for a session.
   */
  getTranscript(sessionId: string, limit?: number): HistoryMessage[] {
    const transcript = this.transcripts.get(sessionId) ?? [];
    return limit ? transcript.slice(-limit) : [...transcript];
  }

  /**
   * Clear a session's transcript.
   */
  clearTranscript(sessionId: string): boolean {
    const transcript = this.transcripts.get(sessionId);
    if (!transcript) return false;
    transcript.length = 0;
    return true;
  }
}

// ── Permission Gate ──────────────────────────────────────────────────────────

export interface PermissionPolicy {
  resource: string;
  decision: PermissionDecision;
  conditions?: Record<string, unknown>;
}

export class ProtocolPermissionGate {
  private policies: Map<string, PermissionDecision> = new Map();
  private alwaysAllow: Set<string> = new Set();

  /**
   * Set a permission for a resource.
   */
  setPermission(resource: string, decision: PermissionDecision): void {
    if (decision === "allow_always") {
      this.alwaysAllow.add(resource);
      this.policies.set(resource, "allow");
    } else {
      this.policies.set(resource, decision);
    }
  }

  /**
   * Check if an action is permitted.
   */
  check(resource: string): PermissionDecision {
    if (this.alwaysAllow.has(resource)) {
      return "allow";
    }

    const decision = this.policies.get(resource);
    if (decision) return decision;

    // Check wildcard
    const wildcardDecision = this.policies.get("*");
    return wildcardDecision ?? "deny";
  }

  /**
   * Reset all permissions.
   */
  reset(): void {
    this.policies.clear();
    this.alwaysAllow.clear();
  }

  /**
   * Get all policies.
   */
  getPolicies(): PermissionPolicy[] {
    return Array.from(this.policies.entries()).map(([resource, decision]) => ({
      resource,
      decision,
    }));
  }
}

export default ProtocolSessionManager;
