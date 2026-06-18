/**
 * Feedback Analytics — admin dashboard for response quality signals.
 *
 * Shows how users rate AI responses (thumbs up/down), common quality issues,
 * and allows exporting raw feedback data.
 *
 * API:
 *   GET /api/feedback/stats   — aggregated feedback stats
 *   GET /api/feedback/export  — export CSV (admin)
 */
import { useState, useEffect, useCallback } from "react";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import {
  ThumbsUp,
  ThumbsDown,
  Download,
  RefreshCw,
  Loader2,
  MessageSquare,
  TrendingUp,
  AlertTriangle,
  BarChart2,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface FeedbackStats {
  totalFeedback: number;
  positiveCount: number;
  negativeCount: number;
  positiveRate: number;
  qualityIssues: Record<string, number>;
  recentTrend?: { date: string; positive: number; negative: number }[];
  topIssues?: string[];
  avgScore?: number;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function AdminFeedback() {
  const [stats, setStats] = useState<FeedbackStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [err, setErr] = useState("");

  const loadStats = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/feedback/stats");
      if (r.ok) setStats(await r.json());
      else setErr("Failed to load stats");
    } catch { setErr("Could not reach server"); }
    setLoading(false);
  }, []);

  useEffect(() => { loadStats(); }, [loadStats]);

  const exportCSV = useCallback(async () => {
    setExporting(true);
    try {
      const r = await fetch("/api/feedback/export");
      if (!r.ok) { setErr("Export failed"); return; }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "nexus-feedback.csv";
      a.click();
      URL.revokeObjectURL(url);
    } finally { setExporting(false); }
  }, []);

  const pct = (n: number, total: number) =>
    total > 0 ? `${Math.round((n / total) * 100)}%` : "—";

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center h-64 text-muted-foreground">
        <Loader2 className="w-5 h-5 animate-spin mr-2" />
        Loading feedback stats…
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <MessageSquare className="w-6 h-6 text-pink-500" />
            Feedback Analytics
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Quality signals from user thumbs up/down on AI responses
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={loadStats}>
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
          <Button variant="outline" size="sm" onClick={exportCSV} disabled={exporting}>
            {exporting
              ? <><Loader2 className="w-4 h-4 animate-spin mr-1" />Exporting…</>
              : <><Download className="w-4 h-4 mr-1" />Export CSV</>}
          </Button>
        </div>
      </div>

      {err && <p className="text-red-500 text-sm">{err}</p>}

      {!stats ? (
        <Card>
          <CardContent className="pt-8 pb-8 text-center">
            <BarChart2 className="w-12 h-12 mx-auto mb-3 text-muted-foreground opacity-40" />
            <p className="text-muted-foreground">No feedback data yet</p>
            <p className="text-xs text-muted-foreground mt-1">
              Users can give thumbs up/down on AI responses to generate data
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Overview stats */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Card>
              <CardContent className="pt-4">
                <p className="text-xs text-muted-foreground uppercase tracking-wide">Total</p>
                <p className="text-3xl font-bold">{stats.totalFeedback.toLocaleString()}</p>
                <p className="text-xs text-muted-foreground mt-1">responses rated</p>
              </CardContent>
            </Card>
            <Card className="border-green-200 dark:border-green-800">
              <CardContent className="pt-4">
                <p className="text-xs text-muted-foreground uppercase tracking-wide flex items-center gap-1">
                  <ThumbsUp className="w-3 h-3" />Positive
                </p>
                <p className="text-3xl font-bold text-green-600">{stats.positiveCount.toLocaleString()}</p>
                <p className="text-xs text-muted-foreground mt-1">
                  {pct(stats.positiveCount, stats.totalFeedback)} of total
                </p>
              </CardContent>
            </Card>
            <Card className="border-red-200 dark:border-red-800">
              <CardContent className="pt-4">
                <p className="text-xs text-muted-foreground uppercase tracking-wide flex items-center gap-1">
                  <ThumbsDown className="w-3 h-3" />Negative
                </p>
                <p className="text-3xl font-bold text-red-500">{stats.negativeCount.toLocaleString()}</p>
                <p className="text-xs text-muted-foreground mt-1">
                  {pct(stats.negativeCount, stats.totalFeedback)} of total
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4">
                <p className="text-xs text-muted-foreground uppercase tracking-wide flex items-center gap-1">
                  <TrendingUp className="w-3 h-3" />Positive Rate
                </p>
                <p className={`text-3xl font-bold ${stats.positiveRate >= 0.7 ? "text-green-600" : stats.positiveRate >= 0.5 ? "text-yellow-500" : "text-red-500"}`}>
                  {Math.round((stats.positiveRate ?? 0) * 100)}%
                </p>
                {stats.avgScore !== undefined && (
                  <p className="text-xs text-muted-foreground mt-1">avg score {stats.avgScore.toFixed(2)}</p>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Positive rate bar */}
          <Card>
            <CardContent className="pt-4">
              <div className="flex items-center justify-between text-sm mb-2">
                <span className="flex items-center gap-1 text-green-600">
                  <ThumbsUp className="w-4 h-4" />
                  Positive
                </span>
                <span className="font-medium">{Math.round((stats.positiveRate ?? 0) * 100)}%</span>
                <span className="flex items-center gap-1 text-red-500">
                  Negative
                  <ThumbsDown className="w-4 h-4" />
                </span>
              </div>
              <div className="w-full bg-red-100 dark:bg-red-900/30 rounded-full h-4 overflow-hidden">
                <div
                  className="bg-green-500 h-4 rounded-full transition-all"
                  style={{ width: `${Math.round((stats.positiveRate ?? 0) * 100)}%` }}
                />
              </div>
            </CardContent>
          </Card>

          {/* Quality issues breakdown */}
          {stats.qualityIssues && Object.keys(stats.qualityIssues).length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-orange-500" />
                  Quality Issues Reported
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {Object.entries(stats.qualityIssues)
                    .sort(([, a], [, b]) => b - a)
                    .map(([issue, count]) => {
                      const maxCount = Math.max(...Object.values(stats.qualityIssues));
                      return (
                        <div key={issue} className="flex items-center gap-3">
                          <span className="text-sm w-48 truncate capitalize">{issue.replace(/_/g, " ")}</span>
                          <div className="flex-1 bg-muted rounded-full h-2">
                            <div
                              className="bg-orange-400 h-2 rounded-full"
                              style={{ width: `${(count / maxCount) * 100}%` }}
                            />
                          </div>
                          <span className="text-xs text-muted-foreground w-10 text-right">{count}</span>
                        </div>
                      );
                    })}
                </div>
              </CardContent>
            </Card>
          )}

          {/* 7-day trend */}
          {stats.recentTrend && stats.recentTrend.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">7-Day Trend</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-end gap-1 h-20">
                  {stats.recentTrend.slice(-7).map((day, i) => {
                    const total = day.positive + day.negative;
                    const maxTotal = Math.max(...stats.recentTrend!.map(d => d.positive + d.negative));
                    const height = maxTotal > 0 ? Math.max(4, (total / maxTotal) * 80) : 4;
                    const positivePct = total > 0 ? (day.positive / total) * 100 : 0;
                    return (
                      <div key={i} className="flex-1 flex flex-col items-center gap-1">
                        <div
                          className="w-full rounded-sm overflow-hidden flex flex-col-reverse"
                          style={{ height: `${height}px` }}
                          title={`${day.date}: +${day.positive} / -${day.negative}`}
                        >
                          <div
                            className="bg-green-500"
                            style={{ height: `${positivePct}%` }}
                          />
                          <div
                            className="bg-red-400"
                            style={{ height: `${100 - positivePct}%` }}
                          />
                        </div>
                        <span className="text-xs text-muted-foreground">
                          {new Date(day.date).toLocaleDateString(undefined, { weekday: "short" }).slice(0, 2)}
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
  );
}
