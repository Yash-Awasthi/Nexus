// SPDX-License-Identifier: Apache-2.0
/**
 * Quality Center — hallucination scoring + speculative decoding.
 *
 * Tab 1: Hallucination Scorer
 *   - Single-response scoring with claim/evidence input
 *   - Batch scoring for multiple responses
 *   - Groundedness check (context vs. answer)
 *   - Threshold settings
 *
 * Tab 2: Speculative Decoding
 *   - Run a prompt with speculative mode
 *   - Classify a text sample
 *   - Live stats (acceptance rate, speedup ratio)
 *   - Config viewer
 *
 * API:
 *   POST /api/hallucination/score
 *   POST /api/hallucination/batch-score
 *   POST /api/hallucination/groundedness
 *   GET  /api/hallucination/thresholds
 *   POST /api/speculative/run
 *   POST /api/speculative/classify
 *   GET  /api/speculative/stats
 *   GET  /api/speculative/config
 */
import { useState, useEffect, useCallback } from "react";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import {
  ShieldCheck,
  Zap,
  Loader2,
  AlertTriangle,
  CheckCircle,
  XCircle,
  BarChart2,
  RefreshCw,
  Plus,
  Trash2,
  Info,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface HallucinationScore {
  score: number; // 0–1, higher = more hallucinated
  label: "factual" | "uncertain" | "hallucinated";
  claims?: { text: string; verdict: string; confidence: number }[];
  explanation?: string;
}

interface GroundednessResult {
  grounded: boolean;
  score: number;
  ungroundedClaims?: string[];
}

interface BatchItem {
  id: string;
  response: string;
  context?: string;
}

interface SpecStats {
  acceptanceRate: number;
  speedupRatio: number;
  totalRuns: number;
  avgTokensGenerated: number;
}

interface SpecConfig {
  draftModel?: string;
  targetModel?: string;
  numSpecTokens?: number;
  enabled: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ScorePill({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  const color =
    score < 0.3
      ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400"
      : score < 0.6
        ? "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-400"
        : "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400";
  return <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${color}`}>{pct}%</span>;
}

function LabelBadge({ label }: { label: string }) {
  if (label === "factual")
    return (
      <Badge className="bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400">
        <CheckCircle className="w-3 h-3 mr-1" />
        Factual
      </Badge>
    );
  if (label === "hallucinated")
    return (
      <Badge className="bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400">
        <XCircle className="w-3 h-3 mr-1" />
        Hallucinated
      </Badge>
    );
  return (
    <Badge className="bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-400">
      <AlertTriangle className="w-3 h-3 mr-1" />
      Uncertain
    </Badge>
  );
}

// ─── Hallucination Tab ────────────────────────────────────────────────────────

function HallucinationTab() {
  const [mode, setMode] = useState<"single" | "batch" | "groundedness">("single");
  const [response, setResponse] = useState("");
  const [context, setContext] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<HallucinationScore | null>(null);
  const [groundResult, setGroundResult] = useState<GroundednessResult | null>(null);
  const [thresholds, setThresholds] = useState<Record<string, number> | null>(null);

  // batch
  const [batchItems, setBatchItems] = useState<BatchItem[]>([
    { id: "1", response: "", context: "" },
    { id: "2", response: "", context: "" },
  ]);
  const [batchResults, setBatchResults] = useState<{ id: string; score: HallucinationScore }[]>([]);

  const [err, setErr] = useState("");

  useEffect(() => {
    fetch("/api/hallucination/thresholds")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d) setThresholds(d);
      })
      .catch(() => {});
  }, []);

  const scoreResponse = useCallback(async () => {
    if (!response.trim()) return;
    setLoading(true);
    setErr("");
    setResult(null);
    try {
      const r = await fetch("/api/hallucination/score", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response: response.trim(), context: context.trim() || undefined }),
      });
      if (r.ok) setResult(await r.json());
      else setErr("Scoring failed");
    } catch {
      setErr("Could not reach server");
    }
    setLoading(false);
  }, [response, context]);

  const checkGroundedness = useCallback(async () => {
    if (!response.trim() || !context.trim()) return;
    setLoading(true);
    setErr("");
    setGroundResult(null);
    try {
      const r = await fetch("/api/hallucination/groundedness", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer: response.trim(), context: context.trim() }),
      });
      if (r.ok) setGroundResult(await r.json());
      else setErr("Groundedness check failed");
    } catch {
      setErr("Could not reach server");
    }
    setLoading(false);
  }, [response, context]);

  const runBatch = useCallback(async () => {
    const valid = batchItems.filter((b) => b.response.trim());
    if (!valid.length) return;
    setLoading(true);
    setErr("");
    setBatchResults([]);
    try {
      const r = await fetch("/api/hallucination/batch-score", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: valid.map((b) => ({
            id: b.id,
            response: b.response,
            context: b.context || undefined,
          })),
        }),
      });
      if (r.ok) {
        const d = await r.json();
        setBatchResults(d.results ?? []);
      } else setErr("Batch scoring failed");
    } catch {
      setErr("Could not reach server");
    }
    setLoading(false);
  }, [batchItems]);

  const addBatchItem = () => {
    setBatchItems((prev) => [...prev, { id: String(Date.now()), response: "", context: "" }]);
  };
  const removeBatchItem = (id: string) => {
    setBatchItems((prev) => prev.filter((b) => b.id !== id));
  };

  return (
    <div className="space-y-4">
      {/* Mode selector */}
      <div className="flex gap-2 flex-wrap">
        {(["single", "batch", "groundedness"] as const).map((m) => (
          <Button
            key={m}
            size="sm"
            variant={mode === m ? "default" : "outline"}
            onClick={() => setMode(m)}
            className="capitalize"
          >
            {m === "groundedness" ? "Groundedness" : m === "batch" ? "Batch Score" : "Single Score"}
          </Button>
        ))}
        {thresholds && (
          <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
            <Info className="w-3 h-3" />
            Thresholds: factual &lt;{Math.round((thresholds.factual ?? 0.3) * 100)}%, hallucinated
            &gt;{Math.round((thresholds.hallucinated ?? 0.6) * 100)}%
          </div>
        )}
      </div>

      {/* Single */}
      {mode === "single" && (
        <Card>
          <CardContent className="pt-4 space-y-3">
            <div className="space-y-1">
              <label className="text-sm font-medium">AI Response to Score</label>
              <Textarea
                rows={4}
                placeholder="Paste the AI response you want to check for hallucinations…"
                value={response}
                onChange={(e) => setResponse(e.target.value)}
                className="resize-none"
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">
                Source Context <span className="text-muted-foreground font-normal">(optional)</span>
              </label>
              <Textarea
                rows={3}
                placeholder="Optionally provide the source documents or context the response was based on…"
                value={context}
                onChange={(e) => setContext(e.target.value)}
                className="resize-none"
              />
            </div>
            {err && <p className="text-red-500 text-xs">{err}</p>}
            <Button onClick={scoreResponse} disabled={loading || !response.trim()}>
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  Scoring…
                </>
              ) : (
                <>
                  <ShieldCheck className="w-4 h-4 mr-2" />
                  Score Response
                </>
              )}
            </Button>

            {result && (
              <div className="border rounded-lg p-4 space-y-3 bg-muted/30">
                <div className="flex items-center justify-between">
                  <LabelBadge label={result.label} />
                  <div className="flex items-center gap-2 text-sm">
                    <span className="text-muted-foreground">Hallucination score:</span>
                    <ScorePill score={result.score} />
                  </div>
                </div>
                {result.explanation && (
                  <p className="text-sm text-muted-foreground">{result.explanation}</p>
                )}
                {result.claims && result.claims.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Claims breakdown
                    </p>
                    {result.claims.map((c, i) => (
                      <div key={i} className="flex items-start gap-2 text-sm">
                        {c.verdict === "supported" ? (
                          <CheckCircle className="w-4 h-4 text-green-500 shrink-0 mt-0.5" />
                        ) : (
                          <XCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
                        )}
                        <span className="flex-1">{c.text}</span>
                        <ScorePill score={1 - c.confidence} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Groundedness */}
      {mode === "groundedness" && (
        <Card>
          <CardContent className="pt-4 space-y-3">
            <p className="text-sm text-muted-foreground">
              Check whether an AI answer is grounded in the provided context (RAG faithfulness).
            </p>
            <div className="space-y-1">
              <label className="text-sm font-medium">Source Context *</label>
              <Textarea
                rows={4}
                placeholder="The retrieved documents or context chunks…"
                value={context}
                onChange={(e) => setContext(e.target.value)}
                className="resize-none"
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">AI Answer *</label>
              <Textarea
                rows={3}
                placeholder="The answer generated from the above context…"
                value={response}
                onChange={(e) => setResponse(e.target.value)}
                className="resize-none"
              />
            </div>
            {err && <p className="text-red-500 text-xs">{err}</p>}
            <Button
              onClick={checkGroundedness}
              disabled={loading || !response.trim() || !context.trim()}
            >
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  Checking…
                </>
              ) : (
                <>
                  <ShieldCheck className="w-4 h-4 mr-2" />
                  Check Groundedness
                </>
              )}
            </Button>

            {groundResult && (
              <div
                className={`border rounded-lg p-4 space-y-2 ${groundResult.grounded ? "border-green-200 bg-green-50 dark:bg-green-950/20" : "border-red-200 bg-red-50 dark:bg-red-950/20"}`}
              >
                <div className="flex items-center gap-2">
                  {groundResult.grounded ? (
                    <CheckCircle className="w-5 h-5 text-green-600" />
                  ) : (
                    <XCircle className="w-5 h-5 text-red-500" />
                  )}
                  <span className="font-medium">
                    {groundResult.grounded ? "Answer is grounded" : "Answer not grounded"}
                  </span>
                  <ScorePill score={1 - groundResult.score} />
                </div>
                {groundResult.ungroundedClaims && groundResult.ungroundedClaims.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-xs font-medium text-muted-foreground">Ungrounded claims:</p>
                    {groundResult.ungroundedClaims.map((c, i) => (
                      <p key={i} className="text-sm text-red-600 dark:text-red-400">
                        • {c}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Batch */}
      {mode === "batch" && (
        <div className="space-y-3">
          {batchItems.map((item, idx) => (
            <Card key={item.id}>
              <CardContent className="pt-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-muted-foreground">
                    Response #{idx + 1}
                  </span>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-6 w-6 text-red-400"
                    onClick={() => removeBatchItem(item.id)}
                  >
                    <Trash2 className="w-3 h-3" />
                  </Button>
                </div>
                <Textarea
                  rows={2}
                  placeholder="AI response…"
                  value={item.response}
                  onChange={(e) =>
                    setBatchItems((prev) =>
                      prev.map((b) => (b.id === item.id ? { ...b, response: e.target.value } : b)),
                    )
                  }
                  className="resize-none text-sm"
                />
                <Input
                  placeholder="Context (optional)"
                  value={item.context}
                  onChange={(e) =>
                    setBatchItems((prev) =>
                      prev.map((b) => (b.id === item.id ? { ...b, context: e.target.value } : b)),
                    )
                  }
                  className="text-sm"
                />
                {batchResults.find((r) => r.id === item.id) &&
                  (() => {
                    const r = batchResults.find((br) => br.id === item.id)!;
                    return (
                      <div className="flex items-center gap-2">
                        <LabelBadge label={r.score.label} />
                        <ScorePill score={r.score.score} />
                      </div>
                    );
                  })()}
              </CardContent>
            </Card>
          ))}
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={addBatchItem}>
              <Plus className="w-4 h-4 mr-1" />
              Add
            </Button>
            <Button size="sm" onClick={runBatch} disabled={loading}>
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin mr-1" />
                  Scoring…
                </>
              ) : (
                <>Score All</>
              )}
            </Button>
          </div>
          {err && <p className="text-red-500 text-xs">{err}</p>}
        </div>
      )}
    </div>
  );
}

// ─── Speculative Decoding Tab ─────────────────────────────────────────────────

function SpeculativeTab() {
  const [prompt, setPrompt] = useState("");
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<{
    output: string;
    acceptanceRate: number;
    speedup: number;
    tokensGenerated: number;
  } | null>(null);
  const [classifyText, setClassifyText] = useState("");
  const [classifying, setClassifying] = useState(false);
  const [classResult, setClassResult] = useState<{
    category: string;
    confidence: number;
    reasoning?: string;
  } | null>(null);
  const [stats, setStats] = useState<SpecStats | null>(null);
  const [config, setConfig] = useState<SpecConfig | null>(null);
  const [loadingStats, setLoadingStats] = useState(true);
  const [err, setErr] = useState("");

  useEffect(() => {
    Promise.all([
      fetch("/api/speculative/stats").then((r) => (r.ok ? r.json() : null)),
      fetch("/api/speculative/config").then((r) => (r.ok ? r.json() : null)),
    ])
      .then(([s, c]) => {
        if (s) setStats(s);
        if (c) setConfig(c);
      })
      .catch(() => {})
      .finally(() => setLoadingStats(false));
  }, []);

  const runSpec = useCallback(async () => {
    if (!prompt.trim()) return;
    setRunning(true);
    setErr("");
    setRunResult(null);
    try {
      const r = await fetch("/api/speculative/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: prompt.trim() }),
      });
      if (r.ok) setRunResult(await r.json());
      else setErr("Speculative run failed");
    } catch {
      setErr("Could not reach server");
    }
    setRunning(false);
  }, [prompt]);

  const classify = useCallback(async () => {
    if (!classifyText.trim()) return;
    setClassifying(true);
    setErr("");
    setClassResult(null);
    try {
      const r = await fetch("/api/speculative/classify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: classifyText.trim() }),
      });
      if (r.ok) setClassResult(await r.json());
      else setErr("Classification failed");
    } catch {
      setErr("Could not reach server");
    }
    setClassifying(false);
  }, [classifyText]);

  return (
    <div className="space-y-4">
      {/* Stats cards */}
      {loadingStats ? (
        <div className="flex items-center gap-2 text-muted-foreground text-sm py-4">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading stats…
        </div>
      ) : stats ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            {
              label: "Acceptance Rate",
              value: `${Math.round((stats.acceptanceRate ?? 0) * 100)}%`,
              color: "text-green-600",
            },
            {
              label: "Speedup Ratio",
              value: `${(stats.speedupRatio ?? 1).toFixed(2)}×`,
              color: "text-blue-600",
            },
            { label: "Total Runs", value: (stats.totalRuns ?? 0).toLocaleString(), color: "" },
            {
              label: "Avg Tokens",
              value: (stats.avgTokensGenerated ?? 0).toLocaleString(),
              color: "",
            },
          ].map((s) => (
            <Card key={s.label}>
              <CardContent className="pt-3">
                <p className="text-xs text-muted-foreground uppercase tracking-wide">{s.label}</p>
                <p className={`text-2xl font-bold ${s.color}`}>{s.value}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : null}

      {/* Config badge */}
      {config && (
        <div className="flex flex-wrap gap-2 items-center text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Config:</span>
          {config.draftModel && <Badge variant="outline">{config.draftModel} → draft</Badge>}
          {config.targetModel && <Badge variant="outline">{config.targetModel} → target</Badge>}
          {config.numSpecTokens && (
            <Badge variant="outline">{config.numSpecTokens} spec tokens</Badge>
          )}
          <Badge
            className={
              config.enabled
                ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400"
                : "bg-slate-100 text-slate-600"
            }
          >
            {config.enabled ? "Enabled" : "Disabled"}
          </Badge>
        </div>
      )}

      {/* Run */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Zap className="w-4 h-4 text-yellow-500" />
            Run with Speculative Decoding
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea
            rows={4}
            placeholder="Enter a prompt to generate with speculative decoding…"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            className="resize-none"
          />
          {err && <p className="text-red-500 text-xs">{err}</p>}
          <Button onClick={runSpec} disabled={running || !prompt.trim()}>
            {running ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
                Running…
              </>
            ) : (
              <>
                <Zap className="w-4 h-4 mr-2" />
                Run
              </>
            )}
          </Button>

          {runResult && (
            <div className="border rounded-lg p-4 space-y-3 bg-muted/30">
              <div className="flex items-center gap-3 flex-wrap text-sm">
                <Badge variant="outline">
                  Acceptance: {Math.round(runResult.acceptanceRate * 100)}%
                </Badge>
                <Badge variant="outline">Speedup: {runResult.speedup.toFixed(2)}×</Badge>
                <Badge variant="outline">{runResult.tokensGenerated} tokens</Badge>
              </div>
              <p className="text-sm whitespace-pre-wrap">{runResult.output}</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Classify */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Classify Text</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea
            rows={3}
            placeholder="Enter text to classify…"
            value={classifyText}
            onChange={(e) => setClassifyText(e.target.value)}
            className="resize-none"
          />
          <Button
            variant="outline"
            onClick={classify}
            disabled={classifying || !classifyText.trim()}
          >
            {classifying ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
                Classifying…
              </>
            ) : (
              "Classify"
            )}
          </Button>

          {classResult && (
            <div className="border rounded-lg p-3 space-y-1 bg-muted/30">
              <div className="flex items-center gap-2">
                <Badge>{classResult.category}</Badge>
                <span className="text-xs text-muted-foreground">
                  confidence: {Math.round(classResult.confidence * 100)}%
                </span>
              </div>
              {classResult.reasoning && (
                <p className="text-sm text-muted-foreground">{classResult.reasoning}</p>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function Quality() {
  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <ShieldCheck className="w-6 h-6 text-violet-500" />
          Quality Center
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Hallucination detection, groundedness checks, and speculative decoding diagnostics
        </p>
      </div>

      <Tabs defaultValue="hallucination">
        <TabsList>
          <TabsTrigger value="hallucination">
            <ShieldCheck className="w-4 h-4 mr-1" />
            Hallucination
          </TabsTrigger>
          <TabsTrigger value="speculative">
            <Zap className="w-4 h-4 mr-1" />
            Speculative Decoding
          </TabsTrigger>
        </TabsList>
        <TabsContent value="hallucination" className="mt-4">
          <HallucinationTab />
        </TabsContent>
        <TabsContent value="speculative" className="mt-4">
          <SpeculativeTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
