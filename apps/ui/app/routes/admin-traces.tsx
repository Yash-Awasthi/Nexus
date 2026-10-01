// SPDX-License-Identifier: Apache-2.0
/**
 * Admin — traces: every model call per request, with latency, tokens and cost.
 *
 * GET /api/traces?page=1&limit=25&type=...
 * GET /api/traces/:id
 */

import { ChevronLeft, ChevronRight, Loader2, RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Page, PageHeader } from "~/components/page";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "~/components/ui/sheet";

interface TraceRow {
  id: string;
  path?: string;
  type: string;
  totalLatencyMs?: number;
  totalTokens?: number;
  totalCostUsd?: number;
  createdAt: string;
}

interface TraceStep {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  cached: boolean;
  error?: string;
}

interface TraceDetail extends TraceRow {
  steps?: TraceStep[];
}

function fmtMs(ms?: number) {
  if (!ms) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`;
}

function fmtTokens(t?: number) {
  if (!t) return "—";
  return t >= 1000 ? `${(t / 1000).toFixed(1)}k` : String(t);
}

function fmtCost(c?: number) {
  if (!c) return "—";
  return c < 0.001 ? `$${(c * 1000).toFixed(3)}m` : `$${c.toFixed(4)}`;
}

function latencyTone(ms?: number) {
  if (!ms) return "text-muted-foreground";
  if (ms < 1000) return "text-success";
  if (ms < 5000) return "text-warning";
  return "text-destructive";
}

const TYPES = ["all", "deliberate", "chat", "research", "embedding"];

function TraceDetailSheet({ traceId, onClose }: { traceId: string | null; onClose: () => void }) {
  const [trace, setTrace] = useState<TraceDetail | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!traceId) return;
    setLoading(true);
    setTrace(null);
    fetch(`/api/traces/${traceId}`)
      .then((r) => (r.ok ? (r.json() as Promise<TraceDetail>) : null))
      .then(setTrace)
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, [traceId]);

  const stats = trace
    ? [
        ["Latency", fmtMs(trace.totalLatencyMs), latencyTone(trace.totalLatencyMs)],
        ["Tokens", fmtTokens(trace.totalTokens), ""],
        ["Cost", fmtCost(trace.totalCostUsd), ""],
        ["Type", trace.type, "capitalize"],
      ]
    : [];

  return (
    <Sheet open={!!traceId} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="truncate pr-8 font-mono text-sm">{traceId}</SheetTitle>
        </SheetHeader>
        <div className="space-y-4 px-4 pb-6 text-sm">
          {loading ? (
            <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />
          ) : !trace ? (
            <p className="text-center text-muted-foreground">Trace not found.</p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2">
                {stats.map(([label, value, tone]) => (
                  <div key={label} className="rounded-lg bg-muted/50 p-3">
                    <p className="text-xs text-muted-foreground">{label}</p>
                    <p className={`font-mono font-medium ${tone}`}>{value}</p>
                  </div>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                {trace.path} · {new Date(trace.createdAt).toLocaleString()}
              </p>
              {trace.steps && trace.steps.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground">
                    Model calls ({trace.steps.length})
                  </p>
                  {trace.steps.map((step, i) => (
                    <div key={i} className="rounded-lg border p-3 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-medium">
                          {step.model || `Call ${i + 1}`}
                        </span>
                        <span className="text-muted-foreground">{fmtMs(step.latencyMs)}</span>
                      </div>
                      <p className="mt-1 text-muted-foreground">
                        {step.provider} · {step.inputTokens} in / {step.outputTokens} out
                        {step.cached ? " · cached" : ""}
                      </p>
                      {step.error && (
                        <p className="mt-1 break-words text-destructive">{step.error}</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

export default function AdminTracesPage() {
  const [traces, setTraces] = useState<TraceRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [type, setType] = useState("all");
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(
    async (pg: number) => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ page: String(pg), limit: "25" });
        if (type !== "all") params.set("type", type);
        const res = await fetch(`/api/traces?${params}`);
        if (res.ok) {
          const data = (await res.json()) as {
            traces?: TraceRow[];
            total?: number;
            pages?: number;
          };
          setTraces(data.traces ?? []);
          setTotal(data.total ?? 0);
          setPages(data.pages ?? 1);
          setPage(pg);
        }
      } catch {
        /* the table keeps its rows */
      }
      setLoading(false);
    },
    [type],
  );

  useEffect(() => {
    void load(1);
  }, [load]);

  const q = search.toLowerCase();
  const filtered = traces.filter(
    (t) => !q || t.id.toLowerCase().includes(q) || (t.path ?? "").toLowerCase().includes(q),
  );

  return (
    <Page width="wide">
      <PageHeader
        title="Traces"
        description={`Model calls per request — provider, tokens, latency and cost. ${total} kept.`}
        actions={
          <Button variant="outline" size="sm" onClick={() => void load(page)} disabled={loading}>
            {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            Refresh
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[200px] max-w-sm flex-1">
          <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by id or path…"
            className="pl-8"
          />
        </div>
        <select
          value={type}
          onChange={(e) => setType(e.target.value)}
          aria-label="Trace type"
          className="h-9 rounded-md border border-input bg-background px-2 text-sm capitalize"
        >
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {t === "all" ? "All types" : t}
            </option>
          ))}
        </select>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="px-4 py-3 font-medium">Request</th>
                  <th className="px-4 py-3 font-medium">Type</th>
                  <th className="px-4 py-3 font-medium">Latency</th>
                  <th className="px-4 py-3 font-medium">Tokens</th>
                  <th className="px-4 py-3 font-medium">Cost</th>
                  <th className="px-4 py-3 font-medium">When</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((t) => (
                  <tr
                    key={t.id}
                    onClick={() => setSelected(t.id)}
                    className="cursor-pointer border-b border-border/50 hover:bg-muted/30"
                  >
                    <td className="max-w-[16rem] px-4 py-3">
                      <p className="truncate font-mono text-xs">{t.path ?? t.id}</p>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant="outline" className="capitalize">
                        {t.type}
                      </Badge>
                    </td>
                    <td className={`px-4 py-3 font-mono ${latencyTone(t.totalLatencyMs)}`}>
                      {fmtMs(t.totalLatencyMs)}
                    </td>
                    <td className="px-4 py-3 font-mono text-muted-foreground">
                      {fmtTokens(t.totalTokens)}
                    </td>
                    <td className="px-4 py-3 font-mono">{fmtCost(t.totalCostUsd)}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">
                      {new Date(t.createdAt).toLocaleString()}
                    </td>
                  </tr>
                ))}
                {!loading && filtered.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                      No traces yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {pages > 1 && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            Page {page} of {pages}
          </span>
          <div className="flex gap-1">
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Previous page"
              disabled={page <= 1 || loading}
              onClick={() => void load(page - 1)}
            >
              <ChevronLeft />
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Next page"
              disabled={page >= pages || loading}
              onClick={() => void load(page + 1)}
            >
              <ChevronRight />
            </Button>
          </div>
        </div>
      )}

      <TraceDetailSheet traceId={selected} onClose={() => setSelected(null)} />
    </Page>
  );
}
