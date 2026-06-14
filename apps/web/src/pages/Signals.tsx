// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from "react";

import { api } from "../lib/api.js";

interface Signal {
  id: string;
  signal_type: string;
  summary: string;
  priority: string;
  source_ref: string | null;
  created_at: string;
}

const priorityColor: Record<string, string> = {
  low: "#475569",
  medium: "#2563eb",
  high: "#d97706",
  critical: "#dc2626",
};

const priorityBorder: Record<string, string> = {
  low: "#1e2535",
  medium: "#1d3a6e",
  high: "#78350f",
  critical: "#7f1d1d",
};

export default function Signals() {
  const [signals, setSignals] = useState<Signal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("all");

  useEffect(() => {
    const query =
      filter !== "all"
        ? `/ingest/signals?priority=${filter}&limit=100`
        : "/ingest/signals?limit=100";
    api
      .get<{ signals: Signal[]; limit: number; offset: number }>(query)
      // eslint-disable-next-line promise/always-return -- void side-effect, no return needed
      .then((data) => {
        setSignals(data.signals);
        setError(null);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Failed to load signals");
      })
      .finally(() => setLoading(false));
  }, [filter]);

  const priorities = ["all", "critical", "high", "medium", "low"];

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 24,
        }}
      >
        <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0 }}>⚡ Signals</h1>
        <div style={{ display: "flex", gap: 6 }}>
          {priorities.map((p) => (
            <button
              key={p}
              onClick={() => setFilter(p)}
              style={{
                padding: "4px 12px",
                borderRadius: 6,
                border: `1px solid ${filter === p ? (priorityColor[p] ?? "#7c3aed") : "#1e2535"}`,
                background: filter === p ? (priorityColor[p] ?? "#7c3aed") + "22" : "transparent",
                color: filter === p ? (priorityColor[p] ?? "#c4b5fd") : "#64748b",
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
                textTransform: "capitalize",
              }}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      {loading && <p style={{ color: "#64748b" }}>Loading signals…</p>}

      {error && (
        <div
          style={{
            background: "#1c0a0a",
            border: "1px solid #7f1d1d",
            borderRadius: 8,
            padding: "12px 16px",
            color: "#f87171",
            marginBottom: 16,
          }}
        >
          {error}
        </div>
      )}

      {!loading && !error && signals.length === 0 && (
        <p style={{ color: "#64748b" }}>No signals yet — ingest events to generate signals.</p>
      )}

      {signals.map((s) => (
        <div
          key={s.id}
          style={{
            background: "#161b27",
            border: `1px solid ${priorityBorder[s.priority] ?? "#1e2535"}`,
            borderRadius: 8,
            padding: "12px 16px",
            marginBottom: 8,
          }}
        >
          <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 6 }}>
            <span
              style={{
                color: priorityColor[s.priority] ?? "#475569",
                fontWeight: 700,
                fontSize: 11,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
              }}
            >
              {s.priority}
            </span>
            <span style={{ color: "#c4b5fd", fontSize: 12 }}>{s.signal_type}</span>
            {s.source_ref && (
              <span style={{ color: "#475569", fontSize: 11, marginLeft: "auto" }}>
                {s.source_ref}
              </span>
            )}
          </div>
          <p style={{ color: "#94a3b8", fontSize: 13, margin: 0 }}>{s.summary}</p>
          <p style={{ color: "#334155", fontSize: 11, margin: "6px 0 0" }}>
            {new Date(s.created_at).toLocaleString()}
          </p>
        </div>
      ))}
    </div>
  );
}
