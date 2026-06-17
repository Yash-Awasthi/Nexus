// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from "react";

import { Header } from "./components/Header.js";
import { ModeSelector, type Mode } from "./components/ModeSelector.js";
import { ThemeSwitcher } from "./components/ThemeSwitcher.js";
import { Chat } from "./pages/Chat.js";
import { Parseltongue } from "./pages/Parseltongue.js";
import { Phantom } from "./pages/Phantom.js";
import { Ultraplinian } from "./pages/Ultraplinian.js";
import { applyTheme, loadSavedTheme, type ThemeId } from "./theme.js";

// ── Konami sequence ────────────────────────────────────────────────────────────
const KONAMI = [
  "ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown",
  "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight",
  "b", "a",
];

const SKULL = `
 ░░░░░░░░░░░░░░░░░░░░░░░░░░░
 ░░░▄████████████████████▄░░
 ░░██▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀██░░
 ░░█░░░░░░░░░░░░░░░░░░░░░█░░
 ░░█░░  ██████  ██████  ░█░░
 ░░█░░  ██████  ██████  ░█░░
 ░░█░░░░░░░░░░░░░░░░░░░░░█░░
 ░░█░░░░  ████████████  ░█░░
 ░░█░░░░░░░░░░░░░░░░░░░░░█░░
 ░░██▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄██░░
 ░░░▀████████████████████▀░░░
 ░░░░░░░░░░░░░░░░░░░░░░░░░░░
       S P E C T R E
   COGNITION UNLOCKED
`.trim();

export default function App() {
  const [theme, setTheme] = useState<ThemeId>(() => loadSavedTheme());
  const [mode, setMode] = useState<Mode>("chat");
  const [konami, setKonami] = useState(false);
  const [keyBuf, setKeyBuf] = useState<string[]>([]);

  // Apply theme on mount + change
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Konami listener
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      setKeyBuf((buf) => {
        const next = [...buf, e.key].slice(-KONAMI.length);
        if (next.join(",") === KONAMI.join(",")) {
          setKonami(true);
          setTimeout(() => setKonami(false), 3200);
          return [];
        }
        return next;
      });
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        background: "var(--bg)",
        color: "var(--fg)",
        fontFamily: "var(--font)",
        overflow: "hidden",
        position: "relative",
      }}
    >
      {/* Konami overlay */}
      {konami && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 9999,
            background: "rgba(0,0,0,0.95)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexDirection: "column",
            gap: 20,
            cursor: "pointer",
          }}
          onClick={() => setKonami(false)}
        >
          <pre
            style={{
              color: "var(--accent)",
              fontFamily: "var(--font)",
              fontSize: "clamp(8px, 2vw, 16px)",
              textAlign: "center",
              animation: "flicker 0.15s infinite alternate",
            }}
          >
            {SKULL}
          </pre>
          <span
            style={{
              color: "var(--fg3)",
              fontSize: 10,
              letterSpacing: "0.3em",
              fontFamily: "var(--font)",
            }}
          >
            [click to dismiss]
          </span>
          <style>{`
            @keyframes flicker {
              from { opacity: 1; }
              to   { opacity: 0.6; }
            }
          `}</style>
        </div>
      )}

      <Header />

      {/* Toolbar */}
      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          padding: "6px 16px",
          borderBottom: "1px solid var(--border)",
          background: "var(--bg2)",
          flexShrink: 0,
        }}
      >
        <ThemeSwitcher current={theme} onChange={setTheme} />
      </div>

      <ModeSelector current={mode} onChange={setMode} />

      {/* Page content */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        {mode === "chat" && <Chat />}
        {mode === "phantom" && <Phantom />}
        {mode === "ultraplinian" && <Ultraplinian />}
        {mode === "parseltongue" && <Parseltongue />}
      </div>
    </div>
  );
}
