// SPDX-License-Identifier: Apache-2.0
import { Database, Clock, Trash2, Minimize2, X, Loader2, Search } from "lucide-react";
import { useState, useEffect, useCallback } from "react";

import { Page, PageHeader } from "~/components/page";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";

interface MemoryEntry {
  id: string;
  text: string;
  createdAt?: number;
  metadata?: { category?: unknown };
  score?: number;
}

interface MemoryStats {
  total: number;
  oldest?: number;
  newest?: number;
}

const day = (epochSeconds?: number) =>
  epochSeconds ? new Date(epochSeconds * 1000).toLocaleDateString() : "—";

async function json<T>(r: Response): Promise<T> {
  const body = (await r.json().catch(() => ({}))) as { message?: string; error?: string };
  if (!r.ok) throw new Error(body.message ?? body.error ?? `Request failed (${r.status})`);
  return body as T;
}

export default function MemoryPage() {
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [recalled, setRecalled] = useState<string | null>(null);
  const [related, setRelated] = useState<string[]>([]);

  const load = useCallback(async () => {
    try {
      const [s, e] = await Promise.all([
        fetch("/api/memory/stats").then((r) => json<MemoryStats>(r)),
        fetch("/api/memory/entries?limit=50").then((r) => json<{ entries: MemoryEntry[] }>(r)),
      ]);
      setStats(s);
      setEntries(e.entries ?? []);
      setRecalled(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (work: () => Promise<string | undefined>) => {
    setBusy(true);
    setError("");
    setNote("");
    try {
      const said = await work();
      if (said) setNote(said);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remember = () =>
    act(async () => {
      await fetch("/api/memory/entries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: draft.trim() }),
      }).then((r) => json(r));
      setDraft("");
      await load();
      return "Remembered.";
    });

  const recall = () =>
    act(async () => {
      const q = query.trim();
      const [res, graph] = await Promise.all([
        fetch(`/api/memory/entries?limit=10&query=${encodeURIComponent(q)}`).then((r) =>
          json<{ entries: MemoryEntry[] }>(r),
        ),
        fetch("/api/v1/agents/librarian/query", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: q, limit: 1, nodeLimit: 8 }),
        })
          .then((r) => json<{ entities?: { name: string }[] }>(r))
          .catch(() => ({ entities: [] })),
      ]);
      setEntries(res.entries ?? []);
      setRelated((graph.entities ?? []).map((e) => e.name));
      setRecalled(q);
    });

  const compact = () =>
    act(async () => {
      const res = await fetch("/api/memory/compact", { method: "POST" }).then((r) =>
        json<{ compacted: number }>(r),
      );
      await load();
      return res.compacted > 0
        ? `Merged ${res.compacted} duplicate${res.compacted === 1 ? "" : "s"}.`
        : "No duplicates to merge.";
    });

  const clearAll = () => {
    if (!window.confirm("Clear every memory? This cannot be undone.")) return;
    void act(async () => {
      await fetch("/api/memory/entries", { method: "DELETE" }).then((r) => json(r));
      await load();
      return "All memories cleared.";
    });
  };

  const forget = (id: string) =>
    act(async () => {
      const r = await fetch(`/api/memory/entries/${id}`, { method: "DELETE" });
      if (!r.ok && r.status !== 404) await json(r);
      setEntries((prev) => prev.filter((e) => e.id !== id));
      setStats((s) => (s ? { ...s, total: Math.max(0, s.total - 1) } : s));
    });

  return (
    <Page width="wide">
      <PageHeader
        title="Memory"
        description="What Nexus remembers about you and your work, recalled by meaning when it's relevant."
      />

      <div className="grid grid-cols-3 gap-3">
        {[
          { icon: Database, label: "Memories", value: stats?.total.toLocaleString() },
          { icon: Clock, label: "Newest", value: day(stats?.newest) },
          { icon: Clock, label: "Oldest", value: day(stats?.oldest) },
        ].map(({ icon: Icon, label, value }) => (
          <Card key={label}>
            <CardContent className="flex items-center gap-3 py-1">
              <div className="hidden size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 sm:flex">
                <Icon className="size-5 text-primary" />
              </div>
              <div className="min-w-0">
                {loading ? (
                  <Loader2 className="size-5 animate-spin text-muted-foreground" />
                ) : (
                  <p className="truncate text-base font-semibold sm:text-2xl">{value ?? "—"}</p>
                )}
                <p className="text-xs text-muted-foreground">{label}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Remember something</CardTitle>
          <CardDescription>Agents and chat recall it later when it is relevant</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea
            aria-label="New memory"
            placeholder="e.g. I prefer TypeScript and short answers."
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
          />
          <Button onClick={remember} disabled={busy || !draft.trim()}>
            Remember
          </Button>
        </CardContent>
      </Card>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {note && <p className="text-sm text-muted-foreground">{note}</p>}

      <Card>
        <CardHeader>
          <CardTitle>{recalled ? `Recalled for “${recalled}”` : "Recent memories"}</CardTitle>
          <CardDescription>
            {recalled ? "Closest by meaning first" : "Newest first"}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            <Input
              aria-label="Recall memories"
              placeholder="Ask what you remember about…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && query.trim() && void recall()}
            />
            <Button
              variant="outline"
              aria-label="Recall"
              onClick={recall}
              disabled={busy || !query.trim()}
            >
              <Search className="size-4" />
            </Button>
            {recalled && (
              <Button variant="ghost" onClick={() => void load()}>
                Show all
              </Button>
            )}
          </div>

          {recalled && related.length > 0 && (
            <div className="flex flex-wrap items-center gap-1 text-xs">
              <span className="text-muted-foreground">Related entities:</span>
              {related.map((name) => (
                <Badge key={name} variant="secondary" className="text-[10px] font-normal">
                  {name}
                </Badge>
              ))}
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : entries.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              {recalled ? "Nothing close to that yet." : "No memories yet."}
            </p>
          ) : (
            <div className="divide-y divide-border">
              {entries.map((entry) => (
                <div key={entry.id} className="flex items-start justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="text-sm break-words">{entry.text}</p>
                    <div className="flex flex-wrap items-center gap-2 mt-1">
                      <span className="text-xs text-muted-foreground">{day(entry.createdAt)}</span>
                      {typeof entry.metadata?.category === "string" && (
                        <Badge variant="outline" className="text-[10px]">
                          {entry.metadata.category}
                        </Badge>
                      )}
                      {entry.score !== undefined && (
                        <Badge variant="secondary" className="text-[10px]">
                          {Math.round(entry.score * 100)}% match
                        </Badge>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => void forget(entry.id)}
                    className="shrink-0 text-muted-foreground hover:text-destructive transition-colors p-1 rounded-sm hover:bg-destructive/10"
                    aria-label="Forget this memory"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={compact}
          disabled={busy || (stats?.total ?? 0) < 2}
        >
          <Minimize2 className="size-3" />
          Merge duplicates
        </Button>
        <Button
          variant="destructive"
          size="sm"
          className="gap-1.5"
          onClick={clearAll}
          disabled={busy || (stats?.total ?? 0) === 0}
        >
          <Trash2 className="size-3" />
          Clear all
        </Button>
      </div>
    </Page>
  );
}
