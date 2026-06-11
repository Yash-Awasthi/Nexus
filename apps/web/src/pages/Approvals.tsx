// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from "react";
import { api } from "../lib/api.js";

interface Approval {
  id: string; entity_type: string; entity_id: string;
  action: string; requestor: string; status: string; created_at: string;
}

export default function Approvals() {
  const [items, setItems] = useState<Approval[]>([]);
  const [filter, setFilter] = useState("pending");
  const [actor, setActor] = useState("");

  const load = () =>
    api.get<{ approvals: Approval[] }>(`/governance/approvals?status=${filter}&limit=50`)
      .then((r) => setItems(r.approvals))
      .catch(console.error);

  useEffect(() => { void load(); }, [filter]);

  const resolve = async (id: string, action: "approve" | "reject") => {
    if (!actor.trim()) { alert("Enter your name first"); return; }
    await api.post(`/governance/approvals/${id}/${action}`, { resolved_by: actor });
    void load();
  };

  const badge = (s: string) => {
    const colors: Record<string, string> = { pending: "#d97706", approved: "#16a34a", rejected: "#dc2626", expired: "#475569" };
    return (
      <span style={{ background: colors[s] ?? "#475569", color: "#fff", padding: "2px 8px", borderRadius: 9999, fontSize: 11 }}>
        {s}
      </span>
    );
  };

  return (
    <div>
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 24 }}>✓ Approvals</h1>

      <div style={{ display: "flex", gap: 12, marginBottom: 20, alignItems: "center" }}>
        {["pending", "approved", "rejected"].map((s) => (
          <button
            key={s}
            style={{
              padding: "6px 14px", borderRadius: 6,
              background: filter === s ? "#7c3aed" : "#161b27",
              border: "1px solid #1e2535", color: "#e2e8f0", cursor: "pointer",
            }}
            onClick={() => setFilter(s)}
          >
            {s}
          </button>
        ))}
        <input
          style={{ marginLeft: "auto", padding: "6px 12px", background: "#161b27", border: "1px solid #1e2535", borderRadius: 6, color: "#e2e8f0" }}
          placeholder="Your name (for approve/reject)"
          value={actor}
          onChange={(e) => setActor(e.target.value)}
        />
      </div>

      {items.length === 0 && <p style={{ color: "#64748b" }}>No {filter} approvals.</p>}

      {items.map((a) => (
        <div
          key={a.id}
          style={{ background: "#161b27", border: "1px solid #1e2535", borderRadius: 10, padding: "16px 20px", marginBottom: 12 }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
            <span style={{ color: "#c4b5fd", fontWeight: 600 }}>{a.action}</span>
            {badge(a.status)}
          </div>
          <p style={{ fontSize: 13, color: "#94a3b8" }}>
            {a.entity_type} · {a.entity_id.slice(0, 8)}… · by {a.requestor}
          </p>
          <p style={{ fontSize: 11, color: "#475569", marginTop: 4 }}>{a.created_at}</p>
          {a.status === "pending" && (
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button
                style={{ padding: "5px 14px", background: "#16a34a", border: "none", borderRadius: 6, color: "#fff", cursor: "pointer" }}
                onClick={() => resolve(a.id, "approve")}
              >
                Approve
              </button>
              <button
                style={{ padding: "5px 14px", background: "#dc2626", border: "none", borderRadius: 6, color: "#fff", cursor: "pointer" }}
                onClick={() => resolve(a.id, "reject")}
              >
                Reject
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
