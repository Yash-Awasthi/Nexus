// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from "react";

import { ChatInput } from "../components/ChatInput.js";
import { MessageBubble } from "../components/MessageBubble.js";
import { nexus } from "../lib/nexus.js";
import { autoTitle, deleteSession, loadSessions, newSession, saveSession, type StoredSession } from "../lib/storage.js";

const MODELS = [
  { id: "nexus/smart", label: "SMART" },
  { id: "nexus/fast", label: "FAST" },
  { id: "anthropic/claude-3.5-sonnet", label: "CLAUDE" },
  { id: "openai/gpt-4o", label: "GPT-4O" },
  { id: "google/gemini-2.5-flash", label: "GEMINI" },
  { id: "x-ai/grok-3", label: "GROK" },
];

export function Chat() {
  const [sessions, setSessions] = useState<StoredSession[]>(() => loadSessions());
  const [activeId, setActiveId] = useState<string>(() => {
    const all = loadSessions();
    return all[0]?.id ?? newSession("chat").id;
  });
  const [model, setModel] = useState(MODELS[0]!.id);
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const session = sessions.find((s) => s.id === activeId) ?? newSession("chat");

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [session.messages.length]);

  function startNewSession() {
    const s = newSession("chat");
    saveSession(s);
    setSessions(loadSessions());
    setActiveId(s.id);
  }

  function switchSession(id: string) {
    setActiveId(id);
    setSessions(loadSessions());
  }

  function removeSession(id: string) {
    deleteSession(id);
    const remaining = loadSessions();
    setSessions(remaining);
    if (activeId === id) {
      setActiveId(remaining[0]?.id ?? newSession("chat").id);
    }
  }

  async function send(text: string) {
    let cur = sessions.find((s) => s.id === activeId);
    if (!cur) {
      cur = newSession("chat");
    }

    const updated: StoredSession = {
      ...cur,
      messages: [...cur.messages, { role: "user", content: text, ts: Date.now() }],
      updatedAt: Date.now(),
    };
    if (updated.title === "New session") updated.title = autoTitle(updated);
    saveSession(updated);
    setSessions(loadSessions());

    setLoading(true);
    const t0 = Date.now();
    try {
      const res = await nexus.gateway.sendMessage({
        model,
        messages: updated.messages.map((m) => ({ role: m.role, content: m.content })),
      });
      const content = res.content.map((c: { type: string; text?: string }) => (c.type === "text" ? (c.text ?? "") : "")).join("");
      const withReply: StoredSession = {
        ...updated,
        messages: [
          ...updated.messages,
          { role: "assistant", content, ts: Date.now(), model, durationMs: Date.now() - t0 },
        ],
        updatedAt: Date.now(),
      };
      saveSession(withReply);
      setSessions(loadSessions());
    } catch (err) {
      const withErr: StoredSession = {
        ...updated,
        messages: [
          ...updated.messages,
          { role: "assistant", content: `[error] ${String(err)}`, ts: Date.now(), model },
        ],
        updatedAt: Date.now(),
      };
      saveSession(withErr);
      setSessions(loadSessions());
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
      {/* Sidebar */}
      <aside
        style={{
          width: 200,
          borderRight: "1px solid var(--border)",
          display: "flex",
          flexDirection: "column",
          background: "var(--bg)",
          flexShrink: 0,
          overflowY: "auto",
        }}
      >
        <button
          onClick={startNewSession}
          style={{
            margin: 8,
            padding: "7px 10px",
            background: "var(--accent)",
            color: "var(--bg)",
            border: "none",
            borderRadius: 3,
            fontFamily: "var(--font)",
            fontSize: 10,
            letterSpacing: "0.15em",
            cursor: "pointer",
            fontWeight: 700,
          }}
        >
          + NEW SESSION
        </button>
        {sessions.map((s) => (
          <div
            key={s.id}
            onClick={() => switchSession(s.id)}
            style={{
              padding: "8px 10px",
              fontSize: 11,
              color: s.id === activeId ? "var(--accent)" : "var(--fg2)",
              background: s.id === activeId ? "var(--bg3)" : "transparent",
              borderLeft: s.id === activeId ? "2px solid var(--accent)" : "2px solid transparent",
              cursor: "pointer",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              fontFamily: "var(--font)",
            }}
          >
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
              {s.title}
            </span>
            <span
              onClick={(e) => {
                e.stopPropagation();
                removeSession(s.id);
              }}
              style={{ fontSize: 10, color: "var(--fg3)", marginLeft: 4, cursor: "pointer" }}
            >
              ×
            </span>
          </div>
        ))}
      </aside>

      {/* Main */}
      <div style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "hidden" }}>
        {/* Model picker */}
        <div
          style={{
            display: "flex",
            gap: 6,
            padding: "8px 12px",
            borderBottom: "1px solid var(--border)",
            background: "var(--bg2)",
            alignItems: "center",
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: 9, color: "var(--fg3)", letterSpacing: "0.2em" }}>MODEL</span>
          {MODELS.map((m) => (
            <button
              key={m.id}
              onClick={() => setModel(m.id)}
              style={{
                fontSize: 9,
                padding: "2px 7px",
                background: model === m.id ? "var(--accent)" : "transparent",
                color: model === m.id ? "var(--bg)" : "var(--fg3)",
                border: `1px solid ${model === m.id ? "var(--accent)" : "var(--border)"}`,
                borderRadius: 2,
                cursor: "pointer",
                fontFamily: "var(--font)",
                letterSpacing: "0.1em",
              }}
            >
              {m.label}
            </button>
          ))}
        </div>

        {/* Messages */}
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            gap: 10,
            padding: "16px 20px",
          }}
        >
          {session.messages.length === 0 && (
            <div
              style={{
                textAlign: "center",
                color: "var(--fg3)",
                fontSize: 11,
                letterSpacing: "0.15em",
                marginTop: 60,
              }}
            >
              AWAITING SIGNAL
            </div>
          )}
          {session.messages.map((m, i) => (
            <MessageBubble key={i} msg={m} />
          ))}
          <div ref={bottomRef} />
        </div>

        <ChatInput onSubmit={send} loading={loading} />
      </div>
    </div>
  );
}
