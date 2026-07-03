// SPDX-License-Identifier: Apache-2.0
/**
 * Dashboard — main landing page after login.
 *
 * Pulls live data from:
 *   GET /api/analytics/overview  — conversations, tokens, cost, latency
 *   GET /api/connectors?limit=100 — connector count + error count
 *   GET /api/research?limit=3    — recent research jobs
 *
 * Falls back gracefully to zeros/empty when any call fails.
 */

import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router";
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
  MemoryStick,
  Loader2,
  CheckCircle2,
  XCircle,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import { useAuth } from "~/context/AuthContext";

import type { Route } from "./+types/home";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "NEXUS - Dashboard" },
    { name: "description", content: "AI-powered deliberation platform" },
  ];
}

export function clientLoader() {
  return {};
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface AnalyticsOverview {
  totalConversations: number;
  totalMessages: number;
  totalTokensUsed: number;
  totalCostUsd: number;
  avgLatencyMs: number;
}

interface StoredConv {
  id: string;
  title: string;
  date: string;
  mode: string;
}

interface ResearchJob {
  id: string;
  query: string;
  status: string;
  createdAt: string;
}

interface ProviderStatus {
  id: string;
  name: string;
  models: number;
  connected: boolean;
}

// ── Stat card ─────────────────────────────────────────────────────────────────

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  color = "text-primary",
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  sub?: string;
  color?: string;
}) {
  return (
    <Card>
      <CardContent className="pt-5 pb-4">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="text-2xl font-bold mt-1 tracking-tight">{value}</p>
            {sub && <p className="text-[11px] text-muted-foreground mt-0.5">{sub}</p>}
          </div>
          <div className={`p-2 rounded-lg bg-primary/10 ${color}`}>
            <Icon className="size-4" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Feature shortcut ───────────────────────────────────────────────────────────

function FeatureCard({
  icon: Icon,
  label,
  description,
  to,
  color,
}: {
  icon: React.ElementType;
  label: string;
  description: string;
  to: string;
  color: string;
}) {
  return (
    <Link
      to={to}
      className="group flex items-start gap-3 p-3 rounded-xl transition-colors hover:bg-muted/50"
      style={{ border: "1px solid hsl(var(--border)/0.5)" }}
    >
      <div className={`p-2 rounded-lg shrink-0 ${color}`}>
        <Icon className="size-4" />
      </div>
      <div className="min-w-0">
        <p className="text-sm font-medium group-hover:text-primary transition-colors">{label}</p>
        <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{description}</p>
      </div>
      <ArrowRight className="size-3.5 shrink-0 mt-1 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
    </Link>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function Home() {
  const { user } = useAuth();

  // Local state
  const [recentConvs, setRecentConvs] = useState<StoredConv[]>([]);
  const [analytics, setAnalytics] = useState<AnalyticsOverview | null>(null);
  const [connectorCount, setConnectorCount] = useState<{ total: number; errors: number } | null>(
    null,
  );
  const [recentResearch, setRecentResearch] = useState<ResearchJob[]>([]);
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Load from localStorage
  useEffect(() => {
    if (!user?.id) return;
    try {
      const raw = localStorage.getItem(`nexus-chats-${user.id}`);
      const all: StoredConv[] = raw ? JSON.parse(raw) : [];
      setRecentConvs(all.slice(0, 5));
    } catch {
      setRecentConvs([]);
    }
  }, [user?.id]);

  // Fetch live stats
  const fetchStats = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    else setRefreshing(true);

    await Promise.allSettled([
      // Analytics overview
      fetch("/api/analytics/overview")
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (data) setAnalytics(data);
        })
        .catch(() => {}),

      // Connector summary
      fetch("/api/connectors?limit=100")
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (!data) return;
          const list = data.connectors ?? [];
          setConnectorCount({
            total: list.length,
            errors: list.filter((c: any) => c.status === "error").length,
          });
        })
        .catch(() => {}),

      // Recent research jobs
      fetch("/api/research?limit=3")
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (data?.jobs) setRecentResearch(data.jobs);
        })
        .catch(() => {}),

      // Provider status
      fetch("/api/providers")
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (!data?.providers) return;
          const connected = new Map<string, number>();
          for (const p of data.providers as any[]) {
            const key = (p.provider ?? p.type ?? "custom").toLowerCase();
            connected.set(key, (connected.get(key) ?? 0) + (p.model ? 1 : 0));
          }
          const DISPLAY: Record<string, string> = {
            openai: "OpenAI",
            anthropic: "Anthropic",
            google: "Google Gemini",
            groq: "Groq",
            ollama: "Ollama",
            openrouter: "OpenRouter",
            mistral: "Mistral",
          };
          setProviders(
            ["openai", "anthropic", "google", "groq", "ollama", "openrouter", "mistral"].map(
              (id) => ({
                id,
                name: DISPLAY[id] ?? id,
                models: connected.get(id) ?? 0,
                connected: connected.has(id),
              }),
            ),
          );
        })
        .catch(() => {}),
    ]);

    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  const displayName = user?.username ?? "there";

  // Format helpers
  const fmtTokens = (n: number) =>
    n >= 1_000_000
      ? `${(n / 1_000_000).toFixed(1)}M`
      : n >= 1_000
        ? `${(n / 1_000).toFixed(1)}k`
        : String(n);

  const fmtCost = (usd: number) =>
    usd < 0.01 ? `$${(usd * 100).toFixed(2)}¢` : `$${usd.toFixed(2)}`;

  const fmtLatency = (ms: number) =>
    ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Welcome back, {displayName}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Your private AI deliberation workspace
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground"
          onClick={() => fetchStats(true)}
          disabled={refreshing}
          title="Refresh stats"
        >
          <RefreshCw className={`size-4 ${refreshing ? "animate-spin" : ""}`} />
        </Button>
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
            label="Deliberations"
            value={String(analytics?.totalConversations ?? 0)}
            sub={`${analytics?.totalMessages ?? 0} messages`}
            color="text-blue-400"
          />
          <StatCard
            icon={Brain}
            label="Tokens Used"
            value={fmtTokens(analytics?.totalTokensUsed ?? 0)}
            sub="lifetime total"
            color="text-purple-400"
          />
          <StatCard
            icon={DollarSign}
            label="Total Cost"
            value={fmtCost(analytics?.totalCostUsd ?? 0)}
            sub="USD all time"
            color="text-green-400"
          />
          <StatCard
            icon={Clock}
            label="Avg Latency"
            value={analytics?.avgLatencyMs ? fmtLatency(analytics.avgLatencyMs) : "—"}
            sub="per response"
            color="text-amber-400"
          />
        </div>
      )}

      {/* Main content grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Recent Deliberations — 2/3 width */}
        <div className="lg:col-span-2 space-y-4">
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
          {recentResearch.length > 0 && (
            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-3">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <Search className="size-3.5 text-primary" /> Deep Research
                </CardTitle>
                <Button variant="ghost" size="sm" className="h-7 text-xs" asChild>
                  <Link to="/deep-research">Open</Link>
                </Button>
              </CardHeader>
              <CardContent className="pt-0 space-y-0.5">
                {recentResearch.map((job) => (
                  <div
                    key={job.id}
                    className="flex items-center gap-2.5 px-3 py-2 rounded-lg hover:bg-muted/40 transition-colors text-sm"
                  >
                    <span
                      className={`text-[10px] font-mono shrink-0 ${
                        job.status === "done"
                          ? "text-green-400"
                          : job.status === "failed"
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
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </div>

        {/* Right column — 1/3 width */}
        <div className="space-y-4">
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
                      {connectorCount.total} connected
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
                <TrendingUp className="size-3.5 text-primary" /> Workspace
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
                icon={MemoryStick}
                label="STM Modules"
                description="Active prompt injections"
                to="/stm"
                color="bg-purple-400/10 text-purple-400"
              />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
