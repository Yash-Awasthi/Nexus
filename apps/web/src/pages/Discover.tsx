// SPDX-License-Identifier: Apache-2.0
/**
 * Discover feed — surfaces recent signals, trending topics from memory,
 * and suggested research queries based on stored context.
 *
 * Data sources:
 *   • /api/v1/signals  — recent pipeline signals
 *   • /api/v1/memory   — recent memory entries (surfaced as topic cards)
 *   • Derived trending keywords from signal content
 */

import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api.js";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Signal {
  id: string;
  type: string;
  source?: string;
  content: string;
  created_at: string;
  metadata?: Record<string, unknown>;
}

interface MemoryEntry {
  id: string;
  text: string;
  importance?: number;
  created_at?: string;
  metadata?: Record<string, unknown>;
}

interface DiscoverData {
  signals: Signal[];
  memories: MemoryEntry[];
  trending: string[];
  suggestedQueries: string[];
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = {
  page: { maxWidth: 900 } as React.CSSProperties,

  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 24,
  } as React.CSSProperties,

  title: { fontSize: 24, fontWeight: 700, margin: 0 } as React.CSSProperties,

  refreshBtn: {
    background: "transparent",
    border: "1px solid #1e2535",
    borderRadius: 8,
    color: "#64748b",
    cursor: "pointer",
    fontSize: 12,
    padding: "6px 12px",
  } as React.CSSProperties,

  grid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 20,
    marginBottom: 24,
  } as React.CSSProperties,

  section: {
    background: "#0f1420",
    border: "1px solid #1e2535",
    borderRadius: 12,
    padding: 16,
  } as React.CSSProperties,

  sectionTitle: {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.08em",
    textTransform: "uppercase" as const,
    color: "#475569",
    marginBottom: 12,
    display: "flex",
    alignItems: "center",
    gap: 6,
  },

  card: {
    background: "#161b27",
    border: "1px solid #1e2535",
    borderRadius: 8,
    padding: "10px 12px",
    marginBottom: 8,
    cursor: "pointer",
    transition: "border-color 0.15s",
  } as React.CSSProperties,

  cardHover: {
    background: "#161b27",
    border: "1px solid #2d1f6e",
    borderRadius: 8,
    padding: "10px 12px",
    marginBottom: 8,
    cursor: "pointer",
    transition: "border-color 0.15s",
  } as React.CSSProperties,

  cardTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: "#e2e8f0",
    marginBottom: 4,
    display: "-webkit-box" as React.CSSProperties["display"],
    WebkitLineClamp: 2,
    WebkitBoxOrient: "vertical" as React.CSSProperties["WebkitBoxOrient"],
    overflow: "hidden",
  } as React.CSSProperties,

  cardMeta: {
    fontSize: 11,
    color: "#334155",
    display: "flex",
    gap: 8,
    alignItems: "center",
  } as React.CSSProperties,

  typeBadge: (type: string): React.CSSProperties => ({
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    color: TYPE_COLORS[type] ?? "#475569",
    background: `${TYPE_COLORS[type] ?? "#475569"}18`,
    borderRadius: 4,
    padding: "1px 5px",
  }),

  trendingList: {
    display: "flex",
    flexWrap: "wrap" as const,
    gap: 6,
    marginTop: 4,
  },

  trendingChip: (i: number): React.CSSProperties => ({
    background: `rgba(124,58,237,${Math.max(0.08, 0.25 - i * 0.02)})`,
    border: "1px solid rgba(124,58,237,0.2)",
    borderRadius: 20,
    color: "#a78bfa",
    fontSize: 12,
    padding: "4px 10px",
    cursor: "pointer",
    transition: "all 0.15s",
  }),

  queryList: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 6,
  },

  queryItem: {
    background: "#161b27",
    border: "1px solid #1e2535",
    borderRadius: 6,
    color: "#94a3b8",
    fontSize: 12,
    padding: "7px 10px",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    gap: 6,
    transition: "all 0.15s",
  } as React.CSSProperties,

  emptyState: {
    color: "#334155",
    fontSize: 13,
    textAlign: "center" as const,
    padding: "24px 0",
  },

  loading: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    height: 200,
    color: "#334155",
    fontSize: 14,
    gap: 10,
  } as React.CSSProperties,

  error: {
    background: "#1c0a0a",
    border: "1px solid #7f1d1d",
    borderRadius: 8,
    color: "#f87171",
    fontSize: 13,
    padding: "12px 16px",
    marginBottom: 16,
  } as React.CSSProperties,

  importanceDot: (importance: number): React.CSSProperties => ({
    width: 6,
    height: 6,
    borderRadius: "50%",
    background: importance > 0.7 ? "#7c3aed" : importance > 0.4 ? "#0284c7" : "#334155",
    flexShrink: 0,
  }),
};

const TYPE_COLORS: Record<string, string> = {
  code: "#7c3aed",
  search: "#0284c7",
  memory: "#16a34a",
  signal: "#d97706",
  ingest: "#dc2626",
  agent: "#7c3aed",
};

// ── Component ─────────────────────────────────────────────────────────────────

export default function Discover() {
  const [data, setData] = useState<DiscoverData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hoveredCard, setHoveredCard] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Fetch signals and memories in parallel
      const [signalsRes, memoriesRes] = await Promise.allSettled([
        api.get<{ signals: Signal[] }>("/signals?limit=20"),
        api.get<{ entries: MemoryEntry[] }>("/memory?limit=15"),
      ]);

      const signals = signalsRes.status === "fulfilled" ? (signalsRes.value.signals ?? []) : [];
      const memories = memoriesRes.status === "fulfilled" ? (memoriesRes.value.entries ?? []) : [];

      // Derive trending keywords from signal content
      const allText = [...signals.map((s) => s.content), ...memories.map((m) => m.text)].join(" ");
      const trending = extractTrending(allText);
      const suggestedQueries = deriveSuggestedQueries(signals, memories);

      setData({ signals, memories, trending, suggestedQueries });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load discover feed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <div style={s.loading}>
        <span style={{ color: "#7c3aed", fontSize: 20 }}>◈</span>
        Loading Discover feed…
      </div>
    );
  }

  return (
    <div style={s.page}>
      {/* Header */}
      <div style={s.header}>
        <h1 style={s.title}>◈ Discover</h1>
        <button style={s.refreshBtn} onClick={() => void load()}>
          ↻ Refresh
        </button>
      </div>

      {error && <div style={s.error}>⚠ {error}</div>}

      {/* Trending + Suggested queries */}
      <div style={s.grid}>
        {/* Trending topics */}
        <div style={s.section}>
          <div style={s.sectionTitle}>
            <span style={{ color: "#7c3aed" }}>⚡</span> Trending Topics
          </div>
          {data && data.trending.length > 0 ? (
            <div style={s.trendingList}>
              {data.trending.map((kw, i) => (
                <span key={kw} style={s.trendingChip(i)} title={`Search for "${kw}"`}>
                  {kw}
                </span>
              ))}
            </div>
          ) : (
            <div style={s.emptyState}>No trending topics yet</div>
          )}
        </div>

        {/* Suggested queries */}
        <div style={s.section}>
          <div style={s.sectionTitle}>
            <span style={{ color: "#0284c7" }}>◎</span> Suggested Research
          </div>
          {data && data.suggestedQueries.length > 0 ? (
            <div style={s.queryList}>
              {data.suggestedQueries.map((q, i) => (
                <div key={i} style={s.queryItem} title={`Start a chat about "${q}"`}>
                  <span style={{ color: "#334155" }}>→</span>
                  {q}
                </div>
              ))}
            </div>
          ) : (
            <div style={s.emptyState}>No suggestions available</div>
          )}
        </div>
      </div>

      {/* Recent signals */}
      <div style={{ ...s.section, marginBottom: 20 }}>
        <div style={s.sectionTitle}>
          <span style={{ color: "#d97706" }}>⚡</span> Recent Signals
          {data && (
            <span
              style={{ color: "#1e2535", fontWeight: 400, textTransform: "none", letterSpacing: 0 }}
            >
              {" "}
              — {data.signals.length}
            </span>
          )}
        </div>
        {data && data.signals.length > 0 ? (
          data.signals.slice(0, 8).map((sig) => (
            <div
              key={sig.id}
              style={hoveredCard === sig.id ? s.cardHover : s.card}
              onMouseEnter={() => setHoveredCard(sig.id)}
              onMouseLeave={() => setHoveredCard(null)}
            >
              <div style={s.cardTitle}>{sig.content}</div>
              <div style={s.cardMeta}>
                <span style={s.typeBadge(sig.type)}>{sig.type}</span>
                {sig.source && <span>{sig.source}</span>}
                <span>{formatRelative(sig.created_at)}</span>
              </div>
            </div>
          ))
        ) : (
          <div style={s.emptyState}>No recent signals</div>
        )}
      </div>

      {/* Memory highlights */}
      <div style={s.section}>
        <div style={s.sectionTitle}>
          <span style={{ color: "#16a34a" }}>◈</span> Memory Highlights
          {data && (
            <span
              style={{ color: "#1e2535", fontWeight: 400, textTransform: "none", letterSpacing: 0 }}
            >
              {" "}
              — {data.memories.length}
            </span>
          )}
        </div>
        {data && data.memories.length > 0 ? (
          data.memories.slice(0, 6).map((mem) => (
            <div
              key={mem.id}
              style={hoveredCard === mem.id ? s.cardHover : s.card}
              onMouseEnter={() => setHoveredCard(mem.id)}
              onMouseLeave={() => setHoveredCard(null)}
            >
              <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                <div style={s.importanceDot(mem.importance ?? 0)} />
                <div style={s.cardTitle}>{mem.text}</div>
              </div>
              {mem.created_at && (
                <div style={{ ...s.cardMeta, marginTop: 4 }}>
                  <span>{formatRelative(mem.created_at)}</span>
                  {mem.importance !== undefined && (
                    <span>importance {(mem.importance * 100).toFixed(0)}%</span>
                  )}
                </div>
              )}
            </div>
          ))
        ) : (
          <div style={s.emptyState}>No memory entries</div>
        )}
      </div>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const STOP = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "in",
  "on",
  "at",
  "to",
  "for",
  "of",
  "with",
  "by",
  "from",
  "is",
  "are",
  "was",
  "were",
  "be",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "not",
  "that",
  "this",
  "it",
  "i",
  "you",
  "he",
  "she",
  "we",
  "they",
  "what",
  "how",
  "why",
  "when",
  "where",
  "which",
]);

function extractTrending(text: string, topK = 12): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOP.has(w));

  const freq = new Map<string, number>();
  for (const w of words) freq.set(w, (freq.get(w) ?? 0) + 1);
  return [...freq.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .map(([w]) => w);
}

function deriveSuggestedQueries(signals: Signal[], memories: MemoryEntry[]): string[] {
  const queries: string[] = [];

  // Top signal types become suggested queries
  const typeCounts = new Map<string, number>();
  for (const s of signals) typeCounts.set(s.type, (typeCounts.get(s.type) ?? 0) + 1);
  const topTypes = [...typeCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2);
  for (const [type] of topTypes) {
    queries.push(`Summarize recent ${type} activity`);
  }

  // High-importance memories become queries
  const important = memories.filter((m) => (m.importance ?? 0) >= 0.7).slice(0, 3);
  for (const mem of important) {
    const snippet = mem.text.slice(0, 60).replace(/\s+\S*$/, "");
    queries.push(`Tell me more about: ${snippet}…`);
  }

  return queries.slice(0, 6);
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}
