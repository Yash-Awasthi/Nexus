/**
 * Task Routing — classify prompts and intelligently route to the optimal model.
 *
 * Tab 1: Classify — classify a task and see which model/agent it routes to
 * Tab 2: Stats — routing distribution and hit rates
 * Tab 3: Config — routing rules and model tiers
 *
 * API:
 *   POST  /api/task-routing/classify
 *   GET   /api/task-routing/stats
 *   GET   /api/task-routing/config
 *   PATCH /api/task-routing/config
 */
import { useState, useEffect, useCallback } from "react";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { Textarea } from "~/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import {
  Route,
  Loader2,
  BarChart2,
  Settings,
  Play,
  RefreshCw,
  Zap,
  Brain,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ClassifyResult {
  taskType: string;
  complexity: "simple" | "medium" | "complex";
  recommendedModel?: string;
  reasoning?: string;
  confidence: number;
  alternatives?: { model: string; score: number }[];
}

interface RoutingStats {
  totalRouted: number;
  byModel?: { model: string; count: number; pct: number }[];
  byTaskType?: { type: string; count: number }[];
  avgLatencyMs?: number;
}

interface RoutingConfig {
  rules?: { taskType: string; model: string; priority: number }[];
  defaultModel?: string;
  enabled: boolean;
  fallbackEnabled?: boolean;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function TaskRouting() {
  const [stats, setStats] = useState<RoutingStats | null>(null);
  const [config, setConfig] = useState<RoutingConfig | null>(null);
  const [loadingStats, setLoadingStats] = useState(true);

  // Classify
  const [prompt, setPrompt] = useState("");
  const [classifying, setClassifying] = useState(false);
  const [classResult, setClassResult] = useState<ClassifyResult | null>(null);
  const [err, setErr] = useState("");

  const loadAll = useCallback(async () => {
    setLoadingStats(true);
    const [sr, cr] = await Promise.allSettled([
      fetch("/api/task-routing/stats").then(r => r.ok ? r.json() : null),
      fetch("/api/task-routing/config").then(r => r.ok ? r.json() : null),
    ]);
    if (sr.status === "fulfilled" && sr.value) setStats(sr.value);
    if (cr.status === "fulfilled" && cr.value) setConfig(cr.value);
    setLoadingStats(false);
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  const classify = useCallback(async () => {
    if (!prompt.trim()) return;
    setClassifying(true); setErr(""); setClassResult(null);
    const r = await fetch("/api/task-routing/classify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: prompt.trim() }),
    }).catch(() => null);
    if (r?.ok) setClassResult(await r.json());
    else setErr("Classification failed");
    setClassifying(false);
  }, [prompt]);

  const complexityColor = (c: string) =>
    c === "simple" ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400"
    : c === "medium" ? "bg-yellow-100 text-yellow-700"
    : "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400";

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Route className="w-6 h-6 text-sky-500" />
            Task Routing
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Classify tasks and route to the optimal AI model automatically
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={loadAll}>
          <RefreshCw className={`w-4 h-4 ${loadingStats ? "animate-spin" : ""}`} />
        </Button>
      </div>

      <Tabs defaultValue="classify">
        <TabsList>
          <TabsTrigger value="classify"><Play className="w-4 h-4 mr-1" />Classify</TabsTrigger>
          <TabsTrigger value="stats"><BarChart2 className="w-4 h-4 mr-1" />Stats</TabsTrigger>
          <TabsTrigger value="config"><Settings className="w-4 h-4 mr-1" />Config</TabsTrigger>
        </TabsList>

        {/* Classify */}
        <TabsContent value="classify" className="mt-4 space-y-4">
          <Card>
            <CardContent className="pt-4 space-y-3">
              <p className="text-sm text-muted-foreground">
                Enter a prompt to see how the router would classify and assign it.
              </p>
              <Textarea
                rows={4}
                placeholder="Write a haiku about the ocean…"
                value={prompt}
                onChange={e => setPrompt(e.target.value)}
                className="resize-none"
              />
              {err && <p className="text-red-500 text-xs">{err}</p>}
              <Button onClick={classify} disabled={classifying || !prompt.trim()}>
                {classifying ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Classifying…</> : <><Route className="w-4 h-4 mr-2" />Classify & Route</>}
              </Button>
            </CardContent>
          </Card>

          {classResult && (
            <Card className="border-sky-200 dark:border-sky-800">
              <CardContent className="pt-4 space-y-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge className="bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-400 capitalize">
                    {classResult.taskType.replace(/_/g, " ")}
                  </Badge>
                  <Badge className={complexityColor(classResult.complexity)}>
                    {classResult.complexity}
                  </Badge>
                  <Badge variant="outline">
                    {Math.round(classResult.confidence * 100)}% confidence
                  </Badge>
                </div>

                {classResult.recommendedModel && (
                  <div className="flex items-center gap-2">
                    <Brain className="w-4 h-4 text-sky-500" />
                    <span className="text-sm font-medium">Route to:</span>
                    <code className="text-sm font-mono bg-muted px-2 py-0.5 rounded">{classResult.recommendedModel}</code>
                  </div>
                )}

                {classResult.reasoning && (
                  <p className="text-sm text-muted-foreground">{classResult.reasoning}</p>
                )}

                {classResult.alternatives && classResult.alternatives.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Alternatives</p>
                    {classResult.alternatives.map(a => (
                      <div key={a.model} className="flex items-center gap-2 text-sm">
                        <code className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">{a.model}</code>
                        <div className="flex-1 bg-muted rounded-full h-1.5">
                          <div className="bg-sky-400 h-1.5 rounded-full" style={{ width: `${a.score * 100}%` }} />
                        </div>
                        <span className="text-xs text-muted-foreground">{Math.round(a.score * 100)}%</span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* Stats */}
        <TabsContent value="stats" className="mt-4">
          {loadingStats ? (
            <div className="flex items-center gap-2 text-muted-foreground py-8 justify-center">
              <Loader2 className="w-4 h-4 animate-spin" />Loading stats…
            </div>
          ) : !stats ? (
            <Card><CardContent className="pt-8 pb-8 text-center text-muted-foreground">No routing data yet</CardContent></Card>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                <Card>
                  <CardContent className="pt-4">
                    <p className="text-xs text-muted-foreground uppercase tracking-wide">Total Routed</p>
                    <p className="text-2xl font-bold">{stats.totalRouted.toLocaleString()}</p>
                  </CardContent>
                </Card>
                {stats.avgLatencyMs && (
                  <Card>
                    <CardContent className="pt-4">
                      <p className="text-xs text-muted-foreground uppercase tracking-wide">Avg Routing Latency</p>
                      <p className="text-2xl font-bold">{stats.avgLatencyMs}ms</p>
                    </CardContent>
                  </Card>
                )}
              </div>

              {stats.byModel && stats.byModel.length > 0 && (
                <Card>
                  <CardHeader className="pb-2"><CardTitle className="text-base">Distribution by Model</CardTitle></CardHeader>
                  <CardContent className="space-y-2">
                    {stats.byModel.map(m => (
                      <div key={m.model} className="flex items-center gap-3">
                        <code className="text-xs font-mono w-40 truncate">{m.model}</code>
                        <div className="flex-1 bg-muted rounded-full h-2">
                          <div className="bg-sky-500 h-2 rounded-full" style={{ width: `${m.pct}%` }} />
                        </div>
                        <span className="text-xs text-muted-foreground w-16 text-right">{m.count} ({Math.round(m.pct)}%)</span>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              )}

              {stats.byTaskType && stats.byTaskType.length > 0 && (
                <Card>
                  <CardHeader className="pb-2"><CardTitle className="text-base">Distribution by Task Type</CardTitle></CardHeader>
                  <CardContent className="space-y-2">
                    {stats.byTaskType.slice(0, 10).map(t => {
                      const max = Math.max(...stats.byTaskType!.map(x => x.count));
                      return (
                        <div key={t.type} className="flex items-center gap-3">
                          <span className="text-sm w-40 truncate capitalize">{t.type.replace(/_/g, " ")}</span>
                          <div className="flex-1 bg-muted rounded-full h-2">
                            <div className="bg-indigo-400 h-2 rounded-full" style={{ width: `${(t.count / max) * 100}%` }} />
                          </div>
                          <span className="text-xs text-muted-foreground w-10 text-right">{t.count}</span>
                        </div>
                      );
                    })}
                  </CardContent>
                </Card>
              )}
            </div>
          )}
        </TabsContent>

        {/* Config */}
        <TabsContent value="config" className="mt-4">
          {loadingStats ? (
            <div className="flex items-center gap-2 text-muted-foreground py-8 justify-center">
              <Loader2 className="w-4 h-4 animate-spin" />Loading config…
            </div>
          ) : !config ? (
            <Card><CardContent className="pt-8 pb-8 text-center text-muted-foreground">Config unavailable</CardContent></Card>
          ) : (
            <div className="space-y-4">
              <div className="flex flex-wrap gap-3 items-center text-sm">
                <span>Routing:</span>
                <Badge className={config.enabled ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400" : "bg-slate-100 text-slate-600"}>
                  {config.enabled ? "Enabled" : "Disabled"}
                </Badge>
                {config.defaultModel && (
                  <>
                    <span className="text-muted-foreground">Default:</span>
                    <code className="text-sm font-mono bg-muted px-2 py-0.5 rounded">{config.defaultModel}</code>
                  </>
                )}
                {config.fallbackEnabled !== undefined && (
                  <Badge variant="outline">{config.fallbackEnabled ? "Fallback on" : "No fallback"}</Badge>
                )}
              </div>

              {config.rules && config.rules.length > 0 && (
                <Card>
                  <CardHeader className="pb-2"><CardTitle className="text-base">Routing Rules</CardTitle></CardHeader>
                  <CardContent>
                    <div className="space-y-2">
                      {config.rules.sort((a, b) => a.priority - b.priority).map((rule, i) => (
                        <div key={i} className="flex items-center gap-3 text-sm">
                          <span className="text-xs text-muted-foreground w-6">{rule.priority}</span>
                          <Badge variant="outline" className="capitalize">{rule.taskType.replace(/_/g, " ")}</Badge>
                          <span className="text-muted-foreground">→</span>
                          <code className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">{rule.model}</code>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
