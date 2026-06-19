// SPDX-License-Identifier: Apache-2.0
import React, { useRef, useEffect } from "react";

interface CodeEditorProps {
  value: string;
  language?: string;
  onChange?: (v: string) => void;
  readOnly?: boolean;
  filename?: string;
  onCopy?: () => void;
  onDownload?: () => void;
}

// Minimal keyword colorizer via CSS classes
// Real syntax highlighting would use Prism/Shiki but keeping zero-dep
function tokenize(code: string, lang: string): string {
  if (!["typescript", "javascript", "tsx", "jsx", "python", "go", "rust"].includes(lang)) {
    return escapeHtml(code);
  }
  let result = escapeHtml(code);
  // Keywords
  const kwRe =
    /\b(import|export|from|const|let|var|function|class|interface|type|return|if|else|for|while|async|await|new|this|extends|implements|default|true|false|null|undefined|void|string|number|boolean|any|object)\b/g;
  result = result.replace(kwRe, '<span style="color:#c678dd">$1</span>');
  // Strings
  result = result.replace(
    /(&#39;[^&#]*&#39;|&quot;[^&]*&quot;|`[^`]*`)/g,
    '<span style="color:#98c379">$1</span>',
  );
  // Comments
  result = result.replace(
    /(\/\/[^\n]*)/g,
    '<span style="color:#5c6370;font-style:italic">$1</span>',
  );
  return result;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function CodeEditor({
  value,
  language = "typescript",
  onChange,
  readOnly = false,
  filename,
  onCopy,
  onDownload,
}: CodeEditorProps) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const hlRef = useRef<HTMLDivElement>(null);

  // Sync scroll between textarea and highlight layer
  function syncScroll() {
    if (taRef.current && hlRef.current) {
      hlRef.current.scrollTop = taRef.current.scrollTop;
      hlRef.current.scrollLeft = taRef.current.scrollLeft;
    }
  }

  const lines = value.split("\n").length;
  const lineNums = Array.from({ length: lines }, (_, i) => i + 1);

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
        <span style={{ fontSize: 12, color: "#666", fontFamily: "monospace" }}>
          {filename ?? `untitled.${language}`}
        </span>
        <div style={{ display: "flex", gap: 6 }}>
          {onCopy && (
            <button
              onClick={onCopy}
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
              Copy
            </button>
          )}
          {onDownload && (
            <button
              onClick={onDownload}
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
              ↓ Download
            </button>
          )}
        </div>
      </div>

      {/* Editor area */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {/* Line numbers */}
        <div
          style={{
            minWidth: 40,
            background: "#080808",
            borderRight: "1px solid #1a1a1a",
            padding: "8px 0",
            overflowY: "hidden",
            userSelect: "none",
            flexShrink: 0,
          }}
        >
          {lineNums.map((n) => (
            <div
              key={n}
              style={{
                fontSize: 11,
                lineHeight: "20px",
                color: "#444",
                textAlign: "right",
                paddingRight: 8,
                fontFamily: "monospace",
              }}
            >
              {n}
            </div>
          ))}
        </div>

        {/* Code area: stacked textarea (input) + highlight layer (display) */}
        <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
          {/* Highlight layer */}
          <div
            ref={hlRef}
            aria-hidden
            style={{
              position: "absolute",
              inset: 0,
              pointerEvents: "none",
              padding: "8px 12px",
              fontFamily: "monospace",
              fontSize: 13,
              lineHeight: "20px",
              color: "#abb2bf",
              whiteSpace: "pre",
              overflowY: "auto",
              overflowX: "auto",
              tabSize: 2,
            }}
            dangerouslySetInnerHTML={{ __html: tokenize(value, language) + "\n" }}
          />
          {/* Textarea */}
          <textarea
            ref={taRef}
            value={value}
            readOnly={readOnly}
            spellCheck={false}
            onChange={(e) => onChange?.(e.target.value)}
            onScroll={syncScroll}
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              padding: "8px 12px",
              fontFamily: "monospace",
              fontSize: 13,
              lineHeight: "20px",
              background: "transparent",
              border: "none",
              color: "transparent",
              caretColor: "#abb2bf",
              resize: "none",
              outline: "none",
              overflowY: "auto",
              overflowX: "auto",
              tabSize: 2,
              whiteSpace: "pre",
            }}
          />
        </div>
      </div>
    </div>
  );
}
