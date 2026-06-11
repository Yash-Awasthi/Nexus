// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from "react";

import { api } from "../lib/api.js";

interface Task {
  id: string;
  type: string;
  status: string;
  priority: string;
  created_at: string;
  error?: string;
}

const statusColors: Record<string, string> = {
  queued: "#7c3aed",
  running: "#2563eb",
  completed: "#16a34a",
  failed: "#dc2626",
  cancelled: "#475569",
  awaiting_approval: "#d97706",
};

export default function Tasks() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [status, setStatus] = useState("");

  useEffect(() => {
    const q = status ? `?status=${status}&limit=50` : "?limit=50";
    api
      .get<{ tasks: Task[] }>(`/runtime/tasks${q}`)
      .then((r) => setTasks(r.tasks))
      .catch(console.error);
  }, [status]);

  return (
    <div>
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 24 }}>◎ Runtime Tasks</h1>

      <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
        {["", "queued", "running", "completed", "failed"].map((s) => (
          <button
            key={s || "all"}
            style={{
              padding: "5px 12px",
              borderRadius: 6,
              cursor: "pointer",
              background: status === s ? "#7c3aed" : "#161b27",
              border: "1px solid #1e2535",
              color: "#e2e8f0",
            }}
            onClick={() => setStatus(s)}
          >
            {s || "all"}
          </button>
        ))}
      </div>

      {tasks.length === 0 && <p style={{ color: "#64748b" }}>No tasks found.</p>}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {tasks.map((t) => (
          <div
            key={t.id}
            style={{
              background: "#161b27",
              border: "1px solid #1e2535",
              borderRadius: 8,
              padding: "12px 16px",
              display: "flex",
              alignItems: "center",
              gap: 16,
            }}
          >
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: "50%",
                background: statusColors[t.status] ?? "#475569",
                flexShrink: 0,
              }}
            />
            <span style={{ color: "#c4b5fd", fontWeight: 600, minWidth: 200 }}>{t.type}</span>
            <span style={{ color: "#64748b", fontSize: 12 }}>{t.status}</span>
            <span style={{ marginLeft: "auto", fontSize: 11, color: "#475569" }}>
              {t.id.slice(0, 8)}…
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
