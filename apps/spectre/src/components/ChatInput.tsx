// SPDX-License-Identifier: Apache-2.0
import { type KeyboardEvent, useRef, useState } from "react";

interface Props {
  onSubmit: (text: string) => void;
  loading?: boolean;
  placeholder?: string;
}

export function ChatInput({ onSubmit, loading = false, placeholder = "send a signal…" }: Props) {
  const [val, setVal] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  function submit() {
    const t = val.trim();
    if (!t || loading) return;
    onSubmit(t);
    setVal("");
    ref.current?.focus();
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <div
      style={{
        display: "flex",
        gap: 8,
        padding: "12px 16px",
        borderTop: "1px solid var(--border)",
        background: "var(--bg)",
        flexShrink: 0,
      }}
    >
      <textarea
        ref={ref}
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={onKey}
        placeholder={placeholder}
        rows={2}
        disabled={loading}
        style={{
          flex: 1,
          resize: "none",
          background: "var(--bg2)",
          border: "1px solid var(--border)",
          borderRadius: 3,
          color: "var(--fg)",
          fontFamily: "var(--font)",
          fontSize: 13,
          padding: "8px 12px",
          outline: "none",
          caretColor: "var(--accent)",
          lineHeight: 1.5,
        }}
      />
      <button
        onClick={submit}
        disabled={loading || !val.trim()}
        style={{
          alignSelf: "flex-end",
          padding: "8px 16px",
          background: loading ? "var(--bg3)" : "var(--accent)",
          color: loading ? "var(--fg3)" : "var(--bg)",
          border: "1px solid var(--accent)",
          borderRadius: 3,
          fontFamily: "var(--font)",
          fontSize: 11,
          letterSpacing: "0.15em",
          cursor: loading ? "not-allowed" : "pointer",
          fontWeight: 700,
          transition: "all 0.15s",
        }}
      >
        {loading ? "…" : "SEND"}
      </button>
    </div>
  );
}
