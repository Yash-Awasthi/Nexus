// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useState } from "react";

import { api } from "../lib/api.js";
import { useEventSource } from "../lib/sse.js";

interface Task {
  id: string;
  type: string;
  status: string;
  priority: string;
  created_at: string;
  updated_at?: string;
  error?: string;
  progress?: number;
  message?: string;
}

interface TaskUpdatePayload {
  taskId: string;
  status: string;
  message?: string;
  progress?: number;
  updatedAt: string;
}

const statusColors: Record<string, string> = {
  queued: "#7c3aed",
  running: "#2563eb",
  completed: "#16a34a",
  failed: "#dc2626",
  cancelled: "#475569",
  paused: "#d97706",
  awaiting_approval: "#d97706",
};

const priorityColors: Record<string, string> = {
  low: "#475569",
  medium: "#2563eb",
  high: "#d97706",
  critical: "#dc2626",
};

export default function Tasks() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [statusFilter, setStatusFilter] = useState("");
  const [loading, setLoading] = useState(true);

  const fetchTasks = useCallback((): void => {
    const q = statusFilter ? `?status=${statusFilter}&limit=50` : "?limit=50";
    setLoading(true);
    api
      .get<{ tasks: Task[] }>(`/runtime/tasks${q}`)
      .then((r) => {
        setTasks(r.tasks);
        setLoading(false);
      })
      .catch((err: unknown) => {
        console.error("Failed to fetch tasks:", err);
        setLoading(false);
      });
  }, [statusFilter]);

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  // ── Live SSE updates ─────────────────────────────────────────────────────

  const handleTaskUpdate = useCallback((payload: TaskUpdatePayload): void => {
    setTasks((prev) =>
      prev.map((t) =>
        t.id === payload.taskId
          ? {
              ...t,
              status: payload.status,
              message: payload.message,
              progress: payload.progress,
              updated_at: payload.updatedAt,
            }
          : t,
      ),
    );
  }, []);

  const { status: sseStatus } = useEventSource<TaskUpdatePayload>(
    "/api/v1/sse/tasks",
    "task.update",
    handleTaskUpdate,
  );

  return (
    <div>
      {/* ── Header ── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 20,
        }}
      >
        <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0 }}>◎ Runtime Tasks</h1>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <LiveIndicator status={sseStatus} />
          <button
            onClick={fetchTasks}
            style={{
              background: "#161b27",
              border: "1px solid #1e2535",
              borderRadius: 6,
              color: "#64748b",
              cursor: "pointer",
              fontSize: 12,
              padding: "5px 10px",
            }}
          >
            ↺ Refresh
          </button>
        </div>
      </div>

      {/* ── Status filter ── */}
      <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
        {["", "queued", "running", "completed", "failed", "cancelled"].map((s) => (
          <button
            key={s || "all"}
            style={{
              padding: "5px 12px",
              borderRadius: 6,
              cursor: "pointer",
              background: statusFilter === s ? "#7c3aed" : "#161b27",
              border: "1px solid #1e2535",
              color: "#e2e8f0",
              fontSize: 13,
              transition: "background 0.15s",
            }}
            onClick={() => setStatusFilter(s)}
          >
            {s || "all"}
          </button>
        ))}
      </div>

      {/* ── Task list ── */}
      {loading && <p style={{ color: "#64748b" }}>Loading…</p>}

      {!loading && tasks.length === 0 && <p style={{ color: "#64748b" }}>No tasks found.</p>}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {tasks.map((t) => (
          <TaskRow key={t.id} task={t} />
        ))}
      </div>
    </div>
  );
}

// ── TaskRow ───────────────────────────────────────────────────────────────────

function TaskRow({ task }: { task: Task }) {
  const isRunning = task.status === "running";
  const color = statusColors[task.status] ?? "#475569";

  return (
    <div
      style={{
        background: "#161b27",
        border: `1px solid ${isRunning ? "#1d3a6e" : "#1e2535"}`,
        borderRadius: 8,
        padding: "12px 16px",
        transition: "border-color 0.3s",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        {/* Status dot — pulses when running */}
        <StatusDot color={color} pulse={isRunning} />

        {/* Task type */}
        <span style={{ color: "#c4b5fd", fontWeight: 600, minWidth: 200, fontSize: 14 }}>
          {task.type}
        </span>

        {/* Status badge */}
        <span
          style={{
            background: color + "22",
            border: `1px solid ${color}55`,
            borderRadius: 4,
            color,
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: "0.05em",
            padding: "2px 8px",
            textTransform: "uppercase",
          }}
        >
          {task.status}
        </span>

        {/* Priority */}
        <span
          style={{
            color: priorityColors[task.priority] ?? "#475569",
            fontSize: 11,
            fontWeight: 600,
          }}
        >
          {task.priority}
        </span>

        {/* ID + timestamp */}
        <span style={{ marginLeft: "auto", fontSize: 11, color: "#334155" }}>
          {task.id.slice(0, 8)}… ·{" "}
          {new Date(task.updated_at ?? task.created_at).toLocaleTimeString()}
        </span>
      </div>

      {/* Progress bar — shows when running with a progress value */}
      {isRunning && task.progress !== undefined && (
        <div
          style={{
            marginTop: 8,
            background: "#0d1117",
            borderRadius: 4,
            height: 3,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${task.progress}%`,
              height: "100%",
              background: "#2563eb",
              borderRadius: 4,
              transition: "width 0.4s ease",
            }}
          />
        </div>
      )}

      {/* Message / error */}
      {(task.message ?? task.error) && (
        <p
          style={{
            margin: "6px 0 0",
            fontSize: 12,
            color: task.error ? "#f87171" : "#64748b",
          }}
        >
          {task.error ?? task.message}
        </p>
      )}
    </div>
  );
}

// ── StatusDot — pulses on running ─────────────────────────────────────────────

function StatusDot({ color, pulse }: { color: string; pulse: boolean }) {
  const [bright, setBright] = useState(true);

  useEffect(() => {
    if (!pulse) return;
    const t = setInterval(() => setBright((b) => !b), 800);
    return () => clearInterval(t);
  }, [pulse]);

  return (
    <span
      style={{
        width: 10,
        height: 10,
        borderRadius: "50%",
        background: color,
        opacity: pulse ? (bright ? 1 : 0.3) : 1,
        transition: "opacity 0.4s",
        flexShrink: 0,
      }}
    />
  );
}

// ── LiveIndicator — SSE connection state badge ────────────────────────────────

function LiveIndicator({ status }: { status: string }) {
  const isLive = status === "connected";
  return (
    <span
      style={{
        display: "flex",
        alignItems: "center",
        gap: 5,
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: "0.06em",
        color: isLive ? "#16a34a" : "#475569",
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: isLive ? "#16a34a" : "#475569",
        }}
      />
      {isLive ? "LIVE" : status.toUpperCase()}
    </span>
  );
}
