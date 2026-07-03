// SPDX-License-Identifier: Apache-2.0
import React from "react";

interface CitationBadgeProps {
  id: number;
  confidence: number;
  onHover: (id: number | null) => void;
  onClick: (id: number) => void;
}

function confidenceColor(score: number): { background: string; color: string } {
  if (score >= 0.7) return { background: "#16a34a", color: "#fff" };
  if (score >= 0.4) return { background: "#ca8a04", color: "#fff" };
  return { background: "#dc2626", color: "#fff" };
}

export function CitationBadge({ id, confidence, onHover, onClick }: CitationBadgeProps) {
  const colors = confidenceColor(confidence);

  return (
    <span
      style={{
        display: "inline",
        verticalAlign: "super",
        fontSize: "0.65em",
        padding: "1px 4px",
        borderRadius: 10,
        cursor: "pointer",
        margin: "0 1px",
        background: colors.background,
        color: colors.color,
        fontWeight: 600,
        lineHeight: 1,
        userSelect: "none",
      }}
      onMouseEnter={() => onHover(id)}
      onMouseLeave={() => onHover(null)}
      onClick={() => onClick(id)}
    >
      {id}
    </span>
  );
}
