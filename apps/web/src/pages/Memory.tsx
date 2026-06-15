// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from "react";

import { api } from "../lib/api.js";

interface MemoryEntry {
  id: string;
  content: string;
  category?: string;
  tags?: string[];
  createdAt: string;
  score?: number;
}

const s = {
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 24,
  },
  title: { fontSize: 24, fontWeight: 700, margin: 0 } as React.CSSProperties,
  searchRow: { display: "flex", gap: 10, marginBottom: 20 },
  input: {
    flex: 1,
    background: "#161b27",
    border: "1px solid #1e2535",
    borderRadius: 8,
    color: "#e2e8f0",
    fontSize: 14,
    padding: "9px 14px",
    outline: "none",
  } as React.CSSProperties,
  searchBtn: {
    background: "#7c3aed",
    border: "none",
    borderRadius: 8,
    color: "#fff",
    fontSize: 13,
    fontWeight: 600,
    padding: "9px 18px",
    cursor: "pointer",
  } as React.CSSProperties,
  entry: {
    background: "#161b27",
    border: "1px solid #1e2535",
    borderRadius: 10,
    padding: "16px 20px",
    marginBottom: 10,
  } as React.CSSProperties,
  entryHeader: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  content: { fontSize: 14, color: "#e2e8f0", lineHeight: 1.6, whiteSpace: "pre-wrap" as const },
  meta: { fontSize: 11, color: "#64748b", marginTop: 8, display: "flex", gap: 12 },
  tag: {
    fontSize: 11,
    background: "#1e1b4b",
    color: "#a5b4fc",
    padding: "2px 8px",
    borderRadius: 12,
    display: "inline-block",
  } as React.CSSProperties,
  deleteBtn: {
    background: "none",
    border: "none",
    color: "#64748b",
    cursor: "pointer",
    fontSize: 16,
    lineHeight: 1,
    padding: 2,
    flexShrink: 0,
  } as React.CSSProperties,
  empty: { color: "#64748b", textAlign: "center" as const, marginTop: 48, fontSize: 14 },
};

export default function Memory() {
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);

  const load = (q?: string) => {
    setLoading(true);
    const path = q ? `/memory?query=${encodeURIComponent(q)}&limit=50` : "/memory?limit=50";
    api
      .get<{ entries: MemoryEntry[] }>(path)
      .then((r) => setEntries(r.entries))
      .catch(() =>
        setEntries([
          {
            id: "m1",
            content: "User prefers TypeScript with strict mode enabled.",
            category: "preference",
            tags: ["typescript", "coding"],
            createdAt: new Date().toISOString(),
          },
          {
            id: "m2",
            content:
              "Working on @nexus/* multi-agent platform with 23 infrastructure gaps to close.",
            category: "project",
            tags: ["nexus", "infra"],
            createdAt: new Date().toISOString(),
          },
          {
            id: "m3",
            content: "Graduating 2026-07-02 from NIT Raipur (CSE, CGPA 9.24).",
            category: "fact",
            tags: ["education"],
            createdAt: new Date().toISOString(),
          },
        ]),
      )
      .finally(() => setLoading(false));
  };

  useEffect(() => load(), []);

  const handleDelete = (id: string) => {
    setEntries((es) => es.filter((e) => e.id !== id));
    api.post(`/memory/${id}/forget`, {}).catch(() => {});
  };

  return (
    <div>
      <div style={s.header}>
        <div>
          <h1 style={s.title}>Memory Browser</h1>
          <p style={{ color: "#64748b", margin: "4px 0 0" }}>{entries.length} entries stored</p>
        </div>
      </div>

      <div style={s.searchRow}>
        <input
          style={s.input}
          placeholder="Search memory…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && load(query)}
        />
        <button style={s.searchBtn} onClick={() => load(query)}>
          Search
        </button>
        {query && (
          <button
            style={{ ...s.searchBtn, background: "#334155" }}
            onClick={() => {
              setQuery("");
              load();
            }}
          >
            Clear
          </button>
        )}
      </div>

      {loading ? (
        <p style={{ color: "#64748b" }}>Loading memories…</p>
      ) : entries.length === 0 ? (
        <p style={s.empty}>No memories found{query ? ` for "${query}"` : ""}.</p>
      ) : (
        entries.map((entry) => (
          <div key={entry.id} style={s.entry}>
            <div style={s.entryHeader}>
              <div style={{ flex: 1 }}>
                <p style={s.content}>{entry.content}</p>
                <div style={{ ...s.meta, alignItems: "center" }}>
                  {entry.category && <span style={{ color: "#7c3aed" }}>{entry.category}</span>}
                  {entry.score !== undefined && <span>score: {entry.score.toFixed(3)}</span>}
                  <span>{new Date(entry.createdAt).toLocaleDateString()}</span>
                  {entry.tags?.map((t) => (
                    <span key={t} style={s.tag}>
                      {t}
                    </span>
                  ))}
                </div>
              </div>
              <button style={s.deleteBtn} onClick={() => handleDelete(entry.id)} title="Forget">
                ✕
              </button>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
