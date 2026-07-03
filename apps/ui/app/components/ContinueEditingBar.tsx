// SPDX-License-Identifier: Apache-2.0
import React from "react";

export interface CodegenSession {
  sessionId: string;
  prompt: string;
  stack: string;
  timestamp: number;
  files: Array<{ name: string; content: string; language: string }>;
}

const KEY = "codegen_active_session";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function saveSession(session: CodegenSession) {
  try {
    localStorage.setItem(KEY, JSON.stringify(session));
  } catch {}
}

export function loadSession(): CodegenSession | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s: CodegenSession = JSON.parse(raw);
    if (Date.now() - s.timestamp > MAX_AGE_MS) {
      localStorage.removeItem(KEY);
      return null;
    }
    return s;
  } catch {
    return null;
  }
}

export function clearSession() {
  try {
    localStorage.removeItem(KEY);
  } catch {}
}

interface ContinueEditingBarProps {
  session: CodegenSession;
  onContinue: (session: CodegenSession) => void;
  onFresh: () => void;
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function ContinueEditingBar({ session, onContinue, onFresh }: ContinueEditingBarProps) {
  return (
    <div
      style={{
        background: "#0d1117",
        border: "1px solid #2563eb44",
        borderRadius: 8,
        padding: "10px 14px",
        display: "flex",
        alignItems: "center",
        gap: 12,
        flexWrap: "wrap",
        marginBottom: 12,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <span style={{ fontSize: 11, color: "#3b82f6", fontWeight: 600 }}>
          Continue last session
        </span>
        <span style={{ fontSize: 11, color: "#555", marginLeft: 8 }}>
          {timeAgo(session.timestamp)}
        </span>
        <div
          style={{
            fontSize: 12,
            color: "#9ca3af",
            marginTop: 2,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          [{session.stack}] {session.prompt}
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
        <button
          onClick={() => onFresh()}
          style={{
            fontSize: 12,
            color: "#666",
            background: "none",
            border: "1px solid #333",
            borderRadius: 5,
            padding: "5px 12px",
            cursor: "pointer",
          }}
        >
          Start fresh
        </button>
        <button
          onClick={() => onContinue(session)}
          style={{
            fontSize: 12,
            color: "#fff",
            background: "#2563eb",
            border: "none",
            borderRadius: 5,
            padding: "5px 14px",
            cursor: "pointer",
            fontWeight: 500,
          }}
        >
          Continue →
        </button>
      </div>
    </div>
  );
}
