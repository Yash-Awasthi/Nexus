// SPDX-License-Identifier: Apache-2.0
import { useState } from "react";
import { api } from "../lib/api.js";

interface Vote { model: string; vote: string; confidence: number; reasoning: string; latencyMs: number }
interface CouncilResult { outcome: string; consensus: number; summary: string; votes: Vote[]; totalLatencyMs: number }

const input: React.CSSProperties = {
  width: "100%", padding: "10px 14px", background: "#161b27",
  border: "1px solid #1e2535", borderRadius: 8, color: "#e2e8f0",
  fontSize: 14, marginBottom: 12, outline: "none",
};

export default function Council() {
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [budget, setBudget] = useState("0.10");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<CouncilResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function deliberate() {
    if (!title.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.post<{ ok: boolean; result: CouncilResult }>("/council/deliberate", {
        proposal: { title, description: desc || undefined },
        budgetUsd: parseFloat(budget),
      });
      setResult(res.result);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  const outcomeColor = result?.outcome === "approved" ? "#16a34a" : result?.outcome === "rejected" ? "#dc2626" : "#d97706";

  return (
    <div style={{ maxWidth: 720 }}>
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 24 }}>⚖ Council Deliberation</h1>

      <input style={input} placeholder="Proposal title *" value={title} onChange={(e) => setTitle(e.target.value)} />
      <textarea
        style={{ ...input, height: 100, resize: "vertical" }}
        placeholder="Description (optional)"
        value={desc}
        onChange={(e) => setDesc(e.target.value)}
      />
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 16 }}>
        <label style={{ color: "#94a3b8", fontSize: 13 }}>Budget ($USD)</label>
        <input style={{ ...input, width: 100, marginBottom: 0 }} value={budget} onChange={(e) => setBudget(e.target.value)} />
      </div>

      <button
        style={{
          padding: "10px 24px", background: loading ? "#4c1d95" : "#7c3aed",
          border: "none", borderRadius: 8, color: "#fff", fontSize: 14,
          cursor: loading ? "default" : "pointer", transition: "background 0.15s",
        }}
        onClick={deliberate}
        disabled={loading}
      >
        {loading ? "Deliberating…" : "Deliberate"}
      </button>

      {error && <div style={{ marginTop: 20, color: "#fca5a5" }}>{error}</div>}

      {result && (
        <div style={{ marginTop: 32, background: "#161b27", border: "1px solid #1e2535", borderRadius: 10, padding: 24 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
            <span style={{ fontSize: 22, fontWeight: 700, color: outcomeColor, textTransform: "uppercase" }}>
              {result.outcome}
            </span>
            <span style={{ color: "#64748b" }}>
              {(result.consensus * 100).toFixed(0)}% consensus · {result.totalLatencyMs}ms
            </span>
          </div>
          <p style={{ color: "#94a3b8", marginBottom: 20 }}>{result.summary}</p>

          <h3 style={{ fontSize: 13, color: "#64748b", textTransform: "uppercase", marginBottom: 12 }}>
            Archetype Votes
          </h3>
          {result.votes.map((v, i) => {
            const vc = v.vote === "yes" ? "#16a34a" : v.vote === "no" ? "#dc2626" : "#64748b";
            return (
              <div key={i} style={{ borderTop: "1px solid #1e2535", paddingTop: 12, marginTop: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                  <span style={{ color: "#c4b5fd", fontWeight: 600 }}>{v.model}</span>
                  <span style={{ color: vc, fontWeight: 700, textTransform: "uppercase" }}>{v.vote}</span>
                </div>
                <p style={{ fontSize: 12, color: "#64748b", lineClamp: 3 }}>{v.reasoning.slice(0, 200)}…</p>
                <p style={{ fontSize: 11, color: "#475569", marginTop: 4 }}>
                  {(v.confidence * 100).toFixed(0)}% confidence · {v.latencyMs}ms
                </p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
