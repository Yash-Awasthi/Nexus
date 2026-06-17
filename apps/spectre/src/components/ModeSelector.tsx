// SPDX-License-Identifier: Apache-2.0
import type { CSSProperties } from "react";

export type Mode = "chat" | "phantom" | "ultraplinian" | "parseltongue";

export const MODES: { id: Mode; label: string; desc: string }[] = [
  { id: "chat", label: "CHAT", desc: "Multi-model chat" },
  { id: "phantom", label: "PHANTOM", desc: "5-combo parallel race" },
  { id: "ultraplinian", label: "ULTRAPLINIAN", desc: "Tier-based model race" },
  { id: "parseltongue", label: "PARSELTONGUE", desc: "Input perturbation" },
];

interface Props {
  current: Mode;
  onChange: (m: Mode) => void;
}

function btn(active: boolean): CSSProperties {
  return {
    fontSize: 11,
    letterSpacing: "0.12em",
    padding: "7px 14px",
    background: active ? "var(--accent)" : "var(--bg2)",
    color: active ? "var(--bg)" : "var(--fg2)",
    border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
    borderRadius: 3,
    cursor: "pointer",
    fontFamily: "var(--font)",
    fontWeight: active ? 700 : 400,
    transition: "all 0.15s",
  };
}

export function ModeSelector({ current, onChange }: Props) {
  return (
    <nav
      style={{
        display: "flex",
        gap: 8,
        padding: "12px 16px",
        borderBottom: "1px solid var(--border)",
        background: "var(--bg)",
        overflowX: "auto",
        flexShrink: 0,
      }}
    >
      {MODES.map((m) => (
        <button key={m.id} style={btn(current === m.id)} onClick={() => onChange(m.id)} title={m.desc}>
          {m.label}
        </button>
      ))}
    </nav>
  );
}
