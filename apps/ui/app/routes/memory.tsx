// SPDX-License-Identifier: Apache-2.0
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Brain, Database, HardDrive, Clock, Trash2, Minimize2, X, Loader2 } from "lucide-react";
import { useState, useMemo, useEffect, useCallback } from "react";

interface MemoryEntry {
  id: string;
  topic: string;
  chunks: number;
  date: string;
  source: string;
}

// No demo entries here — the page renders whatever /api/memory/entries
// returns. Previously shipped MOCK_ENTRIES that showed fabricated memories
// whenever the API disagreed with their shape (which it always did: the store
// returns text/createdAt, not topic/chunks/date).

export default function MemoryPage() {
  const [backend, setBackend] = useState("local");
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [isCompacting, setIsCompacting] = useState(false);
  const [lastCompacted, setLastCompacted] = useState("Never");
  const [loading, setLoading] = useState(true);

  const totalChunks = useMemo(() => entries.reduce((sum, e) => sum + e.chunks, 0), [entries]);
  const storageMB = useMemo(() => (totalChunks * 0.00384).toFixed(1), [totalChunks]);

  // ── Fetch memory stats + entries from backend ─────────────────────────────
  // Shared by initial load, compaction, and clear-all so those actions show
  // the server's truth (an empty list is a valid state — previous code kept
  // stale rows whenever the response was empty, which is why Clear All looked
  // like it worked while the store kept everything).
  const load = useCallback(() => {
    return Promise.allSettled([
      fetch("/api/memory/stats").then((r) => (r.ok ? r.json() : Promise.reject())),
      fetch("/api/memory/entries?limit=50").then((r) => (r.ok ? r.json() : Promise.reject())),
    ])
      .then(([statsResult, entriesResult]) => {
        if (statsResult.status === "fulfilled") {
          const s = statsResult.value;
          if (s?.lastCompacted) setLastCompacted(s.lastCompacted);
          if (s?.backend) setBackend(s.backend);
        }
        if (entriesResult.status === "fulfilled") {
          const list: MemoryEntry[] = Array.isArray(entriesResult.value)
            ? entriesResult.value
            : (entriesResult.value?.entries ?? []);
          setEntries(list);
        }
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleBackendChange = (value: string) => {
    setBackend(value);
    fetch("/api/memory/backend", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ backend: value }),
    }).catch(() => {});
  };

  const handleCompact = () => {
    if (entries.length < 2) return;
    setIsCompacting(true);

    fetch("/api/memory/compact", { method: "POST" })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((data) => {
        // Show what actually happened, then re-read the store.
        setLastCompacted(
          typeof data?.compacted === "number" && data.compacted > 0
            ? `Just now (${data.compacted} duplicates merged)`
            : "Just now (nothing to merge)",
        );
        void load();
      })
      .catch(() => setLastCompacted("Compaction failed"))
      .finally(() => setIsCompacting(false));
  };

  const handleClearAll = () => {
    if (
      !window.confirm("Are you sure you want to clear all memory entries? This cannot be undone.")
    )
      return;
    // Delete server-side first, then re-read: an optimistic local clear only
    // hides the failure until the next load brings the entries back.
    fetch("/api/memory/entries", { method: "DELETE" })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(() => {
        setLastCompacted("Never");
        void load();
      })
      .catch(() => {});
  };

  const handleDeleteEntry = (id: string) => {
    setEntries((prev) => prev.filter((e) => e.id !== id));
    fetch("/api/memory/entries/" + id, { method: "DELETE" }).catch(() => {});
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-6xl mx-auto p-6 space-y-6">
        <div className="flex items-center gap-3">
          <Brain className="size-6 text-muted-foreground" />
          <div>
            <h1 className="text-xl font-semibold">Memory</h1>
            <p className="text-sm text-muted-foreground">
              Manage long-term memory storage, retrieval, and compaction
            </p>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card>
            <CardContent className="flex items-center gap-3 py-4">
              <div className="size-10 rounded-lg bg-primary/10 flex items-center justify-center">
                <Database className="size-5 text-primary" />
              </div>
              <div>
                {loading ? (
                  <Loader2 className="size-5 animate-spin text-muted-foreground" />
                ) : (
                  <p className="text-2xl font-semibold">{totalChunks.toLocaleString()}</p>
                )}
                <p className="text-xs text-muted-foreground">Chunks</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex items-center gap-3 py-4">
              <div className="size-10 rounded-lg bg-primary/10 flex items-center justify-center">
                <HardDrive className="size-5 text-primary" />
              </div>
              <div>
                {loading ? (
                  <Loader2 className="size-5 animate-spin text-muted-foreground" />
                ) : (
                  <p className="text-2xl font-semibold">~{storageMB} MB</p>
                )}
                <p className="text-xs text-muted-foreground">Storage</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex items-center gap-3 py-4">
              <div className="size-10 rounded-lg bg-primary/10 flex items-center justify-center">
                <Clock className="size-5 text-primary" />
              </div>
              <div>
                <p className="text-2xl font-semibold">{lastCompacted}</p>
                <p className="text-xs text-muted-foreground">Last Compacted</p>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Backend Configuration */}
        <Card>
          <CardHeader>
            <CardTitle>Backend Configuration</CardTitle>
            <CardDescription>Select and configure the memory storage engine</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Current Backend</p>
                <p className="text-xs text-muted-foreground">
                  Controls where memory chunks are stored and indexed
                </p>
              </div>
              <Select value={backend} onValueChange={handleBackendChange}>
                <SelectTrigger className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="local">Local</SelectItem>
                  <SelectItem value="qdrant">Qdrant</SelectItem>
                  <SelectItem value="getzep">GetZep</SelectItem>
                  <SelectItem value="google_drive">Google Drive</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={handleCompact}
                disabled={isCompacting || entries.length < 2}
              >
                {isCompacting ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Minimize2 className="size-3" />
                )}
                {isCompacting ? "Compacting..." : "Compact Memory"}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                className="gap-1.5"
                onClick={handleClearAll}
                disabled={entries.length === 0}
              >
                <Trash2 className="size-3" />
                Clear All
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Recent Memory Entries */}
        <Card>
          <CardHeader>
            <CardTitle>Recent Memory Entries</CardTitle>
            <CardDescription>Latest topics stored in long-term memory</CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : entries.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">
                No memory entries. Start a conversation to build memory.
              </p>
            ) : (
              <div className="space-y-0 divide-y divide-border">
                {entries.map((entry) => (
                  <div key={entry.id} className="flex items-center justify-between py-3">
                    <div className="flex items-center gap-3">
                      <Brain className="size-4 text-muted-foreground" />
                      <div>
                        <p className="text-sm font-medium">{entry.topic}</p>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-xs text-muted-foreground">
                            {entry.chunks} chunks
                          </span>
                          <Badge variant="outline" className="text-[10px]">
                            {entry.source}
                          </Badge>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">{entry.date}</span>
                      <button
                        onClick={() => handleDeleteEntry(entry.id)}
                        className="text-muted-foreground hover:text-destructive transition-colors p-1 rounded-sm hover:bg-destructive/10"
                        title="Delete entry"
                      >
                        <X className="size-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
