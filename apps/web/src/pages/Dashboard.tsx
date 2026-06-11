// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from "react";
import { api } from "../lib/api.js";

const card: React.CSSProperties = {
  background: "#161b27", border: "1px solid #1e2535", borderRadius: 10,
  padding: "20px 24px",
};
const title: React.CSSProperties = { fontSize: 12, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.1em" };
const value: React.CSSProperties = { fontSize: 32, fontWeight: 700, color: "#e2e8f0", marginTop: 6 };

interface Stats {
  tasks: { tasks: { status: string }[] };
  approvals: { approvals: { status: string }[] };
  health: { status: string; timestamp: string };
}

export default function Dashboard() {
  const [stats, setStats] = useState<Partial<Stats>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      api.get<Stats["tasks"]>("/runtime/tasks?limit=200"),
      api.get<Stats["approvals"]>("/governance/approvals?limit=200"),
      api.health(),
    ])
      .then(([tasks, approvals, health]) => setStats({ tasks, approvals, health }))
      .catch((e: unknown) => setError(String(e)));
  }, []);

  const tasksByStatus = (status: string) =>
    stats.tasks?.tasks.filter((t) => t.status === status).length ?? "—";

  return (
    <div>
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 8 }}>Dashboard</h1>
      <p style={{ color: "#64748b", marginBottom: 32 }}>
        {stats.health ? `API ${stats.health.status} · ${stats.health.timestamp}` : "Connecting…"}
      </p>

      {error && (
        <div style={{ background: "#450a0a", border: "1px solid #7f1d1d", borderRadius: 8, padding: 16, marginBottom: 24, color: "#fca5a5" }}>
          {error}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 16 }}>
        {[
          { label: "Queued Tasks", v: tasksByStatus("queued"), color: "#7c3aed" },
          { label: "Running Tasks", v: tasksByStatus("running"), color: "#2563eb" },
          { label: "Completed", v: tasksByStatus("completed"), color: "#16a34a" },
          { label: "Failed", v: tasksByStatus("failed"), color: "#dc2626" },
          { label: "Pending Approvals", v: stats.approvals?.approvals.filter((a) => a.status === "pending").length ?? "—", color: "#d97706" },
        ].map(({ label, v, color }) => (
          <div key={label} style={card}>
            <p style={title}>{label}</p>
            <p style={{ ...value, color }}>{v}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
