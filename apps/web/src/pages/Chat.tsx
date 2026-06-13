// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useRef, useState } from "react";

import { api, type ChatMessage } from "../lib/api.js";

// ── Style tokens ──────────────────────────────────────────────────────────────

const MODELS = [
  { id: "nexus/smart", label: "Smart (70B)" },
  { id: "nexus/fast", label: "Fast (8B)" },
  { id: "nexus/planner", label: "Planner (70B)" },
  { id: "nexus/eval", label: "Evaluator (8B)" },
];

const s = {
  page: {
    display: "flex",
    flexDirection: "column" as const,
    height: "calc(100vh - 64px)",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 16,
    flexShrink: 0,
  },
  title: { fontSize: 24, fontWeight: 700, margin: 0 },
  modelSelect: {
    background: "#161b27",
    border: "1px solid #1e2535",
    borderRadius: 8,
    color: "#c4b5fd",
    fontSize: 13,
    padding: "6px 10px",
    cursor: "pointer",
  } as React.CSSProperties,
  history: {
    flex: 1,
    overflowY: "auto" as const,
    display: "flex",
    flexDirection: "column" as const,
    gap: 12,
    padding: "4px 0 16px",
  },
  bubble: (role: "user" | "assistant"): React.CSSProperties => ({
    maxWidth: "78%",
    alignSelf: role === "user" ? "flex-end" : "flex-start",
    background: role === "user" ? "#3b1f6e" : "#161b27",
    border: `1px solid ${role === "user" ? "#5b21b6" : "#1e2535"}`,
    borderRadius: role === "user" ? "16px 16px 4px 16px" : "16px 16px 16px 4px",
    padding: "10px 14px",
    fontSize: 14,
    lineHeight: 1.6,
    color: role === "user" ? "#ddd6fe" : "#e2e8f0",
    whiteSpace: "pre-wrap" as const,
    wordBreak: "break-word" as const,
  }),
  roleBadge: (role: "user" | "assistant"): React.CSSProperties => ({
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.06em",
    textTransform: "uppercase" as const,
    color: role === "user" ? "#a78bfa" : "#7c3aed",
    marginBottom: 4,
    alignSelf: role === "user" ? "flex-end" : "flex-start",
  }),
  inputBar: {
    display: "flex",
    gap: 10,
    paddingTop: 12,
    borderTop: "1px solid #1e2535",
    flexShrink: 0,
  } as React.CSSProperties,
  textarea: {
    flex: 1,
    background: "#161b27",
    border: "1px solid #1e2535",
    borderRadius: 10,
    color: "#e2e8f0",
    fontSize: 14,
    padding: "10px 14px",
    resize: "none" as const,
    lineHeight: 1.5,
    minHeight: 44,
    maxHeight: 160,
    fontFamily: "inherit",
    outline: "none",
  },
  sendBtn: (disabled: boolean): React.CSSProperties => ({
    background: disabled ? "#1e2535" : "#7c3aed",
    border: "none",
    borderRadius: 10,
    color: disabled ? "#475569" : "#fff",
    cursor: disabled ? "not-allowed" : "pointer",
    fontSize: 18,
    width: 44,
    height: 44,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    transition: "background 0.15s",
  }),
  thinking: {
    alignSelf: "flex-start",
    display: "flex",
    alignItems: "center",
    gap: 6,
    color: "#64748b",
    fontSize: 13,
    padding: "8px 0",
  } as React.CSSProperties,
  errorBanner: {
    background: "#1c0a0a",
    border: "1px solid #7f1d1d",
    borderRadius: 8,
    color: "#f87171",
    fontSize: 13,
    padding: "10px 14px",
    flexShrink: 0,
    marginTop: 8,
  } as React.CSSProperties,
  empty: {
    flex: 1,
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    justifyContent: "center",
    color: "#334155",
    gap: 12,
  },
  emptyIcon: { fontSize: 48 },
  emptyHint: { fontSize: 14, color: "#475569", textAlign: "center" as const, maxWidth: 320 },
  tokenInfo: {
    fontSize: 11,
    color: "#334155",
    alignSelf: "flex-start",
    marginTop: -6,
  } as React.CSSProperties,
};

// ── Types ─────────────────────────────────────────────────────────────────────

interface DisplayMessage extends ChatMessage {
  id: string;
  tokenUsage?: { input: number; output: number };
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function Chat() {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState("");
  const [model, setModel] = useState(MODELS[0]!.id);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  // Auto-resize textarea
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    setInput(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };

  const send = useCallback(async (): Promise<void> => {
    const text = input.trim();
    if (!text || loading) return;

    const userMsg: DisplayMessage = {
      id: `u-${Date.now()}`,
      role: "user",
      content: text,
    };

    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setError(null);
    setLoading(true);

    // Reset textarea height
    if (textareaRef.current) textareaRef.current.style.height = "auto";

    // Build history for the API (role + content only)
    const history: ChatMessage[] = [...messages, userMsg].map(({ role, content }) => ({
      role,
      content,
    }));

    try {
      const res = await api.chat(history, model);
      const text = res.content.map((b) => b.text).join("");

      const assistantMsg: DisplayMessage = {
        id: `a-${Date.now()}`,
        role: "assistant",
        content: text,
        tokenUsage: { input: res.usage.input_tokens, output: res.usage.output_tokens },
      };

      setMessages((prev) => [...prev, assistantMsg]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setLoading(false);
      // Refocus input
      setTimeout(() => textareaRef.current?.focus(), 50);
    }
  }, [input, loading, messages, model]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  const clearHistory = (): void => {
    setMessages([]);
    setError(null);
  };

  return (
    <div style={s.page}>
      {/* ── Header ── */}
      <div style={s.header}>
        <h1 style={s.title}>◈ Chat</h1>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            style={s.modelSelect}
          >
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          {messages.length > 0 && (
            <button
              onClick={clearHistory}
              style={{
                background: "transparent",
                border: "1px solid #1e2535",
                borderRadius: 8,
                color: "#64748b",
                cursor: "pointer",
                fontSize: 12,
                padding: "6px 10px",
              }}
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* ── Message history ── */}
      <div style={s.history}>
        {messages.length === 0 && !loading && (
          <div style={s.empty}>
            <span style={s.emptyIcon}>◈</span>
            <p style={s.emptyHint}>
              Send a message to start a conversation. Use{" "}
              <span style={{ color: "#7c3aed" }}>Shift+Enter</span> for new lines.
            </p>
          </div>
        )}

        {messages.map((msg) => (
          <div
            key={msg.id}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 2,
            }}
          >
            <span style={s.roleBadge(msg.role)}>
              {msg.role === "user" ? "You" : "Nexus"}
            </span>
            <div style={s.bubble(msg.role)}>{msg.content}</div>
            {msg.tokenUsage && (
              <span style={s.tokenInfo}>
                {msg.tokenUsage.input}↑ {msg.tokenUsage.output}↓ tokens
              </span>
            )}
          </div>
        ))}

        {loading && (
          <div style={s.thinking}>
            <ThinkingDots />
            <span>Thinking…</span>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* ── Error ── */}
      {error && <div style={s.errorBanner}>⚠ {error}</div>}

      {/* ── Input bar ── */}
      <div style={s.inputBar}>
        <textarea
          ref={textareaRef}
          value={input}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          placeholder="Message Nexus… (Enter to send, Shift+Enter for newline)"
          rows={1}
          style={s.textarea}
          disabled={loading}
          autoFocus
        />
        <button
          onClick={() => void send()}
          disabled={loading || !input.trim()}
          style={s.sendBtn(loading || !input.trim())}
          title="Send (Enter)"
        >
          ▶
        </button>
      </div>
    </div>
  );
}

// ── Animated thinking dots ────────────────────────────────────────────────────

function ThinkingDots() {
  const [dot, setDot] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setDot((d) => (d + 1) % 4), 400);
    return () => clearInterval(t);
  }, []);
  return (
    <span style={{ color: "#7c3aed", fontWeight: 700, letterSpacing: 2 }}>
      {"●".repeat(dot)}{"○".repeat(3 - dot)}
    </span>
  );
}
