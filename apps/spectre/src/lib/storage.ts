// SPDX-License-Identifier: Apache-2.0

export interface StoredMessage {
  role: "user" | "assistant";
  content: string;
  ts: number;
  model?: string;
  durationMs?: number;
}

export interface StoredSession {
  id: string;
  title: string;
  mode: string;
  messages: StoredMessage[];
  createdAt: number;
  updatedAt: number;
}

const KEY = "spectre_history";

function readAll(): StoredSession[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as StoredSession[]) : [];
  } catch {
    return [];
  }
}

function writeAll(sessions: StoredSession[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(sessions));
  } catch {
    // localStorage quota exceeded — drop oldest session and retry
    const trimmed = sessions.slice(1);
    try {
      localStorage.setItem(KEY, JSON.stringify(trimmed));
    } catch {
      /* ignore */
    }
  }
}

export function loadSessions(): StoredSession[] {
  return readAll().sort((a, b) => b.updatedAt - a.updatedAt);
}

export function loadSession(id: string): StoredSession | null {
  return readAll().find((s) => s.id === id) ?? null;
}

export function saveSession(session: StoredSession): void {
  const all = readAll();
  const idx = all.findIndex((s) => s.id === session.id);
  if (idx >= 0) {
    all[idx] = session;
  } else {
    all.push(session);
  }
  writeAll(all);
}

export function deleteSession(id: string): void {
  writeAll(readAll().filter((s) => s.id !== id));
}

export function newSession(mode = "chat"): StoredSession {
  return {
    id: crypto.randomUUID(),
    title: "New session",
    mode,
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export function autoTitle(session: StoredSession): string {
  const first = session.messages.find((m) => m.role === "user");
  if (!first) return "New session";
  return first.content.slice(0, 42).trim() + (first.content.length > 42 ? "…" : "");
}
