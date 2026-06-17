// SPDX-License-Identifier: Apache-2.0
import type { CSSProperties } from "react";

const ASCII = `
███████ ██████  ███████  ██████ ████████ ██████  ███████
██      ██   ██ ██      ██         ██    ██   ██ ██
███████ ██████  █████   ██         ██    ██████  █████
     ██ ██      ██      ██         ██    ██   ██ ██
███████ ██      ███████  ██████    ██    ██   ██ ███████
`.trim();

const s: Record<string, CSSProperties> = {
  root: {
    textAlign: "center",
    padding: "24px 16px 12px",
    borderBottom: "1px solid var(--border)",
    userSelect: "none",
  },
  pre: {
    color: "var(--accent)",
    fontSize: "clamp(5px, 1.1vw, 10px)",
    lineHeight: 1.2,
    fontFamily: "var(--font)",
    margin: "0 auto",
    display: "inline-block",
    overflow: "hidden",
  },
  sub: {
    display: "block",
    marginTop: 6,
    fontSize: 10,
    letterSpacing: "0.25em",
    color: "var(--fg3)",
    textTransform: "uppercase" as const,
  },
  tag: {
    display: "inline-block",
    marginTop: 4,
    fontSize: 9,
    letterSpacing: "0.3em",
    color: "var(--fg3)",
    border: "1px solid var(--border)",
    padding: "1px 6px",
    borderRadius: 2,
  },
};

export function Header() {
  return (
    <header style={s.root}>
      <pre style={s.pre}>{ASCII}</pre>
      <span style={s.sub}>signal without noise</span>
      <span style={s.tag}>powered by nexus</span>
    </header>
  );
}
