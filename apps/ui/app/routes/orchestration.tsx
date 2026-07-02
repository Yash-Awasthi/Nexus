// SPDX-License-Identifier: Apache-2.0
/**
 * Orchestration — compare the candidate diffs from a multi-agent run and pick a
 * winner (§6.2). Reads persisted runs from the orchestration_runs table; merging
 * the winner into the base branch stays opt-in and is driven by the worker (§6.3),
 * so selecting here only records the choice.
 *
 * API:
 *   GET  /api/v1/orchestration/runs
 *   GET  /api/v1/orchestration/runs/:id
 *   POST /api/v1/orchestration/runs/:id/winner
 */
import { GitBranch, Loader2, RefreshCw, Trophy, CheckCircle2, XCircle } from "lucide-react";
import { useState, useEffect, useCallback } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { authFetch } from "~/lib/api";

// ─── Types ────────────────────────────────────────────────────────────────────

interface RunSummary {
  id: string;
  status: string;
  task: string;
  winner: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Candidate {
  spec?: { id?: string; model?: string };
  summary?: string;
  diff?: string;
  ok?: boolean;
  error?: string;
}

interface RunDetail {
  id: string;
  status: string;
  task: string;
  winner: string | null;
  error: string | null;
  candidates: Candidate[];
  scores: Record<string, number> | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const statusColor = (s: string): string =>
  s === "completed"
    ? "bg-emerald-500/15 text-emerald-600"
    : s === "failed"
      ? "bg-red-500/15 text-red-600"
      : "bg-blue-500/15 text-blue-600";

// ─── Component ────────────────────────────────────────────────────────────────

export default function Orchestration() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const loadRuns = useCallback(async () => {
    setLoading(true);
    setErr("");
    try {
      const r = await authFetch("/api/v1/orchestration/runs");
      const data = r.ok ? ((await r.json()) as { runs: RunSummary[] }) : null;
      setRuns(data?.runs ?? []);
    } catch {
      setErr("Could not load orchestration runs");
    }
    setLoading(false);
  }, []);

  const openRun = useCallback(async (id: string) => {
    setSelectedId(id);
    setDetail(null);
    try {
      const r = await authFetch(`/api/v1/orchestration/runs/${encodeURIComponent(id)}`);
      const data = r.ok ? ((await r.json()) as { run: RunDetail }) : null;
      setDetail(data?.run ?? null);
    } catch {
      setErr("Could not load run detail");
    }
  }, []);

  const chooseWinner = useCallback(
    async (id: string, winnerId: string) => {
      setBusy(true);
      setErr("");
      try {
        const r = await authFetch(`/api/v1/orchestration/runs/${encodeURIComponent(id)}/winner`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ winnerId }),
        });
        if (!r.ok) {
          const e = (await r.json().catch(() => ({}))) as { error?: string };
          setErr(e.error ?? "Could not set winner");
        } else {
          setDetail((d) => (d ? { ...d, winner: winnerId } : d));
          setRuns((rs) => rs.map((run) => (run.id === id ? { ...run, winner: winnerId } : run)));
        }
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  useEffect(() => {
    loadRuns();
  }, [loadRuns]);

  const viable = (detail?.candidates ?? []).filter((c) => c.ok && (c.diff ?? "").trim().length > 0);

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <GitBranch className="w-6 h-6 text-violet-500" />
            Orchestration
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Compare candidate diffs from multi-agent runs and pick a winner. Merge stays opt-in.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={loadRuns}>
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {err && <p className="text-red-500 text-sm">{err}</p>}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Run list */}
        <Card className="md:col-span-1">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Recent runs</CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex items-center gap-2 text-muted-foreground py-8 justify-center">
                <Loader2 className="w-5 h-5 animate-spin" />
                Loading…
              </div>
            ) : runs.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">No runs yet</p>
            ) : (
              <div className="space-y-1">
                {runs.map((run) => (
                  <button
                    key={run.id}
                    onClick={() => openRun(run.id)}
                    className={`w-full text-left rounded-md px-3 py-2 text-sm hover:bg-muted transition-colors ${
                      selectedId === run.id ? "bg-muted" : ""
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs truncate">{run.id}</span>
                      <Badge className={statusColor(run.status)}>{run.status}</Badge>
                    </div>
                    <p className="text-muted-foreground truncate mt-1">{run.task}</p>
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Candidate compare */}
        <Card className="md:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">
              {detail ? "Candidates" : "Select a run to compare candidates"}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {selectedId && !detail ? (
              <div className="flex items-center gap-2 text-muted-foreground py-8 justify-center">
                <Loader2 className="w-5 h-5 animate-spin" />
                Loading run…
              </div>
            ) : !detail ? (
              <p className="text-sm text-muted-foreground py-8 text-center">
                Nothing selected.
              </p>
            ) : viable.length === 0 ? (
              <p className="text-sm text-muted-foreground py-8 text-center">
                This run produced no viable candidate diffs.
                {detail.error ? ` (${detail.error})` : ""}
              </p>
            ) : (
              <div className="space-y-4">
                {viable.map((c) => {
                  const id = c.spec?.id ?? "?";
                  const isWinner = detail.winner === id;
                  const score = detail.scores?.[id];
                  return (
                    <div
                      key={id}
                      className={`rounded-lg border p-3 ${
                        isWinner ? "border-emerald-400 dark:border-emerald-600" : ""
                      }`}
                    >
                      <div className="flex items-center gap-2 mb-2">
                        {c.ok ? (
                          <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                        ) : (
                          <XCircle className="w-4 h-4 text-red-500" />
                        )}
                        <span className="font-mono text-sm">{id}</span>
                        {typeof score === "number" && (
                          <Badge className="bg-muted text-foreground">score {score.toFixed(2)}</Badge>
                        )}
                        {isWinner && (
                          <Badge className="bg-emerald-500/15 text-emerald-600 flex items-center gap-1">
                            <Trophy className="w-3 h-3" /> winner
                          </Badge>
                        )}
                        <Button
                          size="sm"
                          variant={isWinner ? "secondary" : "outline"}
                          className="ml-auto"
                          disabled={busy || isWinner}
                          onClick={() => chooseWinner(detail.id, id)}
                        >
                          {isWinner ? "Selected" : "Select winner"}
                        </Button>
                      </div>
                      {c.summary && (
                        <p className="text-xs text-muted-foreground mb-2">{c.summary}</p>
                      )}
                      <pre className="text-xs bg-muted rounded p-2 overflow-x-auto max-h-80 whitespace-pre-wrap">
                        {c.diff}
                      </pre>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
