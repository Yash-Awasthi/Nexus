// SPDX-License-Identifier: Apache-2.0
/**
 * Council page — three-panel layout
 *   Left:   Active Signals  (live poll every 5 s via GET /ingest/signals)
 *   Center: Verdicts        (paginated, GET /council/verdicts)
 *   Right:  Deliberate      (ad-hoc form + trigger-by-signalId)
 */
import { useState, useEffect, useCallback, useRef } from "react";

import { api } from "../lib/api.js";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Signal {
  id: string;
  signalType: string;
  summary: string;
  priority: "low" | "medium" | "high" | "critical";
  createdAt: string;
}

interface Verdict {
  id: string;
  signalId: string;
  decision: "approve" | "reject" | "defer" | "escalate";
  confidence: number;
  rationale: string;
  costUsd: string | null;
  createdAt: string;
}

interface Vote {
  model: string;
  vote: string;
  confidence: number;
  reasoning: string;
  latencyMs: number;
}

interface CouncilResult {
  outcome: string;
  consensus: number;
  summary: string;
  votes: Vote[];
  totalLatencyMs: number;
  totalCostUsd?: number;
}

// ── Styles ────────────────────────────────────────────────────────────────────

const panel: React.CSSProperties = {
  background: "#0f1520",
  border: "1px solid #1e2535",
  borderRadius: 10,
  padding: 16,
  display: "flex",
  flexDirection: "column",
  gap: 8,
  overflowY: "auto",
  height: "calc(100vh - 120px)",
};

const inp: React.CSSProperties = {
  width: "100%",
  padding: "9px 12px",
  background: "#161b27",
  border: "1px solid #1e2535",
  borderRadius: 7,
  color: "#e2e8f0",
  fontSize: 13,
  outline: "none",
  boxSizing: "border-box",
};

const sectionTitle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  color: "#64748b",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  marginBottom: 4,
};

const badge = (color: string): React.CSSProperties => ({
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: 4,
  fontSize: 11,
  fontWeight: 700,
  color: "#fff",
  background: color,
  textTransform: "uppercase",
});

const PRIORITY_COLOR: Record<string, string> = {
  low: "#475569",
  medium: "#0284c7",
  high: "#d97706",
  critical: "#dc2626",
};

const DECISION_COLOR: Record<string, string> = {
  approve: "#16a34a",
  reject: "#dc2626",
  defer: "#d97706",
  escalate: "#9333ea",
};

const OUTCOME_COLOR = (o: string) =>
  o === "approved" ? "#16a34a" : o === "rejected" ? "#dc2626" : "#d97706";

// ── Helpers ───────────────────────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  return `${Math.floor(sec / 3600)}h ago`;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SignalCard({ signal, onTrigger }: { signal: Signal; onTrigger: (id: string) => void }) {
  return (
    <div
      style={{
        background: "#161b27",
        border: "1px solid #1e2535",
        borderRadius: 8,
        padding: 10,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 8,
          marginBottom: 4,
        }}
      >
        <span style={{ fontSize: 11, color: "#94a3b8", fontFamily: "monospace" }}>
          {signal.signalType}
        </span>
        <span style={badge(PRIORITY_COLOR[signal.priority] ?? "#475569")}>{signal.priority}</span>
      </div>
      <p style={{ fontSize: 12, color: "#cbd5e1", margin: "0 0 8px", lineHeight: 1.45 }}>
        {signal.summary.slice(0, 120)}
        {signal.summary.length > 120 ? "…" : ""}
      </p>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 11, color: "#475569" }}>{timeAgo(signal.createdAt)}</span>
        <button
          onClick={() => onTrigger(signal.id)}
          style={{
            padding: "3px 10px",
            background: "transparent",
            border: "1px solid #7c3aed",
            borderRadius: 5,
            color: "#a78bfa",
            fontSize: 11,
            cursor: "pointer",
          }}
        >
          Deliberate →
        </button>
      </div>
    </div>
  );
}

function VerdictCard({ verdict }: { verdict: Verdict }) {
  return (
    <div
      style={{
        background: "#161b27",
        border: "1px solid #1e2535",
        borderRadius: 8,
        padding: 10,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 6,
        }}
      >
        <span style={badge(DECISION_COLOR[verdict.decision] ?? "#475569")}>{verdict.decision}</span>
        <span style={{ fontSize: 11, color: "#475569" }}>
          {(verdict.confidence * 100).toFixed(0)}% · {timeAgo(verdict.createdAt)}
        </span>
      </div>
      <p style={{ fontSize: 12, color: "#94a3b8", margin: 0, lineHeight: 1.45 }}>
        {verdict.rationale.slice(0, 140)}
        {verdict.rationale.length > 140 ? "…" : ""}
      </p>
      {verdict.costUsd && (
        <span style={{ fontSize: 10, color: "#475569", marginTop: 4, display: "block" }}>
          ${parseFloat(verdict.costUsd).toFixed(4)} USD
        </span>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function Council() {
  // ── Signals state ───────────────────────────────────────────────────────
  const [signals, setSignals] = useState<Signal[]>([]);
  const [signalsError, setSignalsError] = useState<string | null>(null);

  // ── Verdicts state ──────────────────────────────────────────────────────
  const [verdictList, setVerdictList] = useState<Verdict[]>([]);
  const [verdictOffset, setVerdictOffset] = useState(0);
  const [verdictLoading, setVerdictLoading] = useState(false);
  const [verdictEnd, setVerdictEnd] = useState(false);
  const VERDICT_LIMIT = 10;

  // ── Deliberate form state ───────────────────────────────────────────────
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [budget, setBudget] = useState("0.10");
  const [triggerSid, setTriggerSid] = useState(""); // trigger-by-signalId
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<CouncilResult | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Live signal poll ────────────────────────────────────────────────────

  const fetchSignals = useCallback(async () => {
    try {
      const res = await api.get<{ signals: Signal[] }>("/ingest/signals?limit=20");
      setSignals(res.signals);
      setSignalsError(null);
    } catch (e) {
      setSignalsError(String(e));
    }
  }, []);

  useEffect(() => {
    void fetchSignals();
    pollRef.current = setInterval(() => void fetchSignals(), 5_000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [fetchSignals]);

  // ── Verdict pagination ──────────────────────────────────────────────────

  const fetchVerdicts = useCallback(async (offset: number, replace: boolean) => {
    setVerdictLoading(true);
    try {
      const res = await api.get<{ verdicts: Verdict[] }>(
        `/council/verdicts?limit=${VERDICT_LIMIT}&offset=${offset}`,
      );
      setVerdictList((prev) => (replace ? res.verdicts : [...prev, ...res.verdicts]));
      if (res.verdicts.length < VERDICT_LIMIT) setVerdictEnd(true);
    } catch {
      // silently keep old list
    } finally {
      setVerdictLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchVerdicts(0, true);
  }, [fetchVerdicts]);

  function loadMoreVerdicts() {
    const next = verdictOffset + VERDICT_LIMIT;
    setVerdictOffset(next);
    void fetchVerdicts(next, false);
  }

  // ── Trigger from signal card ────────────────────────────────────────────

  function handleTriggerSignal(signalId: string) {
    setTriggerSid(signalId);
    setTitle("");
    setDesc("");
    setResult(null);
    setFormError(null);
    // Scroll into view handled by browser naturally
  }

  // ── Deliberate (ad-hoc) ────────────────────────────────────────────────

  async function deliberate() {
    if (!title.trim()) return;
    setLoading(true);
    setFormError(null);
    setResult(null);
    try {
      const res = await api.post<{ ok: boolean; result: CouncilResult }>("/council/deliberate", {
        proposal: { title, description: desc || undefined },
        budgetUsd: parseFloat(budget),
      });
      setResult(res.result);
      void fetchVerdicts(0, true); // refresh verdicts after new deliberation
      setVerdictOffset(0);
      setVerdictEnd(false);
    } catch (e) {
      setFormError(String(e));
    } finally {
      setLoading(false);
    }
  }

  // ── Trigger by signalId ────────────────────────────────────────────────

  async function triggerBySignal() {
    if (!triggerSid.trim()) return;
    setLoading(true);
    setFormError(null);
    setResult(null);
    try {
      const res = await api.post<{ ok: boolean; result: CouncilResult }>("/council/trigger", {
        signalId: triggerSid,
        budgetUsd: parseFloat(budget),
      });
      setResult(res.result);
      void fetchVerdicts(0, true);
      setVerdictOffset(0);
      setVerdictEnd(false);
    } catch (e) {
      setFormError(String(e));
    } finally {
      setLoading(false);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div style={{ padding: "0 4px" }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 16, color: "#e2e8f0" }}>
        ⚖ Council
      </h1>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1.3fr", gap: 14 }}>
        {/* ── Panel 1: Active Signals ── */}
        <div style={panel}>
          <div style={sectionTitle}>
            Active Signals <span style={{ color: "#334155" }}>· live</span>
          </div>

          {signalsError && <div style={{ fontSize: 12, color: "#fca5a5" }}>{signalsError}</div>}

          {signals.length === 0 && !signalsError && (
            <div style={{ fontSize: 12, color: "#475569", marginTop: 8 }}>No signals yet.</div>
          )}

          {signals.map((s) => (
            <SignalCard key={s.id} signal={s} onTrigger={handleTriggerSignal} />
          ))}
        </div>

        {/* ── Panel 2: Verdicts ── */}
        <div style={panel}>
          <div style={sectionTitle}>Verdicts</div>

          {verdictList.length === 0 && !verdictLoading && (
            <div style={{ fontSize: 12, color: "#475569", marginTop: 8 }}>No verdicts yet.</div>
          )}

          {verdictList.map((v) => (
            <VerdictCard key={v.id} verdict={v} />
          ))}

          {!verdictEnd && (
            <button
              onClick={loadMoreVerdicts}
              disabled={verdictLoading}
              style={{
                marginTop: 8,
                padding: "7px 0",
                background: "transparent",
                border: "1px solid #1e2535",
                borderRadius: 6,
                color: "#64748b",
                fontSize: 12,
                cursor: verdictLoading ? "default" : "pointer",
              }}
            >
              {verdictLoading ? "Loading…" : "Load more"}
            </button>
          )}
        </div>

        {/* ── Panel 3: Deliberate ── */}
        <div style={panel}>
          <div style={sectionTitle}>Deliberate</div>

          {/* Trigger by Signal ID */}
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 11, color: "#64748b", marginBottom: 4 }}>
              Trigger by Signal ID
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <input
                style={{ ...inp, flex: 1, marginBottom: 0 }}
                placeholder="signal UUID"
                value={triggerSid}
                onChange={(e) => setTriggerSid(e.target.value)}
              />
              <button
                onClick={() => void triggerBySignal()}
                disabled={loading || !triggerSid.trim()}
                style={{
                  padding: "0 12px",
                  background: loading ? "#1e1b4b" : "#312e81",
                  border: "none",
                  borderRadius: 6,
                  color: "#c7d2fe",
                  fontSize: 12,
                  cursor: loading ? "default" : "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                {loading ? "…" : "Trigger"}
              </button>
            </div>
          </div>

          <div style={{ borderTop: "1px solid #1e2535", paddingTop: 10, marginBottom: 4 }}>
            <div style={{ fontSize: 11, color: "#64748b", marginBottom: 6 }}>Ad-hoc proposal</div>
          </div>

          <input
            style={inp}
            placeholder="Proposal title *"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <textarea
            style={{ ...inp, height: 80, resize: "vertical", marginTop: 6 }}
            placeholder="Description (optional)"
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
          />

          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
            <span style={{ fontSize: 12, color: "#64748b", whiteSpace: "nowrap" }}>Budget ($)</span>
            <input
              style={{ ...inp, width: 80 }}
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
            />
            <button
              onClick={() => void deliberate()}
              disabled={loading || !title.trim()}
              style={{
                flex: 1,
                padding: "9px 0",
                background: loading ? "#4c1d95" : "#7c3aed",
                border: "none",
                borderRadius: 7,
                color: "#fff",
                fontSize: 13,
                fontWeight: 600,
                cursor: loading ? "default" : "pointer",
              }}
            >
              {loading ? "Deliberating…" : "Deliberate"}
            </button>
          </div>

          {formError && (
            <div style={{ fontSize: 12, color: "#fca5a5", marginTop: 8 }}>{formError}</div>
          )}

          {/* Result */}
          {result && (
            <div
              style={{
                marginTop: 12,
                background: "#161b27",
                border: "1px solid #1e2535",
                borderRadius: 8,
                padding: 12,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                <span
                  style={{
                    fontSize: 18,
                    fontWeight: 700,
                    color: OUTCOME_COLOR(result.outcome),
                    textTransform: "uppercase",
                  }}
                >
                  {result.outcome}
                </span>
                <span style={{ fontSize: 12, color: "#64748b" }}>
                  {(result.consensus * 100).toFixed(0)}% consensus
                  {result.totalCostUsd ? ` · $${result.totalCostUsd.toFixed(4)}` : ""}
                </span>
              </div>
              <p style={{ fontSize: 12, color: "#94a3b8", marginBottom: 10 }}>{result.summary}</p>

              <div
                style={{
                  fontSize: 11,
                  color: "#475569",
                  textTransform: "uppercase",
                  marginBottom: 6,
                }}
              >
                Archetype votes
              </div>
              {result.votes.map((v, i) => {
                const vc = v.vote === "yes" ? "#16a34a" : v.vote === "no" ? "#dc2626" : "#64748b";
                return (
                  <div
                    key={i}
                    style={{ borderTop: "1px solid #1e2535", paddingTop: 8, marginTop: 8 }}
                  >
                    <div
                      style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}
                    >
                      <span style={{ fontSize: 12, color: "#c4b5fd", fontWeight: 600 }}>
                        {v.model}
                      </span>
                      <span
                        style={{
                          fontSize: 11,
                          color: vc,
                          fontWeight: 700,
                          textTransform: "uppercase",
                        }}
                      >
                        {v.vote}
                      </span>
                    </div>
                    <p style={{ fontSize: 11, color: "#64748b", margin: 0 }}>
                      {v.reasoning.slice(0, 160)}…
                    </p>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
