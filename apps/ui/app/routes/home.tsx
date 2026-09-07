// SPDX-License-Identifier: Apache-2.0
/**
 * Dashboard — main landing page after login.
 *
 * Composition over three owners, so each concern lives in one place:
 *   - useDashboard (hooks/use-dashboard.ts)   — usage stats/series/research,
 *                                               health, connectors, providers
 *   - NotificationsContext                    — the notification tray (bell +
 *                                               this page's Activity card render
 *                                               the same state)
 *   - listThreads (lib/deliberate.ts)         — recent deliberations (per-user
 *                                               API; localStorage only as an
 *                                               offline cache + ghost migration)
 *
 * Falls back gracefully to zeros/empty when any call fails.
 */

import { lazy, Suspense, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import {
  MessageSquare,
  Plus,
  ArrowRight,
  Zap,
  Search,
  Brain,
  Plug,
  AlertCircle,
  Eye,
  RefreshCw,
  TrendingUp,
  Clock,
  DollarSign,
  Activity,
  Loader2,
  CheckCircle2,
  XCircle,
  Bell,
  Cpu,
  Database,
  Server,
  FolderOpen,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import { FeatureCard } from "~/components/FeatureCard";
import { StatCard } from "~/components/StatCard";
import { useAuth } from "~/context/AuthContext";
import { useNotifications } from "~/context/NotificationsContext";
import { listThreads } from "~/lib/deliberate";
import { fmtCost, fmtLatency, fmtTokens } from "~/lib/format";
import { useDashboard, type UsagePoint } from "~/hooks/use-dashboard";

import type { Route } from "./+types/home";

// Lazy chart — recharts must not run during SSR (see analytics-charts.tsx).
const UsageChart = lazy(() =>
  import("~/components/dashboard-charts").then((m) => ({ default: m.UsageChart })),
);

export function meta({}: Route.MetaArgs) {
  return [
    { title: "NEXUS - Dashboard" },
    { name: "description", content: "AI-powered deliberation platform" },
  ];
}

export function clientLoader() {
  return {};
}

interface StoredConv {
  id: string;
  title: string;
  date: string;
  mode: string;
}

const RECENT_ACTIVITY = 5;

type WindowKey = "today" | "7d" | "30d";

const WINDOWS: { key: WindowKey; label: string; days: number }[] = [
  { key: "today", label: "Today", days: 1 },
  { key: "7d", label: "7 days", days: 7 },
  { key: "30d", label: "30 days", days: 30 },
];

const windowLabel = (w: WindowKey) => WINDOWS.find((x) => x.key === w)!.label.toLowerCase();

/** Sum the series rows inside a window (today = the newest row). */
function windowSums(series: UsagePoint[] | undefined, w: WindowKey) {
  const rows = (series ?? []).slice(-(w === "today" ? 1 : w === "7d" ? 7 : 30));
  return rows.reduce(
    (acc, r) => ({
      requests: acc.requests + r.requests,
      tokens: acc.tokens + r.tokens,
      costUsd: acc.costUsd + r.costUsd,
    }),
    { requests: 0, tokens: 0, costUsd: 0 },
  );
}

/** Rows the chart draws: the window itself, or the trailing week for Today. */
function windowRows(series: UsagePoint[] | undefined, w: WindowKey) {
  const rows = series ?? [];
  return w === "today" ? rows.slice(-7) : rows.slice(-(w === "7d" ? 7 : 30));
}

export default function Home() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { dash, health, connectorCount, providers, loading, refreshing, refresh } = useDashboard();
  const { items: notifications, unread, markRead, refresh: refreshTray } = useNotifications();

  // Stat window — one control drives the cards and the chart.
  const [window, setWindow] = useState<WindowKey>("7d");

  // Recent deliberations come from the threads bridge (per-user API with a
  // localStorage offline cache + one-time ghost migration) — one owner, one
  // mapping, no page-local fetch/fallback copy.
  const [recentConvs, setRecentConvs] = useState<StoredConv[]>([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const threads = await listThreads();
      if (cancelled) return;
      setRecentConvs(
        threads.slice(0, 5).map((t) => ({
          id: t.id,
          title: t.title,
          date: new Date(t.updated_at).toLocaleDateString(),
          mode: t.mode ?? "",
        })),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const stats = dash?.stats;
  const research = dash?.research;
  const sums = windowSums(dash?.series, window);
  const chartData = windowRows(dash?.series, window);
  const todayDate = dash?.series.at(-1)?.date;
  const ollama = providers.find((p) => p.id === "ollama");
  // /health/ready reports checks as { db: "ok" | "degraded" | "down", kv: … }
  const dbOk = health?.db === "ok";
  const kvOk = health?.kv === "ok";

  const displayName = user?.username ?? "there";

  // Activity click: mark read via the shared tray owner, then follow the link
  // when one is attached (emitters set /deep-research?id=… or /projects).
  const openNotification = (id: string, link?: string) => {
    const n = notifications.find((x) => x.id === id);
    if (n && !n.isRead) void markRead(n.id);
    if (link) navigate(link);
  };

  return (
    <div className="p-6 space-y-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Welcome back, {displayName}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Your private AI deliberation workspace
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            className="size-8 text-muted-foreground"
            onClick={() => void refresh(true)}
            disabled={refreshing}
            title="Refresh stats"
          >
            <RefreshCw className={`size-4 ${refreshing ? "animate-spin" : ""}`} />
          </Button>
          <Button size="sm" className="h-8 gap-1.5" asChild>
            <Link to="/chat">
              <Plus className="size-3.5" /> New Deliberation
            </Link>
          </Button>
        </div>
      </div>

      {/* System health strip */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium mr-1">
          System
        </span>
        {[
          { key: "api", label: "API", ok: true, icon: Server },
          { key: "db", label: "Database", ok: dbOk, icon: Database },
          { key: "kv", label: "Redis KV", ok: kvOk, icon: Cpu },
          { key: "ollama", label: "Ollama", ok: ollama?.connected, icon: Brain },
        ].map((s) => (
          <span
            key={s.key}
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium border ${
              s.ok === true
                ? "text-green-400 border-green-400/20 bg-green-400/5"
                : s.ok === false
                  ? "text-destructive border-destructive/20 bg-destructive/5"
                  : "text-muted-foreground border-border bg-muted/30"
            }`}
          >
            {s.ok === true ? (
              <CheckCircle2 className="size-3" />
            ) : s.ok === false ? (
              <XCircle className="size-3" />
            ) : (
              <Loader2 className="size-3 animate-spin" />
            )}
            {s.label}
          </span>
        ))}
      </div>

      {/* Stat cards */}
      {loading ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <Card key={i}>
              <CardContent className="pt-5 pb-4 flex items-center justify-center h-[88px]">
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard
            icon={MessageSquare}
            label="Requests"
            value={String(sums.requests)}
            sub={windowLabel(window)}
            color="text-blue-400"
          />
          <StatCard
            icon={Brain}
            label="Tokens Used"
            value={fmtTokens(sums.tokens)}
            sub={windowLabel(window)}
            color="text-purple-400"
          />
          <StatCard
            icon={DollarSign}
            label="Cost"
            value={fmtCost(sums.costUsd)}
            sub={`USD · ${windowLabel(window)}`}
            color="text-green-400"
          />
          <StatCard
            icon={Clock}
            label="Avg Latency"
            value={stats?.latencyP50ms ? fmtLatency(stats.latencyP50ms) : "—"}
            sub={
              stats?.errorRate
                ? `${(stats.errorRate * 100).toFixed(2)}% errors`
                : "p50 · per response"
            }
            color="text-amber-400"
          />
        </div>
      )}

      {/* Main content grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left 2/3 */}
        <div className="lg:col-span-2 space-y-4">
          {/* 7-day usage */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2 gap-2 flex-wrap">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <TrendingUp className="size-3.5 text-primary" /> Usage — {windowLabel(window)}
              </CardTitle>
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-0.5 rounded-lg border border-border p-0.5">
                  {WINDOWS.map((w) => (
                    <button
                      key={w.key}
                      onClick={() => setWindow(w.key)}
                      className={`px-2 py-0.5 rounded-md text-[11px] font-medium transition-colors ${
                        window === w.key
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {w.label}
                    </button>
                  ))}
                </div>
                <Button variant="ghost" size="sm" className="h-7 text-xs" asChild>
                  <Link to="/costs">Cost Analytics</Link>
                </Button>
              </div>
            </CardHeader>
            <CardContent className="pt-0">
              {dash ? (
                <Suspense
                  fallback={
                    <div className="flex items-center justify-center h-[200px] text-xs text-muted-foreground">
                      Loading chart…
                    </div>
                  }
                >
                  <UsageChart
                    data={chartData}
                    highlightDate={window === "today" ? todayDate : undefined}
                  />
                </Suspense>
              ) : (
                <div className="flex items-center justify-center h-[200px] text-xs text-muted-foreground">
                  No usage data yet — run a deliberation to see it here.
                </div>
              )}
            </CardContent>
          </Card>

          {/* Recent Deliberations */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-3">
              <CardTitle className="text-sm font-semibold">Recent Deliberations</CardTitle>
              <Button variant="ghost" size="sm" className="h-7 text-xs" asChild>
                <Link to="/chat">View all</Link>
              </Button>
            </CardHeader>
            <CardContent className="pt-0">
              {recentConvs.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 text-center gap-3">
                  <MessageSquare className="size-8 text-muted-foreground/30" />
                  <p className="text-sm text-muted-foreground">No deliberations yet.</p>
                  <Button size="sm" asChild>
                    <Link to="/chat">
                      <Plus className="mr-2 size-4" />
                      Start your first deliberation
                    </Link>
                  </Button>
                </div>
              ) : (
                <div className="space-y-0.5">
                  {recentConvs.map((conv) => (
                    <Link
                      key={conv.id}
                      to={`/chat/${conv.id}`}
                      className="flex items-center justify-between rounded-lg px-3 py-2.5 hover:bg-muted/50 transition-colors group"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" />
                        <p className="text-sm font-medium truncate">{conv.title}</p>
                        {conv.mode && (
                          <Badge variant="outline" className="text-[10px] h-4 px-1 shrink-0">
                            {conv.mode}
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-2 shrink-0 text-xs text-muted-foreground">
                        <span>{conv.date}</span>
                        <ArrowRight className="size-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                      </div>
                    </Link>
                  ))}
                  <div className="pt-1">
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full h-7 text-xs gap-1.5"
                      asChild
                    >
                      <Link to="/chat">
                        <Plus className="size-3" /> New Deliberation
                      </Link>
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Recent Research */}
          {research && research.recent.length > 0 && (
            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-3">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <Search className="size-3.5 text-primary" /> Deep Research
                  {research.running > 0 && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-normal text-amber-400">
                      <Loader2 className="size-3 animate-spin" />
                      {research.running} running
                    </span>
                  )}
                </CardTitle>
                <Button variant="ghost" size="sm" className="h-7 text-xs" asChild>
                  <Link to="/deep-research">Open</Link>
                </Button>
              </CardHeader>
              <CardContent className="pt-0 space-y-0.5">
                {research.recent.map((job) => (
                  <Link
                    key={job.id}
                    to={`/deep-research?id=${job.id}`}
                    className="flex items-center gap-2.5 px-3 py-2 rounded-lg hover:bg-muted/40 transition-colors text-sm"
                  >
                    <span
                      className={`text-[10px] font-mono shrink-0 ${
                        job.status === "done"
                          ? "text-green-400"
                          : job.status === "error" || job.status === "failed"
                            ? "text-destructive"
                            : "text-amber-400"
                      }`}
                    >
                      ●
                    </span>
                    <p className="truncate text-sm flex-1">{job.query}</p>
                    <span className="text-[10px] text-muted-foreground shrink-0">
                      {new Date(job.createdAt).toLocaleDateString()}
                    </span>
                  </Link>
                ))}
              </CardContent>
            </Card>
          )}
        </div>

        {/* Right 1/3 */}
        <div className="space-y-4">
          {/* Activity — the shared notification tray */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-3">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Bell className="size-3.5 text-primary" /> Activity
                {unread > 0 && <Badge className="text-[10px] h-4 px-1.5">{unread} new</Badge>}
              </CardTitle>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={() => void refreshTray()}
              >
                <RefreshCw className="size-3 mr-1" />
                Refresh
              </Button>
            </CardHeader>
            <CardContent className="pt-0">
              {notifications.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 text-center gap-2">
                  <Bell className="size-6 text-muted-foreground/30" />
                  <p className="text-xs text-muted-foreground">
                    Nothing yet — research jobs and autopilot runs appear here.
                  </p>
                </div>
              ) : (
                <div className="space-y-1">
                  {notifications.slice(0, RECENT_ACTIVITY).map((n) => (
                    <button
                      key={n.id}
                      onClick={() => openNotification(n.id, n.link)}
                      className={`w-full text-left flex items-start gap-2.5 rounded-lg px-3 py-2 transition-colors hover:bg-muted/40 ${
                        n.isRead ? "opacity-60" : ""
                      }`}
                    >
                      {!n.isRead && (
                        <span className="mt-1.5 size-1.5 rounded-full bg-primary shrink-0" />
                      )}
                      <div className={`flex-1 min-w-0 ${n.isRead ? "pl-3.5" : ""}`}>
                        <p
                          className={`text-xs font-medium leading-tight ${n.isRead ? "text-muted-foreground" : ""}`}
                        >
                          {n.title}
                        </p>
                        {n.message && (
                          <p className="text-[11px] text-muted-foreground mt-0.5 line-clamp-2">
                            {n.message}
                          </p>
                        )}
                        <p className="text-[10px] text-muted-foreground/60 mt-1">
                          {new Date(n.createdAt).toLocaleString()}
                        </p>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Connectors status */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Plug className="size-3.5 text-primary" /> Connectors
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              {connectorCount === null ? (
                <p className="text-xs text-muted-foreground">Loading…</p>
              ) : connectorCount.total === 0 ? (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">No connectors configured.</p>
                  <Button variant="outline" size="sm" className="w-full h-7 text-xs" asChild>
                    <Link to="/connectors/onboarding">Add connector</Link>
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground text-xs">
                      {connectorCount.connected} connected · {connectorCount.total} total
                    </span>
                    {connectorCount.errors > 0 && (
                      <div className="flex items-center gap-1 text-destructive text-xs">
                        <AlertCircle className="size-3" />
                        {connectorCount.errors} error{connectorCount.errors > 1 ? "s" : ""}
                      </div>
                    )}
                  </div>
                  <Button variant="outline" size="sm" className="w-full h-7 text-xs" asChild>
                    <Link to="/connectors/sync">View sync status</Link>
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Provider Status */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold flex items-center justify-between">
                <span className="flex items-center gap-2">
                  <Brain className="size-3.5 text-primary" /> Providers
                </span>
                <span className="text-[10px] font-normal text-muted-foreground">
                  {providers.filter((p) => p.connected).length}/{providers.length} connected
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0 space-y-1">
              {providers.length === 0 ? (
                <p className="text-xs text-muted-foreground">Loading…</p>
              ) : (
                providers.map((p) => (
                  <div key={p.id} className="flex items-center justify-between py-1">
                    <span className="text-xs text-muted-foreground">{p.name}</span>
                    {p.connected ? (
                      <span className="flex items-center gap-1 text-[10px] text-green-400">
                        <CheckCircle2 className="size-3" />
                        {p.models > 0
                          ? `${p.models} model${p.models !== 1 ? "s" : ""}`
                          : "connected"}
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-[10px] text-muted-foreground/50">
                        <XCircle className="size-3" />
                        Not connected
                      </span>
                    )}
                  </div>
                ))
              )}
              <div className="pt-1">
                <Button variant="outline" size="sm" className="w-full h-7 text-xs" asChild>
                  <a href="/language-models">Manage providers</a>
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Feature shortcuts */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Activity className="size-3.5 text-primary" /> Workspace
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0 space-y-1">
              <FeatureCard
                icon={Zap}
                label="ULTRAPLINIAN"
                description="Multi-council debate engine"
                to="/gauntlet"
                color="bg-yellow-400/10 text-yellow-400"
              />
              <FeatureCard
                icon={Eye}
                label="God Mode"
                description="Full system override controls"
                to="/god-mode"
                color="bg-red-400/10 text-red-400"
              />
              <FeatureCard
                icon={Search}
                label="Deep Research"
                description="Agentic multi-step research"
                to="/deep-research"
                color="bg-blue-400/10 text-blue-400"
              />
              <FeatureCard
                icon={FolderOpen}
                label="Projects / Autopilot"
                description="Autonomous project runs"
                to="/projects"
                color="bg-emerald-400/10 text-emerald-400"
              />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
