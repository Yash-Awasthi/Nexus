// SPDX-License-Identifier: Apache-2.0
/**
 * TaskColumns — mission-control style task columns (Needs-input / Running / Done).
 * Adapted from mission-control ProjectView TaskColumn layout.
 */
import { useState, useEffect } from "react";
import {
  AlertCircle,
  Play,
  CheckCircle2,
  Archive,
  RotateCcw,
  Terminal,
  ArrowLeft,
} from "lucide-react";
import { Button } from "~/components/ui/button";

interface Task {
  id: string;
  projectId: string;
  title: string;
  agent: string;
  status: "running" | "needs-input" | "done";
  branch: string;
  preview: string;
  lines: number;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

interface TaskColumnsProps {
  projectId: string;
  projectName: string;
  onBack: () => void;
}

const AGENT_LABELS: Record<string, { label: string; glyph: string }> = {
  "claude-code": { label: "Claude Code", glyph: "C" },
  codex: { label: "Codex", glyph: "X" },
  "cursor-cli": { label: "Cursor CLI", glyph: "⟐" },
  shell: { label: "Shell", glyph: ">" },
};

export function TaskColumns({ projectId, projectName, onBack }: TaskColumnsProps) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [showArchive, setShowArchive] = useState(false);
  const [archivedTasks, setArchivedTasks] = useState<Task[]>([]);

  useEffect(() => {
    fetchTasks();
  }, [projectId]);

  async function fetchTasks() {
    const res = await fetch(`/api/v1/projects/${projectId}/tasks`);
    const data = await res.json();
    setTasks(data.tasks ?? []);
  }

  async function fetchArchive() {
    const res = await fetch("/api/v1/archive");
    const data = await res.json();
    setArchivedTasks((data.tasks ?? []).filter((t: Task) => t.projectId === projectId));
  }

  async function archiveTask(taskId: string) {
    await fetch(`/api/v1/tasks/${taskId}/archive`, { method: "POST" });
    fetchTasks();
  }

  async function restoreTask(taskId: string) {
    await fetch(`/api/v1/tasks/${taskId}/restore`, { method: "POST" });
    fetchTasks();
    fetchArchive();
  }

  const running = tasks.filter((t) => t.status === "running");
  const needsInput = tasks.filter((t) => t.status === "needs-input");
  const done = tasks.filter((t) => t.status === "done");

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="h-4 w-4 mr-1" /> Back
        </Button>
        <h2 className="text-lg font-semibold">{projectName}</h2>
        <Button
          variant="outline"
          size="sm"
          onClick={() => { setShowArchive(!showArchive); if (!showArchive) fetchArchive(); }}
        >
          <Archive className="h-4 w-4 mr-1" /> Archive
        </Button>
      </div>

      {/* Columns */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Needs Input */}
        <TaskColumn
          title="Needs Input"
          icon={<AlertCircle className="h-4 w-4 text-amber-400" />}
          tasks={needsInput}
          accentColor="border-amber-400/30"
        />

        {/* Running */}
        <TaskColumn
          title="Running"
          icon={<Play className="h-4 w-4 text-green-400" />}
          tasks={running}
          accentColor="border-green-400/30"
          shimmer
        />

        {/* Done */}
        <TaskColumn
          title="Done"
          icon={<CheckCircle2 className="h-4 w-4 text-muted-foreground" />}
          tasks={done}
          accentColor="border-muted"
          onArchive={archiveTask}
        />
      </div>

      {/* Archive view */}
      {showArchive && (
        <div className="border rounded-lg p-4 mt-4">
          <h3 className="text-sm font-medium mb-3 flex items-center gap-2">
            <Archive className="h-4 w-4" /> Archived Tasks
          </h3>
          {archivedTasks.length === 0 ? (
            <p className="text-sm text-muted-foreground">No archived tasks</p>
          ) : (
            <div className="space-y-2">
              {archivedTasks.map((t) => (
                <div key={t.id} className="flex items-center justify-between p-2 rounded bg-muted/30">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground font-mono">
                      {AGENT_LABELS[t.agent]?.glyph ?? "?"}
                    </span>
                    <span className="text-sm">{t.title}</span>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => restoreTask(t.id)}>
                    <RotateCcw className="h-3 w-3 mr-1" /> Restore
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── TaskColumn sub-component ────────────────────────────────────────────────

function TaskColumn({
  title,
  icon,
  tasks,
  accentColor,
  shimmer,
  onArchive,
}: {
  title: string;
  icon: React.ReactNode;
  tasks: Task[];
  accentColor: string;
  shimmer?: boolean;
  onArchive?: (taskId: string) => void;
}) {
  return (
    <div className={`border rounded-lg ${accentColor} p-3`}>
      <div className="flex items-center gap-2 mb-3">
        {icon}
        <h3 className="text-sm font-medium">{title}</h3>
        <span className="text-xs text-muted-foreground ml-auto">{tasks.length}</span>
      </div>

      {tasks.length === 0 ? (
        <p className="text-xs text-muted-foreground text-center py-6">No tasks</p>
      ) : (
        <div className="space-y-2">
          {tasks.map((t) => (
            <div
              key={t.id}
              className={`p-3 rounded-md border bg-card hover:border-primary/30 transition-colors ${
                shimmer ? "border-l-2 border-l-green-400" : ""
              }`}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-medium">{t.title}</span>
                {shimmer && (
                  <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                )}
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="font-mono">
                  {AGENT_LABELS[t.agent]?.glyph ?? "?"}
                </span>
                <span>{AGENT_LABELS[t.agent]?.label ?? t.agent}</span>
                {t.branch && <span>· {t.branch}</span>}
                {t.lines > 0 && <span>· +{t.lines} lines</span>}
              </div>
              {t.preview && (
                <p className="text-xs text-muted-foreground mt-1 truncate">{t.preview}</p>
              )}
              <div className="flex items-center gap-2 mt-2">
                <Button variant="ghost" size="sm" className="h-6 text-xs">
                  <Terminal className="h-3 w-3 mr-1" /> Open
                </Button>
                {t.status === "done" && onArchive && (
                  <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => onArchive(t.id)}>
                    <Archive className="h-3 w-3 mr-1" /> Archive
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
