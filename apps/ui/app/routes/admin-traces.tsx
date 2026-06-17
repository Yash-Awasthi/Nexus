/**
 * Admin — Traces Viewer
 *
 * Shows all AI model calls with latency, tokens, cost.
 * Useful for debugging deliberations and monitoring model usage.
 *
 * GET /api/traces?page=1&limit=20&type=...
 * GET /api/traces/:id
 */

import { useState, useEffect, useCallback } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { ScrollArea } from "~/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  Activity, ChevronLeft, ChevronRight, RefreshCw, X,
  Clock, Cpu, DollarSign, Search, Loader2,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface TraceRow {
  id:             string;
  conversationId?: string;
  workflowRunId?:  string;
  type:            string;
  totalLatencyMs?: number;
  totalTokens?:    number;
  totalCostUsd?:   number;
  createdAt:       string;
}

interface TraceDetail extends TraceRow {
  steps?:     unknown[];
  inputText?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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

function latencyColor(ms?: number) {
  if (!ms) return "text-muted-foreground";
  if (ms < 1000)  return "text-green-400";
  if (ms < 5000)  return "text-amber-400";
  return "text-red-400";
}

// ── Trace detail panel ────────────────────────────────────────────────────────

function TraceDetailPanel({
  traceId, onClose,
}: {
  traceId: string;
  onClose: () => void;
}) {
  const [trace, setTrace] = useState<TraceDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/traces/${traceId}`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => setTrace(data?.trace ?? data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [traceId]);

  return (
    <div
      className="w-96 shrink-0 flex flex-col border-l border-border"
      style={{ background: "hsl(var(--card))" }}
    >
      <div className="border-b border-border px-4 py-3 flex items-center gap-2">
        <span className="text-xs font-semibold flex-1 truncate font-mono">{traceId}</span>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
          <X className="size-4" />
        </button>
      </div>
      <ScrollArea className="flex-1 p-4">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : !trace ? (
          <p className="text-xs text-muted-foreground text-center py-4">Trace not found</p>
        ) : (
          <div className="space-y-4 text-xs">
            <div className="grid grid-cols-2 gap-2">
              <div className="p-2 rounded-lg" style={{ background: "hsl(var(--muted)/0.4)" }}>
                <p className="text-muted-foreground mb-1">Latency</p>
                <p className={`font-mono font-medium ${latencyColor(trace.totalLatencyMs)}`}>{fmtMs(trace.totalLatencyMs)}</p>
              </div>
              <div className="p-2 rounded-lg" style={{ background: "hsl(var(--muted)/0.4)" }}>
                <p className="text-muted-foreground mb-1">Tokens</p>
                <p className="font-mono font-medium">{fmtTokens(trace.totalTokens)}</p>
              </div>
              <div className="p-2 rounded-lg" style={{ background: "hsl(var(--muted)/0.4)" }}>
                <p className="text-muted-foreground mb-1">Cost</p>
                <p className="font-mono font-medium text-green-400">{fmtCost(trace.totalCostUsd)}</p>
              </div>
              <div className="p-2 rounded-lg" style={{ background: "hsl(var(--muted)/0.4)" }}>
                <p className="text-muted-foreground mb-1">Type</p>
                <p className="font-mono font-medium capitalize">{trace.type}</p>
              </div>
            </div>

            {trace.conversationId && (
              <div>
                <p className="text-muted-foreground mb-1">Conversation</p>
                <p className="font-mono text-[10px] break-all">{trace.conversationId}</p>
              </div>
            )}

            <div>
              <p className="text-muted-foreground mb-1">Created</p>
              <p className="font-mono">{new Date(trace.createdAt).toLocaleString()}</p>
            </div>

            {Array.isArray(trace.steps) && trace.steps.length > 0 && (
              <div>
                <p className="text-muted-foreground mb-2">Steps ({trace.steps.length})</p>
                <div className="space-y-2">
                  {trace.steps.map((step: any, i) => (
                    <div
                      key={i}
                      className="p-2 rounded-lg text-[10px]"
                      style={{ background: "hsl(var(--muted)/0.3)", border: "1px solid hsl(var(--border)/0.4)" }}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <span className="font-medium">{step.model ?? step.type ?? `Step ${i + 1}`}</span>
                        <span className="text-muted-foreground">{fmtMs(step.latencyMs)}</span>
                      </div>
                      {step.tokens && <p className="text-muted-foreground">{step.tokens} tokens</p>}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

const TYPE_OPTIONS = [
  { value: "all",        label: "All types" },
  { value: "deliberate", label: "Deliberate" },
  { value: "ultraplinian", label: "ULTRAPLINIAN" },
  { value: "research",   label: "Research" },
  { value: "chat",       label: "Chat" },
  { value: "embedding",  label: "Embedding" },
];

export default function AdminTracesPage() {
  const [traces, setTraces]   = useState<TraceRow[]>([]);
  const [total, setTotal]     = useState(0);
  const [page, setPage]       = useState(1);
  const [pages, setPages]     = useState(1);
  const [loading, setLoading] = useState(false);
  const [search, setSearch]   = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [selected, setSelected] = useState<string | null>(null);

  const fetchTraces = useCallback(async (pg = page, type = typeFilter) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(pg), limit: "25" });
      if (type && type !== "all") params.set("type", type);
      const res = await fetch(`/api/traces?${params}`);
      if (res.ok) {
        const data = await res.json();
        setTraces(data.traces ?? []);
        setTotal(data.total ?? 0);
        setPages(data.pages ?? 1);
        setPage(pg);
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, [page, typeFilter]);

  useEffect(() => { fetchTraces(1, typeFilter); }, [typeFilter]);

  const filtered = traces.filter((t) =>
    !search ||
    t.id.toLowerCase().includes(search.toLowerCase()) ||
    t.type.toLowerCase().includes(search.toLowerCase()) ||
    (t.conversationId ?? "").toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="flex h-screen overflow-hidden">
      <div className="flex-1 flex flex-col overflow-hidden">

        {/* Header */}
        <div className="border-b border-border px-6 py-4 shrink-0 flex items-center gap-3">
          <Activity className="size-4 text-primary" />
          <h1 className="text-sm font-semibold">AI Traces</h1>
          <Badge variant="outline" className="text-xs">{total} total</Badge>
          <div className="ml-auto flex items-center gap-2">
            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger className="h-7 text-xs w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TYPE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value} className="text-xs">{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search traces…"
                className="pl-7 h-7 text-xs w-48"
              />
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={() => fetchTraces(page)}
              disabled={loading}
            >
              <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </div>

        <div className="flex flex-1 overflow-hidden">
          {/* Table */}
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* Column headers */}
            <div
              className="grid text-[10px] text-muted-foreground uppercase tracking-wider px-4 py-2 border-b border-border shrink-0"
              style={{ gridTemplateColumns: "1fr 100px 90px 80px 80px 140px" }}
            >
              <span>ID / Conversation</span>
              <span>Type</span>
              <span><Clock className="size-3 inline mr-1" />Latency</span>
              <span><Cpu className="size-3 inline mr-1" />Tokens</span>
              <span><DollarSign className="size-3 inline mr-1" />Cost</span>
              <span>Created</span>
            </div>

            <ScrollArea className="flex-1">
              {loading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="size-5 animate-spin text-muted-foreground" />
                </div>
              ) : filtered.length === 0 ? (
                <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">
                  No traces found
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {filtered.map((t) => (
                    <button
                      key={t.id}
                      onClick={() => setSelected(selected === t.id ? null : t.id)}
                      className="w-full grid text-xs px-4 py-3 text-left hover:bg-muted/30 transition-colors"
                      style={{
                        gridTemplateColumns: "1fr 100px 90px 80px 80px 140px",
                        background: selected === t.id ? "hsl(var(--primary)/0.05)" : undefined,
                      }}
                    >
                      <div className="min-w-0">
                        <p className="font-mono text-[10px] truncate">{t.id}</p>
                        {t.conversationId && (
                          <p className="text-muted-foreground text-[10px] truncate">{t.conversationId}</p>
                        )}
                      </div>
                      <div>
                        <Badge variant="outline" className="text-[10px] capitalize">{t.type}</Badge>
                      </div>
                      <p className={`font-mono ${latencyColor(t.totalLatencyMs)}`}>{fmtMs(t.totalLatencyMs)}</p>
                      <p className="font-mono text-muted-foreground">{fmtTokens(t.totalTokens)}</p>
                      <p className="font-mono text-green-400">{fmtCost(t.totalCostUsd)}</p>
                      <p className="text-muted-foreground">{new Date(t.createdAt).toLocaleString()}</p>
                    </button>
                  ))}
                </div>
              )}
            </ScrollArea>

            {/* Pagination */}
            {pages > 1 && (
              <div className="border-t border-border px-4 py-2.5 flex items-center justify-between shrink-0 text-xs text-muted-foreground">
                <span>Page {page} of {pages} · {total} traces</span>
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    disabled={page <= 1 || loading}
                    onClick={() => fetchTraces(page - 1)}
                  >
                    <ChevronLeft className="size-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    disabled={page >= pages || loading}
                    onClick={() => fetchTraces(page + 1)}
                  >
                    <ChevronRight className="size-3.5" />
                  </Button>
                </div>
              </div>
            )}
          </div>

          {/* Detail panel */}
          {selected && (
            <TraceDetailPanel traceId={selected} onClose={() => setSelected(null)} />
          )}
        </div>
      </div>
    </div>
  );
}
