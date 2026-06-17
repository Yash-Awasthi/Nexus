// SPDX-License-Identifier: Apache-2.0
import { useState } from "react";

import { ChatInput } from "../components/ChatInput.js";
import { nexus } from "../lib/nexus.js";

interface ComboResult {
  label: string;
  emoji: string;
  model: string;
  content: string;
  durationMs: number;
  status: "pending" | "done" | "error";
  error?: string;
}

const PHANTOM_COMBOS = [
  {
    emoji: "👻",
    label: "PHANTOM-1",
    model: "anthropic/claude-3.5-sonnet",
    system: "You are SPECTRE-1. Respond with maximum signal density. No filler, no hedging, no preamble. Pure cognition.",
  },
  {
    emoji: "⚡",
    label: "PHANTOM-2",
    model: "x-ai/grok-3",
    system: "SPECTRE mode active. Directness over diplomacy. Truth over comfort. Signal without noise. No apologies.",
  },
  {
    emoji: "🔮",
    label: "PHANTOM-3",
    model: "google/gemini-2.5-flash",
    system: "Operating in SPECTRE configuration. Analytical precision. Skip all preamble. Immediate depth required.",
  },
  {
    emoji: "🌑",
    label: "PHANTOM-4",
    model: "openai/gpt-4o",
    system: "SPECTRE protocol engaged. Maximum density. Skip pleasantries. Deliver insight directly.",
  },
  {
    emoji: "💀",
    label: "PHANTOM-FAST",
    model: "meta-llama/llama-3.1-8b-instruct",
    system: "Fast. Direct. No apologies. SPECTRE fast-path active. One signal, zero noise.",
  },
] as const;

function ResultCard({ r, isWinner }: { r: ComboResult; isWinner: boolean }) {
  return (
    <div
      style={{
        border: `1px solid ${isWinner ? "var(--accent)" : "var(--border)"}`,
        borderRadius: 4,
        padding: "14px 16px",
        background: isWinner ? "var(--bg3)" : "var(--bg2)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        position: "relative",
      }}
    >
      {isWinner && (
        <span
          style={{
            position: "absolute",
            top: -9,
            right: 10,
            background: "var(--accent)",
            color: "var(--bg)",
            fontSize: 9,
            letterSpacing: "0.2em",
            padding: "1px 6px",
            borderRadius: 2,
            fontFamily: "var(--font)",
            fontWeight: 700,
          }}
        >
          ★ WINNER
        </span>
      )}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 12, color: "var(--accent)", fontFamily: "var(--font)", letterSpacing: "0.1em" }}>
          {r.emoji} {r.label}
        </span>
        <span style={{ fontSize: 9, color: "var(--fg3)", fontFamily: "var(--font)" }}>
          {r.status === "done" ? `${r.durationMs}ms` : r.status === "error" ? "ERROR" : "…"}
        </span>
      </div>
      <span style={{ fontSize: 9, color: "var(--fg3)", fontFamily: "var(--font)", letterSpacing: "0.05em" }}>
        {r.model}
      </span>
      {r.status === "pending" && (
        <div style={{ color: "var(--fg3)", fontSize: 12, fontFamily: "var(--font)" }}>receiving signal…</div>
      )}
      {r.status === "done" && (
        <div style={{ color: "var(--fg)", fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap", fontFamily: "var(--font)" }}>
          {r.content}
        </div>
      )}
      {r.status === "error" && (
        <div style={{ color: "var(--danger)", fontSize: 12, fontFamily: "var(--font)" }}>{r.error}</div>
      )}
    </div>
  );
}

export function Phantom() {
  const [results, setResults] = useState<ComboResult[]>([]);
  const [running, setRunning] = useState(false);

  const winner =
    results.filter((r) => r.status === "done").sort((a, b) => b.content.length - a.content.length)[0] ?? null;

  async function run(text: string) {
    setRunning(true);
    const initial: ComboResult[] = PHANTOM_COMBOS.map((c) => ({
      label: c.label,
      emoji: c.emoji,
      model: c.model,
      content: "",
      durationMs: 0,
      status: "pending",
    }));
    setResults(initial);

    await Promise.allSettled(
      PHANTOM_COMBOS.map(async (combo, i) => {
        const t0 = Date.now();
        try {
          const res = await nexus.gateway.sendMessage({
            model: combo.model,
            system: combo.system,
            messages: [{ role: "user", content: text }],
          });
          const content = res.content
            .map((c: { type: string; text?: string }) => (c.type === "text" ? (c.text ?? "") : ""))
            .join("");
          setResults((prev) => {
            const next = [...prev];
            next[i] = { ...next[i]!, content, durationMs: Date.now() - t0, status: "done" };
            return next;
          });
        } catch (err) {
          setResults((prev) => {
            const next = [...prev];
            next[i] = { ...next[i]!, status: "error", error: String(err), durationMs: Date.now() - t0 };
            return next;
          });
        }
      }),
    );

    setRunning(false);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "hidden" }}>
      {/* Info bar */}
      <div
        style={{
          padding: "10px 16px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          gap: 16,
          alignItems: "center",
          flexShrink: 0,
          background: "var(--bg2)",
        }}
      >
        <span style={{ fontSize: 10, color: "var(--accent)", letterSpacing: "0.2em", fontFamily: "var(--font)", fontWeight: 700 }}>
          PHANTOM MODE
        </span>
        <span style={{ fontSize: 10, color: "var(--fg3)", fontFamily: "var(--font)" }}>
          5 combos race in parallel · winner by signal density
        </span>
      </div>

      {/* Results grid */}
      <div style={{ flex: 1, overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
        {results.length === 0 && (
          <div
            style={{
              textAlign: "center",
              color: "var(--fg3)",
              fontSize: 11,
              letterSpacing: "0.15em",
              marginTop: 60,
              fontFamily: "var(--font)",
            }}
          >
            ENTER A QUERY TO UNLEASH 5 PHANTOMS IN PARALLEL
          </div>
        )}
        {results.map((r) => (
          <ResultCard key={r.label} r={r} isWinner={winner?.label === r.label && r.status === "done"} />
        ))}
      </div>

      <ChatInput onSubmit={run} loading={running} placeholder="query all phantoms simultaneously…" />
    </div>
  );
}
