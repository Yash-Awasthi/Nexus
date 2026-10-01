// SPDX-License-Identifier: Apache-2.0
/**
 * Gateway — how Nexus routes your model calls: the failover chain in order, the free-only chain
 * (model "nexus/free"), which entries are resting after a rate limit, and cache counts.
 *
 *   GET /api/v1/gateway/chain — { chain, free, cache }
 */
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Page, PageHeader } from "~/components/page";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { apiFetch } from "~/lib/api";

interface Entry {
  id: string;
  provider: string;
  model: string;
  restingMs: number;
}

interface Chain {
  chain: Entry[];
  free: Entry[];
  cache: { enabled: boolean; hits: number; misses: number; skips: number; size: number };
}

const wait = (ms: number) => {
  const m = Math.floor(ms / 60_000);
  return m >= 60
    ? `${Math.floor(m / 60)}h ${m % 60}m`
    : m > 0
      ? `${m}m`
      : `${Math.ceil(ms / 1000)}s`;
};

function ChainCard({ title, hint, entries }: { title: string; hint: string; entries: Entry[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </CardHeader>
      <CardContent>
        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            None yet. Save a provider key under Settings.
          </p>
        ) : (
          <ol className="space-y-2">
            {entries.map((e, i) => (
              <li
                key={`${e.id}:${e.model}`}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
              >
                <span className="min-w-0 break-all">
                  <span className="mr-2 text-muted-foreground">{i + 1}.</span>
                  <span className="font-medium">{e.id.replace(/^user:/, "")}</span>
                  <span className="text-muted-foreground"> / {e.model}</span>
                </span>
                {e.restingMs > 0 ? (
                  <Badge variant="destructive">rate-limited, {wait(e.restingMs)} left</Badge>
                ) : (
                  <Badge variant="secondary">ready</Badge>
                )}
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

export default function Gateway() {
  const [data, setData] = useState<Chain | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setData(await apiFetch<Chain>("/api/v1/gateway/chain"));
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the gateway");
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 10_000);
    return () => clearInterval(timer);
  }, [load]);

  const cache = data?.cache;
  const lookups = cache ? cache.hits + cache.misses : 0;

  return (
    <Page width="default">
      <PageHeader
        title="Gateway"
        description={
          <>
            Calls try each provider in order and move on when one fails or is rate-limited. Use
            model <code>nexus/free</code> on /v1 to stay on free models.
          </>
        }
        actions={
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw /> Refresh
          </Button>
        }
      />
      {error && <p className="text-sm text-destructive">{error}</p>}
      {data && (
        <>
          <ChainCard
            title="Failover chain"
            hint="Your saved keys first, then the server's."
            entries={data.chain}
          />
          <ChainCard
            title="Free chain"
            hint="Every :free model your keys reach, then local models."
            entries={data.free}
          />
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Response cache</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <div>
                <div className="text-muted-foreground">Hits</div>
                <div className="text-lg font-semibold">{cache!.hits}</div>
              </div>
              <div>
                <div className="text-muted-foreground">Misses</div>
                <div className="text-lg font-semibold">{cache!.misses}</div>
              </div>
              <div>
                <div className="text-muted-foreground">Hit rate</div>
                <div className="text-lg font-semibold">
                  {lookups ? `${Math.round((cache!.hits / lookups) * 100)}%` : "—"}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground">Stored</div>
                <div className="text-lg font-semibold">{cache!.size}</div>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </Page>
  );
}
