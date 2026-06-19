// SPDX-License-Identifier: Apache-2.0
import React, { useRef, useEffect, useState } from "react";

interface PreviewPaneProps {
  html: string;
  isLoading?: boolean;
  stack?: string;
}

export function PreviewPane({ html, isLoading = false, stack = "html" }: PreviewPaneProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const isBrowserRenderable = ["html", "react", "vue", "svelte"].includes(stack.toLowerCase());

  useEffect(() => {
    if (!iframeRef.current || !html || !isBrowserRenderable) return;
    setError(null);
    const iframe = iframeRef.current;
    try {
      const doc = iframe.contentDocument || iframe.contentWindow?.document;
      if (!doc) return;
      doc.open();
      doc.write(html);
      doc.close();

      // Catch runtime errors inside iframe
      iframe.contentWindow?.addEventListener("error", (e) => {
        setError(e.message);
      });
    } catch (e) {
      setError(String(e));
    }
  }, [html, reloadKey, isBrowserRenderable]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "#0d0d0d",
        borderRadius: 8,
        border: "1px solid #1e1e1e",
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "6px 10px",
          borderBottom: "1px solid #1e1e1e",
          background: "#0a0a0a",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: isLoading ? "#f59e0b" : html ? "#22c55e" : "#555",
              display: "inline-block",
            }}
          />
          <span style={{ fontSize: 12, color: "#666" }}>Preview — {stack}</span>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button
            onClick={() => setReloadKey((k) => k + 1)}
            style={{
              fontSize: 11,
              color: "#666",
              background: "none",
              border: "1px solid #333",
              borderRadius: 4,
              padding: "2px 8px",
              cursor: "pointer",
            }}
          >
            ↺ Reload
          </button>
          {html && (
            <button
              onClick={() => {
                const w = window.open("", "_blank");
                if (w) {
                  w.document.write(html);
                  w.document.close();
                }
              }}
              style={{
                fontSize: 11,
                color: "#666",
                background: "none",
                border: "1px solid #333",
                borderRadius: 4,
                padding: "2px 8px",
                cursor: "pointer",
              }}
            >
              ↗ Fullscreen
            </button>
          )}
        </div>
      </div>

      {/* Preview area */}
      <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
        {isLoading && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "#0d0d0d",
              zIndex: 2,
            }}
          >
            <div style={{ fontSize: 12, color: "#555" }}>Generating…</div>
          </div>
        )}

        {!html && !isLoading && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <div style={{ textAlign: "center", color: "#444" }}>
              <div style={{ fontSize: 28, marginBottom: 8 }}>◻</div>
              <div style={{ fontSize: 12 }}>Preview will appear here</div>
            </div>
          </div>
        )}

        {!isBrowserRenderable && html && (
          <div style={{ padding: 16, color: "#888", fontSize: 12, fontFamily: "monospace" }}>
            <div style={{ color: "#555", marginBottom: 8 }}>
              Server-side target — run in terminal:
            </div>
            <pre
              style={{
                background: "#080808",
                padding: 12,
                borderRadius: 6,
                overflowX: "auto",
                border: "1px solid #1e1e1e",
                color: "#abb2bf",
              }}
            >
              {stack === "python"
                ? "python3 main.py"
                : stack === "go"
                  ? "go run main.go"
                  : "node index.js"}
            </pre>
          </div>
        )}

        {isBrowserRenderable && (
          <iframe
            key={reloadKey}
            ref={iframeRef}
            sandbox="allow-scripts allow-same-origin"
            style={{ width: "100%", height: "100%", border: "none", background: "#fff" }}
            title="preview"
          />
        )}

        {error && (
          <div
            style={{
              position: "absolute",
              bottom: 0,
              left: 0,
              right: 0,
              background: "#2b0d0d",
              border: "1px solid #7f1d1d",
              padding: "8px 12px",
              fontSize: 11,
              color: "#fca5a5",
              fontFamily: "monospace",
            }}
          >
            ⚠ {error}
          </div>
        )}
      </div>
    </div>
  );
}
