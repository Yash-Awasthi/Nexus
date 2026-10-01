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

const DEFAULT_STATS: StatCard[] = [
  { label: "Accounts", value: "—", icon: Users, color: "text-primary" },
  { label: "Model requests", value: "—", icon: MessageSquare, color: "text-success" },
  { label: "Tokens used", value: "—", icon: Coins, color: "text-warning" },
  { label: "Model spend", value: "—", icon: DollarSign, color: "text-primary" },
];

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

// ─── Page Component ───────────────────────────────────────────────────────────

export default function AdminAnalyticsPage() {
  const [statCards, setStatCards] = useState<StatCard[]>(DEFAULT_STATS);
  const [loading, setLoading] = useState(true);

  // ── Fetch overview stats from backend ─────────────────────────────────────
  useEffect(() => {
    fetch("/api/analytics/overview")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(
        (data: {
          totalUsers: number | null;
          requests: number;
          tokens: number;
          costUsd: number;
        }) => {
          const values = [
            data.totalUsers === null ? "—" : String(data.totalUsers),
            compact.format(data.requests),
            compact.format(data.tokens),
            `$${data.costUsd.toFixed(2)}`,
          ];
          setStatCards(DEFAULT_STATS.map((card, i) => ({ ...card, value: values[i]! })));
        },
      )
      .catch(() => setStatCards(DEFAULT_STATS))
      .finally(() => setLoading(false));
  }, []);

  return (
    <Page width="wide">
      <PageHeader
        title="Analytics"
        description="Calls, tokens, cost and latency across every account on this server."
      />

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
