// SPDX-License-Identifier: Apache-2.0
import { CheckCircle2, CircleAlert, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import type { Route } from "./+types/status";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Status · Nexus" }];
}

interface Ready {
  status: "ready" | "not_ready";
  checks: Record<string, string>;
  latencies?: Record<string, number>;
}

const NAMES: Record<string, string> = {
  db: "Database",
  kv: "Key-value store",
  costlog_flush: "Usage log",
  redis: "Job queue",
};

export default function Status() {
  const [live, setLive] = useState<{ version: string } | null | "down">(null);
  const [ready, setReady] = useState<Ready | null>(null);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  const [loading, setLoading] = useState(false);

  const check = useCallback(async () => {
    setLoading(true);
    const [l, r] = await Promise.allSettled([
      fetch("/health", { cache: "no-store" }).then((x) => (x.ok ? x.json() : Promise.reject())),
      fetch("/health/ready", { cache: "no-store" }).then((x) => x.json()),
    ]);
    setLive(l.status === "fulfilled" ? (l.value as { version: string }) : "down");
    setReady(r.status === "fulfilled" ? (r.value as Ready) : null);
    setCheckedAt(new Date());
    setLoading(false);
  }, []);

  useEffect(() => {
    void check();
    const t = setInterval(() => void check(), 30_000);
    return () => clearInterval(t);
  }, [check]);

  const up = live !== "down" && live !== null && ready?.status === "ready";

  return (
    <div className="mx-auto max-w-2xl px-4 py-16 sm:px-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Status</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {checkedAt ? `Checked ${checkedAt.toLocaleTimeString()}` : "Checking…"}
            {live && live !== "down" ? ` · version ${live.version}` : ""}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void check()} disabled={loading}>
          <RefreshCw className={cn(loading && "animate-spin")} /> Refresh
        </Button>
      </div>

      <div
        className={cn(
          "mt-8 flex items-center gap-3 rounded-xl border p-4",
          live === null
            ? ""
            : up
              ? "border-success/40 bg-success/10"
              : "border-destructive/40 bg-destructive/10",
        )}
      >
        {up ? (
          <CheckCircle2 className="size-5 text-success" />
        ) : (
          <CircleAlert
            className={cn("size-5", live === null ? "text-muted-foreground" : "text-destructive")}
          />
        )}
        <p className="font-medium">
          {live === null
            ? "Checking services…"
            : up
              ? "All services are running"
              : live === "down"
                ? "The API is not answering"
                : "Some services are not ready"}
        </p>
      </div>

      {ready && (
        <ul className="mt-6 divide-y rounded-xl border bg-card">
          {Object.entries(ready.checks).map(([key, state]) => (
            <li key={key} className="flex items-center gap-3 px-4 py-3 text-sm">
              <span
                className={cn(
                  "size-2 rounded-full",
                  state === "ok" ? "bg-success" : "bg-destructive",
                )}
              />
              <span className="flex-1">{NAMES[key] ?? key}</span>
              {ready.latencies?.[key] !== undefined && (
                <span className="text-xs text-muted-foreground">{ready.latencies[key]} ms</span>
              )}
              <span className={cn("text-xs", state === "ok" ? "text-success" : "text-destructive")}>
                {state === "ok" ? "Operational" : state}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
