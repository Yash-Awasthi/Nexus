// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from "react";

import { api } from "../lib/api.js";

interface Entry {
  id: string;
  sequence: number;
  entity_type: string;
  action: string;
  actor: string;
  created_at: string;
}

export default function Audit() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [verified, setVerified] = useState<{ valid: boolean; message: string } | null>(null);

  useEffect(() => {
    api
      .get<{ entries: Entry[] }>("/audit/log?limit=100")
      .then((r) => setEntries(r.entries))
      .catch(console.error);
  }, []);

  const verify = async () => {
    const res = await api.get<{ valid: boolean; message: string }>("/audit/log/verify");
    setVerified(res);
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 24 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700 }}>⛓ Audit Log</h1>
        <button
          style={{
            padding: "6px 16px",
            background: "#161b27",
            border: "1px solid #1e2535",
            borderRadius: 6,
            color: "#e2e8f0",
            cursor: "pointer",
          }}
          onClick={verify}
        >
          Verify Chain
        </button>
        {verified && (
          <span style={{ color: verified.valid ? "#16a34a" : "#dc2626" }}>
            {verified.valid ? "✓ Chain intact" : "✗ " + verified.message}
          </span>
        )}
      </div>

      <div style={{ fontFamily: "monospace", fontSize: 12 }}>
        {entries.map((e) => (
          <div
            key={e.id}
            style={{
              borderBottom: "1px solid #1e2535",
              padding: "8px 4px",
              display: "grid",
              gridTemplateColumns: "40px 120px 160px 1fr auto",
              gap: 12,
              color: "#94a3b8",
            }}
          >
            <span style={{ color: "#475569" }}>#{e.sequence}</span>
            <span style={{ color: "#c4b5fd" }}>{e.entity_type}</span>
            <span style={{ color: "#7c3aed" }}>{e.action}</span>
            <span>{e.actor}</span>
            <span style={{ color: "#475569" }}>{e.created_at?.slice(0, 19)}</span>
          </div>
        ))}
        {entries.length === 0 && <p style={{ color: "#475569" }}>No audit entries yet.</p>}
      </div>
    </div>
  );
}
