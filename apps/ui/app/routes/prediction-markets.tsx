// SPDX-License-Identifier: Apache-2.0
/**
 * Prediction Markets — read-only dashboard over the existing
 * `@nexus/prediction-market`-backed API.
 *
 * API (all auth'd via authFetch):
 *   GET /api/v1/prediction-markets?category=&limit=  — { markets, total, fetchedAt }
 *
 * Data is upstream + cached server-side; this page just visualises it.
 */
import { TrendingUp, Loader2, AlertCircle, RefreshCw, Droplets } from "lucide-react";
import { useState, useEffect, useCallback } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { authFetch } from "~/lib/api";

interface Outcome {
  id: string;
  label: string;
  price: number;
  probability: number;
  volume24h?: number;
}

interface Market {
  id: string;
  question: string;
  category: string;
  outcomes: Outcome[];
  volume: number;
  liquidity: number;
  resolveAt?: string;
  fetchedAt: string;
}

const fmtNum = (n: number): string => {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
};

const pct = (p: number): string => `${Math.round(p * 100)}%`;

export default function PredictionMarketsPage() {
  const [markets, setMarkets] = useState<Market[]>([]);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [category, setCategory] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ limit: "50" });
      if (category.trim()) params.set("category", category.trim());
      const res = await authFetch(`/api/v1/prediction-markets?${params.toString()}`);
      if (res.status === 401) throw new Error("Please sign in to view markets.");
      if (res.status === 429) throw new Error("Rate limit exceeded — try again shortly.");
      if (!res.ok) throw new Error(`Failed to load markets (${res.status})`);
      const data = (await res.json()) as { markets: Market[]; fetchedAt?: string };
      setMarkets(data.markets ?? []);
      setFetchedAt(data.fetchedAt ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load markets");
    } finally {
      setLoading(false);
    }
  }, [category]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <TrendingUp className="size-5" /> Prediction Markets
          </h1>
          <p className="text-sm text-muted-foreground">
            Live market probabilities
            {fetchedAt ? ` · updated ${new Date(fetchedAt).toLocaleTimeString()}` : ""}.
          </p>
        </div>
        <Button variant="outline" onClick={() => void load()} className="gap-2" disabled={loading}>
          <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      <div className="flex items-center gap-2">
        <Input
          placeholder="Filter by category (e.g. politics)…"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void load();
          }}
          className="max-w-xs"
        />
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </div>
      ) : markets.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No markets found{category ? ` for “${category}”` : ""}.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {markets.map((m) => (
            <Card key={m.id}>
              <CardHeader className="space-y-2 py-4">
                <div className="flex items-start justify-between gap-3">
                  <CardTitle className="text-base leading-snug">{m.question}</CardTitle>
                  <Badge variant="outline" className="shrink-0 capitalize">
                    {m.category}
                  </Badge>
                </div>
                <div className="flex items-center gap-4 text-xs text-muted-foreground">
                  <span>Vol {fmtNum(m.volume)}</span>
                  <span className="flex items-center gap-1">
                    <Droplets className="size-3" /> {fmtNum(m.liquidity)}
                  </span>
                  {m.resolveAt && (
                    <span>Resolves {new Date(m.resolveAt).toLocaleDateString()}</span>
                  )}
                </div>
                <div className="space-y-1.5 pt-1">
                  {m.outcomes.slice(0, 4).map((o) => (
                    <div key={o.id} className="space-y-0.5">
                      <div className="flex items-center justify-between text-xs">
                        <span className="truncate">{o.label}</span>
                        <span className="font-medium tabular-nums">{pct(o.probability)}</span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-primary"
                          style={{ width: `${Math.min(100, Math.max(0, o.probability * 100))}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </CardHeader>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
