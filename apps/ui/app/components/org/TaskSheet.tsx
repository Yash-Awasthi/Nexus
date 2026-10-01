// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useState } from "react";

import { selectClass } from "~/components/org/AgentDialog";
import { Button } from "~/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "~/components/ui/sheet";
import { Textarea } from "~/components/ui/textarea";
import { Markdown } from "~/lib/markdown";
import { StatusPill, orgApi, timeAgo, useCan, type Agent, type TaskDetail } from "~/lib/org";

const VERB: Record<string, string> = {
  todo: "Move to to-do",
  backlog: "Back to backlog",
  in_progress: "Start",
  in_review: "Send to review",
  blocked: "Mark blocked",
  done: "Mark done",
  cancelled: "Cancel",
};

/** Everything about one task: why it exists, who holds it, and the thread. */
export function TaskSheet({
  taskId,
  agents,
  onClose,
  onChanged,
  onOpenTask,
  children,
}: {
  taskId: string | null;
  agents: Agent[];
  onClose: () => void;
  onChanged: () => void;
  onOpenTask: (id: string) => void;
  children?: (detail: TaskDetail, reload: () => void) => React.ReactNode;
}) {
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [discussing, setDiscussing] = useState(false);
  const manage = useCan("manage");
  const canAssign = useCan("assign");
  const canComment = useCan("comment");

  const load = useCallback(() => {
    if (!taskId) return;
    orgApi<TaskDetail>(`/tasks/${taskId}`)
      .then((d) => {
        setDetail(d);
        return undefined;
      })
      .catch((e: Error) => setError(e.message));
  }, [taskId]);

  useEffect(() => {
    setDetail(null);
    setError(null);
    load();
  }, [load]);

  // A discussion ends with its own system comment; stop following the thread then.
  const last = detail?.comments.at(-1);
  const discussionOver =
    last?.author.id === "discussion" && /^Discussion (settled|ended|stopped)/.test(last.body);
  useEffect(() => {
    if (discussing && discussionOver) setDiscussing(false);
  }, [discussing, discussionOver]);

  // While a run or a discussion holds the task, follow it so status and thread update live.
  const held = detail?.task.checkoutRunId ?? (discussing ? "discussion" : null);
  useEffect(() => {
    if (!held) return;
    const timer = setInterval(() => {
      load();
      onChanged();
    }, 2000);
    return () => clearInterval(timer);
  }, [held, load, onChanged]);

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      load();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const t = detail?.task;
  const names = new Map(agents.map((a) => [a.id, a.name]));
  const who = (actor: { type: string; id: string }) =>
    actor.type === "agent"
      ? (names.get(actor.id) ?? "agent")
      : actor.type === "user"
        ? "Board"
        : actor.type === "member"
          ? "Workspace member"
          : "System";

  return (
    <Sheet open={taskId !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto p-4 sm:max-w-lg" aria-describedby={undefined}>
        {!t ? (
          <p className="text-sm text-muted-foreground">{error ?? "Loading…"}</p>
        ) : (
          <div className="space-y-4 text-sm">
            <SheetHeader className="p-0 pr-8">
              <p className="font-mono text-xs text-muted-foreground">{t.identifier}</p>
              <SheetTitle className="text-base">{t.title}</SheetTitle>
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill status={t.status} />
                <span className="text-xs text-muted-foreground">
                  {t.priority} · {t.workMode === "standard" ? "do the work" : `${t.workMode} only`}
                </span>
                {t.checkoutRunId && (
                  <span className="text-xs text-primary">
                    held by run {t.checkoutRunId.slice(0, 8)}
                  </span>
                )}
              </div>
            </SheetHeader>

            {t.description && <p className="whitespace-pre-wrap">{t.description}</p>}

            {(detail.why.tasks.length > 0 || detail.why.goals.length > 0) && (
              <div className="rounded-lg border bg-muted/30 p-3" aria-label="Why this task exists">
                <p className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Why</p>
                <ul className="space-y-0.5 text-xs">
                  {detail.why.tasks.map((p) => (
                    <li key={p.id}>
                      because of{" "}
                      <button type="button" className="underline" onClick={() => onOpenTask(p.id)}>
                        {p.identifier} {p.title}
                      </button>
                    </li>
                  ))}
                  {detail.why.goals.map((g) => (
                    <li key={g.id}>
                      serving the {g.level} goal <span className="font-medium">{g.title}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <label className="grid gap-1 text-xs">
                Assignee
                <select
                  aria-label="Assignee"
                  disabled={!canAssign}
                  className={selectClass}
                  value={t.assigneeAgentId ?? ""}
                  onChange={(e) =>
                    run(() =>
                      orgApi(`/tasks/${t.id}`, {
                        method: "PATCH",
                        json: { assigneeAgentId: e.target.value || null },
                      }),
                    )
                  }
                >
                  <option value="">Unassigned</option>
                  {agents
                    .filter((a) => a.status !== "terminated")
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                </select>
              </label>
              <label className="grid gap-1 text-xs">
                Priority
                <select
                  aria-label="Priority"
                  disabled={!manage}
                  className={selectClass}
                  value={t.priority}
                  onChange={(e) =>
                    run(() =>
                      orgApi(`/tasks/${t.id}`, {
                        method: "PATCH",
                        json: { priority: e.target.value },
                      }),
                    )
                  }
                >
                  {["critical", "high", "medium", "low"].map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </select>
              </label>
            </div>

            {manage && detail.transitions.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {detail.transitions.map((s) => (
                  <Button
                    key={s}
                    size="sm"
                    variant={s === "done" ? "default" : "outline"}
                    onClick={() =>
                      run(() =>
                        orgApi(`/tasks/${t.id}/status`, { method: "POST", json: { status: s } }),
                      )
                    }
                  >
                    {VERB[s] ?? s}
                  </Button>
                ))}
                {t.checkoutRunId && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => run(() => orgApi(`/tasks/${t.id}/release`, { method: "POST" }))}
                  >
                    Release hold
                  </Button>
                )}
              </div>
            )}

            {detail.openBlockers.length > 0 && (
              <div>
                <p className="text-xs font-semibold uppercase text-muted-foreground">Waiting on</p>
                <ul className="mt-1 space-y-1">
                  {detail.openBlockers.map((b) => (
                    <li key={b.id}>
                      <button type="button" className="underline" onClick={() => onOpenTask(b.id)}>
                        {b.identifier} {b.title}
                      </button>{" "}
                      <StatusPill status={b.status} />
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {detail.subtasks.length > 0 && (
              <div>
                <p className="text-xs font-semibold uppercase text-muted-foreground">
                  Subtasks {detail.subtasks.filter((s) => s.status === "done").length}/
                  {detail.subtasks.length}
                </p>
                <ul className="mt-1 space-y-1">
                  {detail.subtasks.map((s) => (
                    <li key={s.id} className="flex items-center gap-2">
                      <StatusPill status={s.status} />
                      <button
                        type="button"
                        className="truncate underline"
                        onClick={() => onOpenTask(s.id)}
                      >
                        {s.identifier} {s.title}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {children?.(detail, load)}

            {manage && (
              <DiscussBox
                agents={agents.filter(
                  (a) => a.status !== "terminated" && a.adapterType === "nexus",
                )}
                busy={discussing}
                onStart={(agentIds, opts) =>
                  run(async () => {
                    await orgApi(`/tasks/${t.id}/discuss`, {
                      method: "POST",
                      json: { agentIds, rounds: 3, ...opts },
                    });
                    setDiscussing(true);
                  })
                }
              />
            )}

            <div>
              <p className="text-xs font-semibold uppercase text-muted-foreground">Thread</p>
              <ol className="mt-2 space-y-2" aria-label="Comments">
                {detail.comments.map((c) => (
                  <li key={c.id} className="rounded-lg border p-2">
                    <p className="text-[11px] text-muted-foreground">
                      {who(c.author)} · {timeAgo(c.createdAt)}
                    </p>
                    <Markdown text={c.body} />
                  </li>
                ))}
              </ol>
              {canComment && (
                <div className="mt-2 flex gap-2">
                  <Textarea
                    aria-label="New comment"
                    rows={2}
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    placeholder="Add a note, answer the agent, or @name another agent to pull them in…"
                  />
                  <Button
                    size="sm"
                    disabled={!comment.trim()}
                    onClick={() =>
                      run(async () => {
                        await orgApi(`/tasks/${t.id}/comments`, {
                          method: "POST",
                          json: { body: comment },
                        });
                        setComment("");
                      })
                    }
                  >
                    Post
                  </Button>
                </div>
              )}
            </div>

            {error && (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

/** Pick two to five agents to talk the task through in its thread until they agree. */
function DiscussBox({
  agents,
  busy,
  onStart,
}: {
  agents: Agent[];
  busy: boolean;
  onStart: (agentIds: string[], opts: { inOrder: boolean; fileOutcome: boolean }) => void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const [inOrder, setInOrder] = useState(false);
  const [fileOutcome, setFileOutcome] = useState(true);
  if (agents.length < 2) return null;
  const toggle = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  return (
    <fieldset className="rounded-lg border p-3">
      <legend className="px-1 text-xs font-semibold uppercase text-muted-foreground">
        Discuss
      </legend>
      <div className="flex flex-wrap gap-3">
        {agents.map((a) => (
          <label key={a.id} className="flex items-center gap-1 text-sm">
            <input type="checkbox" checked={picked.includes(a.id)} onChange={() => toggle(a.id)} />
            {a.name}
          </label>
        ))}
      </div>
      <label className="mt-2 flex items-center gap-1 text-sm">
        <input type="checkbox" checked={inOrder} onChange={(e) => setInOrder(e.target.checked)} />
        Take turns in order, each seeing the turns before it
      </label>
      <label className="mt-1 flex items-center gap-1 text-sm">
        <input
          type="checkbox"
          checked={fileOutcome}
          onChange={(e) => setFileOutcome(e.target.checked)}
        />
        File an agreed decision as a task for the most senior agent
      </label>
      <Button
        size="sm"
        className="mt-2"
        disabled={busy || picked.length < 2 || picked.length > 5}
        onClick={() => onStart(picked, { inOrder, fileOutcome })}
      >
        {busy ? "Discussing…" : "Start discussion"}
      </Button>
    </fieldset>
  );
}
