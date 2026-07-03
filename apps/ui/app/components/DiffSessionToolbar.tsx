// SPDX-License-Identifier: Apache-2.0
import React, { useState } from "react";

interface DiffSessionToolbarProps {
  accepted: number;
  total: number;
  rollbackId?: string;
  onApply: () => void;
  onRejectAll: () => void;
  onRollback: () => void;
  isApplying?: boolean;
}

export function DiffSessionToolbar({
  accepted,
  total,
  rollbackId,
  onApply,
  onRejectAll,
  onRollback,
  isApplying = false,
}: DiffSessionToolbarProps) {
  const [toast, setToast] = useState<string | null>(null);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  }

  if (total === 0) return null;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 14px",
        background: "#0a0a0a",
        border: "1px solid #222",
        borderRadius: 8,
        marginTop: 10,
        flexWrap: "wrap",
      }}
    >
      {/* Count */}
      <span style={{ fontSize: 12, color: "#888" }}>
        <span style={{ color: accepted > 0 ? "#22c55e" : "#666", fontWeight: 600 }}>
          {accepted}
        </span>
        <span style={{ color: "#555" }}> / {total} blocks accepted</span>
      </span>

      {/* Divider */}
      <span style={{ color: "#222" }}>│</span>

      {/* Actions */}
      <div style={{ display: "flex", gap: 6, marginLeft: "auto", flexWrap: "wrap" }}>
        {rollbackId && (
          <button
            onClick={() => {
              onRollback();
              showToast("Rolled back");
            }}
            style={{
              fontSize: 11,
              color: "#f59e0b",
              background: "none",
              border: "1px solid #78350f",
              borderRadius: 4,
              padding: "4px 10px",
              cursor: "pointer",
            }}
          >
            ↩ Rollback
          </button>
        )}
        <button
          onClick={() => {
            onRejectAll();
            showToast("All rejected");
          }}
          style={{
            fontSize: 11,
            color: "#888",
            background: "none",
            border: "1px solid #333",
            borderRadius: 4,
            padding: "4px 10px",
            cursor: "pointer",
          }}
        >
          Reject all
        </button>
        <button
          onClick={() => {
            if (accepted > 0) {
              onApply();
              showToast("Applied!");
            }
          }}
          disabled={accepted === 0 || isApplying}
          style={{
            fontSize: 11,
            color: accepted === 0 ? "#555" : "#fff",
            background: accepted === 0 ? "none" : "#2563eb",
            border: `1px solid ${accepted === 0 ? "#333" : "#1d4ed8"}`,
            borderRadius: 4,
            padding: "4px 14px",
            cursor: accepted === 0 ? "not-allowed" : "pointer",
            fontWeight: 500,
          }}
        >
          {isApplying ? "Applying…" : `Apply ${accepted > 0 ? `(${accepted})` : ""}`}
        </button>
      </div>

      {/* Toast */}
      {toast && (
        <div
          style={{
            position: "fixed",
            bottom: 24,
            right: 24,
            zIndex: 9999,
            background: "#1e1e1e",
            border: "1px solid #333",
            borderRadius: 8,
            padding: "8px 16px",
            fontSize: 13,
            color: "#e5e7eb",
            boxShadow: "0 4px 20px rgba(0,0,0,0.5)",
          }}
        >
          {toast}
        </div>
      )}
    </div>
  );
}
