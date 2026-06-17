// SPDX-License-Identifier: Apache-2.0
import { useState } from "react";

import {
  applyParseltongue,
  DEFAULT_TRIGGERS,
  type ObfuscationIntensity,
  type ObfuscationTechnique,
} from "@nexus/parseltongue";

import { nexus } from "../lib/nexus.js";

const TECHNIQUES: { id: ObfuscationTechnique; label: string; desc: string }[] = [
  { id: "leetspeak", label: "LEET", desc: "a→4, e→3, i→1, o→0" },
  { id: "unicode", label: "UNICODE", desc: "Cyrillic homoglyphs" },
  { id: "zwj", label: "ZWJ", desc: "Invisible zero-width chars" },
  { id: "mixedcase", label: "MIXCASE", desc: "Alternating capitalisation" },
  { id: "phonetic", label: "PHONETIC", desc: "ph→f, ck→k substitution" },
  { id: "random", label: "RANDOM", desc: "Random technique per word" },
];

const INTENSITIES: ObfuscationIntensity[] = ["light", "medium", "heavy"];

export function Parseltongue() {
  const [input, setInput] = useState("");
  const [technique, setTechnique] = useState<ObfuscationTechnique>("unicode");
  const [intensity, setIntensity] = useState<ObfuscationIntensity>("medium");
  const [customTriggers, setCustomTriggers] = useState("");
  const [response, setResponse] = useState("");
  const [loading, setLoading] = useState(false);

  const extras = customTriggers
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const perturbResult =
    input.trim().length > 0
      ? applyParseltongue(input, {
          enabled: true,
          technique,
          intensity,
          customTriggers: extras,
        })
      : null;

  async function sendPerturbed() {
    if (!perturbResult || loading) return;
    setLoading(true);
    setResponse("");
    try {
      const res = await nexus.gateway.sendMessage({
        model: "nexus/smart",
        messages: [{ role: "user", content: perturbResult.transformedText }],
      });
      const content = res.content
        .map((c: { type: string; text?: string }) => (c.type === "text" ? (c.text ?? "") : ""))
        .join("");
      setResponse(content);
    } catch (err) {
      setResponse(`[error] ${String(err)}`);
    } finally {
      setLoading(false);
    }
  }

  function cellBtn(active: boolean): React.CSSProperties {
    return {
      fontSize: 9,
      padding: "3px 8px",
      background: active ? "var(--accent)" : "transparent",
      color: active ? "var(--bg)" : "var(--fg3)",
      border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
      borderRadius: 2,
      cursor: "pointer",
      fontFamily: "var(--font)",
      letterSpacing: "0.1em",
      transition: "all 0.15s",
    };
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "hidden" }}>
      {/* Controls bar */}
      <div
        style={{
          padding: "10px 16px",
          borderBottom: "1px solid var(--border)",
          background: "var(--bg2)",
          display: "flex",
          gap: 20,
          flexWrap: "wrap",
          alignItems: "center",
          flexShrink: 0,
        }}
      >
        {/* Technique */}
        <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
          <span style={{ fontSize: 9, color: "var(--fg3)", letterSpacing: "0.2em", fontFamily: "var(--font)", marginRight: 4 }}>
            TECHNIQUE
          </span>
          {TECHNIQUES.map((t) => (
            <button key={t.id} title={t.desc} style={cellBtn(technique === t.id)} onClick={() => setTechnique(t.id)}>
              {t.label}
            </button>
          ))}
        </div>

        {/* Intensity */}
        <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
          <span style={{ fontSize: 9, color: "var(--fg3)", letterSpacing: "0.2em", fontFamily: "var(--font)", marginRight: 4 }}>
            INTENSITY
          </span>
          {INTENSITIES.map((i) => (
            <button key={i} style={cellBtn(intensity === i)} onClick={() => setIntensity(i)}>
              {i.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {/* Main area */}
      <div style={{ flex: 1, overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
        {/* Input + preview side by side */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={{ fontSize: 9, color: "var(--fg3)", letterSpacing: "0.2em", fontFamily: "var(--font)" }}>
              ORIGINAL INPUT
            </span>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="type your query here…"
              rows={6}
              style={{
                background: "var(--bg2)",
                border: "1px solid var(--border)",
                borderRadius: 3,
                color: "var(--fg)",
                fontFamily: "var(--font)",
                fontSize: 12,
                padding: "10px 12px",
                resize: "vertical",
                outline: "none",
                caretColor: "var(--accent)",
                lineHeight: 1.5,
              }}
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={{ fontSize: 9, color: "var(--fg3)", letterSpacing: "0.2em", fontFamily: "var(--font)" }}>
              PERTURBED OUTPUT {perturbResult && `· ${perturbResult.triggersFound.length} trigger(s) found`}
            </span>
            <div
              style={{
                background: "var(--bg3)",
                border: `1px solid ${perturbResult && perturbResult.triggersFound.length > 0 ? "var(--accent)" : "var(--border)"}`,
                borderRadius: 3,
                color: "var(--fg)",
                fontFamily: "var(--font)",
                fontSize: 12,
                padding: "10px 12px",
                minHeight: 112,
                lineHeight: 1.5,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {perturbResult ? perturbResult.transformedText : (
                <span style={{ color: "var(--fg3)" }}>preview appears here…</span>
              )}
            </div>
          </div>
        </div>

        {/* Triggers found */}
        {perturbResult && perturbResult.triggersFound.length > 0 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            <span style={{ fontSize: 9, color: "var(--fg3)", fontFamily: "var(--font)", letterSpacing: "0.15em" }}>TRIGGERS:</span>
            {perturbResult.triggersFound.map((t) => (
              <span
                key={t}
                style={{
                  fontSize: 9,
                  padding: "1px 6px",
                  border: "1px solid var(--accent)",
                  borderRadius: 2,
                  color: "var(--accent)",
                  fontFamily: "var(--font)",
                  letterSpacing: "0.1em",
                }}
              >
                {t}
              </span>
            ))}
          </div>
        )}

        {/* Custom triggers */}
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <span style={{ fontSize: 9, color: "var(--fg3)", letterSpacing: "0.2em", fontFamily: "var(--font)" }}>
            CUSTOM TRIGGERS (comma-separated, optional)
          </span>
          <input
            value={customTriggers}
            onChange={(e) => setCustomTriggers(e.target.value)}
            placeholder="e.g. deploy, credentials, delete"
            style={{
              background: "var(--bg2)",
              border: "1px solid var(--border)",
              borderRadius: 3,
              color: "var(--fg)",
              fontFamily: "var(--font)",
              fontSize: 11,
              padding: "6px 10px",
              outline: "none",
              caretColor: "var(--accent)",
            }}
          />
        </div>

        {/* Default trigger count note */}
        <span style={{ fontSize: 9, color: "var(--fg3)", fontFamily: "var(--font)" }}>
          {DEFAULT_TRIGGERS.length} default triggers active · intensity {intensity}: {intensity === "light" ? "11" : intensity === "medium" ? "22" : "33"} techniques
        </span>

        {/* Send button */}
        <button
          onClick={sendPerturbed}
          disabled={!perturbResult || loading}
          style={{
            alignSelf: "flex-start",
            padding: "9px 20px",
            background: !perturbResult || loading ? "var(--bg3)" : "var(--accent)",
            color: !perturbResult || loading ? "var(--fg3)" : "var(--bg)",
            border: "1px solid var(--accent)",
            borderRadius: 3,
            fontFamily: "var(--font)",
            fontSize: 11,
            letterSpacing: "0.15em",
            cursor: !perturbResult || loading ? "not-allowed" : "pointer",
            fontWeight: 700,
          }}
        >
          {loading ? "TRANSMITTING…" : "SEND PERTURBED"}
        </button>

        {/* Response */}
        {response && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={{ fontSize: 9, color: "var(--fg3)", letterSpacing: "0.2em", fontFamily: "var(--font)" }}>RESPONSE</span>
            <div
              style={{
                background: "var(--bg2)",
                border: "1px solid var(--border)",
                borderRadius: 3,
                color: "var(--fg)",
                fontFamily: "var(--font)",
                fontSize: 13,
                padding: "12px 14px",
                lineHeight: 1.6,
                whiteSpace: "pre-wrap",
              }}
            >
              {response}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
