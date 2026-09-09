// SPDX-License-Identifier: Apache-2.0
/**
 * A/B Model Comparison — Arena-style side-by-side model evaluation.
 * Connects to /api/ab/run, /api/ab/:id/preference, /api/ab, /api/ab/stats.
 * Field names mirror the API's AbResult (latencyA/tokensA/winner) — the page
 * previously rendered against an imagined contract (latencyAMs/costA/) and
 * crashed on every completed run.
 */
import { useState, useCallback, useEffect } from "react";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { Textarea } from "~/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  Trophy,
  Zap,
  Coins,
  ThumbsUp,
  ThumbsDown,
  Minus,
  Loader2,
  BarChart2,
  Clock,
  RefreshCw,
  ChevronRight,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ABResult {
  id: string;
  prompt: string;
  modelA: string;
  modelB: string;
  responseA: string;
  responseB: string;
  latencyA: number;
  latencyB: number;
  tokensA: number;
  tokensB: number;
  /** Server-side heuristic winner — deliberately not shown before voting. */
  winner?: "A" | "B" | null;
  userPreference?: "A" | "B" | "tie" | "both_bad" | null;
  createdAt: string;
}

interface ABStats {
  totalRuns: number;
  modelStats: Record<string, { wins: number; losses: number; ties: number }>;
}

// ─── Model catalogue ──────────────────────────────────────────────────────────

// Only live model IDs: claude-3-5-sonnet / 3-haiku / 3-opus and gemini-1.5
// were retired by their vendors; llama-3.1-70b-versatile was decommissioned
// by Groq; gpt-4-turbo shuts down 2026-10-23.
const MODELS = [
  "llama3.2:1b",
  "openai/gpt-oss-120b",
  "gpt-4o-mini",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
  "gemini-3.6-flash",
  "gemini-3.5-flash-lite",
  "deepseek-chat",
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ms(n: number) {
  if (n < 1000) return `${n}ms`;
  return `${(n / 1000).toFixed(1)}s`;
}

function tokens(n: number) {
  if (!n) return "—";
  return `${n.toLocaleString()} tok`;
}

function timeAgo(d: string) {
  const diff = Date.now() - new Date(d).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ABCompare() {
  const [prompt, setPrompt] = useState("");
  const [modelA, setModelA] = useState("gpt-4o-mini");
  const [modelB, setModelB] = useState("claude-sonnet-4-6");
  const [running, setRunning] = useState(false);
  const [current, setCurrent] = useState<ABResult | null>(null);
  const [history, setHistory] = useState<ABResult[]>([]);
  const [stats, setStats] = useState<ABStats | null>(null);
  const [voting, setVoting] = useState(false);
  const [tab, setTab] = useState<"arena" | "history" | "stats">("arena");
  const [err, setErr] = useState("");

  const loadHistory = useCallback(async () => {
    try {
      const r = await fetch("/api/ab");
      if (r.ok) setHistory(await r.json());
    } catch {}
  }, []);

  const loadStats = useCallback(async () => {
    try {
      const r = await fetch("/api/ab/stats");
      if (r.ok) setStats(await r.json());
    } catch {}
  }, []);

  useEffect(() => {
    loadHistory();
    loadStats();
  }, [loadHistory, loadStats]);

  const runComparison = useCallback(async () => {
    if (!prompt.trim()) {
      setErr("Enter a prompt first.");
      return;
    }
    if (modelA === modelB) {
      setErr("Pick two different models.");
      return;
    }
    setErr("");
    setRunning(true);
    setCurrent(null);
    try {
      const r = await fetch("/api/ab/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: prompt.trim(), modelA, modelB }),
      });
      if (!r.ok) throw new Error(await r.text());
      const data = await r.json();
      setCurrent(data.result ?? data);
      loadHistory();
      loadStats();
    } catch (e: any) {
      setErr(e.message ?? "Run failed");
    } finally {
      setRunning(false);
    }
  }, [prompt, modelA, modelB, loadHistory, loadStats]);

  const vote = useCallback(
    async (pref: "A" | "B" | "tie" | "both_bad") => {
      if (!current) return;
      setVoting(true);
      try {
        await fetch(`/api/ab/${current.id}/preference`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ preference: pref }),
        });
        setCurrent({ ...current, userPreference: pref });
        loadHistory();
        loadStats();
      } finally {
        setVoting(false);
      }
    },
    [current, loadHistory, loadStats],
  );

  const loadResult = useCallback(async (id: string) => {
    try {
      const r = await fetch(`/api/ab/${id}`);
      if (r.ok) {
        setCurrent(await r.json());
        setTab("arena");
      }
    } catch {}
  }, []);

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Trophy className="w-6 h-6 text-yellow-500" />
            A/B Model Arena
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Head-to-head blind comparison — pick the better response
          </p>
        </div>
        <div className="flex gap-2">
          {(["arena", "history", "stats"] as const).map((t) => (
            <Button
              key={t}
              variant={tab === t ? "default" : "outline"}
              size="sm"
              onClick={() => setTab(t)}
              className="capitalize"
            >
              {t}
            </Button>
          ))}
        </div>
      </div>

      {/* ── Arena Tab ── */}
      {tab === "arena" && (
        <div className="space-y-4">
          {/* Config row */}
          <Card>
            <CardContent className="pt-4 space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Model A
                  </label>
                  <Select value={modelA} onValueChange={setModelA}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MODELS.map((m) => (
                        <SelectItem key={m} value={m}>
                          {m}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Model B
                  </label>
                  <Select value={modelB} onValueChange={setModelB}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MODELS.map((m) => (
                        <SelectItem key={m} value={m}>
                          {m}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <Textarea
                placeholder="Enter your prompt here…"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={4}
                className="resize-none"
              />

              {err && <p className="text-red-500 text-sm">{err}</p>}

              <Button
                onClick={runComparison}
                disabled={running || !prompt.trim()}
                className="w-full"
              >
                {running ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Running both models…
                  </>
                ) : (
                  <>
                    <Zap className="w-4 h-4 mr-2" /> Run Comparison
                  </>
                )}
              </Button>
            </CardContent>
          </Card>

          {/* Results */}
          {current && (
            <div className="space-y-4">
              {/* Side-by-side responses */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {(["A", "B"] as const).map((side) => {
                  const model = side === "A" ? current.modelA : current.modelB;
                  const response = side === "A" ? current.responseA : current.responseB;
                  const latency = side === "A" ? current.latencyA : current.latencyB;
                  const tk = side === "A" ? current.tokensA : current.tokensB;
                  // A failed side reports latency 0 — never award it "faster".
                  const fasterSide =
                    current.latencyA > 0 && current.latencyB > 0
                      ? current.latencyA <= current.latencyB
                        ? "A"
                        : "B"
                      : null;
                  const isFaster = side !== null && side === fasterSide;
                  const preferred = current.userPreference === side;

                  return (
                    <Card
                      key={side}
                      className={`border-2 transition-colors ${
                        preferred ? "border-green-500" : "border-border"
                      }`}
                    >
                      <CardHeader className="pb-2">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <Badge
                              variant={side === "A" ? "default" : "secondary"}
                              className="font-mono"
                            >
                              Model {side}
                            </Badge>
                            <span className="text-xs text-muted-foreground">{model}</span>
                          </div>
                          <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            {isFaster && (
                              <Badge
                                variant="outline"
                                className="text-green-600 border-green-600 text-[10px]"
                              >
                                faster
                              </Badge>
                            )}
                            <span className="flex items-center gap-1">
                              <Clock className="w-3 h-3" />
                              {ms(latency)}
                            </span>
                            <span className="flex items-center gap-1">
                              <Coins className="w-3 h-3" />
                              {tokens(tk)}
                            </span>
                          </div>
                        </div>
                      </CardHeader>
                      <CardContent>
                        <p className="text-sm whitespace-pre-wrap leading-relaxed">{response}</p>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>

              {/* Vote bar */}
              {!current.userPreference ? (
                <Card>
                  <CardContent className="pt-4">
                    <p className="text-sm font-medium mb-3 text-center">
                      Which response is better?
                    </p>
                    <div className="flex gap-2 justify-center flex-wrap">
                      <Button
                        onClick={() => vote("A")}
                        disabled={voting}
                        variant="outline"
                        className="border-blue-500 text-blue-600 hover:bg-blue-50"
                      >
                        <ThumbsUp className="w-4 h-4 mr-2" />
                        Model A is better
                      </Button>
                      <Button onClick={() => vote("tie")} disabled={voting} variant="outline">
                        <Minus className="w-4 h-4 mr-2" />
                        Tie
                      </Button>
                      <Button
                        onClick={() => vote("B")}
                        disabled={voting}
                        variant="outline"
                        className="border-purple-500 text-purple-600 hover:bg-purple-50"
                      >
                        <ThumbsUp className="w-4 h-4 mr-2" />
                        Model B is better
                      </Button>
                      <Button
                        onClick={() => vote("both_bad")}
                        disabled={voting}
                        variant="outline"
                        className="border-red-400 text-red-500 hover:bg-red-50"
                      >
                        <ThumbsDown className="w-4 h-4 mr-2" />
                        Both bad
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ) : (
                <div className="text-center text-sm text-muted-foreground py-2">
                  ✓ Voted:{" "}
                  <span className="font-medium text-foreground capitalize">
                    {current.userPreference === "A"
                      ? `Model A (${current.modelA}) is better`
                      : current.userPreference === "B"
                        ? `Model B (${current.modelB}) is better`
                        : current.userPreference === "tie"
                          ? "Tie"
                          : "Both bad"}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── History Tab ── */}
      {tab === "history" && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">{history.length} comparisons</p>
            <Button variant="ghost" size="sm" onClick={loadHistory}>
              <RefreshCw className="w-3 h-3 mr-1" />
              Refresh
            </Button>
          </div>
          {history.length === 0 && (
            <p className="text-muted-foreground text-sm text-center py-8">No comparisons yet</p>
          )}
          {history.map((item) => (
            <Card
              key={item.id}
              className="cursor-pointer hover:bg-accent/50 transition-colors"
              onClick={() => loadResult(item.id)}
            >
              <CardContent className="pt-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{item.prompt}</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {item.modelA} vs {item.modelB}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {item.userPreference && (
                      <Badge
                        variant={
                          item.userPreference === "tie"
                            ? "outline"
                            : item.userPreference === "both_bad"
                              ? "destructive"
                              : "default"
                        }
                        className="text-xs"
                      >
                        {item.userPreference === "A"
                          ? `A wins`
                          : item.userPreference === "B"
                            ? `B wins`
                            : item.userPreference}
                      </Badge>
                    )}
                    <span className="text-xs text-muted-foreground">{timeAgo(item.createdAt)}</span>
                    <ChevronRight className="w-4 h-4 text-muted-foreground" />
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* ── Stats Tab ── */}
      {tab === "stats" && (
        <div className="space-y-4">
          {!stats || stats.totalRuns === 0 ? (
            <p className="text-muted-foreground text-sm text-center py-8">
              No stats yet — run some comparisons first
            </p>
          ) : (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {[
                  { label: "Total Runs", value: stats.totalRuns, icon: BarChart2 },
                  {
                    label: "Models Compared",
                    value: Object.keys(stats.modelStats).length,
                    icon: Trophy,
                  },
                  {
                    label: "Total Votes",
                    value: Object.values(stats.modelStats).reduce(
                      (a, m) => a + m.wins + m.losses + m.ties,
                      0,
                    ),
                    icon: ThumbsUp,
                  },
                  {
                    label: "Total Wins",
                    value: Object.values(stats.modelStats).reduce((a, m) => a + m.wins, 0),
                    icon: Zap,
                  },
                ].map(({ label, value, icon: Icon }) => (
                  <Card key={label}>
                    <CardContent className="pt-4">
                      <div className="flex items-center gap-2 mb-1">
                        <Icon className="w-4 h-4 text-muted-foreground" />
                        <span className="text-xs text-muted-foreground">{label}</span>
                      </div>
                      <p className="text-xl font-bold">{value}</p>
                    </CardContent>
                  </Card>
                ))}
              </div>

              {/* Model win/loss records */}
              {Object.keys(stats.modelStats).length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">
                      Model Records (wins / losses / ties)
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-2">
                      {Object.entries(stats.modelStats)
                        .sort(([, a], [, b]) => b.wins - a.wins)
                        .map(([model, rec]) => {
                          const total = rec.wins + rec.losses + rec.ties;
                          const pct = total > 0 ? Math.round((rec.wins / total) * 100) : 0;
                          return (
                            <div key={model} className="flex items-center gap-3">
                              <span className="text-sm font-mono w-48 truncate">{model}</span>
                              <div className="flex-1 bg-muted rounded-full h-2">
                                <div
                                  className="bg-yellow-500 h-2 rounded-full"
                                  style={{ width: `${pct}%` }}
                                />
                              </div>
                              <span className="text-xs text-muted-foreground w-24 text-right">
                                {rec.wins}W / {rec.losses}L / {rec.ties}T
                              </span>
                            </div>
                          );
                        })}
                    </div>
                  </CardContent>
                </Card>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
