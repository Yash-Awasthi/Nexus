// SPDX-License-Identifier: Apache-2.0
/**
 * Cost Analytics — personal spending view over the user-scoped cost log.
 *
 * Data contract = the real /api/costs/* surface (routes/costs.ts, pinned by
 * tests/routes/costs.test.ts):
 *   GET /api/costs/dashboard?days=N → { totalUsd, totalTokens, byDay, byModel, period, requests }
 *   GET /api/costs/breakdown        → { breakdown: [{model, calls, tokens, usd}], totalUsd }
 *   GET /api/costs/per-provider     → { providers: [{name, usd}] }
 *   GET /api/costs/efficiency       → { efficiency: [{model, tokensPerDollar}] }
 *   GET /api/costs/limits           → { limits:{monthly_usd,daily_usd}, spent:{...}, remaining:{...}, enforced, note }
 *   GET /api/costs/organization     → { totalUsd, seats, perSeatUsd }
 *   GET /api/costs/pricing          → { models: [{model, inputPer1MTokens, outputPer1MTokens}] }
 *
 * The previous version read a mtd/wtd/ytd/percentUsed spec the API never had,
 * so every tab showed zeros, empty states, or "$NaN" regardless of real spend.
 * MTD / WTD / YTD are now derived client-side from the daily series.
 */
import { useCallback, useEffect, useState } from "react";
import {
  DollarSign,
  RefreshCw,
  Loader2,
  BarChart2,
  Zap,
  TrendingUp,
  Info,
  AlertTriangle,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";

// ─── API shapes (mirror routes/costs.ts) ──────────────────────────────────────

interface DayRow {
  date: string;
  costUsd: number;
  tokens?: number;
  requests?: number;
}
interface Dashboard {
  totalUsd: number;
  totalTokens: number;
  byDay: Record<string, { requests: number; tokens: number; costUsd: number }>;
  byModel: Record<string, number>;
  period: string;
  requests: number;
}
interface Breakdown {
  breakdown: { model: string; calls: number; tokens: number; usd: number }[];
  totalUsd: number;
}
interface ProviderCost {
  name: string;
  usd: number;
}
interface Efficiency {
  efficiency: { model: string; tokensPerDollar: number }[];
}
interface Limits {
  limits: { monthly_usd: number | null; daily_usd: number | null };
  spent: { monthly_usd: number; daily_usd: number };
  remaining: { monthly_usd: number | null; daily_usd: number | null };
  enforced: boolean;
  note: string;
}
interface Org {
  totalUsd: number;
  seats: number;
  perSeatUsd: number;
}
interface PricingModel {
  model: string;
  inputPer1MTokens: number;
  outputPer1MTokens: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmt = (n: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 4,
  }).format(Number.isFinite(n) ? n : 0);

const dayKey = (d: Date) => d.toISOString().slice(0, 10);

/** Sum the per-day costUsd rows from `since` (inclusive) to today. */
function sumSince(byDay: DayRow[], since: string): number {
  return byDay.filter((r) => r.date >= since).reduce((s, r) => s + r.costUsd, 0);
}

function MiniBar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="flex-1 bg-muted rounded-full h-1.5 overflow-hidden">
      <div className={`${color} h-1.5 rounded-full transition-all`} style={{ width: `${pct}%` }} />
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function Costs() {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [breakdown, setBreakdown] = useState<Breakdown | null>(null);
  const [providers, setProviders] = useState<ProviderCost[]>([]);
  const [efficiency, setEfficiency] = useState<Efficiency | null>(null);
  const [limits, setLimits] = useState<Limits | null>(null);
  const [org, setOrg] = useState<Org | null>(null);
  const [pricing, setPricing] = useState<PricingModel[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const loadAll = useCallback(async () => {
    setLoading(true);
    setErr("");
    try {
      // One 366-day window covers YTD, MTD and WTD sums client-side.
      // A 401 (expired session) must surface as an error, not as "$0.00".
      const results = await Promise.allSettled([
        fetch("/api/costs/dashboard?days=366").then((r) => {
          if (r.status === 401) throw new Error("session_expired");
          return r.ok ? r.json() : null;
        }),
        fetch("/api/costs/breakdown").then((r) => (r.ok ? r.json() : null)),
        fetch("/api/costs/per-provider").then((r) => (r.ok ? r.json() : null)),
        fetch("/api/costs/efficiency").then((r) => (r.ok ? r.json() : null)),
        fetch("/api/costs/limits").then((r) => (r.ok ? r.json() : null)),
        fetch("/api/costs/organization").then((r) => (r.ok ? r.json() : null)),
        fetch("/api/costs/pricing").then((r) => (r.ok ? r.json() : null)),
      ]);
      const [d, b, p, e, l, o, pr] = results;
      if (d.status === "fulfilled" && d.value) setDashboard(d.value);
      if (b.status === "fulfilled" && b.value) setBreakdown(b.value);
      if (p.status === "fulfilled" && p.value) setProviders(p.value.providers ?? []);
      if (e.status === "fulfilled" && e.value) setEfficiency(e.value);
      if (l.status === "fulfilled" && l.value) setLimits(l.value);
      if (o.status === "fulfilled" && o.value) setOrg(o.value);
      if (pr.status === "fulfilled" && pr.value) setPricing(pr.value.models ?? []);
      if (d.status === "rejected" && (d.reason as Error)?.message === "session_expired") {
        setErr("Your session has expired — sign in again to view your cost data.");
      } else if (results.every((r) => r.status === "rejected")) {
        setErr("Could not load cost data");
      }
    } catch {
      setErr("Could not load cost data");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  // Derive the KPI windows from the daily series.
  const dayRows: DayRow[] = dashboard
    ? Object.entries(dashboard.byDay).map(([date, v]) => ({
        date,
        costUsd: v.costUsd,
        tokens: v.tokens,
        requests: v.requests,
      }))
    : [];
  const ytd = dashboard ? sumSince(dayRows, `${new Date().getFullYear()}-01-01`) : 0;
  const mtd = dashboard
    ? sumSince(dayRows, dayKey(new Date(new Date().getFullYear(), new Date().getMonth(), 1)))
    : 0;
  const wtd = dashboard ? sumSince(dayRows, dayKey(new Date(Date.now() - 6 * 86_400_000))) : 0;

  const hasLimit = limits && limits.limits.monthly_usd !== null;
  const monthPrefix = new Date().toISOString().slice(0, 7);
  const spentMonth =
    limits?.spent.monthly_usd ??
    (dashboard ? Math.round(sumSince(dayRows, `${monthPrefix}-01`) * 10_000) / 10_000 : 0);
  const pctUsed = hasLimit
    ? Math.min(100, (spentMonth / (limits!.limits.monthly_usd as number)) * 100)
    : null;

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <DollarSign className="w-6 h-6 text-emerald-500" />
            Cost Analytics
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Your AI spending, efficiency metrics, and provider pricing
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={loadAll}>
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {loading && !dashboard ? (
        <div className="flex items-center gap-2 text-muted-foreground py-12 justify-center">
          <Loader2 className="w-5 h-5 animate-spin" />
          Loading cost data…
        </div>
      ) : !dashboard ? (
        // A failed load (e.g. expired session) must never render $0.00 as if real.
        <div className="py-12 text-center space-y-3">
          <p className="text-red-500 text-sm">{err || "Could not load cost data"}</p>
          <Button variant="outline" size="sm" onClick={loadAll}>
            <RefreshCw className="w-4 h-4 mr-2" /> Retry
          </Button>
        </div>
      ) : (
        <>
          {/* KPI cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Card>
              <CardContent className="pt-4">
                <p className="text-xs text-muted-foreground uppercase tracking-wide">
                  Month-to-Date
                </p>
                <p className="text-2xl font-bold text-emerald-600">{fmt(mtd)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4">
                <p className="text-xs text-muted-foreground uppercase tracking-wide">
                  Week-to-Date
                </p>
                <p className="text-2xl font-bold">{fmt(wtd)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4">
                <p className="text-xs text-muted-foreground uppercase tracking-wide">
                  Year-to-Date
                </p>
                <p className="text-2xl font-bold">{fmt(ytd)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4">
                <p className="text-xs text-muted-foreground uppercase tracking-wide">Requests</p>
                <p className="text-2xl font-bold">{(dashboard?.requests ?? 0).toLocaleString()}</p>
              </CardContent>
            </Card>
          </div>

          {/* Budget bar — only meaningful when a limit is configured */}
          {limits && (
            <Card>
              <CardContent className="pt-4">
                {hasLimit ? (
                  <>
                    <div className="flex justify-between text-sm mb-2">
                      <span className="text-muted-foreground">Monthly budget utilization</span>
                      <span
                        className={
                          (pctUsed ?? 0) > 80 ? "text-orange-500 font-medium" : "font-medium"
                        }
                      >
                        {Math.round(pctUsed ?? 0)}%
                      </span>
                    </div>
                    <div className="w-full bg-muted rounded-full h-3 overflow-hidden">
                      <div
                        className={`h-3 rounded-full transition-all ${pctUsed! > 80 ? "bg-orange-500" : pctUsed! > 60 ? "bg-yellow-500" : "bg-emerald-500"}`}
                        style={{ width: `${Math.min(100, pctUsed ?? 0)}%` }}
                      />
                    </div>
                    <div className="flex justify-between text-xs text-muted-foreground mt-1">
                      <span>{fmt(spentMonth)} spent</span>
                      <span>{fmt(limits.limits.monthly_usd as number)} limit</span>
                    </div>
                  </>
                ) : (
                  <div className="flex items-start gap-2 text-sm text-muted-foreground">
                    {limits.spent.daily_usd > 0 && (
                      <AlertTriangle className="w-4 h-4 text-orange-500 shrink-0 mt-0.5" />
                    )}
                    <div>
                      <p>
                        No budget limit configured. Today: {fmt(limits.spent.daily_usd)} · This
                        month: {fmt(limits.spent.monthly_usd)}.
                      </p>
                      <p className="text-xs mt-1">{limits.note}</p>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          <Tabs defaultValue="breakdown">
            <TabsList>
              <TabsTrigger value="breakdown">
                <BarChart2 className="w-4 h-4 mr-1" />
                By Model
              </TabsTrigger>
              <TabsTrigger value="providers">
                <Zap className="w-4 h-4 mr-1" />
                By Provider
              </TabsTrigger>
              <TabsTrigger value="efficiency">
                <TrendingUp className="w-4 h-4 mr-1" />
                Efficiency
              </TabsTrigger>
              {pricing && pricing.length > 0 && (
                <TabsTrigger value="pricing">
                  <DollarSign className="w-4 h-4 mr-1" />
                  Pricing
                </TabsTrigger>
              )}
              {org && <TabsTrigger value="org">Organization</TabsTrigger>}
            </TabsList>

            {/* By Model */}
            <TabsContent value="breakdown" className="mt-4">
              {!breakdown || !breakdown.breakdown.length ? (
                <Card>
                  <CardContent className="pt-8 pb-8 text-center text-muted-foreground">
                    No model breakdown data
                  </CardContent>
                </Card>
              ) : (
                <Card>
                  <CardContent className="pt-4 space-y-3">
                    {breakdown.breakdown.map((m) => {
                      const maxUsd = Math.max(...breakdown.breakdown.map((x) => x.usd));
                      return (
                        <div key={m.model} className="flex items-center gap-3">
                          <span className="text-sm w-40 truncate font-mono">{m.model}</span>
                          <MiniBar value={m.usd} max={maxUsd} color="bg-emerald-500" />
                          <span className="text-sm font-medium w-20 text-right">{fmt(m.usd)}</span>
                          <span className="text-xs text-muted-foreground w-24 text-right">
                            {m.tokens.toLocaleString()} tok
                          </span>
                          <span className="text-xs text-muted-foreground w-16 text-right">
                            {m.calls.toLocaleString()} calls
                          </span>
                        </div>
                      );
                    })}
                    <div className="pt-2 border-t flex justify-between text-sm font-semibold">
                      <span>Total</span>
                      <span>{fmt(breakdown.totalUsd)}</span>
                    </div>
                  </CardContent>
                </Card>
              )}
            </TabsContent>

            {/* By Provider */}
            <TabsContent value="providers" className="mt-4">
              {!providers.length ? (
                <Card>
                  <CardContent className="pt-8 pb-8 text-center text-muted-foreground">
                    No provider cost data
                  </CardContent>
                </Card>
              ) : (
                <div className="grid sm:grid-cols-2 gap-3">
                  {providers.map((p) => (
                    <Card key={p.name}>
                      <CardContent className="pt-4">
                        <div className="flex items-center justify-between mb-2">
                          <span className="font-medium capitalize">{p.name}</span>
                          <span className="text-lg font-bold text-emerald-600">{fmt(p.usd)}</span>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </TabsContent>

            {/* Efficiency */}
            <TabsContent value="efficiency" className="mt-4">
              {!efficiency || !efficiency.efficiency.length ? (
                <Card>
                  <CardContent className="pt-8 pb-8 text-center text-muted-foreground">
                    No efficiency data yet — it appears once you have spend
                  </CardContent>
                </Card>
              ) : (
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base flex items-center gap-2">
                      <Info className="w-4 h-4 text-blue-500" />
                      Tokens per dollar, by model
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-2">
                      {efficiency.efficiency.map((e) => (
                        <div key={e.model} className="flex items-center justify-between text-sm">
                          <span className="font-mono">{e.model}</span>
                          <span className="font-medium">
                            {e.tokensPerDollar > 0
                              ? `${e.tokensPerDollar.toLocaleString()} tok/$`
                              : "$0 (free/local)"}
                          </span>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}
            </TabsContent>

            {/* Pricing */}
            {pricing && pricing.length > 0 && (
              <TabsContent value="pricing" className="mt-4">
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base">Published pricing per 1M tokens</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-2">
                      {pricing.map((m) => (
                        <div key={m.model} className="flex items-center justify-between text-sm">
                          <span className="font-mono">{m.model}</span>
                          <span className="font-medium">
                            in {fmt(m.inputPer1MTokens)} · out {fmt(m.outputPer1MTokens)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>
            )}

            {/* Organization */}
            {org && (
              <TabsContent value="org" className="mt-4">
                <div className="grid sm:grid-cols-3 gap-3">
                  <Card>
                    <CardContent className="pt-4">
                      <p className="text-xs text-muted-foreground uppercase tracking-wide">
                        Total spend
                      </p>
                      <p className="text-2xl font-bold text-emerald-600">{fmt(org.totalUsd)}</p>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="pt-4">
                      <p className="text-xs text-muted-foreground uppercase tracking-wide">Seats</p>
                      <p className="text-2xl font-bold">{org.seats}</p>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="pt-4">
                      <p className="text-xs text-muted-foreground uppercase tracking-wide">
                        Per seat
                      </p>
                      <p className="text-2xl font-bold">{fmt(org.perSeatUsd)}</p>
                    </CardContent>
                  </Card>
                </div>
              </TabsContent>
            )}
          </Tabs>
        </>
      )}
    </div>
  );
}
