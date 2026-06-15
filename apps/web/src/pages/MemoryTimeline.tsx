// SPDX-License-Identifier: Apache-2.0
/**
 * MemoryTimeline — Visual timeline of agent memory/observation events.
 *
 * Fetches live observations from /obs/memories (obs-providers API) on mount.
 * Falls back to DEMO_MEMORIES when the API is unreachable.
 * Supports search filtering, deletion, and category badges.
 */

import { useState, useMemo, useEffect, useCallback } from "react";

import { api } from "../lib/api.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MemoryEntry {
  id: string;
  content: string;
  category?: string;
  tags?: string[];
  confidence?: number;
  createdAt: string; // ISO string
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const CATEGORY_COLORS: Record<string, string> = {
  fact: "#0284c7",
  preference: "#7c3aed",
  event: "#d97706",
  skill: "#16a34a",
  context: "#64748b",
};

function categoryColor(cat?: string): string {
  return cat ? (CATEGORY_COLORS[cat] ?? "#334155") : "#334155";
}

const s = {
  page: { padding: "0 32px 32px" } as React.CSSProperties,

  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 24,
    flexWrap: "wrap" as const,
    gap: 12,
  },

  title: {
    fontSize: 22,
    fontWeight: 700,
    color: "#c4b5fd",
    letterSpacing: "-0.5px",
  },

  controls: {
    display: "flex",
    gap: 10,
    alignItems: "center",
    flexWrap: "wrap" as const,
  },

  searchInput: {
    background: "#0f1420",
    border: "1px solid #1e2535",
    borderRadius: 8,
    color: "#cbd5e1",
    fontSize: 13,
    padding: "7px 14px",
    outline: "none",
    width: 220,
  } as React.CSSProperties,

  refreshBtn: {
    background: "transparent",
    border: "1px solid #1e2535",
    borderRadius: 8,
    color: "#64748b",
    fontSize: 12,
    padding: "6px 12px",
    cursor: "pointer",
  } as React.CSSProperties,

  statusBadge: (live: boolean): React.CSSProperties => ({
    fontSize: 10,
    fontWeight: 600,
    padding: "2px 8px",
    borderRadius: 12,
    background: live ? "#14532d" : "#1c1917",
    color: live ? "#4ade80" : "#78716c",
  }),

  empty: {
    textAlign: "center" as const,
    color: "#334155",
    padding: "80px 0",
    fontSize: 14,
  },

  timeline: {
    position: "relative" as const,
    paddingLeft: 28,
  },

  line: {
    position: "absolute" as const,
    left: 10,
    top: 0,
    bottom: 0,
    width: 2,
    background: "#1e2535",
  },

  dot: {
    position: "absolute" as const,
    left: -24,
    top: 16,
    width: 10,
    height: 10,
    borderRadius: "50%",
    background: "#7c3aed",
    border: "2px solid #0a0e1a",
  },

  card: {
    position: "relative" as const,
    background: "#0d1220",
    border: "1px solid #1e2535",
    borderRadius: 10,
    padding: "14px 16px",
    marginBottom: 16,
  } as React.CSSProperties,

  cardHeader: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    marginBottom: 8,
    gap: 8,
  } as React.CSSProperties,

  badge: (cat?: string): React.CSSProperties => ({
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: "0.06em",
    padding: "2px 8px",
    borderRadius: 4,
    background: `${categoryColor(cat)}22`,
    color: categoryColor(cat),
    border: `1px solid ${categoryColor(cat)}44`,
    textTransform: "uppercase",
    flexShrink: 0,
  }),

  content: {
    color: "#94a3b8",
    fontSize: 13,
    lineHeight: 1.6,
    marginBottom: 10,
  } as React.CSSProperties,

  meta: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    flexWrap: "wrap" as const,
  },

  timestamp: {
    fontSize: 11,
    color: "#334155",
  } as React.CSSProperties,

  tag: {
    fontSize: 10,
    color: "#475569",
    background: "#0a0e1a",
    border: "1px solid #1e2535",
    borderRadius: 4,
    padding: "1px 6px",
  } as React.CSSProperties,

  confidence: (score: number): React.CSSProperties => ({
    fontSize: 10,
    color: score >= 0.7 ? "#16a34a" : score >= 0.4 ? "#d97706" : "#dc2626",
    fontWeight: 700,
  }),

  deleteBtn: {
    background: "transparent",
    border: "none",
    color: "#334155",
    cursor: "pointer",
    fontSize: 14,
    padding: "2px 6px",
    borderRadius: 4,
    transition: "color 0.12s",
    flexShrink: 0,
  } as React.CSSProperties,
};

// ── Helper ─────────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

interface MemoryTimelineProps {
  /** When provided, used directly (prop-driven mode). Disables API fetch. */
  memories?: MemoryEntry[];
  onDelete?: (id: string) => void;
}

export default function MemoryTimeline({ memories: memoriesProp, onDelete }: MemoryTimelineProps) {
  const [memories, setMemories] = useState<MemoryEntry[]>(memoriesProp ?? DEMO_MEMORIES);
  const [search, setSearch] = useState("");
  const [isLive, setIsLive] = useState(false);
  const [loading, setLoading] = useState(!memoriesProp);

  const fetchMemories = useCallback(() => {
    if (memoriesProp) return; // controlled externally
    setLoading(true);
    api
      .obsMemories({ limit: 200 })
      .then((r) => {
        setMemories(r.memories);
        setIsLive(true);
      })
      .catch(() => {
        setMemories(DEMO_MEMORIES);
        setIsLive(false);
      })
      .finally(() => setLoading(false));
  }, [memoriesProp]);

  // Fetch on mount
  useEffect(() => {
    fetchMemories();
  }, [fetchMemories]);

  // If prop changes (controlled mode), sync
  useEffect(() => {
    if (memoriesProp) setMemories(memoriesProp);
  }, [memoriesProp]);

  const handleDelete = useCallback(
    (id: string) => {
      if (onDelete) {
        onDelete(id);
        return;
      }
      // API delete + local optimistic removal
      api.obsDelete(id).catch(() => {});
      setMemories((prev) => prev.filter((m) => m.id !== id));
    },
    [onDelete],
  );

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return memories;
    return memories.filter(
      (m) =>
        m.content.toLowerCase().includes(q) ||
        m.category?.toLowerCase().includes(q) ||
        m.tags?.some((t) => t.toLowerCase().includes(q)),
    );
  }, [memories, search]);

  return (
    <div style={s.page}>
      {/* Header */}
      <div style={s.header}>
        <h1 style={s.title}>⊙ Memory Timeline</h1>
        <div style={s.controls}>
          <span style={s.statusBadge(isLive)}>{isLive ? "live" : "demo"}</span>
          <input
            style={s.searchInput}
            placeholder="Search memories…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search memories"
          />
          {!memoriesProp && (
            <button style={s.refreshBtn} onClick={fetchMemories} disabled={loading}>
              {loading ? "…" : "↻ Refresh"}
            </button>
          )}
        </div>
      </div>

      {/* Empty state */}
      {filtered.length === 0 && (
        <div style={s.empty}>
          {loading
            ? "Loading memories…"
            : search
              ? `No memories matching "${search}"`
              : "No memories stored yet."}
        </div>
      )}

      {/* Timeline */}
      {filtered.length > 0 && (
        <div style={s.timeline}>
          <div style={s.line} />
          {filtered.map((memory) => (
            <div key={memory.id} style={s.card}>
              <div style={s.dot} />
              <div style={s.cardHeader}>
                {memory.category && <span style={s.badge(memory.category)}>{memory.category}</span>}
                <button
                  style={s.deleteBtn}
                  onClick={() => handleDelete(memory.id)}
                  title="Delete memory"
                  aria-label="Delete memory"
                >
                  ✕
                </button>
              </div>
              <p style={s.content}>{memory.content}</p>
              <div style={s.meta}>
                <span style={s.timestamp}>{formatDate(memory.createdAt)}</span>
                {memory.confidence !== undefined && (
                  <span style={s.confidence(memory.confidence)}>
                    {Math.round(memory.confidence * 100)}% conf
                  </span>
                )}
                {memory.tags?.map((tag) => (
                  <span key={tag} style={s.tag}>
                    #{tag}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Demo data (shown when API unavailable) ─────────────────────────────────────

const DEMO_MEMORIES: MemoryEntry[] = [
  {
    id: "m1",
    content: "User prefers concise responses with bullet points over long paragraphs.",
    category: "preference",
    tags: ["response-style"],
    confidence: 0.9,
    createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
  },
  {
    id: "m2",
    content: "User is a CSE student at NIT Raipur graduating in July 2026 with CGPA 9.24.",
    category: "fact",
    tags: ["education", "profile"],
    confidence: 1.0,
    createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
  },
  {
    id: "m3",
    content: "Nexus platform reached 5,911 passing tests across 13+ packages, zero failures.",
    category: "event",
    tags: ["nexus", "testing", "milestone"],
    confidence: 1.0,
    createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
  },
  {
    id: "m4",
    content:
      "User employs batch-consolidation discipline: executes multi-phase work in single sessions.",
    category: "skill",
    tags: ["workflow", "productivity"],
    confidence: 0.95,
    createdAt: new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString(),
  },
];
