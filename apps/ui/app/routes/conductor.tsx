/**
 * GhostStack — Multi-Agent Orchestration
 *
 * Local-first autonomous task execution:
 * submit a natural-language objective → PlanningEngine classifies it →
 * GovernanceEngine evaluates constraints → TaskExecutor routes to adapters →
 * results returned with plan trace.
 *
 * API:
 *   POST /api/v1/gs/submit       — submit objective
 *   GET  /api/v1/gs/jobs         — recent job log
 *   GET  /api/v1/gs/status       — queue depth + health
 *   GET  /api/v1/gs/dead-letter  — dead-letter queue
 *   DELETE /api/v1/gs/dead-letter — clear DLQ
 */
import { useState, useEffect, useCallback } from "react";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { Textarea } from "~/components/ui/textarea";
import {
  Bot,
  Play,
  RefreshCw,
  Loader2,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Activity,
  Trash2,
  Clock,
  Layers,
} from "lucide-react";

interface Job {
  id: string;
  objective: string;
  status: "running" | "done" | "failed" | "blocked";
  result?: { planId: string; allowed: boolean; reason?: string; processed: number };
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

interface QueueStatus {
  initialised: boolean;
  queueLength: number;
  activeJobs: unknown[];
  deadLetterCount: number;
  recentJobs?: Job[];
  error?: string;
}

const statusIcon = (s: Job["status"]) => {
  if (s === "done") return <CheckCircle className="w-4 h-4 text-green-500" />;
  if (s === "failed") return <XCircle className="w-4 h-4 text-red-500" />;
  if (s === "blocked") return <AlertTriangle className="w-4 h-4 text-yellow-500" />;
  return <Loader2 className="w-4 h-4 text-blue-500 animate-spin" />;
};

const statusColor = (s: Job["status"]) => {
  if (s === "done") return "bg-green-500/10 text-green-600";
  if (s === "failed") return "bg-red-500/10 text-red-600";
  if (s === "blocked") return "bg-yellow-500/10 text-yellow-600";
  return "bg-blue-500/10 text-blue-600";
};

export default function GhostStack() {
  const [objective, setObjective] = useState("");
  const [maxIterations, setMaxIterations] = useState(50);
  const [submitting, setSubmitting] = useState(false);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [status, setStatus] = useState<QueueStatus | null>(null);
  const [dlq, setDlq] = useState<unknown[]>([]);
  const [err, setErr] = useState("");
  const [lastResult, setLastResult] = useState<Job | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const [sR, jR] = await Promise.all([
        fetch("/api/v1/gs/status"),
        fetch("/api/v1/gs/jobs"),
      ]);
      if (sR.ok) setStatus(await sR.json());
      if (jR.ok) { const d = await jR.json(); setJobs(d.jobs ?? []); }
    } catch { /* ignore */ }
  }, []);

  const fetchDlq = useCallback(async () => {
    try {
      const r = await fetch("/api/v1/gs/dead-letter");
      if (r.ok) { const d = await r.json(); setDlq(d.jobs ?? []); }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { fetchStatus(); fetchDlq(); }, [fetchStatus, fetchDlq]);

  const handleSubmit = useCallback(async () => {
    if (!objective.trim()) return;
    setSubmitting(true);
    setErr("");
    setLastResult(null);
    try {
      const r = await fetch("/api/v1/gs/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ objective, maxIterations }),
      });
      const data = await r.json();
      if (!r.ok) { setErr(data.error ?? "Submission failed"); }
      else {
        setLastResult({ id: data.jobId, objective, status: data.allowed ? "done" : "blocked", result: data, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() });
        setObjective("");
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Network error");
    } finally {
      setSubmitting(false);
      fetchStatus();
    }
  }, [objective, maxIterations, fetchStatus]);

  const clearDlq = useCallback(async () => {
    await fetch("/api/v1/gs/dead-letter", { method: "DELETE" });
    setDlq([]);
    fetchStatus();
  }, [fetchStatus]);

  const EXAMPLES = [
    "Search for the latest AI research papers on reasoning and summarise findings",
    "Scrape the Hacker News front page and identify trending topics",
    "Research recent developments in TypeScript 5.x and create a summary",
    "Find information about vector databases and compare the top 3 options",
  ];

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Bot className="w-6 h-6 text-violet-500" />
            GhostStack
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Multi-agent orchestration — submit a natural-language objective and watch the runtime plan, govern, and execute
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={fetchStatus}>
          <RefreshCw className="w-4 h-4 mr-2" /> Refresh
        </Button>
      </div>

      {/* Status bar */}
      {status && (
        <div className="flex gap-3 flex-wrap">
          <Badge variant="outline" className={status.initialised ? "border-green-500 text-green-600" : "border-yellow-500 text-yellow-600"}>
            {status.initialised ? "Runtime active" : "Runtime idle"}
          </Badge>
          <Badge variant="outline">Queue: {status.queueLength}</Badge>
          <Badge variant="outline">Active: {(status.activeJobs ?? []).length}</Badge>
          {status.deadLetterCount > 0 && (
            <Badge variant="outline" className="border-red-500 text-red-600">DLQ: {status.deadLetterCount}</Badge>
          )}
          {status.error && <Badge variant="destructive">Init error</Badge>}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left — submit */}
        <div className="lg:col-span-2 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Play className="w-4 h-4" /> Submit Objective
              </CardTitle>
              <CardDescription>
                Natural-language task. PlanningEngine picks a blueprint, GovernanceEngine checks constraints, TaskExecutor runs it.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Textarea
                value={objective}
                onChange={e => setObjective(e.target.value)}
                placeholder="Search for recent papers on LLM reasoning and summarise the key findings…"
                rows={4}
                className="font-mono text-sm"
              />
              <div className="flex items-center gap-3">
                <label className="text-sm text-muted-foreground">Max iterations</label>
                <input
                  type="number"
                  value={maxIterations}
                  onChange={e => setMaxIterations(Number(e.target.value))}
                  min={1}
                  max={500}
                  className="w-20 border rounded px-2 py-1 text-sm"
                />
              </div>
              {err && <p className="text-sm text-red-500">{err}</p>}
              <Button onClick={handleSubmit} disabled={submitting || !objective.trim()} className="w-full">
                {submitting ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Running…</> : <><Play className="w-4 h-4 mr-2" /> Submit</>}
              </Button>
            </CardContent>
          </Card>

          {/* Examples */}
          <Card>
            <CardHeader><CardTitle className="text-sm">Quick Examples</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {EXAMPLES.map((ex, i) => (
                <button
                  key={i}
                  onClick={() => setObjective(ex)}
                  className="w-full text-left text-sm px-3 py-2 rounded border border-dashed hover:bg-muted/50 transition-colors"
                >
                  {ex}
                </button>
              ))}
            </CardContent>
          </Card>

          {/* Last result */}
          {lastResult && (
            <Card className={lastResult.status === "done" ? "border-green-500/40" : lastResult.status === "blocked" ? "border-yellow-500/40" : "border-red-500/40"}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm">
                  {statusIcon(lastResult.status)}
                  {lastResult.status === "done" ? "Completed" : lastResult.status === "blocked" ? "Blocked by governance" : "Failed"}
                </CardTitle>
              </CardHeader>
              <CardContent className="text-sm space-y-2">
                {lastResult.result && (
                  <>
                    <div className="flex gap-4">
                      <span className="text-muted-foreground">Plan ID</span>
                      <code className="font-mono text-xs">{lastResult.result.planId}</code>
                    </div>
                    <div className="flex gap-4">
                      <span className="text-muted-foreground">Processed</span>
                      <span>{lastResult.result.processed} tasks</span>
                    </div>
                    {lastResult.result.reason && (
                      <div className="flex gap-4">
                        <span className="text-muted-foreground">Reason</span>
                        <span className="text-yellow-600">{lastResult.result.reason}</span>
                      </div>
                    )}
                  </>
                )}
                {lastResult.error && <p className="text-red-500">{lastResult.error}</p>}
              </CardContent>
            </Card>
          )}
        </div>

        {/* Right — job log + DLQ */}
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm">
                <Layers className="w-4 h-4" /> Job Log
              </CardTitle>
            </CardHeader>
            <CardContent>
              {jobs.length === 0 ? (
                <p className="text-sm text-muted-foreground">No jobs yet</p>
              ) : (
                <div className="space-y-2 max-h-80 overflow-y-auto">
                  {jobs.map(j => (
                    <div key={j.id} className={`rounded px-3 py-2 text-xs ${statusColor(j.status)}`}>
                      <div className="flex items-center gap-1 mb-1">
                        {statusIcon(j.status)}
                        <span className="font-medium capitalize">{j.status}</span>
                        {j.result && <span className="ml-auto">{j.result.processed}t</span>}
                      </div>
                      <p className="text-muted-foreground truncate">{j.objective}</p>
                      <p className="opacity-60 flex items-center gap-1 mt-1">
                        <Clock className="w-3 h-3" />
                        {new Date(j.startedAt).toLocaleTimeString()}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* DLQ */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2">
                  <Activity className="w-4 h-4 text-red-500" />
                  Dead-Letter Queue
                </span>
                {dlq.length > 0 && (
                  <Button variant="ghost" size="sm" onClick={clearDlq}>
                    <Trash2 className="w-3 h-3" />
                  </Button>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {dlq.length === 0 ? (
                <p className="text-sm text-muted-foreground">Empty</p>
              ) : (
                <div className="space-y-1 max-h-40 overflow-y-auto">
                  {dlq.map((j, i) => (
                    <div key={i} className="text-xs bg-red-500/10 text-red-600 rounded px-2 py-1 font-mono truncate">
                      {JSON.stringify(j).slice(0, 80)}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
