// SPDX-License-Identifier: Apache-2.0
import type { CSSProperties } from "react";

import { THEMES, type ThemeId } from "../theme.js";

interface Props {
  current: ThemeId;
  onChange: (id: ThemeId) => void;
}

const s: Record<string, CSSProperties> = {
  row: {
    display: "flex",
    gap: 6,
    alignItems: "center",
  },
  label: {
    fontSize: 9,
    color: "var(--fg3)",
    letterSpacing: "0.2em",
    marginRight: 4,
  },
};

function btn(active: boolean): CSSProperties {
  return {
    fontSize: 9,
    letterSpacing: "0.15em",
    padding: "3px 8px",
    background: active ? "var(--accent)" : "transparent",
    color: active ? "var(--bg)" : "var(--fg3)",
    border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
    borderRadius: 2,
    cursor: "pointer",
    fontFamily: "var(--font)",
    transition: "all 0.15s",
  };
}

export function ThemeSwitcher({ current, onChange }: Props) {
  return (
    <div style={s.row}>
      <span style={s.label}>THEME</span>
      {THEMES.map((t) => (
        <button key={t.id} style={btn(current === t.id)} onClick={() => onChange(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}
