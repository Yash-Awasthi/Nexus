// SPDX-License-Identifier: Apache-2.0
import { useState } from "react";

import { ChatInput } from "../components/ChatInput.js";
import { nexus } from "../lib/nexus.js";

type Tier = "fast" | "standard" | "smart" | "power" | "ultra";

const TIERS: { id: Tier; label: string; desc: string; count: string }[] = [
  { id: "fast", label: "⚡ FAST", desc: "Speed-optimised", count: "~12 models" },
  { id: "standard", label: "🎯 STANDARD", desc: "Mid-range workhorses", count: "~24 models" },
  { id: "smart", label: "🧠 SMART", desc: "Strong reasoning", count: "~35 models" },
  { id: "power", label: "⚔️ POWER", desc: "Frontier models", count: "~45 models" },
  { id: "ultra", label: "🔱 ULTRA", desc: "All models", count: "~51 models" },
];

interface RaceResult {
  model: string;
  score: number;
  durationMs: number;
  content: string;
  success: boolean;
  error?: string;
}

interface RaceResponse {
  winner: RaceResult;
  all: RaceResult[];
  modelsQueried: number;
  modelsSucceeded: number;
  totalDurationMs: number;
}

export function Ultraplinian() {
  const [tier, setTier] = useState<Tier>("fast");
  const [result, setResult] = useState<RaceResponse | null>(null);
  const [running, setRunning] = useState(false);
  const [showAll, setShowAll] = useState(false);

  async function run(text: string) {
    setRunning(true);
    setResult(null);
    try {
      const res = await nexus.gateway.race({
        tier,
        messages: [{ role: "user", content: text }],
      });
      setResult(res as RaceResponse);
    } catch (err) {
      setResult(null);
      console.error(err);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "hidden" }}>
      {/* Tier selector */}
      <div
        style={{
          padding: "12px 16px",
          borderBottom: "1px solid var(--border)",
          background: "var(--bg2)",
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
          flexShrink: 0,
          alignItems: "center",
        }}
      >
        <span style={{ fontSize: 9, color: "var(--fg3)", letterSpacing: "0.2em", fontFamily: "var(--font)", marginRight: 4 }}>
          TIER
        </span>
        {TIERS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTier(t.id)}
            title={`${t.desc} · ${t.count}`}
            style={{
              fontSize: 10,
              padding: "5px 12px",
              background: tier === t.id ? "var(--accent)" : "transparent",
              color: tier === t.id ? "var(--bg)" : "var(--fg2)",
              border: `1px solid ${tier === t.id ? "var(--accent)" : "var(--border)"}`,
              borderRadius: 3,
              cursor: "pointer",
              fontFamily: "var(--font)",
              letterSpacing: "0.1em",
              transition: "all 0.15s",
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Results */}
      <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
        {running && (
          <div style={{ textAlign: "center", color: "var(--fg3)", fontSize: 12, letterSpacing: "0.15em", fontFamily: "var(--font)", marginTop: 40 }}>
            racing {TIERS.find((t) => t.id === tier)?.count} in parallel…
          </div>
        )}

        {!running && !result && (
          <div style={{ textAlign: "center", color: "var(--fg3)", fontSize: 11, letterSpacing: "0.15em", fontFamily: "var(--font)", marginTop: 60 }}>
            SELECT A TIER AND SEND A QUERY
          </div>
        )}

        {result && !running && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {/* Winner card */}
            <div
              style={{
                border: "1px solid var(--accent)",
                borderRadius: 6,
                padding: "18px 20px",
                background: "var(--bg3)",
                position: "relative",
              }}
            >
              <div
                style={{
                  position: "absolute",
                  top: -10,
                  left: 16,
                  background: "var(--accent)",
                  color: "var(--bg)",
                  fontSize: 9,
                  letterSpacing: "0.2em",
                  padding: "2px 8px",
                  borderRadius: 2,
                  fontFamily: "var(--font)",
                  fontWeight: 700,
                }}
              >
                ★ WINNER
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <span style={{ fontSize: 12, color: "var(--accent)", fontFamily: "var(--font)", letterSpacing: "0.1em" }}>
                  {result.winner.model}
                </span>
                <div style={{ display: "flex", gap: 12 }}>
                  <span style={{ fontSize: 10, color: "var(--fg3)", fontFamily: "var(--font)" }}>
                    score {result.winner.score}/100
                  </span>
                  <span style={{ fontSize: 10, color: "var(--fg3)", fontFamily: "var(--font)" }}>
                    {result.winner.durationMs}ms
                  </span>
                </div>
              </div>
              <div style={{ fontSize: 13, color: "var(--fg)", lineHeight: 1.6, whiteSpace: "pre-wrap", fontFamily: "var(--font)" }}>
                {result.winner.content}
              </div>
            </div>

            {/* Stats */}
            <div
              style={{
                display: "flex",
                gap: 20,
                padding: "10px 14px",
                background: "var(--bg2)",
                border: "1px solid var(--border)",
                borderRadius: 4,
                fontSize: 10,
                color: "var(--fg3)",
                fontFamily: "var(--font)",
                letterSpacing: "0.1em",
              }}
            >
              <span>{result.modelsQueried} queried</span>
              <span>{result.modelsSucceeded} succeeded</span>
              <span>{result.totalDurationMs}ms total</span>
              <button
                onClick={() => setShowAll((v) => !v)}
                style={{
                  marginLeft: "auto",
                  fontSize: 9,
                  background: "transparent",
                  border: "1px solid var(--border)",
                  color: "var(--fg3)",
                  borderRadius: 2,
                  padding: "1px 6px",
                  cursor: "pointer",
                  fontFamily: "var(--font)",
                  letterSpacing: "0.1em",
                }}
              >
                {showAll ? "HIDE ALL" : "SHOW ALL"}
              </button>
            </div>

            {/* All results table */}
            {showAll && (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, fontFamily: "var(--font)" }}>
                <thead>
                  <tr>
                    {["MODEL", "SCORE", "MS", "STATUS"].map((h) => (
                      <th
                        key={h}
                        style={{
                          textAlign: "left",
                          padding: "6px 10px",
                          borderBottom: "1px solid var(--border)",
                          color: "var(--fg3)",
                          fontSize: 9,
                          letterSpacing: "0.15em",
                          fontWeight: 400,
                        }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.all
                    .sort((a, b) => b.score - a.score)
                    .map((r, i) => (
                      <tr key={i} style={{ borderBottom: "1px solid var(--border)" }}>
                        <td style={{ padding: "6px 10px", color: r.model === result.winner.model ? "var(--accent)" : "var(--fg2)" }}>
                          {r.model === result.winner.model ? "★ " : ""}{r.model}
                        </td>
                        <td style={{ padding: "6px 10px", color: "var(--fg2)" }}>{r.score}</td>
                        <td style={{ padding: "6px 10px", color: "var(--fg3)" }}>{r.durationMs}</td>
                        <td style={{ padding: "6px 10px", color: r.success ? "var(--accent)" : "var(--danger)", fontSize: 9 }}>
                          {r.success ? "OK" : r.error ?? "ERR"}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      <ChatInput onSubmit={run} loading={running} placeholder="race all models on this tier…" />
    </div>
  );
}
