// SPDX-License-Identifier: Apache-2.0
import React, { useRef, useState, useEffect, useCallback } from "react";
import { useContextMention, type MentionType } from "../hooks/useContextMention";
import { ContextPill } from "./ContextPill";

export interface Mention {
  type: "file" | "symbol" | "web";
  label: string;
  value: string;
}

interface SearchResult {
  label: string;
  value: string;
  sub?: string;
}

interface ContextMentionProps {
  value: string;
  onChange: (v: string) => void;
  onMentionsChange: (mentions: Mention[]) => void;
  placeholder?: string;
  rows?: number;
}

const TAB_TYPES: Array<{ key: MentionType | "all"; label: string }> = [
  { key: "all", label: "All" },
  { key: "file", label: "Files" },
  { key: "symbol", label: "Symbols" },
  { key: "web", label: "Web" },
];

async function fetchResults(type: MentionType | "all", query: string): Promise<SearchResult[]> {
  const q = encodeURIComponent(query);
  if (type === "file" || type === "all") {
    try {
      const r = await fetch(`/api/context/files?q=${q}`);
      if (r.ok) {
        const data: Array<{ path: string; name: string; size: number }> = await r.json();
        return data.slice(0, 8).map((f) => ({ label: f.name, value: f.path, sub: f.path }));
      }
    } catch {}
  }
  if (type === "symbol") {
    try {
      const r = await fetch(`/api/context/symbols?q=${q}`);
      if (r.ok) {
        const data: Array<{ name: string; type: string; file: string; line: number }> =
          await r.json();
        return data
          .slice(0, 8)
          .map((s) => ({ label: s.name, value: s.name, sub: `${s.type} · ${s.file}:${s.line}` }));
      }
    } catch {}
  }
  if (type === "web") {
    try {
      const r = await fetch(`/api/context/web?q=${q}`);
      if (r.ok) {
        const data: Array<{ title: string; url: string; snippet: string }> = await r.json();
        return data.slice(0, 5).map((w) => ({ label: w.title, value: w.url, sub: w.snippet }));
      }
    } catch {}
  }
  return [];
}

export function ContextMention({
  value,
  onChange,
  onMentionsChange,
  placeholder = "Message… (type @ for context)",
  rows = 4,
}: ContextMentionProps) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const mention = useContextMention(taRef);
  const [mentions, setMentions] = useState<Mention[]>([]);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [activeTab, setActiveTab] = useState<MentionType | "all">("all");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync tab to detected mention type
  useEffect(() => {
    if (mention.mentionType) setActiveTab(mention.mentionType);
    else setActiveTab("all");
  }, [mention.mentionType]);

  // Fetch results when query/tab changes
  useEffect(() => {
    if (!mention.isOpen) {
      setResults([]);
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      const r = await fetchResults(activeTab, mention.query);
      setResults(r);
    }, 150);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [mention.isOpen, mention.query, activeTab]);

  const selectResult = useCallback(
    (result: SearchResult) => {
      const type = activeTab === "all" ? "file" : (activeTab as "file" | "symbol" | "web");
      const newMention: Mention = { type, label: result.label, value: result.value };
      const updated = [...mentions, newMention];
      setMentions(updated);
      onMentionsChange(updated);

      // Remove @query from textarea
      const ta = taRef.current;
      if (ta) {
        const cursor = ta.selectionStart ?? value.length;
        const before = value.slice(0, cursor);
        const after = value.slice(cursor);
        const cleaned = before.replace(/@([^@\s]*)$/, "") + after;
        onChange(cleaned);
      }
      mention.closePicker();
    },
    [activeTab, mentions, value, onChange, onMentionsChange, mention],
  );

  const removeMention = useCallback(
    (idx: number) => {
      const updated = mentions.filter((_, i) => i !== idx);
      setMentions(updated);
      onMentionsChange(updated);
    },
    [mentions, onMentionsChange],
  );

  const estimatedTokens = mentions.length * 300;

  return (
    <div style={{ position: "relative", width: "100%" }}>
      {/* Pills row */}
      {mentions.length > 0 && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 2,
            padding: "6px 4px",
            borderBottom: "1px solid #1e1e1e",
            marginBottom: 4,
          }}
        >
          {mentions.map((m, i) => (
            <ContextPill
              key={i}
              type={m.type}
              label={m.label}
              value={m.value}
              onRemove={() => removeMention(i)}
            />
          ))}
        </div>
      )}

      {/* Textarea */}
      <textarea
        ref={taRef}
        value={value}
        rows={rows}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value);
          mention.onTextareaChange(e);
        }}
        onKeyDown={(e) => mention.onKeyDown(e)}
        style={{
          width: "100%",
          background: "#0a0a0a",
          border: "1px solid #2a2a2a",
          color: "#f0f0f0",
          borderRadius: 8,
          padding: "10px 12px",
          fontSize: 14,
          resize: "vertical",
          outline: "none",
          boxSizing: "border-box",
          fontFamily: "inherit",
          lineHeight: 1.5,
        }}
      />

      {/* Token estimate */}
      {mentions.length > 0 && (
        <div style={{ fontSize: 11, color: "#555", textAlign: "right", marginTop: 3 }}>
          ~{estimatedTokens > 999 ? `${(estimatedTokens / 1000).toFixed(1)}k` : estimatedTokens} ctx
          tokens
        </div>
      )}

      {/* Floating picker */}
      {mention.isOpen && (
        <div
          style={{
            position: "fixed",
            top: mention.anchorPos.top,
            left: mention.anchorPos.left,
            zIndex: 9000,
            background: "#111",
            border: "1px solid #333",
            borderRadius: 10,
            width: 340,
            maxHeight: 320,
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
            boxShadow: "0 8px 32px rgba(0,0,0,0.7)",
          }}
        >
          {/* Tabs */}
          <div style={{ display: "flex", borderBottom: "1px solid #222" }}>
            {TAB_TYPES.map((t) => (
              <button
                key={t.key ?? "all"}
                onClick={() => setActiveTab(t.key)}
                style={{
                  flex: 1,
                  background: "none",
                  border: "none",
                  borderBottom: activeTab === t.key ? "2px solid #3b82f6" : "2px solid transparent",
                  color: activeTab === t.key ? "#e5e7eb" : "#666",
                  padding: "7px 0",
                  fontSize: 12,
                  cursor: "pointer",
                  fontWeight: activeTab === t.key ? 600 : 400,
                }}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* Search input display */}
          <div style={{ padding: "6px 10px", borderBottom: "1px solid #1e1e1e" }}>
            <input
              readOnly
              value={mention.query}
              placeholder="Type to search…"
              style={{
                width: "100%",
                background: "#0a0a0a",
                border: "1px solid #2a2a2a",
                color: "#aaa",
                borderRadius: 6,
                padding: "4px 8px",
                fontSize: 12,
                outline: "none",
                boxSizing: "border-box",
              }}
            />
          </div>

          {/* Results */}
          <div style={{ overflowY: "auto", flex: 1 }}>
            {results.length === 0 ? (
              <div
                style={{ color: "#555", fontSize: 12, padding: "16px 12px", textAlign: "center" }}
              >
                {mention.query ? "No results" : "Type to search…"}
              </div>
            ) : (
              results.map((r, i) => (
                <div
                  key={i}
                  onClick={() => selectResult(r)}
                  style={{
                    padding: "8px 12px",
                    cursor: "pointer",
                    background: mention.selectedIndex === i ? "#1e1e1e" : "transparent",
                    borderBottom: "1px solid #1a1a1a",
                  }}
                  onMouseEnter={() => mention.setSelectedIndex(i)}
                >
                  <div style={{ fontSize: 13, color: "#e5e7eb", marginBottom: r.sub ? 2 : 0 }}>
                    {r.label}
                  </div>
                  {r.sub && (
                    <div
                      style={{
                        fontSize: 11,
                        color: "#666",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {r.sub}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
