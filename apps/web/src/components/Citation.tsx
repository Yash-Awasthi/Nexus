// SPDX-License-Identifier: Apache-2.0
/**
 * Citation components — inline numbered references + source cards.
 *
 * Components:
 *   CitationBadge   — inline superscript [1] marker that opens the source card
 *   CitationCard    — expanded source card: title, URL, excerpt
 *   CitationList    — renders a numbered list of all citations for a message
 *   parseCitations  — extract [[cite:N]] markers from text, return split segments
 */

import { useState } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CitationSource {
  id: number;
  title: string;
  url?: string;
  excerpt?: string;
  /** Source system label, e.g. "GitHub", "Notion", "Memory" */
  source?: string;
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = {
  badge: (active: boolean): React.CSSProperties => ({
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 18,
    height: 18,
    borderRadius: "50%",
    background: active ? "#7c3aed" : "rgba(124,58,237,0.15)",
    border: `1px solid ${active ? "#7c3aed" : "rgba(124,58,237,0.4)"}`,
    color: active ? "#fff" : "#a78bfa",
    fontSize: 10,
    fontWeight: 700,
    cursor: "pointer",
    verticalAlign: "middle",
    marginLeft: 2,
    marginRight: 1,
    flexShrink: 0,
    transition: "all 0.15s",
    userSelect: "none" as const,
    lineHeight: 1,
  }),
  card: {
    background: "#0f1420",
    border: "1px solid #2d1f6e",
    borderRadius: 8,
    padding: "10px 12px",
    marginTop: 6,
    marginBottom: 2,
    fontSize: 12,
    lineHeight: 1.5,
  } as React.CSSProperties,
  cardHeader: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginBottom: 4,
  } as React.CSSProperties,
  cardNum: {
    width: 20,
    height: 20,
    borderRadius: "50%",
    background: "#7c3aed",
    color: "#fff",
    fontSize: 10,
    fontWeight: 700,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  } as React.CSSProperties,
  cardTitle: {
    fontWeight: 600,
    color: "#c4b5fd",
    flex: 1,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  cardSourceBadge: {
    fontSize: 10,
    fontWeight: 700,
    color: "#7c3aed",
    background: "rgba(124,58,237,0.12)",
    borderRadius: 4,
    padding: "1px 5px",
    flexShrink: 0,
  } as React.CSSProperties,
  cardExcerpt: {
    color: "#64748b",
    fontSize: 11,
    marginTop: 4,
    fontStyle: "italic",
    display: "-webkit-box" as React.CSSProperties["display"],
    WebkitLineClamp: 2,
    WebkitBoxOrient: "vertical" as React.CSSProperties["WebkitBoxOrient"],
    overflow: "hidden",
  } as React.CSSProperties,
  cardUrl: {
    color: "#a78bfa",
    fontSize: 11,
    marginTop: 4,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
    textDecoration: "none",
    display: "block",
  } as React.CSSProperties,
  list: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 4,
    marginTop: 8,
    paddingTop: 8,
    borderTop: "1px solid #1e2535",
  },
  listHeader: {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: "0.08em",
    textTransform: "uppercase" as const,
    color: "#334155",
    marginBottom: 4,
  },
};

// ── CitationBadge ─────────────────────────────────────────────────────────────

interface CitationBadgeProps {
  num: number;
  source: CitationSource;
}

export function CitationBadge({ num, source }: CitationBadgeProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <span
        style={s.badge(open)}
        onClick={() => setOpen((v) => !v)}
        title={source.title}
        role="button"
        aria-label={`Citation ${num}: ${source.title}`}
        aria-expanded={open}
      >
        {num}
      </span>
      {open && <CitationCard source={source} />}
    </>
  );
}

// ── CitationCard ──────────────────────────────────────────────────────────────

interface CitationCardProps {
  source: CitationSource;
}

export function CitationCard({ source }: CitationCardProps) {
  return (
    <span style={{ display: "block" }}>
      <div style={s.card}>
        <div style={s.cardHeader}>
          <div style={s.cardNum}>{source.id}</div>
          <span style={s.cardTitle}>{source.title}</span>
          {source.source && (
            <span style={s.cardSourceBadge}>{source.source}</span>
          )}
        </div>
        {source.excerpt && <div style={s.cardExcerpt}>{source.excerpt}</div>}
        {source.url && (
          <a
            href={source.url}
            target="_blank"
            rel="noopener noreferrer"
            style={s.cardUrl}
            onClick={(e) => e.stopPropagation()}
          >
            ↗ {source.url}
          </a>
        )}
      </div>
    </span>
  );
}

// ── CitationList ──────────────────────────────────────────────────────────────

interface CitationListProps {
  sources: CitationSource[];
}

export function CitationList({ sources }: CitationListProps) {
  if (sources.length === 0) return null;
  return (
    <div style={s.list}>
      <div style={s.listHeader}>Sources ({sources.length})</div>
      {sources.map((src) => (
        <CitationCard key={src.id} source={src} />
      ))}
    </div>
  );
}

// ── Text parser ───────────────────────────────────────────────────────────────

/** A segment of parsed text — either plain text or a citation reference. */
export type TextSegment =
  | { type: "text"; content: string }
  | { type: "citation"; num: number };

/**
 * Parse text containing `[[cite:N]]` markers into alternating text/citation segments.
 * Unrecognised cite numbers (not in sources) are rendered as plain text.
 */
export function parseCitations(text: string, sources: CitationSource[]): TextSegment[] {
  const sourceIds = new Set(sources.map((s) => s.id));
  const parts = text.split(/\[\[cite:(\d+)\]\]/);
  const segments: TextSegment[] = [];

  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      if (parts[i]) segments.push({ type: "text", content: parts[i]! });
    } else {
      const num = parseInt(parts[i]!, 10);
      if (sourceIds.has(num)) {
        segments.push({ type: "citation", num });
      } else {
        segments.push({ type: "text", content: `[[cite:${parts[i]}]]` });
      }
    }
  }

  return segments;
}

// ── CitedText ─────────────────────────────────────────────────────────────────

interface CitedTextProps {
  text: string;
  sources: CitationSource[];
}

/**
 * Renders text with [[cite:N]] markers replaced by interactive CitationBadge components.
 */
export function CitedText({ text, sources }: CitedTextProps) {
  const sourceMap = new Map(sources.map((s) => [s.id, s]));
  const segments = parseCitations(text, sources);

  return (
    <>
      {segments.map((seg, i) => {
        if (seg.type === "text") {
          return <span key={i}>{seg.content}</span>;
        }
        const src = sourceMap.get(seg.num);
        if (!src) return null;
        return <CitationBadge key={i} num={seg.num} source={src} />;
      })}
    </>
  );
}
