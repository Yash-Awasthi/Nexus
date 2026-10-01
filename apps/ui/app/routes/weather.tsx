// SPDX-License-Identifier: Apache-2.0
/**
 * Weather — seven-day forecast for a city.
 *
 * API: GET /api/v1/forecast/weather?city=
 */
import { Loader2, Search } from "lucide-react";
import { useState } from "react";

import { Page, PageHeader } from "~/components/page";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { apiFetch } from "~/lib/api";

interface Day {
  id: string;
  label: string;
  description: string;
}

interface WeatherResult {
  summary: string;
  indicators: { source?: string };
  scenarios: Day[];
}

const weekday = (iso: string) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });

export default function WeatherPage() {
  const [city, setCity] = useState("");
  const [result, setResult] = useState<WeatherResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const look = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await apiFetch<{ result: WeatherResult }>(
        `/api/v1/forecast/weather?city=${encodeURIComponent(city.trim())}`,
      );
      setResult(res.result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };

  return (
    <Page width="default">
      <PageHeader title="Weather" description="Seven-day forecast for any city." />

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (city.trim()) void look();
        }}
      >
        <Input
          aria-label="City"
          placeholder="e.g. Oslo"
          value={city}
          onChange={(e) => setCity(e.target.value)}
          className="min-w-0 flex-1"
        />
        <Button type="submit" disabled={busy || !city.trim()} aria-label="Look up">
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
        </Button>
      </form>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      {result && (
        <Card>
          <CardHeader>
            <CardTitle className="break-words">{result.summary}</CardTitle>
            {result.indicators.source && result.indicators.source !== "noop" && (
              <CardDescription>Source: {result.indicators.source}</CardDescription>
            )}
          </CardHeader>
          {result.scenarios.length > 0 && (
            <CardContent className="divide-y divide-border py-0">
              {result.scenarios.map((d) => (
                <div key={d.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span className="w-24 shrink-0 font-medium">{weekday(d.label)}</span>
                  <span className="min-w-0 flex-1 break-words text-muted-foreground">
                    {d.description}
                  </span>
                </div>
              ))}
            </CardContent>
          )}
        </Card>
      )}
    </Page>
  );
}
