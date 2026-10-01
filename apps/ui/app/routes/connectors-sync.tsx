// SPDX-License-Identifier: Apache-2.0
/**
 * Connector Sync Dashboard
 *
 * Full-page route wrapping ConnectorSyncPanel.
 * Lists all connectors, shows sync job history per connector,
 * and allows triggering/scheduling new syncs.
 */

import {
  RefreshCw,
  Search,
  Plug,
  CheckCircle2,
  AlertCircle,
  Clock,
  Loader2,
  Radio,
  Plus,
} from "lucide-react";
import { useState, useEffect, useRef, useCallback } from "react";
import { Link } from "react-router";

import { ConnectorSyncPanel } from "~/components/ConnectorSyncPanel";
import { EmptyState, Page, PageHeader } from "~/components/page";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { cn } from "~/lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Connector {
  id: string;
  name: string;
  source: string;
  status: "active" | "error" | "disabled" | "not_attempted";
  lastSyncAt?: string;
  syncedDocs: number;
  errorMsg?: string;
}

// ── Connector status helpers ──────────────────────────────────────────────────

const STATUS_ICONS: Record<Connector["status"], React.ReactNode> = {
  active: <CheckCircle2 className="size-3.5 text-success" />,
  error: <AlertCircle className="size-3.5 text-destructive" />,
  disabled: <Clock className="size-3.5 text-muted-foreground" />,
  not_attempted: <Clock className="size-3.5 text-muted-foreground" />,
};

const STATUS_LABEL: Record<Connector["status"], string> = {
  active: "Active",
  error: "Error",
  disabled: "Disabled",
  not_attempted: "Never synced",
};

// ── Sync job status shape (for live-polling active jobs) ──────────────────────

interface SyncJob {
  id: string;
  connectorId: string;
  status: "pending" | "running" | "completed" | "failed";
  startedAt?: string;
  completedAt?: string;
}

const POLL_INTERVAL_MS = 5_000; // refresh active jobs every 5 s

export default function ConnectorsSyncPage() {
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [activeJobs, setActiveJobs] = useState<SyncJob[]>([]);
  const [polling, setPolling] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const selectedRef = useRef<string | null>(null);

  // Keep ref in sync so polling closure sees latest selected
  selectedRef.current = selected;

  const fetchConnectors = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/connectors");
      if (!res.ok) throw new Error(`Failed to load connectors (${res.status})`);
      const data = (await res.json()) as {
        connectors?: {
          id: string;
          name: string;
          source: string;
          status: string;
          lastSyncAt: string | null;
          totalDocCount: number;
          errorMsg: string | null;
        }[];
      };
      const list: Connector[] = (data.connectors ?? []).map((c) => ({
        id: c.id,
        name: c.name,
        source: c.source,
        status: c.status === "error" ? "error" : c.lastSyncAt ? "active" : "not_attempted",
        lastSyncAt: c.lastSyncAt ?? undefined,
        syncedDocs: c.totalDocCount,
        errorMsg: c.errorMsg ?? undefined,
      }));
      setConnectors(list);
      setLastRefreshed(new Date());
      const wanted = new URLSearchParams(window.location.search).get("id");
      if (!selectedRef.current && list.length > 0) {
        setSelected(list.find((c) => c.id === wanted)?.id ?? list[0].id);
      }
    } catch (err) {
      if (!silent) setError(err instanceof Error ? err.message : "Unknown error");
    }
    if (!silent) setLoading(false);
  }, []);

  // Fetch active sync jobs (pending + running) for the selected connector
  const fetchActiveJobs = useCallback(async () => {
    const id = selectedRef.current;
    if (!id) return;
    try {
      const res = await fetch(`/api/connectors/${id}/sync-jobs?status=pending,running&limit=20`);
      if (!res.ok) return;
      const data = (await res.json()) as { jobs?: (Partial<SyncJob> & { id: string })[] };
      const jobs: SyncJob[] = (data.jobs ?? []).map((j) => ({
        id: j.id,
        connectorId: j.connectorId ?? id,
        status: j.status ?? "pending",
        startedAt: j.startedAt,
        completedAt: j.completedAt,
      }));
      setActiveJobs(jobs);
      // If any job is actively running/pending, keep polling
      const hasActive = jobs.some((j) => j.status === "pending" || j.status === "running");
      if (hasActive) {
        setPolling(true);
        // Refresh connector list too so docs count + status stays current
        void fetchConnectors(true);
      } else {
        setPolling(false);
      }
    } catch {
      // silent — don't break UX on poll errors
    }
  }, [fetchConnectors]);

  // Start/stop polling when selected connector changes
  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    setActiveJobs([]);
    setPolling(false);
    if (!selected) return;

    void fetchActiveJobs();
    pollRef.current = setInterval(() => void fetchActiveJobs(), POLL_INTERVAL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [selected, fetchActiveJobs]);

  useEffect(() => {
    void fetchConnectors();
  }, [fetchConnectors]);

  const filtered = connectors.filter(
    (c) =>
      !search ||
      c.name.toLowerCase().includes(search.toLowerCase()) ||
      c.source.toLowerCase().includes(search.toLowerCase()),
  );

  const selectedConnector = connectors.find((c) => c.id === selected);

  const running = activeJobs.filter((j) => j.status === "running").length;

  return (
    <Page width="wide">
      <PageHeader
        title="Connectors"
        description="Sources that sync documents into your knowledge bases. Pick one to see its sync history or run a sync."
        actions={
          <>
            {polling && (
              <span
                className="flex items-center gap-1 text-xs text-success"
                title="Refreshing every 5 seconds while a sync runs"
              >
                <Radio className="size-3.5 animate-pulse" /> Live
              </span>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => void fetchConnectors()}
              disabled={loading}
            >
              {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              Refresh
            </Button>
            <Button asChild size="sm">
              <Link to="/connectors/onboarding">
                <Plus /> Add connector
              </Link>
            </Button>
          </>
        }
      />

      <div className="grid items-start gap-4 lg:grid-cols-[18rem_1fr]">
        <div className="overflow-hidden rounded-xl border bg-card">
          <div className="border-b p-3">
            <div className="relative">
              <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Filter connectors…"
                className="pl-8"
              />
            </div>
          </div>
          <div className="max-h-64 space-y-0.5 overflow-y-auto p-1.5 lg:max-h-[65vh]">
            {loading && connectors.length === 0 ? (
              <Loader2 className="mx-auto my-6 size-5 animate-spin text-muted-foreground" />
            ) : error ? (
              <p className="px-3 py-4 text-sm text-destructive">{error}</p>
            ) : filtered.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {search ? "No connector matches." : "No connectors yet."}
              </p>
            ) : (
              filtered.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setSelected(c.id)}
                  className={cn(
                    "flex w-full items-start gap-2.5 rounded-md px-3 py-2 text-left transition-colors",
                    selected === c.id ? "bg-primary/10" : "hover:bg-muted",
                  )}
                >
                  <span className="mt-0.5 shrink-0">{STATUS_ICONS[c.status]}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{c.name}</span>
                    <span className="block text-xs text-muted-foreground capitalize">
                      {c.source} · {c.syncedDocs} docs
                      {c.lastSyncAt && ` · ${new Date(c.lastSyncAt).toLocaleDateString()}`}
                    </span>
                  </span>
                </button>
              ))
            )}
          </div>
          <div className="flex justify-between border-t px-4 py-2.5 text-xs text-muted-foreground">
            <span>{connectors.filter((c) => c.status === "active").length} active</span>
            <span>{connectors.filter((c) => c.status === "error").length} with errors</span>
            <span>{lastRefreshed ? lastRefreshed.toLocaleTimeString() : ""}</span>
          </div>
        </div>

        <div className="min-w-0 overflow-hidden rounded-xl border bg-card">
          {selectedConnector ? (
            <>
              <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
                {STATUS_ICONS[selectedConnector.status]}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{selectedConnector.name}</p>
                  <p className="text-xs text-muted-foreground capitalize">
                    {selectedConnector.source} · {STATUS_LABEL[selectedConnector.status]}
                  </p>
                </div>
                {activeJobs.length > 0 && (
                  <span className="flex items-center gap-1.5 text-xs text-warning">
                    <Loader2 className="size-3.5 animate-spin" />
                    {running > 0 ? `${running} running` : `${activeJobs.length} queued`}
                  </span>
                )}
              </div>
              {selectedConnector.errorMsg && (
                <p className="border-b bg-destructive/10 px-4 py-2 text-sm text-destructive">
                  {selectedConnector.errorMsg}
                </p>
              )}
              <div className="p-4">
                <ConnectorSyncPanel connectorId={selectedConnector.id} />
              </div>
            </>
          ) : (
            <EmptyState
              icon={Plug}
              title="No connector selected"
              description="Pick a connector to see its sync history and run a sync."
              className="border-0"
            />
          )}
        </div>
      </div>
    </Page>
  );
}
