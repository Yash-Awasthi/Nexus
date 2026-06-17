// SPDX-License-Identifier: Apache-2.0
import type { CSSProperties } from "react";

import type { StoredMessage } from "../lib/storage.js";

interface Props {
  msg: StoredMessage;
}

function bubble(role: "user" | "assistant"): CSSProperties {
  return {
    maxWidth: "80%",
    alignSelf: role === "user" ? "flex-end" : "flex-start",
    background: role === "user" ? "var(--bg3)" : "var(--bg2)",
    border: `1px solid ${role === "user" ? "var(--fg3)" : "var(--border)"}`,
    borderRadius: 4,
    padding: "10px 14px",
    fontSize: 13,
    lineHeight: 1.6,
    color: "var(--fg)",
    fontFamily: "var(--font)",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  };
}

export function MessageBubble({ msg }: Props) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: msg.role === "user" ? "flex-end" : "flex-start",
      }}
    >
      <div style={bubble(msg.role)}>{msg.content}</div>
      {msg.model && (
        <span
          style={{
            fontSize: 9,
            color: "var(--fg3)",
            marginTop: 3,
            letterSpacing: "0.1em",
          }}
        >
          {msg.model}
          {msg.durationMs ? ` · ${msg.durationMs}ms` : ""}
        </span>
      )}
    </div>
  );
}
