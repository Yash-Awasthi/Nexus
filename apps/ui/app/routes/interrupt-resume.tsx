/**
 * Interrupt & Resume — pause, modify, and resume long-running council runs.
 *
 * Create a run, interrupt mid-flight to inject additional context,
 * modify parameters, then resume. Useful for course-correcting long
 * deliberations without starting over.
 *
 * API:
 *   POST   /api/imr/runs
 *   GET    /api/imr/runs
 *   GET    /api/imr/runs/:id
 *   POST   /api/imr/runs/:id/interrupt
 *   PATCH  /api/imr/runs/:id/modify
 *   POST   /api/imr/runs/:id/resume
 *   DELETE /api/imr/runs/:id
 */
import { useState, useEffect, useCallback } from "react";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import {
  PauseCircle,
  PlayCircle,
  Plus,
  Loader2,
  RefreshCw,
  Trash2,
  Edit3,
  Clock,
  CheckCircle,
  XCircle,
  AlertCircle,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface IMRRun {
  id: string;
  query: string;
  status: "running" | "interrupted" | "resumed" | "done" | "failed";
  createdAt: string;
  interruptedAt?: string;
  resumedAt?: string;
  output?: string;
  progress?: number;
}

// ─── Status badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: IMRRun["status"] }) {
  const map: Record<string, string> = {
    running: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400",
    interrupted: "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-400",
    resumed: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-400",
    done: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400",
    failed: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400",
  };
  const icons: Record<string, React.ReactNode> = {
    running: <Clock className="w-3 h-3 mr-1 animate-pulse" />,
    interrupted: <PauseCircle className="w-3 h-3 mr-1" />,
    resumed: <PlayCircle className="w-3 h-3 mr-1" />,
    done: <CheckCircle className="w-3 h-3 mr-1" />,
    failed: <XCircle className="w-3 h-3 mr-1" />,
  };
  return (
    <Badge className={`${map[status] ?? "bg-slate-100 text-slate-600"} flex items-center`}>
      {icons[status]}{status}
    </Badge>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function InterruptResume() {
  const [runs, setRuns] = useState<IMRRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<IMRRun | null>(null);
  const [loadingRun, setLoadingRun] = useState(false);

  // Create
  const [newQuery, setNewQuery] = useState("");
  const [creating, setCreating] = useState(false);

  // Actions
  const [injectText, setInjectText] = useState("");
  const [modifyParams, setModifyParams] = useState("");
  const [actioning, setActioning] = useState(false);

  const [err, setErr] = useState("");

  const loadRuns = useCallback(async () => {
    setLoading(true);
    const r = await fetch("/api/imr/runs").catch(() => null);
    if (r?.ok) {
      const d = await r.json();
      setRuns(d.runs ?? d);
    }
    setLoading(false);
  }, []);

  useEffect(() => { loadRuns(); }, [loadRuns]);

  const loadRun = useCallback(async (id: string) => {
    setLoadingRun(true);
    const r = await fetch(`/api/imr/runs/${id}`).catch(() => null);
    if (r?.ok) setSelected(await r.json());
    setLoadingRun(false);
  }, []);

  const createRun = useCallback(async () => {
    if (!newQuery.trim()) return;
    setCreating(true); setErr("");
    const r = await fetch("/api/imr/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: newQuery.trim() }),
    }).catch(() => null);
    if (r?.ok) {
      const run = await r.json();
      setRuns(prev => [run, ...prev]);
      setSelected(run);
      setNewQuery("");
    } else setErr("Create failed");
    setCreating(false);
  }, [newQuery]);

  const interrupt = useCallback(async () => {
    if (!selected) return;
    setActioning(true);
    const r = await fetch(`/api/imr/runs/${selected.id}/interrupt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inject: injectText.trim() || undefined }),
    }).catch(() => null);
    if (r?.ok) {
      const updated = await r.json();
      setSelected(updated);
      setRuns(prev => prev.map(x => x.id === updated.id ? updated : x));
    }
    setActioning(false);
  }, [selected, injectText]);

  const modify = useCallback(async () => {
    if (!selected) return;
    let params;
    try { params = modifyParams.trim() ? JSON.parse(modifyParams) : {}; } catch { setErr("Invalid JSON params"); return; }
    setActioning(true); setErr("");
    const r = await fetch(`/api/imr/runs/${selected.id}/modify`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    }).catch(() => null);
    if (r?.ok) {
      const updated = await r.json();
      setSelected(updated);
    }
    setActioning(false);
  }, [selected, modifyParams]);

  const resume = useCallback(async () => {
    if (!selected) return;
    setActioning(true);
    const r = await fetch(`/api/imr/runs/${selected.id}/resume`, { method: "POST" }).catch(() => null);
    if (r?.ok) {
      const updated = await r.json();
      setSelected(updated);
      setRuns(prev => prev.map(x => x.id === updated.id ? updated : x));
    }
    setActioning(false);
  }, [selected]);

  const deleteRun = useCallback(async (id: string) => {
    if (!confirm("Delete this run?")) return;
    await fetch(`/api/imr/runs/${id}`, { method: "DELETE" }).catch(() => {});
    setRuns(prev => prev.filter(r => r.id !== id));
    if (selected?.id === id) setSelected(null);
  }, [selected]);

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <PauseCircle className="w-6 h-6 text-amber-500" />
            Interrupt & Resume
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Pause long-running council deliberations, inject context, modify parameters, then resume
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={loadRuns}>
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {/* Create new run */}
      <Card>
        <CardContent className="pt-4 space-y-2">
          <div className="flex gap-2">
            <Input
              placeholder="Enter a query to start a new interruptible run…"
              value={newQuery}
              onChange={e => setNewQuery(e.target.value)}
              onKeyDown={e => e.key === "Enter" && createRun()}
              className="flex-1"
            />
            <Button onClick={createRun} disabled={creating || !newQuery.trim()}>
              {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4 mr-1" />}
              Start Run
            </Button>
          </div>
          {err && <p className="text-red-500 text-xs">{err}</p>}
        </CardContent>
      </Card>

      <div className="grid md:grid-cols-3 gap-4">
        {/* Run list */}
        <div className="space-y-1.5">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Runs</h2>
          {loading ? (
            <div className="flex items-center gap-2 text-muted-foreground text-sm py-4">
              <Loader2 className="w-4 h-4 animate-spin" />Loading…
            </div>
          ) : runs.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">No runs yet</p>
          ) : (
            runs.map(run => (
              <div
                key={run.id}
                className={`border rounded-lg p-3 cursor-pointer hover:bg-muted/40 transition-colors ${selected?.id === run.id ? "bg-muted border-primary/30" : ""}`}
                onClick={() => loadRun(run.id)}
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm truncate flex-1">{run.query}</p>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-5 w-5 text-red-400 shrink-0"
                    onClick={e => { e.stopPropagation(); deleteRun(run.id); }}
                  >
                    <Trash2 className="w-3 h-3" />
                  </Button>
                </div>
                <div className="flex items-center gap-2 mt-1">
                  <StatusBadge status={run.status} />
                  {run.progress !== undefined && (
                    <div className="flex-1 bg-muted rounded-full h-1">
                      <div className="bg-primary h-1 rounded-full" style={{ width: `${run.progress}%` }} />
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
        </div>

        {/* Run detail */}
        <div className="md:col-span-2 space-y-4">
          {loadingRun ? (
            <div className="flex items-center gap-2 text-muted-foreground py-8 justify-center">
              <Loader2 className="w-4 h-4 animate-spin" />Loading run…
            </div>
          ) : selected ? (
            <>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base flex items-center justify-between">
                    <span className="truncate">{selected.query}</span>
                    <StatusBadge status={selected.status} />
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {/* Output so far */}
                  {selected.output && (
                    <div>
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Output</p>
                      <p className="text-sm whitespace-pre-wrap bg-muted/30 p-3 rounded-md max-h-40 overflow-y-auto">{selected.output}</p>
                    </div>
                  )}

                  {/* Interrupt */}
                  {selected.status === "running" && (
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Interrupt with context injection</label>
                      <Textarea
                        rows={2}
                        placeholder="Additional context to inject before interrupting…"
                        value={injectText}
                        onChange={e => setInjectText(e.target.value)}
                        className="resize-none text-sm"
                      />
                      <Button onClick={interrupt} disabled={actioning} variant="outline" className="border-orange-300 text-orange-600 hover:bg-orange-50">
                        {actioning ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <PauseCircle className="w-4 h-4 mr-2" />}
                        Interrupt
                      </Button>
                    </div>
                  )}

                  {/* Modify + Resume */}
                  {selected.status === "interrupted" && (
                    <div className="space-y-3">
                      <div className="space-y-1">
                        <label className="text-sm font-medium">Modify parameters <span className="text-muted-foreground font-normal">(JSON, optional)</span></label>
                        <Textarea
                          rows={2}
                          placeholder='{ "temperature": 0.5, "maxTokens": 2000 }'
                          value={modifyParams}
                          onChange={e => setModifyParams(e.target.value)}
                          className="resize-none font-mono text-xs"
                        />
                      </div>
                      <div className="flex gap-2">
                        <Button onClick={modify} disabled={actioning} variant="outline">
                          {actioning ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Edit3 className="w-4 h-4 mr-2" />}
                          Modify
                        </Button>
                        <Button onClick={resume} disabled={actioning} className="bg-green-600 hover:bg-green-700">
                          {actioning ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <PlayCircle className="w-4 h-4 mr-2" />}
                          Resume
                        </Button>
                      </div>
                    </div>
                  )}

                  {selected.status === "done" && (
                    <div className="flex items-center gap-2 text-green-600 dark:text-green-400 text-sm">
                      <CheckCircle className="w-4 h-4" />Run completed successfully
                    </div>
                  )}
                </CardContent>
              </Card>
            </>
          ) : (
            <div className="flex items-center justify-center h-48 text-muted-foreground border rounded-lg border-dashed">
              <div className="text-center">
                <PauseCircle className="w-10 h-10 mx-auto mb-2 opacity-30" />
                <p className="text-sm">Select a run to manage it</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
