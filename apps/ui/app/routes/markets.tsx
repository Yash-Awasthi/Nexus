// SPDX-License-Identifier: Apache-2.0
/**
 * Prediction markets — live markets, one outcome's order book, and a council
 * of your models forecasting the market against its price.
 *
 * API:
 *   GET  /api/v1/prediction-markets?source=         — open markets
 *   GET  /api/v1/prediction-markets/:id/book        — order book (Polymarket)
 *   POST /api/v1/prediction-markets/:id/forecast    — models forecast; consensus vs price
 */
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Page, PageHeader } from "~/components/page";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { apiFetch } from "~/lib/api";

interface Outcome {
  id: string;
  label: string;
  price: number;
}

interface Market {
  id: string;
  question: string;
  outcomes: Outcome[];
  volume: number;
  resolveAt?: string;
}

interface Level {
  price: number;
  size: number;
}

interface Book {
  bids: Level[];
  asks: Level[];
  midpoint: number | null;
  spread: number | null;
}

interface Forecast {
  marketYes: number;
  consensus: number | null;
  edge: number | null;
  predictions: { label: string; value: number | null; reasoning: string }[];
}

interface Member {
  label: string;
  provider: string;
  model: string;
}

const pct = (n: number | null | undefined) => (n == null ? "—" : `${Math.round(n * 1000) / 10}%`);

export default function MarketsPage() {
  const [source, setSource] = useState("polymarket");
  const [markets, setMarkets] = useState<Market[] | null>(null);
  const [selected, setSelected] = useState<Market | null>(null);
  const [book, setBook] = useState<Book | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [forecast, setForecast] = useState<Forecast | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async (src: string) => {
    setMarkets(null);
    setSelected(null);
    setError("");
    try {
      const res = await apiFetch<{ markets: Market[] }>(
        `/api/v1/prediction-markets?source=${src}&limit=25`,
      );
      setMarkets(res.markets);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setMarkets([]);
    }
  }, []);

  useEffect(() => {
    void load(source);
  }, [load, source]);

  useEffect(() => {
    apiFetch<{ keys: { provider: string; label?: string; models?: string[] }[] }>(
      "/api/user/provider-keys",
    )
      .then((res) =>
        setMembers(
          res.keys
            .flatMap((k) =>
              (k.models ?? []).map((model) => ({ label: model, provider: k.provider, model })),
            )
            .slice(0, 3),
        ),
      )
      .catch(() => setMembers([]));
  }, []);

  const open = async (m: Market) => {
    setSelected(m);
    setBook(null);
    setForecast(null);
    if (source !== "polymarket") return;
    try {
      setBook(await apiFetch<Book>(`/api/v1/prediction-markets/${encodeURIComponent(m.id)}/book`));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const runForecast = async () => {
    if (!selected) return;
    setBusy(true);
    setError("");
    try {
      setForecast(
        await apiFetch<Forecast>(
          `/api/v1/prediction-markets/${encodeURIComponent(selected.id)}/forecast?source=${source}`,
          { method: "POST", json: { members } },
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };

  return (
    <Page width="wide">
      <PageHeader
        title="Prediction markets"
        description="Open markets with their prices and order books. Ask your models for their own odds and see where they disagree with the market."
        actions={
          <Select value={source} onValueChange={setSource}>
            <SelectTrigger aria-label="Market source" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="polymarket">Polymarket</SelectItem>
              <SelectItem value="kalshi">Kalshi</SelectItem>
              <SelectItem value="metaculus">Metaculus</SelectItem>
            </SelectContent>
          </Select>
        }
      />

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      {selected && (
        <Card>
          <CardHeader>
            <CardTitle className="break-words">{selected.question}</CardTitle>
            <CardDescription>
              {selected.outcomes.map((o) => `${o.label} ${pct(o.price)}`).join(" · ")}
              {selected.resolveAt ? ` · resolves ${selected.resolveAt.slice(0, 10)}` : ""}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {book && (
              <div className="space-y-2">
                <p className="text-sm font-medium">
                  Order book for {selected.outcomes[0]?.label}: mid {pct(book.midpoint)}, spread{" "}
                  {pct(book.spread)}
                </p>
                <div className="grid grid-cols-2 gap-3 text-xs tabular-nums">
                  {(
                    [
                      ["Bids", book.bids, "text-success"],
                      ["Asks", book.asks, "text-destructive"],
                    ] as const
                  ).map(([title, levels, tone]) => (
                    <div key={title}>
                      <p className="mb-1 text-muted-foreground">{title}</p>
                      {levels.slice(0, 6).map((l) => (
                        <div key={l.price} className="flex justify-between">
                          <span className={tone}>{pct(l.price)}</span>
                          <span className="text-muted-foreground">
                            {Math.round(l.size).toLocaleString()}
                          </span>
                        </div>
                      ))}
                      {levels.length === 0 && <p className="text-muted-foreground">Empty</p>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">
                {members.length > 0
                  ? `Forecast with ${members.map((m) => m.label).join(", ")}`
                  : "Add a provider key with models under Models & keys to forecast."}
              </p>
              <Button onClick={runForecast} disabled={busy || members.length === 0}>
                {busy && <Loader2 className="size-4 animate-spin" />}
                Ask the council
              </Button>
            </div>

            {forecast && (
              <div className="space-y-2 text-sm">
                <p>
                  Council {pct(forecast.consensus)} vs market {pct(forecast.marketYes)}
                  {forecast.edge != null && (
                    <span className="text-muted-foreground">
                      {" "}
                      ({forecast.edge > 0 ? "+" : ""}
                      {Math.round(forecast.edge * 1000) / 10} points)
                    </span>
                  )}
                </p>
                <ul className="space-y-1 text-xs">
                  {forecast.predictions.map((p) => (
                    <li key={p.label} className="break-words">
                      <span className="font-medium">{p.label}</span> {pct(p.value)}
                      <span className="text-muted-foreground"> — {p.reasoning}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="py-2">
          {markets === null ? (
            <Loader2 className="mx-auto my-6 size-5 animate-spin text-muted-foreground" />
          ) : markets.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No open markets here.</p>
          ) : (
            <div className="divide-y divide-border">
              {markets.map((m) => (
                <button
                  key={m.id}
                  onClick={() => void open(m)}
                  className="flex w-full items-start justify-between gap-3 py-3 text-left hover:bg-muted/40"
                >
                  <span className="min-w-0 text-sm break-words">{m.question}</span>
                  <span className="shrink-0 text-sm font-medium tabular-nums">
                    {pct(m.outcomes[0]?.price)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </Page>
  );
}
