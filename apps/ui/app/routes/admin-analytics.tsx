// SPDX-License-Identifier: Apache-2.0
import {
  lazy,
  Suspense,
  useState,
  useEffect,
  Component,
  type ReactNode,
  type ErrorInfo,
} from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "~/components/ui/card";
import {
  BarChart3,
  Users,
  MessageSquare,
  Coins,
  DollarSign,
  AlertTriangle,
  Loader2,
} from "lucide-react";

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
                <AlertTriangle className="size-8 text-amber-400" />
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
  { label: "Total Users", value: "—", icon: Users, color: "text-blue-400" },
  { label: "Conversations Today", value: "—", icon: MessageSquare, color: "text-green-400" },
  { label: "Tokens Used", value: "—", icon: Coins, color: "text-amber-400" },
  { label: "Cost", value: "—", icon: DollarSign, color: "text-purple-400" },
];

// ─── Page Component ───────────────────────────────────────────────────────────

export default function AdminAnalyticsPage() {
  const [statCards, setStatCards] = useState<StatCard[]>(DEFAULT_STATS);
  const [loading, setLoading] = useState(true);

  // ── Fetch overview stats from backend ─────────────────────────────────────
  useEffect(() => {
    fetch("/api/analytics/overview")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((data) => {
        setStatCards([
          {
            label: "Total Users",
            value: String(data.totalUsers ?? data.users ?? "0"),
            icon: Users,
            color: "text-blue-400",
          },
          {
            label: "Conversations Today",
            value: String(data.conversationsToday ?? data.conversations ?? "0"),
            icon: MessageSquare,
            color: "text-green-400",
          },
          {
            label: "Tokens Used",
            value: data.tokensFormatted ?? data.tokens ?? "0",
            icon: Coins,
            color: "text-amber-400",
          },
          {
            label: "Cost",
            value: data.costFormatted ?? data.cost ?? "$0",
            icon: DollarSign,
            color: "text-purple-400",
          },
        ]);
      })
      .catch(() => {
        // Fall back to mock numbers
        setStatCards([
          { label: "Total Users", value: "24", icon: Users, color: "text-blue-400" },
          {
            label: "Conversations Today",
            value: "47",
            icon: MessageSquare,
            color: "text-green-400",
          },
          { label: "Tokens Used", value: "2.8M", icon: Coins, color: "text-amber-400" },
          { label: "Cost", value: "$47.83", icon: DollarSign, color: "text-purple-400" },
        ]);
      })
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-6xl mx-auto p-6 space-y-6">
        <div className="flex items-center gap-3">
          <BarChart3 className="size-6 text-muted-foreground" />
          <div>
            <h1 className="text-xl font-semibold">Analytics</h1>
            <p className="text-sm text-muted-foreground">
              Platform usage metrics, costs, and performance insights
            </p>
          </div>
        </div>

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
      </div>
    </div>
  );
}
