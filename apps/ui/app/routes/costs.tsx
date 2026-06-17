/**
 * Costs — AI spending analytics dashboard.
 *
 * Shows breakdown by model/provider, efficiency metrics, per-provider costs,
 * organization-level summary, and pricing reference.
 *
 * API:
 *   GET /api/costs/breakdown
 *   GET /api/costs/limits
 *   GET /api/costs/efficiency
 *   GET /api/costs/pricing
 *   GET /api/costs/per-provider
 *   GET /api/costs/organization
 *   GET /api/costs/dashboard
 */
import { useState, useEffect, useCallback } from "react";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import {
  DollarSign,
  TrendingUp,
  TrendingDown,
  Loader2,
  RefreshCw,
  Zap,
  BarChart2,
  AlertTriangle,
  Info,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface CostBreakdown {
  total: number;
  currency: string;
  byModel?: { model: string; cost: number; tokens: number; requests: number }[];
  byDay?: { date: string; cost: number }[];
}

interface CostLimits {
  monthly?: number;
  daily?: number;
  spent?: number;
  currency?: string;
  percentUsed?: number;
}

interface CostEfficiency {
  costPerToken?: number;
  costPerRequest?: number;
  mostExpensiveModel?: string;
  cheapestModel?: string;
  suggestions?: string[];
}

interface ProviderCost {
  provider: string;
  cost: number;
  tokens: number;
  requests: number;
  avgCostPerRequest?: number;
}

interface OrgCost {
  totalCost: number;
  currency: string;
  byTeam?: { team: string; cost: number }[];
  budget?: number;
}

interface Dashboard {
  mtd: number;
  wtd: number;
  ytd: number;
  currency: string;
  trend?: "up" | "down" | "stable";
  trendPct?: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmt = (n: number, currency = "USD") =>
  new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 4 }).format(n);

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
  const [breakdown, setBreakdown] = useState<CostBreakdown | null>(null);
  const [limits, setLimits] = useState<CostLimits | null>(null);
  const [efficiency, setEfficiency] = useState<CostEfficiency | null>(null);
  const [perProvider, setPerProvider] = useState<ProviderCost[]>([]);
  const [org, setOrg] = useState<OrgCost | null>(null);
  const [pricing, setPricing] = useState<Record<string, number> | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [d, b, l, e, p, o, pr] = await Promise.allSettled([
        fetch("/api/costs/dashboard").then(r => r.ok ? r.json() : null),
        fetch("/api/costs/breakdown").then(r => r.ok ? r.json() : null),
        fetch("/api/costs/limits").then(r => r.ok ? r.json() : null),
        fetch("/api/costs/efficiency").then(r => r.ok ? r.json() : null),
        fetch("/api/costs/per-provider").then(r => r.ok ? r.json() : null),
        fetch("/api/costs/organization").then(r => r.ok ? r.json() : null),
        fetch("/api/costs/pricing").then(r => r.ok ? r.json() : null),
      ]);
      if (d.status === "fulfilled" && d.value) setDashboard(d.value);
      if (b.status === "fulfilled" && b.value) setBreakdown(b.value);
      if (l.status === "fulfilled" && l.value) setLimits(l.value);
      if (e.status === "fulfilled" && e.value) setEfficiency(e.value);
      if (p.status === "fulfilled" && p.value) setPerProvider(p.value.providers ?? p.value ?? []);
      if (o.status === "fulfilled" && o.value) setOrg(o.value);
      if (pr.status === "fulfilled" && pr.value) setPricing(pr.value);
    } catch { setErr("Could not load cost data"); }
    setLoading(false);
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <DollarSign className="w-6 h-6 text-emerald-500" />
            Cost Analytics
          </h1>
          <p className="text-muted-foreground text-sm mt-1">AI spending breakdown, efficiency metrics, and budget limits</p>
        </div>
        <Button variant="ghost" size="sm" onClick={loadAll}>
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {err && <p className="text-red-500 text-sm">{err}</p>}

      {loading && !dashboard ? (
        <div className="flex items-center gap-2 text-muted-foreground py-12 justify-center">
          <Loader2 className="w-5 h-5 animate-spin" />Loading cost data…
        </div>
      ) : (
        <>
          {/* KPI cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Card>
              <CardContent className="pt-4">
                <p className="text-xs text-muted-foreground uppercase tracking-wide">Month-to-Date</p>
                <p className="text-2xl font-bold text-emerald-600">{dashboard ? fmt(dashboard.mtd, dashboard.currency) : "—"}</p>
                {dashboard?.trend && (
                  <p className={`text-xs mt-1 flex items-center gap-1 ${dashboard.trend === "up" ? "text-red-500" : "text-green-600"}`}>
                    {dashboard.trend === "up" ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                    {dashboard.trendPct !== undefined ? `${Math.abs(dashboard.trendPct)}% vs last month` : ""}
                  </p>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4">
                <p className="text-xs text-muted-foreground uppercase tracking-wide">Week-to-Date</p>
                <p className="text-2xl font-bold">{dashboard ? fmt(dashboard.wtd, dashboard.currency) : "—"}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4">
                <p className="text-xs text-muted-foreground uppercase tracking-wide">Year-to-Date</p>
                <p className="text-2xl font-bold">{dashboard ? fmt(dashboard.ytd, dashboard.currency) : "—"}</p>
              </CardContent>
            </Card>
            <Card className={limits && limits.percentUsed !== undefined && limits.percentUsed > 80 ? "border-orange-300 dark:border-orange-700" : ""}>
              <CardContent className="pt-4">
                <p className="text-xs text-muted-foreground uppercase tracking-wide flex items-center gap-1">
                  {limits && limits.percentUsed !== undefined && limits.percentUsed > 80 && <AlertTriangle className="w-3 h-3 text-orange-500" />}
                  Budget Used
                </p>
                <p className="text-2xl font-bold">{limits?.percentUsed !== undefined ? `${Math.round(limits.percentUsed)}%` : "—"}</p>
                {limits?.monthly && (
                  <p className="text-xs text-muted-foreground mt-1">of {fmt(limits.monthly, limits.currency)} limit</p>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Budget bar */}
          {limits?.percentUsed !== undefined && (
            <Card>
              <CardContent className="pt-4">
                <div className="flex justify-between text-sm mb-2">
                  <span className="text-muted-foreground">Budget utilization</span>
                  <span className={limits.percentUsed > 80 ? "text-orange-500 font-medium" : ""}>{Math.round(limits.percentUsed)}%</span>
                </div>
                <div className="w-full bg-muted rounded-full h-3 overflow-hidden">
                  <div
                    className={`h-3 rounded-full transition-all ${limits.percentUsed > 80 ? "bg-orange-500" : limits.percentUsed > 60 ? "bg-yellow-500" : "bg-emerald-500"}`}
                    style={{ width: `${Math.min(100, limits.percentUsed)}%` }}
                  />
                </div>
                {limits.spent !== undefined && limits.monthly && (
                  <div className="flex justify-between text-xs text-muted-foreground mt-1">
                    <span>{fmt(limits.spent, limits.currency)} spent</span>
                    <span>{fmt(limits.monthly, limits.currency)} limit</span>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          <Tabs defaultValue="breakdown">
            <TabsList>
              <TabsTrigger value="breakdown"><BarChart2 className="w-4 h-4 mr-1" />By Model</TabsTrigger>
              <TabsTrigger value="providers"><Zap className="w-4 h-4 mr-1" />By Provider</TabsTrigger>
              <TabsTrigger value="efficiency"><TrendingUp className="w-4 h-4 mr-1" />Efficiency</TabsTrigger>
              {pricing && <TabsTrigger value="pricing"><DollarSign className="w-4 h-4 mr-1" />Pricing</TabsTrigger>}
              {org && <TabsTrigger value="org">Organization</TabsTrigger>}
            </TabsList>

            {/* By Model */}
            <TabsContent value="breakdown" className="mt-4">
              {!breakdown || !breakdown.byModel?.length ? (
                <Card><CardContent className="pt-8 pb-8 text-center text-muted-foreground">No model breakdown data</CardContent></Card>
              ) : (
                <Card>
                  <CardContent className="pt-4 space-y-3">
                    {breakdown.byModel.map(m => {
                      const maxCost = Math.max(...breakdown.byModel!.map(x => x.cost));
                      return (
                        <div key={m.model} className="flex items-center gap-3">
                          <span className="text-sm w-40 truncate font-mono">{m.model}</span>
                          <MiniBar value={m.cost} max={maxCost} color="bg-emerald-500" />
                          <span className="text-sm font-medium w-20 text-right">{fmt(m.cost, breakdown.currency)}</span>
                          <span className="text-xs text-muted-foreground w-24 text-right">{m.tokens.toLocaleString()} tok</span>
                        </div>
                      );
                    })}
                    {breakdown.total !== undefined && (
                      <div className="pt-2 border-t flex justify-between text-sm font-semibold">
                        <span>Total</span>
                        <span>{fmt(breakdown.total, breakdown.currency)}</span>
                      </div>
                    )}
                  </CardContent>
                </Card>
              )}
            </TabsContent>

            {/* By Provider */}
            <TabsContent value="providers" className="mt-4">
              {!perProvider.length ? (
                <Card><CardContent className="pt-8 pb-8 text-center text-muted-foreground">No provider cost data</CardContent></Card>
              ) : (
                <div className="grid sm:grid-cols-2 gap-3">
                  {perProvider.map(p => (
                    <Card key={p.provider}>
                      <CardContent className="pt-4">
                        <div className="flex items-center justify-between mb-2">
                          <span className="font-medium capitalize">{p.provider}</span>
                          <span className="text-lg font-bold text-emerald-600">{fmt(p.cost)}</span>
                        </div>
                        <div className="flex gap-3 text-xs text-muted-foreground">
                          <span>{p.requests.toLocaleString()} requests</span>
                          <span>{p.tokens.toLocaleString()} tokens</span>
                          {p.avgCostPerRequest !== undefined && <span>{fmt(p.avgCostPerRequest)}/req</span>}
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </TabsContent>

            {/* Efficiency */}
            <TabsContent value="efficiency" className="mt-4">
              <div className="space-y-4">
                {efficiency && (
                  <div className="grid sm:grid-cols-2 gap-3">
                    {efficiency.costPerToken !== undefined && (
                      <Card>
                        <CardContent className="pt-4">
                          <p className="text-xs text-muted-foreground uppercase tracking-wide">Cost per 1K tokens</p>
                          <p className="text-xl font-bold">{fmt(efficiency.costPerToken * 1000)}</p>
                        </CardContent>
                      </Card>
                    )}
                    {efficiency.costPerRequest !== undefined && (
                      <Card>
                        <CardContent className="pt-4">
                          <p className="text-xs text-muted-foreground uppercase tracking-wide">Cost per request</p>
                          <p className="text-xl font-bold">{fmt(efficiency.costPerRequest)}</p>
                        </CardContent>
                      </Card>
                    )}
                    {efficiency.mostExpensiveModel && (
                      <Card>
                        <CardContent className="pt-4">
                          <p className="text-xs text-muted-foreground uppercase tracking-wide">Most expensive model</p>
                          <p className="text-sm font-mono font-medium">{efficiency.mostExpensiveModel}</p>
                        </CardContent>
                      </Card>
                    )}
                    {efficiency.cheapestModel && (
                      <Card>
                        <CardContent className="pt-4">
                          <p className="text-xs text-muted-foreground uppercase tracking-wide">Cheapest model</p>
                          <p className="text-sm font-mono font-medium">{efficiency.cheapestModel}</p>
                        </CardContent>
                      </Card>
                    )}
                  </div>
                )}
                {efficiency?.suggestions && efficiency.suggestions.length > 0 && (
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-base flex items-center gap-2">
                        <Info className="w-4 h-4 text-blue-500" />
                        Cost Optimization Suggestions
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <ul className="space-y-2">
                        {efficiency.suggestions.map((s, i) => (
                          <li key={i} className="text-sm text-muted-foreground flex items-start gap-2">
                            <span className="text-blue-500 shrink-0">•</span>{s}
                          </li>
                        ))}
                      </ul>
                    </CardContent>
                  </Card>
                )}
              </div>
            </TabsContent>

            {/* Pricing */}
            {pricing && (
              <TabsContent value="pricing" className="mt-4">
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base">Current Pricing per 1M tokens</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-2">
                      {Object.entries(pricing).map(([model, price]) => (
                        <div key={model} className="flex items-center justify-between text-sm">
                          <span className="font-mono">{model}</span>
                          <span className="font-medium">{fmt((price as number) * 1_000_000)}</span>
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
                <div className="space-y-4">
                  <div className="grid sm:grid-cols-2 gap-3">
                    <Card>
                      <CardContent className="pt-4">
                        <p className="text-xs text-muted-foreground uppercase tracking-wide">Organization Total</p>
                        <p className="text-2xl font-bold text-emerald-600">{fmt(org.totalCost, org.currency)}</p>
                      </CardContent>
                    </Card>
                    {org.budget && (
                      <Card>
                        <CardContent className="pt-4">
                          <p className="text-xs text-muted-foreground uppercase tracking-wide">Budget</p>
                          <p className="text-2xl font-bold">{fmt(org.budget, org.currency)}</p>
                          <p className="text-xs text-muted-foreground mt-1">
                            {Math.round((org.totalCost / org.budget) * 100)}% used
                          </p>
                        </CardContent>
                      </Card>
                    )}
                  </div>
                  {org.byTeam && org.byTeam.length > 0 && (
                    <Card>
                      <CardHeader className="pb-2"><CardTitle className="text-base">By Team</CardTitle></CardHeader>
                      <CardContent className="space-y-2">
                        {org.byTeam.map(t => {
                          const maxCost = Math.max(...org.byTeam!.map(x => x.cost));
                          return (
                            <div key={t.team} className="flex items-center gap-3">
                              <span className="text-sm w-32 truncate">{t.team}</span>
                              <MiniBar value={t.cost} max={maxCost} color="bg-emerald-500" />
                              <span className="text-sm font-medium w-20 text-right">{fmt(t.cost, org.currency)}</span>
                            </div>
                          );
                        })}
                      </CardContent>
                    </Card>
                  )}
                </div>
              </TabsContent>
            )}
          </Tabs>
        </>
      )}
    </div>
  );
}
