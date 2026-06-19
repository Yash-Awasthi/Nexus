// SPDX-License-Identifier: Apache-2.0
/**
 * Billing & Plans — Phase 8.x
 *
 * Plan selection, subscription management, and usage overview.
 *
 * API:
 *   GET  /api/billing/plans                  — list plans
 *   GET  /api/billing/subscription/:tenantId — current subscription
 *   POST /api/billing/checkout               — create Stripe checkout session
 *   POST /api/billing/cancel/:tenantId       — cancel subscription
 *   GET  /api/billing/usage/:tenantId        — usage stats
 */
import { useState, useEffect, useCallback } from "react";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import {
  CreditCard,
  CheckCircle,
  Zap,
  Building2,
  Star,
  Loader2,
  RefreshCw,
  AlertCircle,
  XCircle,
  ExternalLink,
  BarChart2,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Plan {
  id: string;
  name: string;
  description?: string;
  priceMonthly?: number;
  priceAnnual?: number;
  features?: string[];
  limits?: Record<string, number | string>;
  isPopular?: boolean;
}

interface Subscription {
  id: string;
  tenantId: string;
  planId: string;
  status: "active" | "trialing" | "canceled" | "past_due" | "unpaid";
  currentPeriodEnd?: string;
  cancelAtPeriodEnd?: boolean;
  stripeCustomerId?: string;
  interval?: "monthly" | "annual";
}

interface UsageSummary {
  requests: number;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  periodStart: string;
  periodEnd: string;
  byModel?: Record<string, { requests: number; cost: number }>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const STATUS_STYLES: Record<string, string> = {
  active: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400",
  trialing: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400",
  canceled: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400",
  past_due: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400",
  unpaid: "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-400",
};

const PLAN_ICONS: Record<string, React.ReactNode> = {
  free: <Star className="w-5 h-5 text-slate-500" />,
  starter: <Zap className="w-5 h-5 text-blue-500" />,
  pro: <CheckCircle className="w-5 h-5 text-indigo-500" />,
  enterprise: <Building2 className="w-5 h-5 text-purple-500" />,
};

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
  const [plans, setPlans] = useState<Plan[]>([]);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [checkingOut, setCheckingOut] = useState<string | null>(null);
  const [canceling, setCanceling] = useState(false);
  const [interval, setInterval] = useState<"monthly" | "annual">("monthly");
  const [err, setErr] = useState("");
  const [tenantId, setTenantId] = useState<string | null>(null);

  // Get current user/tenant
  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.tenantId || d?.id) setTenantId(d.tenantId ?? String(d.id));
      });
  }, []);

  const loadPlans = useCallback(async () => {
    try {
      const r = await fetch("/api/billing/plans");
      if (r.ok) {
        const d = await r.json();
        setPlans(d.plans ?? d);
      }
    } catch {}
  }, []);

  const loadSubscription = useCallback(async (tid: string) => {
    try {
      const r = await fetch(`/api/billing/subscription/${tid}`);
      if (r.ok) setSubscription(await r.json());
    } catch {}
  }, []);

  const loadUsage = useCallback(async (tid: string) => {
    try {
      const r = await fetch(`/api/billing/usage/${tid}`);
      if (r.ok) setUsage(await r.json());
    } catch {}
  }, []);

  useEffect(() => {
    loadPlans().finally(() => setLoading(false));
  }, [loadPlans]);

  useEffect(() => {
    if (tenantId) {
      loadSubscription(tenantId);
      loadUsage(tenantId);
    }
  }, [tenantId, loadSubscription, loadUsage]);

  const handleCheckout = useCallback(
    async (planId: string) => {
      if (!tenantId) {
        setErr("Not logged in");
        return;
      }
      setCheckingOut(planId);
      setErr("");
      try {
        const r = await fetch("/api/billing/checkout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tenantId, planId, interval }),
        });
        const d = await r.json();
        if (!r.ok) {
          setErr(d.error ?? "Checkout failed");
          return;
        }
        if (d.url) window.location.href = d.url;
        else if (d.sessionUrl) window.location.href = d.sessionUrl;
      } catch {
        setErr("Checkout failed");
      } finally {
        setCheckingOut(null);
      }
    },
    [tenantId, interval],
  );

  const handleCancel = useCallback(async () => {
    if (!tenantId || !subscription) return;
    if (
      !confirm("Cancel your subscription? You'll keep access until the end of the billing period.")
    )
      return;
    setCanceling(true);
    try {
      const r = await fetch(`/api/billing/cancel/${tenantId}`, { method: "POST" });
      if (r.ok) {
        await loadSubscription(tenantId);
      } else {
        setErr("Cancellation failed");
      }
    } catch {
      setErr("Cancellation failed");
    } finally {
      setCanceling(false);
    }
  }, [tenantId, subscription, loadSubscription]);

  const currentPlan = subscription ? plans.find((p) => p.id === subscription.planId) : null;

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <CreditCard className="w-6 h-6 text-indigo-500" />
            Billing & Plans
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Manage your subscription and view usage
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            if (tenantId) {
              loadSubscription(tenantId);
              loadUsage(tenantId);
            }
            loadPlans();
          }}
        >
          <RefreshCw className="w-4 h-4" />
        </Button>
      </div>

      {err && (
        <div className="flex items-center gap-2 text-red-600 text-sm bg-red-50 dark:bg-red-950/30 p-3 rounded-lg">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {err}
        </div>
      )}

      {/* Current subscription */}
      {subscription && (
        <Card className="border-indigo-200 dark:border-indigo-800 bg-indigo-50/50 dark:bg-indigo-950/20">
          <CardContent className="pt-5">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <p className="font-semibold text-lg">
                    {currentPlan?.name ?? subscription.planId}
                  </p>
                  <Badge className={STATUS_STYLES[subscription.status] ?? ""}>
                    {subscription.status}
                  </Badge>
                  {subscription.cancelAtPeriodEnd && (
                    <Badge variant="outline" className="text-orange-600 border-orange-400 text-xs">
                      Cancels {fmtDate(subscription.currentPeriodEnd)}
                    </Badge>
                  )}
                </div>
                <p className="text-sm text-muted-foreground">
                  {subscription.interval === "annual" ? "Annual" : "Monthly"} billing · Renews{" "}
                  {fmtDate(subscription.currentPeriodEnd)}
                </p>
              </div>
              {subscription.status === "active" && !subscription.cancelAtPeriodEnd && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCancel}
                  disabled={canceling}
                  className="text-red-600 border-red-300 hover:bg-red-50"
                >
                  {canceling ? (
                    <Loader2 className="w-3 h-3 animate-spin mr-1" />
                  ) : (
                    <XCircle className="w-3 h-3 mr-1" />
                  )}
                  Cancel plan
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Usage summary */}
      {usage && (
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3 flex items-center gap-2">
            <BarChart2 className="w-4 h-4" />
            This period usage
            <span className="font-normal normal-case text-xs">
              {fmtDate(usage.periodStart)} — {fmtDate(usage.periodEnd)}
            </span>
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { label: "Requests", value: fmt(usage.requests) },
              { label: "Tokens In", value: fmt(usage.tokensIn) },
              { label: "Tokens Out", value: fmt(usage.tokensOut) },
              { label: "Cost", value: `$${(usage.cost ?? 0).toFixed(4)}` },
            ].map(({ label, value }) => (
              <Card key={label}>
                <CardContent className="pt-4">
                  <p className="text-xs text-muted-foreground uppercase tracking-wide">{label}</p>
                  <p className="text-2xl font-bold mt-1">{value}</p>
                </CardContent>
              </Card>
            ))}
          </div>

          {usage.byModel && Object.keys(usage.byModel).length > 0 && (
            <Card className="mt-4">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Usage by model</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {Object.entries(usage.byModel)
                    .sort(([, a], [, b]) => b.cost - a.cost)
                    .map(([model, stats]) => (
                      <div key={model} className="flex items-center gap-3 text-sm">
                        <span className="font-mono text-xs w-52 truncate">{model}</span>
                        <span className="text-muted-foreground">{fmt(stats.requests)} req</span>
                        <span className="ml-auto">${stats.cost.toFixed(4)}</span>
                      </div>
                    ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* Interval toggle */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Choose a plan</h2>
          <div className="flex items-center gap-1 border rounded-lg p-1 bg-muted/50">
            <Button
              variant={interval === "monthly" ? "default" : "ghost"}
              size="sm"
              onClick={() => setInterval("monthly")}
              className="h-7 text-xs"
            >
              Monthly
            </Button>
            <Button
              variant={interval === "annual" ? "default" : "ghost"}
              size="sm"
              onClick={() => setInterval("annual")}
              className="h-7 text-xs"
            >
              Annual
              <Badge className="ml-1.5 text-[10px] bg-green-600 text-white">-20%</Badge>
            </Button>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin mr-2" />
            Loading plans…
          </div>
        ) : plans.length === 0 ? (
          <Card>
            <CardContent className="pt-8 pb-8 text-center">
              <p className="text-muted-foreground text-sm">
                No plans configured — add STRIPE_SECRET_KEY to .env
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {plans.map((plan) => {
              const isCurrent =
                subscription?.planId === plan.id && subscription.status !== "canceled";
              const price = interval === "annual" ? plan.priceAnnual : plan.priceMonthly;
              const iconKey = plan.id.toLowerCase();
              return (
                <Card
                  key={plan.id}
                  className={`relative flex flex-col ${
                    plan.isPopular ? "border-indigo-500 shadow-lg" : ""
                  } ${isCurrent ? "border-green-500 bg-green-50/30 dark:bg-green-950/10" : ""}`}
                >
                  {plan.isPopular && !isCurrent && (
                    <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                      <Badge className="bg-indigo-600 text-white text-xs">Most Popular</Badge>
                    </div>
                  )}
                  {isCurrent && (
                    <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                      <Badge className="bg-green-600 text-white text-xs">Current Plan</Badge>
                    </div>
                  )}
                  <CardHeader className="pb-3">
                    <div className="flex items-center gap-2">
                      {PLAN_ICONS[iconKey] ?? (
                        <CreditCard className="w-5 h-5 text-muted-foreground" />
                      )}
                      <CardTitle className="text-base">{plan.name}</CardTitle>
                    </div>
                    {plan.description && (
                      <CardDescription className="text-xs">{plan.description}</CardDescription>
                    )}
                    <div className="mt-2">
                      {price !== undefined ? (
                        <p className="text-3xl font-bold">
                          ${price}
                          <span className="text-sm font-normal text-muted-foreground">
                            /{interval === "annual" ? "yr" : "mo"}
                          </span>
                        </p>
                      ) : (
                        <p className="text-3xl font-bold">Free</p>
                      )}
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
                    {plan.limits && Object.keys(plan.limits).length > 0 && (
                      <div className="border-t pt-2 space-y-1">
                        {Object.entries(plan.limits).map(([k, v]) => (
                          <div
                            key={k}
                            className="flex justify-between text-xs text-muted-foreground"
                          >
                            <span className="capitalize">{k.replace(/_/g, " ")}</span>
                            <span className="font-medium">
                              {typeof v === "number" ? fmt(v) : v}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                  <div className="p-4 pt-0">
                    {isCurrent ? (
                      <Button variant="outline" className="w-full" disabled>
                        <CheckCircle className="w-4 h-4 mr-2" />
                        Current plan
                      </Button>
                    ) : (
                      <Button
                        className="w-full"
                        variant={plan.isPopular ? "default" : "outline"}
                        onClick={() => handleCheckout(plan.id)}
                        disabled={checkingOut === plan.id}
                      >
                        {checkingOut === plan.id ? (
                          <>
                            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                            Redirecting…
                          </>
                        ) : (
                          <>
                            <ExternalLink className="w-4 h-4 mr-2" />
                            {price ? "Upgrade" : "Get started"}
                          </>
                        )}
                      </Button>
                    )}
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {/* Stripe disclaimer */}
      <p className="text-xs text-muted-foreground text-center">
        Payments are processed securely by Stripe. Nexus never stores card details.
      </p>
    </div>
  );
}
