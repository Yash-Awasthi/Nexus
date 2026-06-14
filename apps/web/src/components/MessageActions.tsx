// SPDX-License-Identifier: Apache-2.0
/**
 * MessageActions — per-message action bar for assistant messages.
 *
 * Features:
 *   • Copy to clipboard
 *   • Regenerate / rewrite with optional model override
 *   • Model picker (inline dropdown on rewrite)
 *   • Thumbs up / down rating (calls onRate callback)
 */

import { useState, useCallback } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MessageActionsProps {
  messageId: string;
  content: string;
  currentModel: string;
  models: { id: string; label: string }[];
  onRegenerate: (messageId: string, model: string) => void | Promise<void>;
  onRate?: (messageId: string, rating: "up" | "down") => void;
  loading?: boolean;
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = {
  bar: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    marginTop: 4,
    opacity: 0,
    transition: "opacity 0.15s",
  } as React.CSSProperties,

  barVisible: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    marginTop: 4,
    opacity: 1,
    transition: "opacity 0.15s",
  } as React.CSSProperties,

  btn: (active?: boolean): React.CSSProperties => ({
    background: active ? "rgba(124,58,237,0.15)" : "transparent",
    border: `1px solid ${active ? "#7c3aed" : "#1e2535"}`,
    borderRadius: 6,
    color: active ? "#a78bfa" : "#334155",
    cursor: "pointer",
    fontSize: 11,
    padding: "3px 7px",
    display: "flex",
    alignItems: "center",
    gap: 4,
    transition: "all 0.12s",
    lineHeight: 1.4,
  }),

  modelSelect: {
    background: "#0f1420",
    border: "1px solid #2d1f6e",
    borderRadius: 6,
    color: "#a78bfa",
    fontSize: 11,
    padding: "3px 6px",
    cursor: "pointer",
    outline: "none",
  } as React.CSSProperties,

  separator: {
    width: 1,
    height: 14,
    background: "#1e2535",
    margin: "0 2px",
  } as React.CSSProperties,

  copySuccess: {
    fontSize: 10,
    color: "#16a34a",
    fontWeight: 700,
  } as React.CSSProperties,
};

// ── Component ─────────────────────────────────────────────────────────────────

export function MessageActions({
  messageId,
  content,
  currentModel,
  models,
  onRegenerate,
  onRate,
  loading = false,
}: MessageActionsProps) {
  const [visible, setVisible] = useState(false);
  const [copied, setCopied] = useState(false);
  const [rewriteModel, setRewriteModel] = useState(currentModel);
  const [rating, setRating] = useState<"up" | "down" | null>(null);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API unavailable — silently ignore
    }
  }, [content]);

  const handleRegenerate = useCallback(() => {
    void onRegenerate(messageId, rewriteModel);
  }, [messageId, rewriteModel, onRegenerate]);

  const handleRate = useCallback(
    (r: "up" | "down") => {
      setRating(r);
      onRate?.(messageId, r);
    },
    [messageId, onRate],
  );

  return (
    <div
      style={visible ? s.barVisible : s.bar}
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
      aria-label="Message actions"
    >
      {/* Copy */}
      <button
        style={s.btn(copied)}
        onClick={() => void handleCopy()}
        title="Copy to clipboard"
        disabled={loading}
      >
        {copied ? <span style={s.copySuccess}>✓ Copied</span> : "⎘ Copy"}
      </button>

      <div style={s.separator} />

      {/* Model picker for rewrite */}
      <select
        style={s.modelSelect}
        value={rewriteModel}
        onChange={(e) => setRewriteModel(e.target.value)}
        disabled={loading}
        title="Model for regeneration"
        aria-label="Select model for regeneration"
      >
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </select>

      {/* Regenerate */}
      <button
        style={s.btn()}
        onClick={handleRegenerate}
        title={`Regenerate with ${rewriteModel}`}
        disabled={loading}
      >
        ↻ Rewrite
      </button>

      {onRate && (
        <>
          <div style={s.separator} />
          <button
            style={s.btn(rating === "up")}
            onClick={() => handleRate("up")}
            title="Good response"
            aria-label="Rate thumbs up"
            disabled={loading}
          >
            ▲
          </button>
          <button
            style={s.btn(rating === "down")}
            onClick={() => handleRate("down")}
            title="Bad response"
            aria-label="Rate thumbs down"
            disabled={loading}
          >
            ▼
          </button>
        </>
      )}
    </div>
  );
}
