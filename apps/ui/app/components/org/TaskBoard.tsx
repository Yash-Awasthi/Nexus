// SPDX-License-Identifier: Apache-2.0
import { Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { selectClass } from "~/components/org/AgentDialog";
import { RunList, TaskReplayBox } from "~/components/org/RunList";
import { TaskSheet } from "~/components/org/TaskSheet";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import {
  BOARD_COLUMNS,
  PRIORITY_TONE,
  orgApi,
  useVisibleInterval,
  type Agent,
  type Goal,
  type Task,
  useCan,
} from "~/lib/org";

function NewTaskDialog({
  open,
  onOpenChange,
  companyId,
  agents,
  goals,
  tasks,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  companyId: string;
  agents: Agent[];
  goals: Goal[];
  tasks: Task[];
  onCreated: (t: Task) => void;
}) {
  const blank = {
    title: "",
    description: "",
    priority: "medium",
    assigneeAgentId: "",
    goalId: "",
    parentId: "",
    status: "todo",
    workMode: "standard",
  };
  const [draft, setDraft] = useState(blank);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<typeof blank>) => setDraft((d) => ({ ...d, ...patch }));
  useEffect(() => {
    if (open) {
      setDraft(blank);
      setError(null);
    }
  }, [open]);
  async function create() {
    try {
      const t = await orgApi<Task>(`/companies/${companyId}/tasks`, {
        method: "POST",
        json: {
          ...draft,
          assigneeAgentId: draft.assigneeAgentId || null,
          goalId: draft.goalId || null,
          parentId: draft.parentId || null,
        },
      });
      onCreated(t);
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  const live = agents.filter((a) => a.status !== "terminated");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New task</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="task-title">Title</Label>
            <Input
              id="task-title"
              value={draft.title}
              onChange={(e) => set({ title: e.target.value })}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="task-description">Description</Label>
            <Textarea
              id="task-description"
              rows={3}
              value={draft.description}
              onChange={(e) => set({ description: e.target.value })}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="task-assignee">Assignee</Label>
              <select
                id="task-assignee"
                className={selectClass}
                value={draft.assigneeAgentId}
                onChange={(e) => set({ assigneeAgentId: e.target.value })}
              >
                <option value="">Unassigned</option>
                {live.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="task-priority">Priority</Label>
              <select
                id="task-priority"
                className={selectClass}
                value={draft.priority}
                onChange={(e) => set({ priority: e.target.value })}
              >
                {["critical", "high", "medium", "low"].map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="task-goal">Goal</Label>
              <select
                id="task-goal"
                className={selectClass}
                value={draft.goalId}
                onChange={(e) => set({ goalId: e.target.value })}
              >
                <option value="">None</option>
                {goals.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.title}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="task-parent">Parent task</Label>
              <select
                id="task-parent"
                className={selectClass}
                value={draft.parentId}
                onChange={(e) => set({ parentId: e.target.value })}
              >
                <option value="">None</option>
                {tasks
                  .filter((t) => t.status !== "done" && t.status !== "cancelled")
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.identifier} {t.title}
                    </option>
                  ))}
              </select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="task-status">Start in</Label>
              <select
                id="task-status"
                className={selectClass}
                value={draft.status}
                onChange={(e) => set({ status: e.target.value })}
              >
                <option value="todo">To do</option>
                <option value="backlog">Backlog</option>
              </select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="task-mode">Mode</Label>
              <select
                id="task-mode"
                className={selectClass}
                value={draft.workMode}
                onChange={(e) => set({ workMode: e.target.value })}
              >
                <option value="standard">Do the work</option>
                <option value="planning">Plan only</option>
                <option value="ask">Answer only</option>
              </select>
            </div>
          </div>
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={create} disabled={!draft.title.trim()}>
            Create task
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Columns by status. Scrolls sideways with snap on a phone, fits on a desktop. */
export function TaskBoard({
  companyId,
  agents,
  refreshKey,
  onChanged,
}: {
  companyId: string;
  agents: Agent[];
  refreshKey: number;
  onChanged: () => void;
}) {
  const manage = useCan("manage");
  const fileTask = useCan("fileTask");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [assignee, setAssignee] = useState("");

  const load = useCallback(() => {
    void Promise.all([
      orgApi<{ tasks: Task[] }>(`/companies/${companyId}/tasks`),
      orgApi<{ goals: Goal[] }>(`/companies/${companyId}/goals`),
    ])
      .then(([t, g]) => {
        setTasks(t.tasks);
        setGoals(g.goals);
        return undefined;
      })
      .catch(() => undefined);
  }, [companyId]);

  useEffect(load, [load, refreshKey]);
  useVisibleInterval(load, 5000);

  const names = useMemo(() => new Map(agents.map((a) => [a.id, a.name])), [agents]);
  const shown = assignee ? tasks.filter((t) => t.assigneeAgentId === assignee) : tasks;

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Filter by assignee"
          className={`${selectClass} w-auto`}
          value={assignee}
          onChange={(e) => setAssignee(e.target.value)}
        >
          <option value="">Everyone</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <span className="text-sm text-muted-foreground">
          {shown.length} {shown.length === 1 ? "task" : "tasks"}
        </span>
        {fileTask && (
          <Button size="sm" className="ml-auto" onClick={() => setCreating(true)}>
            <Plus className="size-4" /> New task
          </Button>
        )}
      </div>
      <div className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-2 sm:mx-0 sm:px-0">
        {BOARD_COLUMNS.map((col) => {
          const items = shown.filter((t) => t.status === col.status);
          return (
            <div
              key={col.status}
              className="w-[80vw] shrink-0 snap-start rounded-xl bg-muted/40 p-2 sm:w-64"
              data-testid={`column-${col.status}`}
            >
              <h3 className="flex items-center justify-between px-1 pb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {col.label}
                <span className="font-mono">{items.length}</span>
              </h3>
              <ul className="space-y-2">
                {items.map((t) => (
                  <li key={t.id}>
                    <button
                      type="button"
                      onClick={() => setOpenId(t.id)}
                      className="w-full rounded-lg border bg-card p-2.5 text-left text-sm shadow-xs hover:border-primary/40"
                      data-testid="task-card"
                    >
                      <div className="flex items-center gap-2 text-[11px]">
                        <span className="font-mono text-muted-foreground">{t.identifier}</span>
                        <span className={`font-medium ${PRIORITY_TONE[t.priority]}`}>
                          {t.priority}
                        </span>
                        {t.checkoutRunId && <span className="text-primary">● running</span>}
                      </div>
                      <p className="mt-1 line-clamp-2 font-medium">{t.title}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {t.assigneeAgentId
                          ? (names.get(t.assigneeAgentId) ?? "unknown")
                          : "unassigned"}
                      </p>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
      <NewTaskDialog
        open={creating}
        onOpenChange={setCreating}
        companyId={companyId}
        agents={agents}
        goals={goals}
        tasks={tasks}
        onCreated={() => {
          load();
          onChanged();
        }}
      />
      <TaskSheet
        taskId={openId}
        agents={agents}
        onClose={() => setOpenId(null)}
        onChanged={() => {
          load();
          onChanged();
        }}
        onOpenTask={setOpenId}
      >
        {(detail, reload) => (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold uppercase text-muted-foreground">Runs</p>
              {manage &&
                detail.task.assigneeAgentId &&
                !detail.task.checkoutRunId &&
                !["done", "cancelled"].includes(detail.task.status) && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      void orgApi(`/agents/${detail.task.assigneeAgentId}/wake`, {
                        method: "POST",
                        json: { taskId: detail.task.id, reason: "Run this task" },
                      })
                        .then(() => {
                          setTimeout(reload, 400);
                          return undefined;
                        })
                        .catch(() => undefined)
                    }
                  >
                    Run this task
                  </Button>
                )}
            </div>
            <RunList
              key={`${detail.task.updatedAt}:${detail.task.checkoutRunId ?? ""}`}
              companyId={companyId}
              agents={agents}
              refreshKey={refreshKey}
              taskId={detail.task.id}
              compact
            />
            {manage && <TaskReplayBox taskId={detail.task.id} />}
          </div>
        )}
      </TaskSheet>
    </section>
  );
}
