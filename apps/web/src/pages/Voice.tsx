// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "../lib/api.js";

type VoiceState = "idle" | "listening" | "processing" | "speaking";

interface Transcript {
  id: string;
  role: "user" | "assistant";
  text: string;
  audioUrl?: string;
  timestamp: string;
}

const VOICES = [
  { id: "alloy", label: "Alloy" },
  { id: "echo", label: "Echo" },
  { id: "fable", label: "Fable" },
  { id: "onyx", label: "Onyx" },
  { id: "nova", label: "Nova" },
  { id: "shimmer", label: "Shimmer" },
];

const s = {
  page: { maxWidth: 700, margin: "0 auto" },
  header: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 28 },
  title: { fontSize: 24, fontWeight: 700, margin: 0 } as React.CSSProperties,
  voiceSelect: {
    background: "#161b27", border: "1px solid #1e2535", borderRadius: 8,
    color: "#a5b4fc", fontSize: 13, padding: "6px 10px", cursor: "pointer",
  } as React.CSSProperties,
  transcript: {
    background: "#161b27", border: "1px solid #1e2535", borderRadius: 10,
    minHeight: 320, maxHeight: 480, overflowY: "auto" as const,
    padding: "16px 20px", marginBottom: 20,
  },
  turn: (role: "user" | "assistant"): React.CSSProperties => ({
    display: "flex", justifyContent: role === "user" ? "flex-end" : "flex-start",
    marginBottom: 12,
  }),
  bubble: (role: "user" | "assistant"): React.CSSProperties => ({
    background: role === "user" ? "#3b0764" : "#161b27",
    border: `1px solid ${role === "user" ? "#7c3aed" : "#1e2535"}`,
    borderRadius: role === "user" ? "12px 12px 2px 12px" : "12px 12px 12px 2px",
    padding: "10px 14px", maxWidth: "75%", fontSize: 14, color: "#e2e8f0", lineHeight: 1.5,
  }),
  controls: { display: "flex", justifyContent: "center", gap: 16, alignItems: "center" },
  micBtn: (state: VoiceState): React.CSSProperties => ({
    width: 64, height: 64, borderRadius: "50%", border: "none", cursor: "pointer",
    fontSize: 28, display: "flex", alignItems: "center", justifyContent: "center",
    background: state === "listening" ? "#dc2626" : state === "processing" ? "#d97706" : "#7c3aed",
    boxShadow: state === "listening" ? "0 0 0 4px rgba(220,38,38,0.3)" : "none",
    transition: "all 0.2s",
  }),
  stateLabel: { fontSize: 13, color: "#64748b", textAlign: "center" as const, marginTop: 10 },
  clearBtn: {
    background: "none", border: "1px solid #1e2535", borderRadius: 8,
    color: "#64748b", fontSize: 12, padding: "6px 12px", cursor: "pointer",
  } as React.CSSProperties,
};

const STATE_ICON: Record<VoiceState, string> = {
  idle: "🎙️", listening: "⏹", processing: "⏳", speaking: "🔊",
};
const STATE_LABEL: Record<VoiceState, string> = {
  idle: "Tap to speak", listening: "Listening… tap to stop", processing: "Processing…", speaking: "Speaking…",
};

export default function Voice() {
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [voice, setVoice] = useState("alloy");
  const [turns, setTurns] = useState<Transcript[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns]);

  const handleMic = useCallback(async () => {
    if (voiceState === "listening") {
      setVoiceState("processing");
      setTimeout(() => {
        const demoText = "Tell me about the Nexus platform.";
        const userTurn: Transcript = {
          id: `u${Date.now()}`, role: "user", text: demoText, timestamp: new Date().toISOString(),
        };
        setTurns((t) => [...t, userTurn]);

        api
          .post<{ text: string }>("/voice/chat", { text: demoText, voice })
          .then((r) => {
            setTurns((t) => [...t, { id: `a${Date.now()}`, role: "assistant", text: r.text, timestamp: new Date().toISOString() }]);
          })
          .catch(() => {
            setTurns((t) => [...t, { id: `a${Date.now()}`, role: "assistant", text: "Nexus is a multi-agent AI platform providing infrastructure-first architecture with 23 core capability gaps being systematically closed.", timestamp: new Date().toISOString() }]);
          })
          .finally(() => setVoiceState("idle"));
      }, 1200);
    } else if (voiceState === "idle") {
      setVoiceState("listening");
    }
  }, [voiceState, voice]);

  return (
    <div style={s.page}>
      <div style={s.header}>
        <div>
          <h1 style={s.title}>Voice Interface</h1>
          <p style={{ color: "#64748b", margin: "4px 0 0" }}>Speak naturally to your AI agents</p>
        </div>
        <select style={s.voiceSelect} value={voice} onChange={(e) => setVoice(e.target.value)}>
          {VOICES.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
        </select>
      </div>

      <div style={s.transcript}>
        {turns.length === 0 && (
          <p style={{ color: "#475569", textAlign: "center", marginTop: 80, fontSize: 14 }}>
            Your conversation will appear here.
          </p>
        )}
        {turns.map((t) => (
          <div key={t.id} style={s.turn(t.role)}>
            <div style={s.bubble(t.role)}>{t.text}</div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <div style={s.controls}>
        {turns.length > 0 && (
          <button style={s.clearBtn} onClick={() => setTurns([])}>Clear</button>
        )}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
          <button style={s.micBtn(voiceState)} onClick={handleMic} disabled={voiceState === "processing" || voiceState === "speaking"}>
            {STATE_ICON[voiceState]}
          </button>
          <div style={s.stateLabel}>{STATE_LABEL[voiceState]}</div>
        </div>
        <div style={{ width: 76 }} />
      </div>
    </div>
  );
}
