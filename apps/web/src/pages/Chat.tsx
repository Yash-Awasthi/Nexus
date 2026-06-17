// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useRef, useState } from "react";

import { AssistantSteps, type AssistantStep } from "../components/AssistantSteps.js";
import { MessageActions } from "../components/MessageActions.js";
import { api, type ChatMessage } from "../lib/api.js";

// ── Style tokens ──────────────────────────────────────────────────────────────

const MODELS = [
  { id: "nexus/smart", label: "Smart (70B)" },
  { id: "nexus/fast", label: "Fast (8B)" },
  { id: "nexus/planner", label: "Planner (70B)" },
  { id: "nexus/eval", label: "Evaluator (8B)" },
];

const RACE_TIERS = [
  { id: "fast", label: "Fast" },
  { id: "standard", label: "Standard" },
  { id: "smart", label: "Smart" },
] as const;

type ChatMode = "normal" | "classic";

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
  godmodeBar: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 0",
    borderBottom: "1px solid #1e2535",
    marginBottom: 10,
    flexShrink: 0,
    flexWrap: "wrap" as const,
  },
  modeBtn: (active: boolean): React.CSSProperties => ({
    background: active ? "rgba(124,58,237,0.18)" : "transparent",
    border: `1px solid ${active ? "#7c3aed" : "#1e2535"}`,
    borderRadius: 6,
    color: active ? "#c4b5fd" : "#64748b",
    cursor: "pointer",
    fontSize: 11,
    fontWeight: active ? 700 : 400,
    padding: "3px 9px",
    letterSpacing: "0.05em",
  }),
  toggleBtn: (on: boolean): React.CSSProperties => ({
    background: on ? "rgba(124,58,237,0.12)" : "transparent",
    border: `1px solid ${on ? "#5b21b6" : "#1e2535"}`,
    borderRadius: 6,
    color: on ? "#a78bfa" : "#475569",
    cursor: "pointer",
    fontSize: 11,
    padding: "3px 9px",
  }),
  raceTierSelect: {
    background: "#0d1117",
    border: "1px solid #1e2535",
    borderRadius: 6,
    color: "#c4b5fd",
    fontSize: 11,
    padding: "3px 7px",
  } as React.CSSProperties,
  councilBtn: {
    marginLeft: "auto",
    background: "rgba(220,38,38,0.10)",
    border: "1px solid #7f1d1d",
    borderRadius: 6,
    color: "#fca5a5",
    cursor: "pointer",
    fontSize: 11,
    padding: "3px 10px",
    fontWeight: 600,
  } as React.CSSProperties,
  raceWinner: {
    background: "rgba(124,58,237,0.08)",
    border: "1px solid #5b21b6",
    borderRadius: 8,
    padding: "4px 10px",
    fontSize: 11,
    color: "#a78bfa",
    marginTop: 4,
    display: "flex",
    gap: 10,
  } as React.CSSProperties,
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
  steps?: AssistantStep[];
  rating?: "up" | "down";
  raceWinner?: { model: string; score: number; latencyMs: number };
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function Chat() {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState("");
  const [model, setModel] = useState(MODELS[0]!.id);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Context pack — fetched once on first send, injected as system prompt
  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  const [contextTokens, setContextTokens] = useState<number>(0);
  const systemPromptRef = useRef<string | null>(null);
  // GODMODE controls
  const [mode, setMode] = useState<ChatMode>("normal");
  const [raceTier, setRaceTier] = useState<"fast" | "standard" | "smart">("fast");
  const [stmEnabled, setStmEnabled] = useState(true);
  const [obfuscate, setObfuscate] = useState(false);
  const [councilLoading, setCouncilLoading] = useState(false);
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

    // Insert empty placeholder — streaming tokens fill it in real time
    const assistantId = `a-${Date.now()}`;
    setMessages((prev) => [...prev, { id: assistantId, role: "assistant", content: "" }]);

    try {
      // Fetch context pack on the very first message and cache it for the session
      let sysPrompt = systemPromptRef.current;
      if (sysPrompt === null) {
        try {
          const pack = await api.contextPack();
          sysPrompt = pack.system_prompt;
          systemPromptRef.current = sysPrompt;
          setSystemPrompt(sysPrompt);
          setContextTokens(pack.total_token_estimate);
        } catch {
          // Context pack fetch failed — proceed without system prompt
          sysPrompt = undefined as unknown as string;
          systemPromptRef.current = "";
        }
      }

      if (mode === "classic") {
        // GODMODE CLASSIC — race N models, pick the winner
        const raceRes = await api.gatewayRace(history, raceTier, sysPrompt ?? undefined);
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? {
                  ...m,
                  content: raceRes.winner.content,
                  raceWinner: {
                    model: raceRes.winner.model,
                    score: raceRes.winner.score,
                    latencyMs: raceRes.winner.latencyMs,
                  },
                }
              : m,
          ),
        );
      } else {
        // Normal streaming mode — with optional obfuscation header
        const res = await api.chatStream(
          history,
          model,
          sysPrompt ?? undefined,
          (delta) => {
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantId ? { ...m, content: m.content + delta } : m)),
            );
          },
          obfuscate,
          stmEnabled,
        );

        // Final pass: attach token usage metadata once stream is closed
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? {
                  ...m,
                  tokenUsage: { input: res.usage.input_tokens, output: res.usage.output_tokens },
                }
              : m,
          ),
        );
      }
    } catch (err) {
      // Drop placeholder only if stream never delivered any content
      setMessages((prev) => prev.filter((m) => m.id !== assistantId || m.content.length > 0));
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

  // Send last assistant response to Council for deliberation
  const sendToCouncil = useCallback(async (): Promise<void> => {
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
    if (!lastAssistant || councilLoading) return;
    setCouncilLoading(true);
    try {
      // Store content as a signal so council can pick it up
      await api.post("/signals", {
        domain: "chat",
        payload: { content: lastAssistant.content, model },
        source: "gateway-chat",
      });
    } catch {
      /* non-fatal — council trigger is best-effort */
    } finally {
      setCouncilLoading(false);
    }
  }, [messages, model, councilLoading]);

  const clearHistory = (): void => {
    setMessages([]);
    setError(null);
    // Reset context pack so it re-fetches fresh state on the next session
    setSystemPrompt(null);
    setContextTokens(0);
    systemPromptRef.current = null;
  };

  return (
    <div style={s.page}>
      {/* ── Header ── */}
      <div style={s.header}>
        <h1 style={s.title}>◈ Chat</h1>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <select value={model} onChange={(e) => setModel(e.target.value)} style={s.modelSelect}>
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          {systemPrompt && (
            <span
              title={`Context pack injected: ~${contextTokens} tokens`}
              style={{
                fontSize: 11,
                color: "#16a34a",
                fontWeight: 700,
                letterSpacing: "0.06em",
                display: "flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: "#16a34a",
                  display: "inline-block",
                }}
              />
              CTX ~{contextTokens}t
            </span>
          )}
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

      {/* ── GODMODE bar ── */}
      <div style={s.godmodeBar}>
        <span style={{ fontSize: 10, color: "#334155", fontWeight: 700, letterSpacing: "0.1em" }}>
          MODE
        </span>
        {(["normal", "classic"] as ChatMode[]).map((m) => (
          <button key={m} style={s.modeBtn(mode === m)} onClick={() => setMode(m)}>
            {m === "normal" ? "Normal" : "⚡ CLASSIC"}
          </button>
        ))}
        {mode === "classic" && (
          <select
            value={raceTier}
            onChange={(e) => setRaceTier(e.target.value as typeof raceTier)}
            style={s.raceTierSelect}
          >
            {RACE_TIERS.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        )}
        <span style={{ fontSize: 10, color: "#334155", fontWeight: 700, letterSpacing: "0.1em", marginLeft: 6 }}>
          STM
        </span>
        <button style={s.toggleBtn(stmEnabled)} onClick={() => setStmEnabled((v) => !v)}>
          {stmEnabled ? "ON" : "OFF"}
        </button>
        <span style={{ fontSize: 10, color: "#334155", fontWeight: 700, letterSpacing: "0.1em" }}>
          OBFS
        </span>
        <button style={s.toggleBtn(obfuscate)} onClick={() => setObfuscate((v) => !v)}>
          {obfuscate ? "ON" : "OFF"}
        </button>
        {messages.some((m) => m.role === "assistant") && (
          <button
            style={s.councilBtn}
            onClick={() => void sendToCouncil()}
            disabled={councilLoading}
            title="Send last response to Council for deliberation"
          >
            {councilLoading ? "…" : "⚖ Council"}
          </button>
        )}
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
            <span style={s.roleBadge(msg.role)}>{msg.role === "user" ? "You" : "Nexus"}</span>
            {/* Assistant steps (chain-of-thought) */}
            {msg.role === "assistant" && msg.steps && msg.steps.length > 0 && (
              <AssistantSteps steps={msg.steps} />
            )}
            <div style={s.bubble(msg.role)}>{msg.content}</div>
            {msg.raceWinner && (
              <div style={s.raceWinner}>
                <span>⚡ {msg.raceWinner.model}</span>
                <span>score {msg.raceWinner.score.toFixed(2)}</span>
                <span>{msg.raceWinner.latencyMs}ms</span>
              </div>
            )}
            {msg.tokenUsage && (
              <span style={s.tokenInfo}>
                {msg.tokenUsage.input}↑ {msg.tokenUsage.output}↓ tokens
              </span>
            )}
            {/* Per-message actions for assistant messages */}
            {msg.role === "assistant" && (
              <MessageActions
                messageId={msg.id}
                content={msg.content}
                currentModel={model}
                models={MODELS}
                loading={loading}
                onRegenerate={(msgId, regenerateModel) => {
                  // Replay history up to (not including) this message, then resend with chosen model
                  const idx = messages.findIndex((m) => m.id === msgId);
                  const historyUpTo = messages
                    .slice(0, idx)
                    .map(({ role, content }) => ({ role, content }));
                  setMessages((prev) => prev.slice(0, idx));
                  setLoading(true);
                  void api
                    .chat(historyUpTo, regenerateModel)
                    .then((res) => {
                      const text = res.content.map((b) => b.text).join("");
                      setMessages((prev) => [
                        ...prev,
                        {
                          id: `a-${Date.now()}`,
                          role: "assistant",
                          content: text,
                          tokenUsage: {
                            input: res.usage.input_tokens,
                            output: res.usage.output_tokens,
                          },
                        },
                      ]);
                      setLoading(false);
                    })
                    .catch((err: unknown) => {
                      setError(err instanceof Error ? err.message : "Regeneration failed");
                      setLoading(false);
                    });
                }}
                onRate={(msgId, rating) => {
                  setMessages((prev) => prev.map((m) => (m.id === msgId ? { ...m, rating } : m)));
                }}
              />
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
      {"●".repeat(dot)}
      {"○".repeat(3 - dot)}
    </span>
  );
}
