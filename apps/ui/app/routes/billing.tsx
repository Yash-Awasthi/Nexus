// SPDX-License-Identifier: Apache-2.0
/**
 * Billing & Usage
 *
 * Nexus is free + BYOK (locked roadmap decision: no paid tier, no payment
 * provider, never build). This page therefore shows exactly two honest things:
 *   1. the plan statement (free, forever, BYOK),
 *   2. the caller's real usage for the last 30 days (user-scoped cost log).
 *
 * The previous version rendered a synthetic "pro" subscription, a Monthly/
 * Annual toggle, a cancel flow and a Stripe disclaimer — all fiction supplied
 * by bridge endpoints that fabricated usage from the tenant-id length.
 *
 * API:
 *   GET /api/billing/plans           — free+BYOK plan statement (honest)
 *   GET /api/billing/usage/:tid      — real user-scoped usage (cost log)
 */
import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import {
  CreditCard,
  CheckCircle,
  Loader2,
  RefreshCw,
  AlertCircle,
  BarChart2,
  KeyRound,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Plan {
  id: string;
  name: string;
  price?: number;
  features?: string[];
}

interface UsageSummary {
  periodStart: string;
  periodEnd: string;
  requests: number;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  byModel?: Record<string, { requests: number; cost: number }>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n: number) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

function fmtDate(d?: string) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function Billing() {
  const navigate = useNavigate();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [plansRes, meRes] = await Promise.all([
        fetch("/api/billing/plans"),
        fetch("/api/v1/auth/me"),
      ]);
      if (plansRes.ok) {
        const d = await plansRes.json();
        setPlans(d.plans ?? d);
      }
      if (meRes.ok) {
        const me = await meRes.json();
        const tid = me?.tenantId ?? me?.id ?? me?.user?.id;
        if (tid) {
          const usageRes = await fetch(`/api/billing/usage/${tid}`);
          if (usageRes.ok) setUsage(await usageRes.json());
        }
      }
    } catch {
      setErr("Could not load billing info.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <CreditCard className="w-6 h-6 text-indigo-500" />
            Billing &amp; Usage
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Nexus is free — you only pay your LLM provider for your own keys
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={refresh} disabled={refreshing}>
          <RefreshCw className={`w-4 h-4 ${refreshing ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {err && (
        <div className="flex items-center gap-2 text-red-600 text-sm bg-red-50 dark:bg-red-950/30 p-3 rounded-lg">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {err}
        </div>
      )}

      {/* Plan statement — the only "plan" that exists */}
      <Card className="border-green-200 dark:border-green-800 bg-green-50/50 dark:bg-green-950/20">
        <CardContent className="pt-5">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <p className="font-semibold text-lg">Free + BYOK</p>
                <Badge className="bg-green-600 text-white">active</Badge>
              </div>
              <p className="text-sm text-muted-foreground">
                No subscription, no metering, no payment provider — and there never will be one.
                Bring your own provider keys and pay them directly, at cost.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate("/provider-keys")}
              className="shrink-0"
            >
              <KeyRound className="w-4 h-4 mr-1" />
              Manage keys
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Usage summary — real, user-scoped */}
      {loading ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground">
          <Loader2 className="w-5 h-5 animate-spin mr-2" />
          Loading usage…
        </div>
      ) : (
        usage && (
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3 flex items-center gap-2">
              <BarChart2 className="w-4 h-4" />
              Your usage — last 30 days
              <span className="font-normal normal-case text-xs">
                {fmtDate(usage.periodStart)} — {fmtDate(usage.periodEnd)}
              </span>
            </h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {[
                { label: "Requests", value: fmt(usage.requests) },
                { label: "Tokens In", value: fmt(usage.tokensIn) },
                { label: "Tokens Out", value: fmt(usage.tokensOut) },
                {
                  label: "Est. provider cost",
                  value: `$${(usage.cost ?? 0).toFixed(4)}`,
                },
              ].map(({ label, value }) => (
                <Card key={label}>
                  <CardContent className="pt-4">
                    <p className="text-xs text-muted-foreground uppercase tracking-wide">{label}</p>
                    <p className="text-2xl font-bold mt-1">{value}</p>
                  </CardContent>
                </Card>
              ))}
            </div>
            <p className="text-xs text-muted-foreground mt-3">
              Estimated from published per-token prices for the models you used — what your own
              provider would charge you. Nexus adds nothing.
            </p>
          </div>
        )
      )}

      {/* Plan details from the API (free + BYOK) */}
      {plans.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold mb-4">What's included</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {plans.map((plan) => (
              <Card key={plan.id} className="flex flex-col">
                <CardHeader className="pb-3">
                  <div className="flex items-center gap-2">
                    <CheckCircle className="w-5 h-5 text-green-500" />
                    <CardTitle className="text-base">{plan.name}</CardTitle>
                  </div>
                  <div className="mt-2">
                    <p className="text-3xl font-bold">Free</p>
                  </div>
                </CardHeader>
                <CardContent className="flex-1 space-y-3">
                  {plan.features && plan.features.length > 0 && (
                    <ul className="space-y-1.5">
                      {plan.features.map((f) => (
                        <li key={f} className="flex items-start gap-2 text-sm">
                          <CheckCircle className="w-3.5 h-3.5 text-green-500 shrink-0 mt-0.5" />
                          {f}
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
