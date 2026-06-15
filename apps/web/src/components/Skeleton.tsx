// SPDX-License-Identifier: Apache-2.0
/**
 * Skeleton loading components — shimmer placeholders shown while data loads.
 *
 * Components:
 *   Skeleton        — base rectangular shimmer block
 *   SkeletonText    — lines of text shimmer
 *   SkeletonCard    — card with header + body lines
 *   SkeletonTable   — table with N rows × M columns
 *   SkeletonList    — list of N skeleton cards
 *
 * Usage:
 *   if (loading) return <SkeletonList count={5} />;
 *   if (error)   return <ErrorMessage error={error} />;
 *   return <DataComponent data={data} />;
 */

import { type CSSProperties } from "react";

// ── Base shimmer animation (inline CSS) ───────────────────────────────────────

const shimmerStyle: CSSProperties = {
  background:    "linear-gradient(90deg, #f0f0f0 25%, #e0e0e0 50%, #f0f0f0 75%)",
  backgroundSize: "200% 100%",
  animation:     "nexus-shimmer 1.5s infinite",
  borderRadius:  "4px",
};

/** Inject keyframes once into document.head. */
function ensureKeyframes(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById("nexus-skeleton-styles")) return;
  const style = document.createElement("style");
  style.id = "nexus-skeleton-styles";
  style.textContent = `
    @keyframes nexus-shimmer {
      0%   { background-position: 200% 0; }
      100% { background-position: -200% 0; }
    }
  `;
  document.head.appendChild(style);
}
ensureKeyframes();

// ── Skeleton ──────────────────────────────────────────────────────────────────

export interface SkeletonProps {
  width?:  string | number;
  height?: string | number;
  style?:  CSSProperties;
  className?: string;
}

export function Skeleton({ width = "100%", height = 16, style, className }: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      className={className}
      style={{
        ...shimmerStyle,
        width:  typeof width  === "number" ? `${width}px`  : width,
        height: typeof height === "number" ? `${height}px` : height,
        ...style,
      }}
    />
  );
}

// ── SkeletonText ──────────────────────────────────────────────────────────────

export interface SkeletonTextProps {
  lines?:     number;
  lastWidth?: string; // width of last line (default: "60%")
  gap?:       number; // px between lines
}

export function SkeletonText({ lines = 3, lastWidth = "60%", gap = 8 }: SkeletonTextProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap }}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton
          key={i}
          height={14}
          width={i === lines - 1 ? lastWidth : "100%"}
        />
      ))}
    </div>
  );
}

// ── SkeletonCard ──────────────────────────────────────────────────────────────

export interface SkeletonCardProps {
  lines?:  number;
  header?: boolean;
}

export function SkeletonCard({ lines = 3, header = true }: SkeletonCardProps) {
  return (
    <div
      aria-busy="true"
      aria-label="Loading..."
      style={{
        padding:      "1rem",
        border:       "1px solid #e2e8f0",
        borderRadius: "8px",
        background:   "#fff",
      }}
    >
      {header && (
        <Skeleton height={20} width="45%" style={{ marginBottom: "1rem" }} />
      )}
      <SkeletonText lines={lines} />
    </div>
  );
}

// ── SkeletonTable ─────────────────────────────────────────────────────────────

export interface SkeletonTableProps {
  rows?:    number;
  columns?: number;
}

export function SkeletonTable({ rows = 5, columns = 4 }: SkeletonTableProps) {
  return (
    <div
      aria-busy="true"
      aria-label="Loading table..."
      style={{ width: "100%", overflowX: "auto" }}
    >
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            {Array.from({ length: columns }, (_, i) => (
              <th key={i} style={{ padding: "0.75rem", textAlign: "left" }}>
                <Skeleton height={14} width={`${60 + Math.random() * 40}%`} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }, (_, rowIdx) => (
            <tr key={rowIdx} style={{ borderTop: "1px solid #e2e8f0" }}>
              {Array.from({ length: columns }, (_, colIdx) => (
                <td key={colIdx} style={{ padding: "0.75rem" }}>
                  <Skeleton height={12} width={`${50 + Math.random() * 50}%`} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── SkeletonList ──────────────────────────────────────────────────────────────

export interface SkeletonListProps {
  count?: number;
  lines?: number;
  gap?:   number;
}

export function SkeletonList({ count = 3, lines = 2, gap = 12 }: SkeletonListProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap }}>
      {Array.from({ length: count }, (_, i) => (
        <SkeletonCard key={i} lines={lines} />
      ))}
    </div>
  );
}
