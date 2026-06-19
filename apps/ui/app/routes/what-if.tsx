// SPDX-License-Identifier: Apache-2.0
/**
 * What-If Scenarios — branch a simulation run and compare alternative paths.
 *
 * Fork an existing simulation run at any tick, apply different conditions,
 * run branches independently, and compare outcomes side-by-side.
 *
 * API:
 *   POST /api/simulate/runs/:simId/branches
 *   GET  /api/simulate/runs/:simId/branches
 *   GET  /api/simulate/branches/:id
 *   POST /api/simulate/branches/:id/tick
 *   GET  /api/simulate/runs/:simId/compare
 *   DELETE /api/simulate/branches/:id
 */
import { useState, useCallback } from "react";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import {
  GitBranch,
  Plus,
  Loader2,
  Play,
  RefreshCw,
  Trash2,
  BarChart2,
  ChevronRight,
  Search,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Branch {
  id: string;
  name?: string;
  conditions?: string;
  tick: number;
  status: "idle" | "running" | "done";
  events?: string[];
}

interface CompareResult {
  branches: {
    id: string;
    name?: string;
    outcome?: string;
    metrics?: Record<string, number>;
  }[];
  winner?: string;
  analysis?: string;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function WhatIf() {
  const [simId, setSimId] = useState("");
  const [loadingBranches, setLoadingBranches] = useState(false);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [selected, setSelected] = useState<Branch | null>(null);

  // Create branch
  const [newName, setNewName] = useState("");
  const [newConditions, setNewConditions] = useState("");
  const [creating, setCreating] = useState(false);

  // Compare
  const [comparing, setComparing] = useState(false);
  const [compareResult, setCompareResult] = useState<CompareResult | null>(null);

  // Actions
  const [ticking, setTicking] = useState<string | null>(null);

  const [err, setErr] = useState("");

  const loadBranches = useCallback(async () => {
    if (!simId.trim()) return;
    setLoadingBranches(true);
    setErr("");
    const r = await fetch(`/api/simulate/runs/${simId.trim()}/branches`).catch(() => null);
    if (r?.ok) {
      const d = await r.json();
      setBranches(d.branches ?? d);
    } else setErr("Could not load branches for that run ID");
    setLoadingBranches(false);
  }, [simId]);

  const createBranch = useCallback(async () => {
    if (!simId.trim()) return;
    setCreating(true);
    setErr("");
    const r = await fetch(`/api/simulate/runs/${simId.trim()}/branches`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: newName.trim() || undefined,
        conditions: newConditions.trim() || undefined,
      }),
    }).catch(() => null);
    if (r?.ok) {
      const b = await r.json();
      setBranches((prev) => [...prev, b]);
      setNewName("");
      setNewConditions("");
    } else setErr("Create branch failed");
    setCreating(false);
  }, [simId, newName, newConditions]);

  const tickBranch = useCallback(
    async (branchId: string) => {
      setTicking(branchId);
      const r = await fetch(`/api/simulate/branches/${branchId}/tick`, { method: "POST" }).catch(
        () => null,
      );
      if (r?.ok) {
        const updated = await r.json();
        setBranches((prev) => prev.map((b) => (b.id === branchId ? { ...b, ...updated } : b)));
        if (selected?.id === branchId) setSelected(updated);
      }
      setTicking(null);
    },
    [selected],
  );

  const deleteBranch = useCallback(
    async (id: string) => {
      if (!confirm("Delete this branch?")) return;
      await fetch(`/api/simulate/branches/${id}`, { method: "DELETE" }).catch(() => {});
      setBranches((prev) => prev.filter((b) => b.id !== id));
      if (selected?.id === id) setSelected(null);
    },
    [selected],
  );

  const compare = useCallback(async () => {
    if (!simId.trim() || branches.length < 2) return;
    setComparing(true);
    setCompareResult(null);
    const r = await fetch(`/api/simulate/runs/${simId.trim()}/compare`).catch(() => null);
    if (r?.ok) setCompareResult(await r.json());
    setComparing(false);
  }, [simId, branches]);

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <GitBranch className="w-6 h-6 text-lime-600" />
          What-If Scenarios
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Fork simulation runs into parallel branches with different conditions and compare outcomes
        </p>
      </div>

      {/* Load run */}
      <Card>
        <CardContent className="pt-4 space-y-3">
          <label className="text-sm font-medium">Simulation Run ID</label>
          <div className="flex gap-2">
            <Input
              placeholder="Enter the simulation run ID to branch from…"
              value={simId}
              onChange={(e) => setSimId(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && loadBranches()}
              className="flex-1 font-mono text-sm"
            />
            <Button onClick={loadBranches} disabled={loadingBranches || !simId.trim()}>
              {loadingBranches ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Search className="w-4 h-4" />
              )}
            </Button>
          </div>
          {err && <p className="text-red-500 text-xs">{err}</p>}
        </CardContent>
      </Card>

      {simId.trim() && (
        <div className="grid md:grid-cols-3 gap-4">
          {/* Branch list + create */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Branches ({branches.length})</h2>
              {branches.length >= 2 && (
                <Button size="sm" variant="outline" onClick={compare} disabled={comparing}>
                  {comparing ? (
                    <Loader2 className="w-3 h-3 animate-spin mr-1" />
                  ) : (
                    <BarChart2 className="w-3 h-3 mr-1" />
                  )}
                  Compare
                </Button>
              )}
            </div>

            {/* Create form */}
            <Card className="bg-muted/20">
              <CardContent className="pt-3 space-y-2">
                <Input
                  placeholder="Branch name (optional)"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className="text-sm h-8"
                />
                <Textarea
                  rows={2}
                  placeholder="Different conditions or interventions…"
                  value={newConditions}
                  onChange={(e) => setNewConditions(e.target.value)}
                  className="resize-none text-xs"
                />
                <Button size="sm" className="w-full" onClick={createBranch} disabled={creating}>
                  {creating ? (
                    <Loader2 className="w-3 h-3 animate-spin mr-1" />
                  ) : (
                    <Plus className="w-3 h-3 mr-1" />
                  )}
                  Fork Branch
                </Button>
              </CardContent>
            </Card>

            {/* Branch list */}
            {branches.map((b) => (
              <div
                key={b.id}
                className={`border rounded-lg p-2.5 cursor-pointer hover:bg-muted/40 transition-colors ${selected?.id === b.id ? "bg-muted border-primary/30" : ""}`}
                onClick={() => setSelected(b)}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 min-w-0">
                    <GitBranch className="w-3.5 h-3.5 text-lime-600 shrink-0" />
                    <span className="text-sm font-medium truncate">
                      {b.name ?? b.id.slice(0, 8)}
                    </span>
                  </div>
                  <div className="flex items-center gap-1">
                    <Badge variant="secondary" className="text-xs">
                      t={b.tick}
                    </Badge>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6 text-red-400"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteBranch(b.id);
                      }}
                    >
                      <Trash2 className="w-3 h-3" />
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Branch detail */}
          <div className="md:col-span-2 space-y-4">
            {selected ? (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base flex items-center justify-between">
                    <span>{selected.name ?? "Branch " + selected.id.slice(0, 8)}</span>
                    <div className="flex gap-2">
                      <Badge variant={selected.status === "done" ? "default" : "secondary"}>
                        {selected.status}
                      </Badge>
                      <Button
                        size="sm"
                        onClick={() => tickBranch(selected.id)}
                        disabled={ticking === selected.id || selected.status === "done"}
                      >
                        {ticking === selected.id ? (
                          <Loader2 className="w-3 h-3 animate-spin mr-1" />
                        ) : (
                          <Play className="w-3 h-3 mr-1" />
                        )}
                        Tick
                      </Button>
                    </div>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <span>
                      Tick: <strong>{selected.tick}</strong>
                    </span>
                  </div>
                  {selected.conditions && (
                    <div>
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">
                        Conditions
                      </p>
                      <p className="text-sm text-muted-foreground">{selected.conditions}</p>
                    </div>
                  )}
                  {selected.events && selected.events.length > 0 && (
                    <div>
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">
                        Events
                      </p>
                      <div className="space-y-1 max-h-48 overflow-y-auto">
                        {selected.events.map((ev, i) => (
                          <div
                            key={i}
                            className="text-xs text-muted-foreground flex items-start gap-1"
                          >
                            <ChevronRight className="w-3 h-3 shrink-0 mt-0.5" />
                            {ev}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            ) : (
              <div className="flex items-center justify-center h-40 text-muted-foreground border rounded-lg border-dashed">
                <div className="text-center">
                  <GitBranch className="w-10 h-10 mx-auto mb-2 opacity-30" />
                  <p className="text-sm">Select a branch to inspect</p>
                </div>
              </div>
            )}

            {/* Compare result */}
            {compareResult && (
              <Card className="border-lime-200 dark:border-lime-800">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base flex items-center gap-2">
                    <BarChart2 className="w-4 h-4 text-lime-600" />
                    Comparison
                    {compareResult.winner && (
                      <Badge className="bg-lime-100 text-lime-700 dark:bg-lime-900/40 dark:text-lime-400">
                        Winner: {compareResult.winner}
                      </Badge>
                    )}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {compareResult.branches.map((b) => (
                    <div key={b.id} className="border rounded-md p-3">
                      <p className="text-sm font-medium">{b.name ?? b.id.slice(0, 8)}</p>
                      {b.outcome && (
                        <p className="text-xs text-muted-foreground mt-1">{b.outcome}</p>
                      )}
                      {b.metrics && Object.keys(b.metrics).length > 0 && (
                        <div className="flex flex-wrap gap-2 mt-2">
                          {Object.entries(b.metrics).map(([k, v]) => (
                            <span key={k} className="text-xs bg-muted px-1.5 py-0.5 rounded">
                              {k}: {typeof v === "number" ? v.toFixed(2) : v}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                  {compareResult.analysis && (
                    <p className="text-sm text-muted-foreground">{compareResult.analysis}</p>
                  )}
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
