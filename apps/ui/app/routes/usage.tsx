// SPDX-License-Identifier: Apache-2.0
/**
 * Usage — month-to-date spend against the account's quota cap, broken down by
 * model + day.
 *
 * API:
 *   GET /api/v1/billing/quota
 *   GET /api/v1/billing/usage/by-model-day
 */
import { Gauge, Loader2, RefreshCw, AlertTriangle } from "lucide-react";
import { useState, useEffect, useCallback } from "react";

import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { authFetch } from "~/lib/api";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Quota {
  allowed: boolean;
  plan: string;
  tokensPerMonth: number;
  tokensUsed: number;
  tokensRemaining: number | null;
  rpmLimit: number;
}

interface ModelDayUsage {
  model: string;
  day: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  requests: number;
}

interface ByModelDay {
  periodStart: string;
  byModelDay: ModelDayUsage[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmtUsd = (n: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 4,
  }).format(n);

// ─── Component ────────────────────────────────────────────────────────────────

export default function Usage() {
  const [quota, setQuota] = useState<Quota | null>(null);
  const [usage, setUsage] = useState<ByModelDay | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const loadAll = useCallback(async () => {
    setLoading(true);
    setErr("");
    try {
      const [q, u] = await Promise.allSettled([
        authFetch("/api/v1/billing/quota").then((r) =>
          r.ok ? (r.json() as Promise<Quota>) : null,
        ),
        authFetch("/api/v1/billing/usage/by-model-day").then((r) =>
          r.ok ? (r.json() as Promise<ByModelDay>) : null,
        ),
      ]);
      if (q.status === "fulfilled" && q.value) setQuota(q.value);
      if (u.status === "fulfilled" && u.value) setUsage(u.value);
    } catch {
      setErr("Could not load usage data");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  // Month-to-date cost = sum of costUsd across the by-model-day breakdown.
  const mtdCost = usage?.byModelDay.reduce((sum, r) => sum + r.costUsd, 0) ?? 0;
  const capUsd = quota && quota.tokensPerMonth >= 0 ? quota.tokensPerMonth : null;
  const percentOfCap = capUsd && capUsd > 0 ? Math.min(100, (mtdCost / capUsd) * 100) : null;

  // Group rows by model for a per-model summary alongside the per-day rows.
  const byModel = (usage?.byModelDay ?? []).reduce<
    Record<
      string,
      { promptTokens: number; completionTokens: number; costUsd: number; requests: number }
    >
  >((acc, r) => {
    const cur = acc[r.model] ?? { promptTokens: 0, completionTokens: 0, costUsd: 0, requests: 0 };
    cur.promptTokens += r.promptTokens;
    cur.completionTokens += r.completionTokens;
    cur.costUsd += r.costUsd;
    cur.requests += r.requests;
    acc[r.model] = cur;
    return acc;
  }, {});

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Gauge className="w-6 h-6 text-emerald-500" />
            Usage
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Month-to-date spend against your quota cap, by model and day.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={loadAll}>
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {err && <p className="text-red-500 text-sm">{err}</p>}

      {loading && !quota ? (
        <div className="flex items-center gap-2 text-muted-foreground py-12 justify-center">
          <Loader2 className="w-5 h-5 animate-spin" />
          Loading usage…
        </div>
      ) : (
        <>
          {/* KPI cards */}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <Card>
              <CardContent className="pt-4">
                <p className="text-xs text-muted-foreground uppercase tracking-wide">
                  Month-to-Date Cost
                </p>
                <p className="text-2xl font-bold text-emerald-600">{fmtUsd(mtdCost)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4">
                <p className="text-xs text-muted-foreground uppercase tracking-wide">Monthly Cap</p>
                <p className="text-2xl font-bold">
                  {capUsd !== null ? fmtUsd(capUsd) : "Unlimited"}
                </p>
              </CardContent>
            </Card>
            <Card
              className={
                percentOfCap !== null && percentOfCap > 80
                  ? "border-orange-300 dark:border-orange-700"
                  : ""
              }
            >
              <CardContent className="pt-4">
                <p className="text-xs text-muted-foreground uppercase tracking-wide flex items-center gap-1">
                  {percentOfCap !== null && percentOfCap > 80 && (
                    <AlertTriangle className="w-3 h-3 text-orange-500" />
                  )}
                  Cap Used
                </p>
                <p className="text-2xl font-bold">
                  {percentOfCap !== null ? `${Math.round(percentOfCap)}%` : "—"}
                </p>
              </CardContent>
            </Card>
          </div>

          {/* Budget bar */}
          {percentOfCap !== null && (
            <Card>
              <CardContent className="pt-4">
                <div className="flex justify-between text-sm mb-2">
                  <span className="text-muted-foreground">Cap utilization</span>
                  <span className={percentOfCap > 80 ? "text-orange-500 font-medium" : ""}>
                    {Math.round(percentOfCap)}%
                  </span>
                </div>
                <div className="w-full bg-muted rounded-full h-3 overflow-hidden">
                  <div
                    className={`h-3 rounded-full transition-all ${percentOfCap > 80 ? "bg-orange-500" : percentOfCap > 60 ? "bg-yellow-500" : "bg-emerald-500"}`}
                    style={{ width: `${percentOfCap}%` }}
                  />
                </div>
                <div className="flex justify-between text-xs text-muted-foreground mt-1">
                  <span>{fmtUsd(mtdCost)} spent</span>
                  <span>{capUsd !== null ? fmtUsd(capUsd) : "no cap"}</span>
                </div>
              </CardContent>
            </Card>
          )}

          {/* By model */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">By Model (month-to-date)</CardTitle>
            </CardHeader>
            <CardContent>
              {Object.keys(byModel).length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">No usage yet</p>
              ) : (
                <div className="space-y-3">
                  {Object.entries(byModel).map(([model, m]) => (
                    <div key={model} className="flex items-center gap-3">
                      <span className="text-sm w-48 truncate font-mono">{model}</span>
                      <span className="text-xs text-muted-foreground w-32">
                        {(m.promptTokens + m.completionTokens).toLocaleString()} tok
                      </span>
                      <span className="text-xs text-muted-foreground w-24">
                        {m.requests.toLocaleString()} req
                      </span>
                      <span className="text-sm font-medium ml-auto">{fmtUsd(m.costUsd)}</span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* By day */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">By Day</CardTitle>
            </CardHeader>
            <CardContent>
              {!usage?.byModelDay.length ? (
                <p className="text-sm text-muted-foreground py-4 text-center">No usage yet</p>
              ) : (
                <div className="space-y-2">
                  {usage.byModelDay.map((r) => (
                    <div
                      key={`${r.model}-${r.day}`}
                      className="flex items-center gap-3 text-sm border-b last:border-0 pb-2 last:pb-0"
                    >
                      <span className="text-muted-foreground w-24">{r.day}</span>
                      <span className="font-mono flex-1 truncate">{r.model}</span>
                      <span className="text-xs text-muted-foreground w-28 text-right">
                        {(r.promptTokens + r.completionTokens).toLocaleString()} tok
                      </span>
                      <span className="font-medium w-20 text-right">{fmtUsd(r.costUsd)}</span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
