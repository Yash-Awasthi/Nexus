// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "~/components/ui/sheet";
import {
  StatusPill,
  duration,
  orgApi,
  timeAgo,
  usd,
  type Agent,
  type Replay,
  type Run,
  type RunSummary,
  useCan,
} from "~/lib/org";

const LIVE = new Set(["queued", "running"]);

/** One run in full: its log, every model call it made, and what it produced. */
function RunSheet({
  runId,
  agents,
  onClose,
}: {
  runId: string | null;
  agents: Agent[];
  onClose: () => void;
}) {
  const manage = useCan("manage");
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!runId) return;
    orgApi<Run>(`/runs/${runId}`)
      .then((r) => {
        setRun(r);
        return undefined;
      })
      .catch((e: Error) => setError(e.message));
  }, [runId]);

  useEffect(() => {
    setRun(null);
    load();
  }, [load]);

  // Follow a live run until it settles.
  useEffect(() => {
    if (!run || !LIVE.has(run.status)) return;
    const t = setInterval(load, 1500);
    return () => clearInterval(t);
  }, [run, load]);

  const agent = agents.find((a) => a.id === run?.agentId);
  return (
    <Sheet open={runId !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto p-4 sm:max-w-xl" aria-describedby={undefined}>
        {!run ? (
          <p className="text-sm text-muted-foreground">{error ?? "Loading…"}</p>
        ) : (
          <div className="space-y-4 text-sm">
            <SheetHeader className="p-0 pr-8">
              <SheetTitle className="text-base">
                {agent?.name ?? "Agent"} · {run.source} run
              </SheetTitle>
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill status={run.status} />
                <span className="font-mono text-xs text-muted-foreground">
                  {run.inputTokens + run.outputTokens} tok · {usd(run.costUsd)} ·{" "}
                  {duration(run.startedAt, run.finishedAt)}
                </span>
              </div>
              {run.coalescedCount > 0 && (
                <p className="text-xs text-muted-foreground">
                  {run.coalescedCount} later wakes folded into this run
                </p>
              )}
            </SheetHeader>
            {manage && LIVE.has(run.status) && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void orgApi(`/runs/${run.id}/cancel`, { method: "POST" }).then(load)}
              >
                Cancel run
              </Button>
            )}
            {run.error && (
              <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-destructive">
                {run.error}
              </p>
            )}
            {run.outcome && (
              <div className="rounded-lg border bg-muted/30 p-3">
                <p className="text-xs font-semibold uppercase text-muted-foreground">Outcome</p>
                <p>
                  {run.outcome.status ?? "no status"}
                  {run.outcome.summary ? ` — ${run.outcome.summary}` : ""}
                </p>
                {run.outcome.subtasks.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {run.outcome.subtasks.length} tasks created or assigned
                  </p>
                )}
              </div>
            )}
            {manage && run.replayable && !LIVE.has(run.status) && <ReplayBox runId={run.id} />}
            {run.steps.length > 0 && (
              <div>
                <p className="text-xs font-semibold uppercase text-muted-foreground">Model calls</p>
                <ul
                  className="mt-1 divide-y rounded-lg border font-mono text-xs"
                  aria-label="Model calls"
                >
                  {run.steps.map((s, i) => (
                    <li key={i} className="flex flex-wrap justify-between gap-2 p-2">
                      <span>
                        {s.provider}/{s.model}
                        {s.cached ? " (cached)" : ""}
                      </span>
                      <span className={s.error ? "text-destructive" : "text-muted-foreground"}>
                        {s.error
                          ? s.error.slice(0, 80)
                          : `${s.inputTokens}→${s.outputTokens} tok · ${s.latencyMs}ms`}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div>
              <p className="text-xs font-semibold uppercase text-muted-foreground">Log</p>
              <ol
                className="mt-1 max-h-96 space-y-1 overflow-y-auto rounded-lg border bg-muted/20 p-2 font-mono text-xs"
                aria-label="Run log"
              >
                {run.log.map((l, i) => (
                  <li
                    key={i}
                    className={
                      l.stream === "stderr"
                        ? "text-destructive"
                        : l.stream === "system"
                          ? "text-muted-foreground"
                          : ""
                    }
                  >
                    <span className="whitespace-pre-wrap break-words">{l.text}</span>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

const DIFF_TONE = {
  " ": "text-muted-foreground",
  "-": "text-destructive",
  "+": "text-success",
};

/** Send the run's exact prompt to another model and show where the answers differ. */
function ReplayBox({ runId }: { runId: string }) {
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Replay | null>(null);
  const [error, setError] = useState<string | null>(null);

  const replay = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await orgApi<Replay>(`/runs/${runId}/replay`, { method: "POST", json: { model } }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 rounded-lg border p-3">
      <p className="text-xs font-semibold uppercase text-muted-foreground">Replay</p>
      <div className="flex gap-2">
        <Input
          aria-label="Model to replay on"
          placeholder="provider/model, e.g. mistral/mistral-small-latest"
          value={model}
          onChange={(e) => setModel(e.target.value)}
        />
        <Button size="sm" disabled={!model.trim() || busy} onClick={() => void replay()}>
          {busy ? "Asking…" : "Replay"}
        </Button>
      </div>
      {error && <p className="text-destructive">{error}</p>}
      {result && (
        <>
          <p className="font-mono text-xs text-muted-foreground">
            {result.original.model ?? "original"} vs {result.replay.model} ·{" "}
            {usd(result.replay.costUsd)}
          </p>
          <ol
            className="max-h-96 overflow-y-auto rounded-lg border bg-muted/20 p-2 font-mono text-xs"
            aria-label="Answer diff"
          >
            {result.diff.map((d, i) => (
              <li key={i} className={`whitespace-pre-wrap break-words ${DIFF_TONE[d.op]}`}>
                {d.op} {d.line}
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

/** Recent runs across the company, newest first; refreshes while any is live. */
export function RunList({
  companyId,
  agents,
  refreshKey,
  taskId,
  agentId,
  compact = false,
}: {
  companyId: string;
  agents: Agent[];
  refreshKey: number;
  taskId?: string;
  agentId?: string;
  compact?: boolean;
}) {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const names = useMemo(() => new Map(agents.map((a) => [a.id, a.name])), [agents]);

  const load = useCallback(() => {
    orgApi<{ runs: RunSummary[] }>(
      `/companies/${companyId}/runs?limit=50${taskId ? `&task=${taskId}` : ""}${agentId ? `&agent=${agentId}` : ""}`,
    )
      .then((b) => {
        setRuns(b.runs);
        return undefined;
      })
      .catch(() => undefined);
  }, [companyId, taskId, agentId]);

  useEffect(load, [load, refreshKey]);
  useEffect(() => {
    if (!runs.some((r) => LIVE.has(r.status))) return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [runs, load]);

  if (runs.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        {compact ? "No runs yet." : "No runs yet. Wake an agent from the org chart or a task."}
      </p>
    );
  return (
    <>
      <ul className="divide-y rounded-lg border" aria-label="Runs">
        {runs.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              className="flex w-full items-center gap-3 p-3 text-left text-sm hover:bg-muted/40"
              onClick={() => setOpen(r.id)}
              data-testid="run-row"
            >
              <StatusPill status={r.status} />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">
                  {names.get(r.agentId) ?? "agent"}{" "}
                  <span className="font-normal text-muted-foreground">· {r.source}</span>
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {r.outcome?.summary || r.error || r.reason}
                </p>
              </div>
              <div className="shrink-0 text-right font-mono text-[11px] text-muted-foreground">
                <p>{usd(r.costUsd)}</p>
                <p>{timeAgo(r.queuedAt)}</p>
              </div>
            </button>
          </li>
        ))}
      </ul>
      <RunSheet runId={open} agents={agents} onClose={() => setOpen(null)} />
    </>
  );
}

interface TaskReplay {
  rows: {
    runId: string;
    originalModel: string | null;
    originalCostUsd: number;
    originalStatus: string | null;
    replayModel: string;
    replayCostUsd: number;
    replayStatus: string | null;
    changedLines: number;
  }[];
  stopped: string | null;
  totals: { originalCostUsd: number; replayCostUsd: number };
}

/** Re-run every run of a task on another model and compare what each cost and reported. */
export function TaskReplayBox({ taskId }: { taskId: string }) {
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TaskReplay | null>(null);
  const [error, setError] = useState<string | null>(null);

  const replay = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(
        await orgApi<TaskReplay>(`/tasks/${taskId}/replay`, { method: "POST", json: { model } }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 rounded-lg border p-3" data-testid="task-replay">
      <p className="text-xs font-semibold uppercase text-muted-foreground">Replay the whole task</p>
      <div className="flex gap-2">
        <Input
          aria-label="Model to replay the task on"
          placeholder="provider/model"
          value={model}
          onChange={(e) => setModel(e.target.value)}
        />
        <Button size="sm" disabled={!model.trim() || busy} onClick={() => void replay()}>
          {busy ? "Replaying…" : "Replay all runs"}
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {result && (
        <div className="space-y-1 text-xs">
          <table className="w-full" aria-label="Task replay">
            <thead className="text-muted-foreground">
              <tr>
                <th className="text-left font-normal">Run</th>
                <th className="text-left font-normal">Original</th>
                <th className="text-left font-normal">Replay</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((r, i) => (
                <tr key={r.runId}>
                  <td>#{i + 1}</td>
                  <td>
                    {r.originalStatus ?? "no status"} · {usd(r.originalCostUsd)}
                  </td>
                  <td>
                    {r.replayStatus ?? "no status"} · {usd(r.replayCostUsd)}
                    {r.replayStatus !== r.originalStatus && " (differs)"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            Total {usd(result.totals.originalCostUsd)} originally,{" "}
            {usd(result.totals.replayCostUsd)} on the replay.
          </p>
          {result.stopped && <p className="text-warning">Stopped early: {result.stopped}</p>}
        </div>
      )}
    </div>
  );
}
