// SPDX-License-Identifier: Apache-2.0
import React, { useState, useEffect } from "react";

interface ProjectInstructionsProps {
  projectId: string;
}

const MAX_CHARS = 2000;

export function ProjectInstructions({ projectId }: ProjectInstructionsProps) {
  const [instructions, setInstructions] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    fetch(`/api/v1/projects/${projectId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((p: { instructions?: string } | null) => setInstructions(p?.instructions ?? ""))
      .catch(() => {});
  }, [projectId]);

  async function handleSave() {
    setSaving(true);
    setFailed(false);
    const res = await fetch(`/api/v1/projects/${projectId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instructions }),
    }).catch(() => null);
    setSaving(false);
    if (!res?.ok) {
      setFailed(true);
      return;
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  const remaining = MAX_CHARS - instructions.length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
      {/* Header */}
      <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--border)" }}>
        <span
          style={{
            fontSize: 11,
            color: "var(--muted-foreground)",
            textTransform: "uppercase",
            letterSpacing: "1px",
          }}
        >
          Instructions
        </span>
      </div>

      <div style={{ padding: "12px 14px" }}>
        {/* Instruction textarea */}
        <textarea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value.slice(0, MAX_CHARS))}
          placeholder="Custom instructions for this project&#10;e.g. Always respond in TypeScript. Prefer functional patterns."
          rows={6}
          style={{
            width: "100%",
            background: "var(--background)",
            border: "1px solid var(--border)",
            color: "var(--foreground)",
            borderRadius: 6,
            padding: "8px 10px",
            fontSize: 12,
            resize: "vertical",
            outline: "none",
            boxSizing: "border-box",
            fontFamily: "inherit",
            lineHeight: 1.5,
          }}
        />

        {/* Char count + Save */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginTop: 6,
          }}
        >
          <span
            style={{
              fontSize: 10,
              color: remaining < 100 ? "var(--destructive)" : "var(--muted-foreground)",
            }}
          >
            {remaining} chars left
          </span>
          <button
            onClick={handleSave}
            disabled={saving}
            style={{
              fontSize: 11,
              color: saved ? "var(--success)" : "var(--foreground)",
              background: saved ? "var(--success-surface)" : "var(--secondary)",
              border: `1px solid ${saved ? "var(--success)" : "var(--border)"}`,
              borderRadius: 5,
              padding: "4px 12px",
              cursor: saving ? "not-allowed" : "pointer",
              transition: "all 0.2s",
            }}
          >
            {saving ? "Saving…" : saved ? "✓ Saved" : "Save"}
          </button>
        </div>

        {failed && (
          <div style={{ marginTop: 6, fontSize: 11, color: "var(--destructive)" }}>Save failed</div>
        )}
        <div style={{ marginTop: 8, fontSize: 10, color: "var(--muted-foreground)" }}>
          Work handed from this project to a company follows these instructions.
        </div>
      </div>
    </div>
  );
}
