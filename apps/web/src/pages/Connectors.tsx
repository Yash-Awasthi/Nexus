// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from "react";

import { api } from "../lib/api.js";

interface Connector {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  status: "ok" | "error" | "unconfigured";
  lastSyncAt?: string;
  error?: string;
}

const s = {
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 28,
  },
  title: { fontSize: 24, fontWeight: 700, margin: 0 } as React.CSSProperties,
  addBtn: {
    background: "#7c3aed",
    border: "none",
    borderRadius: 8,
    color: "#fff",
    fontSize: 13,
    fontWeight: 600,
    padding: "8px 16px",
    cursor: "pointer",
  } as React.CSSProperties,
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 16 },
  card: {
    background: "#161b27",
    border: "1px solid #1e2535",
    borderRadius: 10,
    padding: "20px 24px",
  } as React.CSSProperties,
  cardHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 12,
  },
  name: { fontSize: 15, fontWeight: 600, color: "#e2e8f0" },
  type: {
    fontSize: 11,
    color: "#64748b",
    textTransform: "uppercase" as const,
    letterSpacing: "0.08em",
  },
  status: (s: Connector["status"]): React.CSSProperties => ({
    fontSize: 11,
    fontWeight: 600,
    padding: "2px 8px",
    borderRadius: 12,
    background: s === "ok" ? "#14532d" : s === "error" ? "#450a0a" : "#1c1917",
    color: s === "ok" ? "#4ade80" : s === "error" ? "#fca5a5" : "#78716c",
  }),
  toggle: (enabled: boolean): React.CSSProperties => ({
    width: 40,
    height: 22,
    borderRadius: 11,
    border: "none",
    cursor: "pointer",
    background: enabled ? "#7c3aed" : "#334155",
    position: "relative",
    flexShrink: 0,
    transition: "background 0.2s",
  }),
  meta: { fontSize: 12, color: "#64748b", marginTop: 8 },
  err: { fontSize: 12, color: "#fca5a5", marginTop: 6, wordBreak: "break-word" as const },
};

export default function Connectors() {
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ connectors: Connector[] }>("/connectors")
      .then((r) => setConnectors(r.connectors))
      .catch(() =>
        setConnectors([
          {
            id: "gmail",
            name: "Gmail",
            type: "email",
            enabled: true,
            status: "ok",
            lastSyncAt: new Date().toISOString(),
          },
          {
            id: "github",
            name: "GitHub",
            type: "vcs",
            enabled: true,
            status: "ok",
            lastSyncAt: new Date().toISOString(),
          },
          { id: "slack", name: "Slack", type: "messaging", enabled: false, status: "unconfigured" },
          { id: "notion", name: "Notion", type: "docs", enabled: false, status: "unconfigured" },
          {
            id: "linear",
            name: "Linear",
            type: "issues",
            enabled: false,
            status: "error",
            error: "Invalid API token",
          },
          { id: "supabase", name: "Supabase", type: "database", enabled: true, status: "ok" },
        ]),
      )
      .finally(() => setLoading(false));
  }, []);

  const toggle = (id: string) => {
    setConnectors((cs) => cs.map((c) => (c.id === id ? { ...c, enabled: !c.enabled } : c)));
    api
      .patch(`/connectors/${id}`, { enabled: !connectors.find((c) => c.id === id)?.enabled })
      .catch(() => {});
  };

  return (
    <div>
      <div style={s.header}>
        <div>
          <h1 style={s.title}>Connectors</h1>
          <p style={{ color: "#64748b", margin: "4px 0 0" }}>
            Manage integrations and data sources
          </p>
        </div>
        <button style={s.addBtn}>+ Add Connector</button>
      </div>

      {error && (
        <div
          style={{
            background: "#450a0a",
            border: "1px solid #7f1d1d",
            borderRadius: 8,
            padding: 14,
            marginBottom: 20,
            color: "#fca5a5",
            fontSize: 13,
          }}
        >
          {error}
        </div>
      )}

      {loading ? (
        <p style={{ color: "#64748b" }}>Loading connectors…</p>
      ) : (
        <div style={s.grid}>
          {connectors.map((c) => (
            <div key={c.id} style={s.card}>
              <div style={s.cardHeader}>
                <div>
                  <div style={s.name}>{c.name}</div>
                  <div style={s.type}>{c.type}</div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={s.status(c.status)}>{c.status}</span>
                  <button
                    style={s.toggle(c.enabled)}
                    onClick={() => toggle(c.id)}
                    title={c.enabled ? "Disable" : "Enable"}
                  />
                </div>
              </div>
              {c.lastSyncAt && (
                <div style={s.meta}>Last sync: {new Date(c.lastSyncAt).toLocaleString()}</div>
              )}
              {c.error && <div style={s.err}>⚠ {c.error}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
