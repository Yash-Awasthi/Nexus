// SPDX-License-Identifier: Apache-2.0
import { Users, MessageSquare, Coins, DollarSign, AlertTriangle, Loader2 } from "lucide-react";
import {
  lazy,
  Suspense,
  useState,
  useEffect,
  Component,
  type ReactNode,
  type ErrorInfo,
} from "react";

import { Page, PageHeader } from "~/components/page";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "~/components/ui/card";

const LazyCharts = lazy(() => import("~/components/analytics-charts"));

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
}
interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class ChartsErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }
  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Analytics charts failed to load:", error, errorInfo);
  }
  render() {
    if (this.state.hasError) {
      return (
        this.props.fallback ?? (
          <Card>
            <CardContent className="py-8">
              <div className="flex flex-col items-center gap-3 text-center">
                <AlertTriangle className="size-8 text-warning" />
                <div>
                  <p className="text-sm font-medium">Charts failed to load</p>
                  <p className="text-xs text-muted-foreground mt-1">{this.state.error?.message}</p>
                </div>
                <button
                  onClick={() => this.setState({ hasError: false, error: null })}
                  className="text-xs text-primary hover:underline mt-1"
                >
                  Try again
                </button>
              </div>
            </CardContent>
          </Card>
        )
      );
    }
    return this.props.children;
  }
}

function ClientOnly({ children, fallback }: { children: ReactNode; fallback: ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted ? <>{children}</> : <>{fallback}</>;
}

// ─── Stat card types ──────────────────────────────────────────────────────────

interface StatCard {
  label: string;
  value: string;
  icon: React.ElementType;
  color: string;
}

/** What `GET /api/analytics/overview` returns, minus the fields this page does not show. */
interface Overview {
  totalUsers: number | null;
  requests: number;
  tokens: number;
  costUsd: number;
  latencyP50ms?: number | null;
  latencyP99ms?: number | null;
  errorRate?: number | null;
  /** `gateway-log` when the traffic log answered, `cost-log` when it could not. */
  source?: "gateway-log" | "cost-log";
}

const DEFAULT_STATS: StatCard[] = [
  { label: "Accounts", value: "—", icon: Users, color: "text-primary" },
  { label: "Model requests", value: "—", icon: MessageSquare, color: "text-success" },
  { label: "Tokens used", value: "—", icon: Coins, color: "text-warning" },
  { label: "Model spend", value: "—", icon: DollarSign, color: "text-primary" },
];

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

/**
 * Zero from the API means two different things. A server that has never served a
 * request reports `0` requests and `$0.00` spend, and this page used to print both
 * as if they were measurements — the numbers a quiet instance shows are the same
 * ones a broken one shows. Nothing recorded is now its own state.
 */
function hasRecordedTraffic(overview: Overview | null): boolean {
  if (!overview) return false;
  return overview.requests > 0 || overview.tokens > 0 || overview.costUsd > 0;
}

/** The four headline numbers, or an em dash where the API has nothing to say. */
function statCardsFor(overview: Overview | null): StatCard[] {
  if (!hasRecordedTraffic(overview) || !overview) return DEFAULT_STATS;
  const values = [
    overview.totalUsers === null ? "—" : String(overview.totalUsers),
    compact.format(overview.requests),
    compact.format(overview.tokens),
    `$${overview.costUsd.toFixed(2)}`,
  ];
  return DEFAULT_STATS.map((card, i) => ({ ...card, value: values[i]! }));
}

// ─── Page Component ───────────────────────────────────────────────────────────

export default function AdminAnalyticsPage() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  // ── Fetch overview stats from backend ─────────────────────────────────────
  useEffect(() => {
    fetch("/api/analytics/overview")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data: Overview) => setOverview(data))
      .catch(() => setFailed(true))
      .finally(() => setLoading(false));
  }, []);

  const statCards = statCardsFor(overview);
  const empty = !loading && !failed && !hasRecordedTraffic(overview);

  return (
    <Page width="wide">
      <PageHeader
        title="Analytics"
        description="Calls, tokens, cost and latency across every account on this server."
      />

      {failed ? (
        <Card>
          <CardContent className="flex items-center gap-3 py-6">
            <AlertTriangle className="size-5 text-warning" />
            <div>
              <p className="text-sm font-medium">Could not load analytics</p>
              <p className="text-xs text-muted-foreground mt-1">
                The overview request failed, so nothing below is a measurement.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : empty ? (
        <Card data-testid="analytics-empty">
          <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
            <MessageSquare className="size-8 text-muted-foreground" />
            <p className="text-sm font-medium">No model traffic recorded yet</p>
            <p className="text-xs text-muted-foreground max-w-md">
              These numbers count requests through the gateway on this server. They stay dashes
              until the first call lands — an empty server is not a measured zero.
            </p>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {statCards.map((stat) => {
          const Icon = stat.icon;
          return (
            <Card key={stat.label}>
              <CardContent className="flex items-center gap-3 py-4">
                <div className="size-10 rounded-lg bg-muted flex items-center justify-center">
                  {loading ? (
                    <Loader2 className="size-5 animate-spin text-muted-foreground" />
                  ) : (
                    <Icon className={"size-5 " + stat.color} />
                  )}
                </div>
                <div>
                  <p className="text-2xl font-semibold">{stat.value}</p>
                  <p className="text-xs text-muted-foreground">{stat.label}</p>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <ClientOnly
        fallback={
          <div className="space-y-4">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <Card>
                <CardHeader>
                  <CardTitle>Daily Conversations</CardTitle>
                  <CardDescription>Last 7 days</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="h-[200px] bg-muted/30 rounded animate-pulse" />
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Provider Usage</CardTitle>
                  <CardDescription>Request distribution across providers</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="h-[200px] bg-muted/30 rounded animate-pulse" />
                </CardContent>
              </Card>
            </div>
            <Card>
              <CardHeader>
                <CardTitle>Requests &amp; Costs Over Time</CardTitle>
                <CardDescription>Last 30 days</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="h-[240px] bg-muted/30 rounded animate-pulse" />
              </CardContent>
            </Card>
          </div>
        }
      >
        <Suspense fallback={<div className="h-[200px] bg-muted/30 rounded animate-pulse" />}>
          <ChartsErrorBoundary>
            <LazyCharts />
          </ChartsErrorBoundary>
        </Suspense>
      </ClientOnly>
    </Page>
  );
}
