// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from "react";
import { api } from "../lib/api.js";

interface Signal { id: string; signal_type: string; summary: string; priority: string; created_at: string }

const priorityColor: Record<string, string> = { low: "#475569", medium: "#2563eb", high: "#d97706", critical: "#dc2626" };

export default function Signals() {
  const [signals, setSignals] = useState<Signal[]>([]);

  useEffect(() => {
    // Signals endpoint — GET /ingest/signals not in scope yet; use tasks as proxy
    api.get<{ tasks: Signal[] }>("/runtime/tasks?limit=50")
      .then(() => {}) // placeholder until signals list endpoint added
      .catch(console.error);

    // For now show a placeholder
    setSignals([]);
  }, []);

  return (
    <div>
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 24 }}>⚡ Signals</h1>
      {signals.length === 0 && (
        <p style={{ color: "#64748b" }}>No signals yet — ingest events to generate signals.</p>
      )}
      {signals.map((s) => (
        <div key={s.id} style={{ background: "#161b27", border: "1px solid #1e2535", borderRadius: 8, padding: "12px 16px", marginBottom: 8 }}>
          <div style={{ display: "flex", gap: 12, marginBottom: 6 }}>
            <span style={{ color: priorityColor[s.priority] ?? "#475569", fontWeight: 700, fontSize: 11, textTransform: "uppercase" }}>{s.priority}</span>
            <span style={{ color: "#c4b5fd" }}>{s.signal_type}</span>
          </div>
          <p style={{ color: "#94a3b8", fontSize: 13 }}>{s.summary}</p>
        </div>
      ))}
    </div>
  );
}
