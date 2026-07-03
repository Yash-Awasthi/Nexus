// SPDX-License-Identifier: Apache-2.0
/**
 * Cross-Memory — retrieve and fuse memories across multiple agents or sessions.
 *
 * Tab 1: Retrieve — query across agent memory banks
 * Tab 2: Context — build a fused context object from cross-memory results
 *
 * API:
 *   POST /api/cross-memory/retrieve
 *   POST /api/cross-memory/context
 */
import { useState, useCallback } from "react";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { Loader2, Brain, Layers, Search } from "lucide-react";

interface MemoryHit {
  agentId?: string;
  sessionId?: string;
  content: string;
  score?: number;
  source?: string;
}

interface RetrieveResult {
  hits: MemoryHit[];
  total?: number;
}

interface ContextResult {
  context: string;
  sources?: number;
  tokens?: number;
}

// ─── Retrieve Tab ─────────────────────────────────────────────────────────────

function RetrieveTab() {
  const [query, setQuery] = useState("");
  const [agentIds, setAgentIds] = useState("");
  const [topK, setTopK] = useState("5");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<RetrieveResult | null>(null);
  const [err, setErr] = useState("");

  const retrieve = useCallback(async () => {
    if (!query.trim()) return;
    setLoading(true);
    setErr("");
    setResult(null);
    const body: Record<string, unknown> = { query: query.trim(), topK: parseInt(topK) || 5 };
    if (agentIds.trim())
      body.agentIds = agentIds
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    const r = await fetch("/api/cross-memory/retrieve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    if (r?.ok) setResult(await r.json());
    else setErr("Retrieval failed");
    setLoading(false);
  }, [query, agentIds, topK]);

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="pt-4 space-y-3">
          <Textarea
            rows={3}
            placeholder="Query to search across all memory banks…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="resize-none"
          />
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">
                Agent IDs (comma-separated, optional)
              </label>
              <Input
                placeholder="agent-1, agent-2…"
                value={agentIds}
                onChange={(e) => setAgentIds(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Top K</label>
              <Input
                type="number"
                value={topK}
                onChange={(e) => setTopK(e.target.value)}
                min={1}
                max={50}
              />
            </div>
          </div>
          {err && <p className="text-red-500 text-xs">{err}</p>}
          <Button onClick={retrieve} disabled={loading || !query.trim()}>
            {loading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
                Retrieving…
              </>
            ) : (
              <>
                <Search className="w-4 h-4 mr-2" />
                Retrieve
              </>
            )}
          </Button>
        </CardContent>
      </Card>

      {result && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Brain className="w-4 h-4 text-indigo-500" />
              {result.hits.length} result(s)
              {result.total !== undefined ? ` of ${result.total}` : ""}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {result.hits.map((hit, i) => (
              <div key={i} className="p-3 rounded-lg bg-muted/50 space-y-1">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  {hit.agentId && <Badge variant="secondary">{hit.agentId}</Badge>}
                  {hit.sessionId && <span>session: {hit.sessionId}</span>}
                  {hit.score !== undefined && (
                    <Badge variant="outline" className="ml-auto">
                      {(hit.score * 100).toFixed(1)}%
                    </Badge>
                  )}
                </div>
                <p className="text-sm">{hit.content}</p>
                {hit.source && <p className="text-xs text-muted-foreground">{hit.source}</p>}
              </div>
            ))}
            {result.hits.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-4">No memory hits found</p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Context Tab ──────────────────────────────────────────────────────────────

function ContextTab() {
  const [query, setQuery] = useState("");
  const [agentIds, setAgentIds] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ContextResult | null>(null);
  const [err, setErr] = useState("");

  const build = useCallback(async () => {
    if (!query.trim()) return;
    setLoading(true);
    setErr("");
    setResult(null);
    const body: Record<string, unknown> = { query: query.trim() };
    if (agentIds.trim())
      body.agentIds = agentIds
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    const r = await fetch("/api/cross-memory/context", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    if (r?.ok) setResult(await r.json());
    else setErr("Context build failed");
    setLoading(false);
  }, [query, agentIds]);

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="pt-4 space-y-3">
          <p className="text-sm text-muted-foreground">
            Build a fused context block from cross-agent memories for use in a prompt.
          </p>
          <Textarea
            rows={3}
            placeholder="Query / topic to fuse context for…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="resize-none"
          />
          <Input
            placeholder="Agent IDs (comma-separated, optional)"
            value={agentIds}
            onChange={(e) => setAgentIds(e.target.value)}
          />
          {err && <p className="text-red-500 text-xs">{err}</p>}
          <Button onClick={build} disabled={loading || !query.trim()}>
            {loading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
                Building…
              </>
            ) : (
              <>
                <Layers className="w-4 h-4 mr-2" />
                Build Context
              </>
            )}
          </Button>
        </CardContent>
      </Card>

      {result && (
        <Card className="border-indigo-200 dark:border-indigo-800">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center justify-between">
              <span>Fused Context</span>
              <div className="flex items-center gap-2">
                {result.sources !== undefined && (
                  <Badge variant="secondary">{result.sources} sources</Badge>
                )}
                {result.tokens !== undefined && (
                  <Badge variant="outline">{result.tokens} tokens</Badge>
                )}
              </div>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="text-sm text-muted-foreground whitespace-pre-wrap bg-muted/50 p-3 rounded-lg max-h-64 overflow-y-auto">
              {result.context}
            </pre>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function CrossMemory() {
  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Brain className="w-6 h-6 text-indigo-500" />
          Cross-Memory
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Retrieve and fuse memories across multiple agents and sessions
        </p>
      </div>
      <Tabs defaultValue="retrieve">
        <TabsList>
          <TabsTrigger value="retrieve">
            <Search className="w-4 h-4 mr-1" />
            Retrieve
          </TabsTrigger>
          <TabsTrigger value="context">
            <Layers className="w-4 h-4 mr-1" />
            Context
          </TabsTrigger>
        </TabsList>
        <TabsContent value="retrieve" className="mt-4">
          <RetrieveTab />
        </TabsContent>
        <TabsContent value="context" className="mt-4">
          <ContextTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
