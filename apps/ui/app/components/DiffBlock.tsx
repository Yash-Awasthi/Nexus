// SPDX-License-Identifier: Apache-2.0
import React, { useState } from "react";

export type HunkLine = {
  type: "added" | "removed" | "context";
  content: string;
  oldLine?: number;
  newLine?: number;
};

export type Hunk = {
  id: string;
  filename: string;
  oldStart: number;
  newStart: number;
  lines: HunkLine[];
  status: "pending" | "accepted" | "rejected";
};

interface DiffBlockProps {
  hunk: Hunk;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
  onEdit: (id: string, editedLines: HunkLine[]) => void;
}

const LINE_STYLES: Record<HunkLine["type"], React.CSSProperties> = {
  added: { background: "#0d2b0d", borderLeft: "3px solid #22c55e" },
  removed: { background: "#2b0d0d", borderLeft: "3px solid #ef4444" },
  context: { background: "transparent", borderLeft: "3px solid transparent" },
};

const LINE_PREFIX: Record<HunkLine["type"], string> = {
  added: "+",
  removed: "-",
  context: " ",
};

const LINE_COLOR: Record<HunkLine["type"], string> = {
  added: "#86efac",
  removed: "#fca5a5",
  context: "#9ca3af",
};

export function DiffBlock({ hunk, onAccept, onReject, onEdit }: DiffBlockProps) {
  const [hovered, setHovered] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");

  const statusColors = {
    pending: { border: "#333", bg: "#0f0f0f" },
    accepted: { border: "#16a34a", bg: "#0a1a0a" },
    rejected: { border: "#555", bg: "#111" },
  };
  const style = statusColors[hunk.status];

  function startEdit() {
    const editableLines = hunk.lines
      .filter((l) => l.type !== "removed")
      .map((l) => l.content)
      .join("\n");
    setEditValue(editableLines);
    setEditing(true);
  }

  function submitEdit() {
    const newLines: HunkLine[] = editValue.split("\n").map((content, i) => ({
      type: "added" as const,
      content,
      newLine: hunk.newStart + i,
    }));
    onEdit(hunk.id, newLines);
    setEditing(false);
  }

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        border: `1px solid ${style.border}`,
        borderRadius: 6,
        background: style.bg,
        marginBottom: 10,
        overflow: "hidden",
        opacity: hunk.status === "rejected" ? 0.45 : 1,
        transition: "opacity 0.2s, border-color 0.2s",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "5px 10px",
          background: "#0a0a0a",
          borderBottom: "1px solid #1e1e1e",
        }}
      >
        <span style={{ fontSize: 11, color: "#888", fontFamily: "monospace" }}>
          {hunk.filename}
          <span style={{ color: "#555", marginLeft: 8 }}>
            @@ -{hunk.oldStart} +{hunk.newStart} @@
          </span>
        </span>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {hunk.status === "accepted" && (
            <span style={{ fontSize: 10, color: "#22c55e" }}>✓ accepted</span>
          )}
          {hunk.status === "rejected" && (
            <span style={{ fontSize: 10, color: "#666" }}>✗ rejected</span>
          )}
          {(hovered || hunk.status === "pending") && hunk.status !== "rejected" && (
            <>
              {hunk.status === "pending" && (
                <button
                  onClick={() => startEdit()}
                  style={{
                    fontSize: 11,
                    color: "#888",
                    background: "none",
                    border: "1px solid #333",
                    borderRadius: 4,
                    padding: "2px 8px",
                    cursor: "pointer",
                  }}
                >
                  Edit
                </button>
              )}
              <button
                onClick={() => onReject(hunk.id)}
                style={{
                  fontSize: 11,
                  color: "#ef4444",
                  background: "none",
                  border: "1px solid #7f1d1d",
                  borderRadius: 4,
                  padding: "2px 8px",
                  cursor: "pointer",
                }}
              >
                Reject
              </button>
              <button
                onClick={() => onAccept(hunk.id)}
                style={{
                  fontSize: 11,
                  color: "#22c55e",
                  background: "none",
                  border: "1px solid #14532d",
                  borderRadius: 4,
                  padding: "2px 10px",
                  cursor: "pointer",
                  fontWeight: 600,
                }}
              >
                Accept
              </button>
            </>
          )}
        </div>
      </div>

      {/* Diff lines */}
      {!editing ? (
        <div style={{ fontFamily: "monospace", fontSize: 12, overflowX: "auto" }}>
          {hunk.lines.map((line, i) => (
            <div
              key={i}
              style={{
                ...LINE_STYLES[line.type],
                display: "flex",
                padding: "1px 0",
              }}
            >
              <span
                style={{
                  color: "#444",
                  minWidth: 36,
                  textAlign: "right",
                  padding: "0 8px",
                  userSelect: "none",
                  fontSize: 10,
                }}
              >
                {line.oldLine ?? ""}
              </span>
              <span
                style={{
                  color: "#444",
                  minWidth: 36,
                  textAlign: "right",
                  padding: "0 8px",
                  userSelect: "none",
                  fontSize: 10,
                }}
              >
                {line.newLine ?? ""}
              </span>
              <span
                style={{ color: LINE_COLOR[line.type], padding: "0 4px 0 2px", userSelect: "none" }}
              >
                {LINE_PREFIX[line.type]}
              </span>
              <span style={{ color: LINE_COLOR[line.type], whiteSpace: "pre", flex: 1 }}>
                {line.content}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ padding: 8 }}>
          <textarea
            autoFocus
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            style={{
              width: "100%",
              background: "#0a0a0a",
              border: "1px solid #333",
              color: "#e5e7eb",
              borderRadius: 4,
              padding: 8,
              fontFamily: "monospace",
              fontSize: 12,
              resize: "vertical",
              minHeight: 80,
              outline: "none",
              boxSizing: "border-box",
            }}
          />
          <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
            <button
              onClick={submitEdit}
              style={{
                fontSize: 11,
                color: "#22c55e",
                background: "none",
                border: "1px solid #14532d",
                borderRadius: 4,
                padding: "3px 10px",
                cursor: "pointer",
              }}
            >
              Apply edit
            </button>
            <button
              onClick={() => setEditing(false)}
              style={{
                fontSize: 11,
                color: "#888",
                background: "none",
                border: "1px solid #333",
                borderRadius: 4,
                padding: "3px 10px",
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
