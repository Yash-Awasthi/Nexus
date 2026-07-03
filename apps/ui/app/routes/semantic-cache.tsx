// SPDX-License-Identifier: Apache-2.0
/**
 * Semantic Cache — manage the semantic similarity cache for LLM responses.
 *
 * Shows cache hit stats, lets admins look up whether a query would hit the cache,
 * invalidate stale entries, and view/update the cache configuration.
 *
 * API:
 *   GET    /api/semantic-cache/stats
 *   POST   /api/semantic-cache/lookup
 *   DELETE /api/semantic-cache/invalidate
 *   GET    /api/semantic-cache/config
 *   PATCH  /api/semantic-cache/config
 */
import { useState, useEffect, useCallback } from "react";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { Input } from "~/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import {
  Database,
  Search,
  Trash2,
  Settings,
  Loader2,
  RefreshCw,
  CheckCircle,
  XCircle,
  Zap,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface CacheStats {
  totalEntries: number;
  hitRate: number;
  missRate: number;
  totalHits: number;
  totalMisses: number;
  avgSimilarityScore?: number;
  sizeBytes?: number;
  oldestEntry?: string;
}

interface LookupResult {
  hit: boolean;
  score?: number;
  cachedResponse?: string;
  cachedAt?: string;
  key?: string;
}

interface CacheConfig {
  enabled: boolean;
  similarityThreshold: number;
  maxEntries: number;
  ttlSeconds: number;
  embeddingModel?: string;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function SemanticCache() {
  const [stats, setStats] = useState<CacheStats | null>(null);
  const [config, setConfig] = useState<CacheConfig | null>(null);
  const [loadingStats, setLoadingStats] = useState(true);
  const [loadingConfig, setLoadingConfig] = useState(true);
  const [savingConfig, setSavingConfig] = useState(false);

  // Lookup
  const [lookupQuery, setLookupQuery] = useState("");
  const [lookupResult, setLookupResult] = useState<LookupResult | null>(null);
  const [looking, setLooking] = useState(false);

  // Invalidate
  const [invalidateQuery, setInvalidateQuery] = useState("");
  const [invalidating, setInvalidating] = useState(false);
  const [invalidateMsg, setInvalidateMsg] = useState("");

  const [editConfig, setEditConfig] = useState<Partial<CacheConfig>>({});
  const [err, setErr] = useState("");

  const loadStats = useCallback(async () => {
    setLoadingStats(true);
    const r = await fetch("/api/semantic-cache/stats").catch(() => null);
    if (r?.ok) setStats(await r.json());
    setLoadingStats(false);
  }, []);

  const loadConfig = useCallback(async () => {
    setLoadingConfig(true);
    const r = await fetch("/api/semantic-cache/config").catch(() => null);
    if (r?.ok) {
      const c = await r.json();
      setConfig(c);
      setEditConfig(c);
    }
    setLoadingConfig(false);
  }, []);

  useEffect(() => {
    loadStats();
    loadConfig();
  }, [loadStats, loadConfig]);

  const lookup = useCallback(async () => {
    if (!lookupQuery.trim()) return;
    setLooking(true);
    setLookupResult(null);
    const r = await fetch("/api/semantic-cache/lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: lookupQuery.trim() }),
    }).catch(() => null);
    if (r?.ok) setLookupResult(await r.json());
    setLooking(false);
  }, [lookupQuery]);

  const invalidate = useCallback(async () => {
    setInvalidating(true);
    setInvalidateMsg("");
    const body: Record<string, string> = {};
    if (invalidateQuery.trim()) body.query = invalidateQuery.trim();
    const r = await fetch("/api/semantic-cache/invalidate", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.keys(body).length ? body : undefined),
    }).catch(() => null);
    if (r?.ok) {
      const d = await r.json();
      setInvalidateMsg(`Invalidated ${d.count ?? "all"} entries`);
      loadStats();
    }
    setInvalidating(false);
  }, [invalidateQuery, loadStats]);

  const saveConfig = useCallback(async () => {
    setSavingConfig(true);
    setErr("");
    const r = await fetch("/api/semantic-cache/config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(editConfig),
    }).catch(() => null);
    if (r?.ok) {
      const c = await r.json();
      setConfig(c);
      setEditConfig(c);
    } else setErr("Save failed");
    setSavingConfig(false);
  }, [editConfig]);

  const hitRatePct = stats ? Math.round((stats.hitRate ?? 0) * 100) : 0;

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Database className="w-6 h-6 text-cyan-500" />
            Semantic Cache
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Similarity-based cache for LLM responses — reduces cost and latency for repeated queries
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={loadStats}>
          <RefreshCw className={`w-4 h-4 ${loadingStats ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {/* Stats */}
      {loadingStats ? (
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading stats…
        </div>
      ) : stats ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Card>
            <CardContent className="pt-4">
              <p className="text-xs text-muted-foreground uppercase tracking-wide">Entries</p>
              <p className="text-2xl font-bold">{(stats.totalEntries ?? 0).toLocaleString()}</p>
              {stats.sizeBytes && (
                <p className="text-xs text-muted-foreground mt-1">
                  {(stats.sizeBytes / 1024).toFixed(1)} KB
                </p>
              )}
            </CardContent>
          </Card>
          <Card className="border-green-200 dark:border-green-800">
            <CardContent className="pt-4">
              <p className="text-xs text-muted-foreground uppercase tracking-wide flex items-center gap-1">
                <Zap className="w-3 h-3" />
                Hit Rate
              </p>
              <p className="text-2xl font-bold text-green-600">{hitRatePct}%</p>
              <p className="text-xs text-muted-foreground mt-1">
                {(stats.totalHits ?? 0).toLocaleString()} hits
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <p className="text-xs text-muted-foreground uppercase tracking-wide">Misses</p>
              <p className="text-2xl font-bold">{Math.round((stats.missRate ?? 0) * 100)}%</p>
              <p className="text-xs text-muted-foreground mt-1">
                {(stats.totalMisses ?? 0).toLocaleString()} misses
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <p className="text-xs text-muted-foreground uppercase tracking-wide">
                Avg Similarity
              </p>
              <p className="text-2xl font-bold">
                {stats.avgSimilarityScore !== undefined
                  ? `${Math.round(stats.avgSimilarityScore * 100)}%`
                  : "—"}
              </p>
            </CardContent>
          </Card>
        </div>
      ) : null}

      {/* Hit rate bar */}
      {stats && (
        <Card>
          <CardContent className="pt-4">
            <div className="flex justify-between text-sm mb-2">
              <span className="flex items-center gap-1 text-green-600">
                <CheckCircle className="w-3.5 h-3.5" />
                Hits
              </span>
              <span className="font-medium">{hitRatePct}%</span>
              <span className="flex items-center gap-1 text-muted-foreground">
                <XCircle className="w-3.5 h-3.5" />
                Misses
              </span>
            </div>
            <div className="w-full bg-muted rounded-full h-3 overflow-hidden">
              <div
                className="bg-green-500 h-3 rounded-full transition-all"
                style={{ width: `${hitRatePct}%` }}
              />
            </div>
          </CardContent>
        </Card>
      )}

      <Tabs defaultValue="lookup">
        <TabsList>
          <TabsTrigger value="lookup">
            <Search className="w-4 h-4 mr-1" />
            Lookup
          </TabsTrigger>
          <TabsTrigger value="invalidate">
            <Trash2 className="w-4 h-4 mr-1" />
            Invalidate
          </TabsTrigger>
          <TabsTrigger value="config">
            <Settings className="w-4 h-4 mr-1" />
            Config
          </TabsTrigger>
        </TabsList>

        {/* Lookup */}
        <TabsContent value="lookup" className="mt-4 space-y-3">
          <Card>
            <CardContent className="pt-4 space-y-3">
              <p className="text-sm text-muted-foreground">
                Check whether a query would be served from the cache.
              </p>
              <div className="flex gap-2">
                <Input
                  placeholder="Enter a query to test cache hit…"
                  value={lookupQuery}
                  onChange={(e) => setLookupQuery(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && lookup()}
                  className="flex-1"
                />
                <Button onClick={lookup} disabled={looking || !lookupQuery.trim()}>
                  {looking ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Search className="w-4 h-4" />
                  )}
                </Button>
              </div>
              {lookupResult && (
                <div
                  className={`p-3 rounded-lg border text-sm ${lookupResult.hit ? "border-green-200 bg-green-50 dark:bg-green-950/20" : "border-muted bg-muted/30"}`}
                >
                  <div className="flex items-center gap-2 mb-2">
                    {lookupResult.hit ? (
                      <>
                        <CheckCircle className="w-4 h-4 text-green-600" />
                        <span className="font-medium text-green-700 dark:text-green-400">
                          Cache HIT
                        </span>
                      </>
                    ) : (
                      <>
                        <XCircle className="w-4 h-4 text-muted-foreground" />
                        <span className="font-medium text-muted-foreground">Cache MISS</span>
                      </>
                    )}
                    {lookupResult.score !== undefined && (
                      <Badge variant="outline">
                        similarity: {Math.round(lookupResult.score * 100)}%
                      </Badge>
                    )}
                  </div>
                  {lookupResult.hit && lookupResult.cachedResponse && (
                    <p className="text-xs text-muted-foreground line-clamp-3">
                      {lookupResult.cachedResponse}
                    </p>
                  )}
                  {lookupResult.cachedAt && (
                    <p className="text-xs text-muted-foreground mt-1">
                      Cached: {new Date(lookupResult.cachedAt).toLocaleString()}
                    </p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Invalidate */}
        <TabsContent value="invalidate" className="mt-4 space-y-3">
          <Card>
            <CardContent className="pt-4 space-y-3">
              <p className="text-sm text-muted-foreground">
                Invalidate cache entries. Leave the query blank to clear all entries.
              </p>
              <div className="flex gap-2">
                <Input
                  placeholder="Query to invalidate (or leave blank to clear all)…"
                  value={invalidateQuery}
                  onChange={(e) => setInvalidateQuery(e.target.value)}
                  className="flex-1"
                />
                <Button variant="destructive" onClick={invalidate} disabled={invalidating}>
                  {invalidating ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Trash2 className="w-4 h-4" />
                  )}
                </Button>
              </div>
              {invalidateMsg && (
                <p className="text-sm text-green-600 dark:text-green-400">{invalidateMsg}</p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Config */}
        <TabsContent value="config" className="mt-4 space-y-3">
          {loadingConfig ? (
            <div className="flex items-center gap-2 text-muted-foreground text-sm py-8 justify-center">
              <Loader2 className="w-4 h-4 animate-spin" />
              Loading config…
            </div>
          ) : config ? (
            <Card>
              <CardContent className="pt-4 space-y-4">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium">Enabled</label>
                  <button
                    onClick={() => setEditConfig((prev) => ({ ...prev, enabled: !prev.enabled }))}
                    className={`w-12 h-6 rounded-full transition-colors relative ${editConfig.enabled ? "bg-green-500" : "bg-slate-300 dark:bg-slate-600"}`}
                  >
                    <span
                      className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${editConfig.enabled ? "translate-x-6" : "translate-x-0.5"}`}
                    />
                  </button>
                </div>
                <div className="space-y-1">
                  <label className="text-sm font-medium flex justify-between">
                    Similarity Threshold
                    <span className="font-normal text-muted-foreground">
                      {((editConfig.similarityThreshold ?? 0.9) * 100).toFixed(0)}%
                    </span>
                  </label>
                  <input
                    type="range"
                    min={0.5}
                    max={1.0}
                    step={0.01}
                    value={editConfig.similarityThreshold ?? 0.9}
                    onChange={(e) =>
                      setEditConfig((prev) => ({
                        ...prev,
                        similarityThreshold: parseFloat(e.target.value),
                      }))
                    }
                    className="w-full accent-primary"
                  />
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>Looser</span>
                    <span>Stricter</span>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label className="text-sm font-medium">Max Entries</label>
                    <Input
                      type="number"
                      value={editConfig.maxEntries ?? 10000}
                      onChange={(e) =>
                        setEditConfig((prev) => ({
                          ...prev,
                          maxEntries: parseInt(e.target.value) || 10000,
                        }))
                      }
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-sm font-medium">TTL (seconds)</label>
                    <Input
                      type="number"
                      value={editConfig.ttlSeconds ?? 86400}
                      onChange={(e) =>
                        setEditConfig((prev) => ({
                          ...prev,
                          ttlSeconds: parseInt(e.target.value) || 86400,
                        }))
                      }
                    />
                  </div>
                </div>
                {config.embeddingModel && (
                  <p className="text-xs text-muted-foreground">
                    Embedding model: {config.embeddingModel}
                  </p>
                )}
                {err && <p className="text-red-500 text-xs">{err}</p>}
                <Button onClick={saveConfig} disabled={savingConfig}>
                  {savingConfig ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin mr-2" />
                      Saving…
                    </>
                  ) : (
                    "Save Config"
                  )}
                </Button>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="pt-8 pb-8 text-center text-muted-foreground">
                No config available
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
