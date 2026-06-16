// SPDX-License-Identifier: Apache-2.0
/**
 * transcript-store — Stores and replays conversation transcripts.
 *
 * Features:
 *   • Append messages to a session transcript
 *   • Replay: iterate messages in chronological order with optional filters
 *   • Export to plain text / JSON
 *   • Search messages by content substring
 *   • Snapshot (fork) a session at a given turn
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type MessageRole = "user" | "assistant" | "system" | "tool";

/** Transcript message interface definition. */
export interface TranscriptMessage {
  id: string;
  role: MessageRole;
  content: string;
  /** ISO 8601 */
  timestamp: string;
  metadata?: Record<string, unknown>;
}

/** Transcript interface definition. */
export interface Transcript {
  sessionId: string;
  createdAt: string;
  messages: TranscriptMessage[];
}

/** Replay options interface definition. */
export interface ReplayOptions {
  fromIndex?: number;
  toIndex?: number;
  roles?: MessageRole[];
}

/** Search options interface definition. */
export interface SearchOptions {
  role?: MessageRole;
  limit?: number;
  caseSensitive?: boolean;
}

// ── ID generation ─────────────────────────────────────────────────────────────

let _msgCounter = 0;
function nextId(prefix: string): string {
  return `${prefix}-${Date.now()}-${++_msgCounter}`;
}

// ── InMemoryTranscriptStore ───────────────────────────────────────────────────

export class InMemoryTranscriptStore {
  private sessions = new Map<string, Transcript>();

  // ── Session lifecycle ──────────────────────────────────────────────────────

  createSession(sessionId?: string): Transcript {
    const id = sessionId ?? nextId("session");
    const t: Transcript = {
      sessionId: id,
      createdAt: new Date().toISOString(),
      messages: [],
    };
    this.sessions.set(id, t);
    return t;
  }

  getSession(sessionId: string): Transcript | undefined {
    return this.sessions.get(sessionId);
  }

  deleteSession(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  listSessionIds(): string[] {
    return [...this.sessions.keys()];
  }

  // ── Append ─────────────────────────────────────────────────────────────────

  append(
    sessionId: string,
    role: MessageRole,
    content: string,
    metadata?: Record<string, unknown>,
  ): TranscriptMessage {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    const msg: TranscriptMessage = {
      id: nextId("msg"),
      role,
      content,
      timestamp: new Date().toISOString(),
      metadata,
    };
    session.messages.push(msg);
    return msg;
  }

  // ── Replay ─────────────────────────────────────────────────────────────────

  replay(sessionId: string, opts: ReplayOptions = {}): TranscriptMessage[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    const { fromIndex = 0, toIndex, roles } = opts;
    let msgs = session.messages.slice(fromIndex, toIndex !== undefined ? toIndex + 1 : undefined);
    if (roles && roles.length > 0) {
      msgs = msgs.filter((m) => roles.includes(m.role));
    }
    return msgs;
  }

  // ── Search ─────────────────────────────────────────────────────────────────

  search(sessionId: string, query: string, opts: SearchOptions = {}): TranscriptMessage[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    const { role, limit, caseSensitive = false } = opts;
    const q = caseSensitive ? query : query.toLowerCase();
    let results = session.messages.filter((m) => {
      if (role && m.role !== role) return false;
      const text = caseSensitive ? m.content : m.content.toLowerCase();
      return text.includes(q);
    });
    if (limit !== undefined) results = results.slice(0, limit);
    return results;
  }

  // ── Export ─────────────────────────────────────────────────────────────────

  exportText(sessionId: string): string {
    const session = this.sessions.get(sessionId);
    if (!session) return "";
    return session.messages.map((m) => `[${m.role.toUpperCase()}] ${m.content}`).join("\n\n");
  }

  exportJSON(sessionId: string): string {
    const session = this.sessions.get(sessionId);
    if (!session) return "null";
    return JSON.stringify(session, null, 2);
  }

  // ── Snapshot / fork ────────────────────────────────────────────────────────

  /**
   * Fork a session up to (and including) `upToIndex`.
   * Returns the new session.
   */
  snapshot(sessionId: string, newSessionId: string, upToIndex?: number): Transcript {
    const source = this.sessions.get(sessionId);
    if (!source) throw new Error(`Session not found: ${sessionId}`);
    const msgs = source.messages.slice(0, upToIndex !== undefined ? upToIndex + 1 : undefined);
    const fork: Transcript = {
      sessionId: newSessionId,
      createdAt: new Date().toISOString(),
      messages: msgs.map((m) => ({ ...m })),
    };
    this.sessions.set(newSessionId, fork);
    return fork;
  }

  // ── Stats ─────────────────────────────────────────────────────────────────

  messageCount(sessionId: string): number {
    return this.sessions.get(sessionId)?.messages.length ?? 0;
  }
}
