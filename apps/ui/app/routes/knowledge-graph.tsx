/**
 * Knowledge Graph — Phase 4.8
 *
 * GraphRAG-style personal knowledge graph built on memory triples.
 * Visualise entities, relationships, and communities extracted from conversations.
 *
 * API:
 *   POST /api/kg/extract    — extract entities from text
 *   GET  /api/kg/graph      — full graph (nodes + edges)
 *   POST /api/kg/search     — NL search across graph
 *   POST /api/kg/traverse   — BFS from an entity
 *   GET  /api/kg/communities — community detection
 */
import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import {
  Network,
  Search,
  Plus,
  Loader2,
  RefreshCw,
  GitBranch,
  Layers,
  ChevronRight,
  X,
  Info,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface GraphNode {
  id: string;
  label: string;
  type: "entity" | "concept";
  degree: number;
  community?: number;
}

interface GraphEdge {
  source: string;
  target: string;
  predicate: string;
  confidence: number;
}

interface KGGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  nodeCount: number;
  edgeCount: number;
}

interface Community {
  id: number;
  entities: string[];
  summary?: string;
}

// ─── SVG canvas sizes ─────────────────────────────────────────────────────────

const W = 700;
const H = 480;
const NODE_R = 20;

// ─── Deterministic layout (force-ish from degree) ────────────────────────────

function layoutNodes(nodes: GraphNode[], edges: GraphEdge[]) {
  if (nodes.length === 0) return {};
  const positions: Record<string, { x: number; y: number }> = {};
  const cx = W / 2;
  const cy = H / 2;

  nodes.forEach((n, i) => {
    const angle = (i / nodes.length) * 2 * Math.PI;
    const r = 160 + (n.degree ?? 1) * 5;
    positions[n.id] = {
      x: cx + r * Math.cos(angle),
      y: cy + r * Math.sin(angle),
    };
  });

  // Simple spring iterations
  for (let iter = 0; iter < 30; iter++) {
    edges.forEach(e => {
      const a = positions[e.source];
      const b = positions[e.target];
      if (!a || !b) return;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const ideal = 120;
      const f = (dist - ideal) * 0.04;
      const mx = (dx / dist) * f;
      const my = (dy / dist) * f;
      a.x += mx; a.y += my;
      b.x -= mx; b.y -= my;
    });
    // Repulsion
    nodes.forEach((a, i) => {
      nodes.slice(i + 1).forEach(b => {
        const pa = positions[a.id];
        const pb = positions[b.id];
        if (!pa || !pb) return;
        const dx = pb.x - pa.x;
        const dy = pb.y - pa.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        if (dist < 80) {
          const f = (80 - dist) * 0.15;
          const mx = (dx / dist) * f;
          const my = (dy / dist) * f;
          pa.x -= mx; pa.y -= my;
          pb.x += mx; pb.y += my;
        }
      });
    });
    // Clamp
    Object.values(positions).forEach(p => {
      p.x = Math.max(NODE_R + 5, Math.min(W - NODE_R - 5, p.x));
      p.y = Math.max(NODE_R + 5, Math.min(H - NODE_R - 5, p.y));
    });
  }
  return positions;
}

// ─── Community colour palette ─────────────────────────────────────────────────

const COMMUNITY_COLORS = [
  "#6366f1", "#f59e0b", "#10b981", "#ef4444",
  "#3b82f6", "#ec4899", "#14b8a6", "#f97316",
];

function nodeColor(n: GraphNode) {
  if (n.community !== undefined) {
    return COMMUNITY_COLORS[n.community % COMMUNITY_COLORS.length];
  }
  return n.type === "entity" ? "#6366f1" : "#10b981";
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function KnowledgeGraph() {
  const [graph, setGraph] = useState<KGGraph>({ nodes: [], edges: [], nodeCount: 0, edgeCount: 0 });
  const [communities, setCommunities] = useState<Community[]>([]);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  const [loadingGraph, setLoadingGraph] = useState(true);

  // Extract
  const [extractText, setExtractText] = useState("");
  const [extracting, setExtracting] = useState(false);
  const [extractResult, setExtractResult] = useState<{ added: number; skipped: number } | null>(null);

  // Search
  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResult, setSearchResult] = useState<{ nodes: GraphNode[]; edges: GraphEdge[] } | null>(null);

  // Traverse
  const [traverseFrom, setTraverseFrom] = useState("");
  const [traversing, setTraversing] = useState(false);
  const [traverseResult, setTraverseResult] = useState<{ nodes: GraphNode[]; edges: GraphEdge[] } | null>(null);

  const [tab, setTab] = useState<"graph" | "extract" | "search" | "communities">("graph");
  const [err, setErr] = useState("");

  const loadGraph = useCallback(async () => {
    setLoadingGraph(true);
    try {
      const r = await fetch("/api/kg/graph?limit=80");
      if (r.ok) {
        const data = await r.json();
        setGraph(data);
        setPositions(layoutNodes(data.nodes ?? [], data.edges ?? []));
      }
    } catch {}
    setLoadingGraph(false);
  }, []);

  const loadCommunities = useCallback(async () => {
    try {
      const r = await fetch("/api/kg/communities");
      if (r.ok) setCommunities(await r.json());
    } catch {}
  }, []);

  useEffect(() => { loadGraph(); loadCommunities(); }, [loadGraph, loadCommunities]);

  const handleExtract = useCallback(async () => {
    if (!extractText.trim()) return;
    setExtracting(true);
    setExtractResult(null);
    setErr("");
    try {
      const r = await fetch("/api/kg/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: extractText.trim() }),
      });
      if (r.ok) {
        const d = await r.json();
        setExtractResult({ added: d.added ?? 0, skipped: d.skipped ?? 0 });
        setExtractText("");
        loadGraph();
        loadCommunities();
      } else setErr("Extraction failed");
    } catch { setErr("Extraction error"); }
    finally { setExtracting(false); }
  }, [extractText, loadGraph, loadCommunities]);

  const handleSearch = useCallback(async () => {
    if (!searchQuery.trim()) return;
    setSearching(true);
    setSearchResult(null);
    try {
      const r = await fetch("/api/kg/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: searchQuery.trim(), hops: 2 }),
      });
      if (r.ok) setSearchResult(await r.json());
    } catch {}
    finally { setSearching(false); }
  }, [searchQuery]);

  const handleTraverse = useCallback(async (entity: string) => {
    const e = entity || traverseFrom;
    if (!e.trim()) return;
    setTraversing(true);
    setTraverseResult(null);
    try {
      const r = await fetch("/api/kg/traverse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startEntity: e.trim(), hops: 2 }),
      });
      if (r.ok) setTraverseResult(await r.json());
    } catch {}
    finally { setTraversing(false); }
  }, [traverseFrom]);

  // Display graph — full or search/traverse overlay
  const displayGraph = searchResult ?? traverseResult ?? graph;
  const displayPositions = (searchResult || traverseResult)
    ? layoutNodes(displayGraph.nodes ?? [], displayGraph.edges ?? [])
    : positions;

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Network className="w-6 h-6 text-indigo-500" />
            Knowledge Graph
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            {graph.nodeCount} entities · {graph.edgeCount} relationships
          </p>
        </div>
        <div className="flex gap-2">
          {(["graph", "extract", "search", "communities"] as const).map(t => (
            <Button
              key={t}
              size="sm"
              variant={tab === t ? "default" : "outline"}
              onClick={() => { setTab(t); setSearchResult(null); setTraverseResult(null); }}
              className="capitalize"
            >
              {t}
            </Button>
          ))}
        </div>
      </div>

      {/* ── Graph Tab ── */}
      {tab === "graph" && (
        <div className="space-y-4">
          {loadingGraph ? (
            <div className="flex items-center justify-center h-64 text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin mr-2" />
              Loading graph…
            </div>
          ) : graph.nodes.length === 0 ? (
            <Card>
              <CardContent className="pt-8 pb-8 text-center space-y-3">
                <Network className="w-12 h-12 text-muted-foreground mx-auto opacity-40" />
                <p className="text-muted-foreground">No entities yet</p>
                <p className="text-sm text-muted-foreground">
                  Switch to <strong>Extract</strong> tab and paste some text to build your graph
                </p>
                <Button size="sm" onClick={() => setTab("extract")}>
                  <Plus className="w-4 h-4 mr-1" />
                  Extract entities
                </Button>
              </CardContent>
            </Card>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <div className="lg:col-span-2">
                <Card>
                  <CardContent className="p-0 overflow-hidden rounded-lg">
                    <svg width={W} height={H} className="w-full" style={{ background: "var(--background)" }}>
                      <defs>
                        <marker id="arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
                          <path d="M0,0 L0,6 L6,3 z" fill="#94a3b8" />
                        </marker>
                      </defs>
                      {/* Edges */}
                      {(displayGraph.edges ?? []).map((e, i) => {
                        const a = displayPositions[e.source];
                        const b = displayPositions[e.target];
                        if (!a || !b) return null;
                        const dx = b.x - a.x;
                        const dy = b.y - a.y;
                        const len = Math.sqrt(dx * dx + dy * dy) || 1;
                        const ex = b.x - (dx / len) * (NODE_R + 4);
                        const ey = b.y - (dy / len) * (NODE_R + 4);
                        const mx = (a.x + b.x) / 2;
                        const my = (a.y + b.y) / 2;
                        return (
                          <g key={i}>
                            <line
                              x1={a.x} y1={a.y} x2={ex} y2={ey}
                              stroke="#94a3b8"
                              strokeWidth={1 + e.confidence}
                              strokeOpacity={0.5}
                              markerEnd="url(#arrow)"
                            />
                            <text x={mx} y={my - 4} fontSize={9} fill="#94a3b8" textAnchor="middle">
                              {e.predicate}
                            </text>
                          </g>
                        );
                      })}
                      {/* Nodes */}
                      {(displayGraph.nodes ?? []).map(n => {
                        const p = displayPositions[n.id];
                        if (!p) return null;
                        const isSelected = selectedNode?.id === n.id;
                        const color = nodeColor(n);
                        return (
                          <g
                            key={n.id}
                            style={{ cursor: "pointer" }}
                            onClick={() => setSelectedNode(isSelected ? null : n)}
                          >
                            <circle
                              cx={p.x} cy={p.y} r={NODE_R + (isSelected ? 4 : 0)}
                              fill={color}
                              fillOpacity={isSelected ? 1 : 0.8}
                              stroke={isSelected ? "#fff" : "transparent"}
                              strokeWidth={2}
                            />
                            <text
                              x={p.x} y={p.y + 1}
                              fontSize={9}
                              fill="white"
                              textAnchor="middle"
                              dominantBaseline="middle"
                              style={{ pointerEvents: "none", userSelect: "none" }}
                            >
                              {n.label.length > 10 ? n.label.slice(0, 9) + "…" : n.label}
                            </text>
                          </g>
                        );
                      })}
                    </svg>
                  </CardContent>
                </Card>
              </div>

              {/* Side panel */}
              <div className="space-y-3">
                {selectedNode ? (
                  <Card>
                    <CardHeader className="pb-2">
                      <div className="flex items-center justify-between">
                        <CardTitle className="text-sm">{selectedNode.label}</CardTitle>
                        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setSelectedNode(null)}>
                          <X className="w-3 h-3" />
                        </Button>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-2">
                      <div className="flex gap-2">
                        <Badge variant="outline" className="text-xs capitalize">{selectedNode.type}</Badge>
                        {selectedNode.community !== undefined && (
                          <Badge
                            className="text-xs text-white"
                            style={{ background: COMMUNITY_COLORS[selectedNode.community % COMMUNITY_COLORS.length] }}
                          >
                            community {selectedNode.community}
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">Degree: {selectedNode.degree} connections</p>

                      {/* Connected edges */}
                      <div className="space-y-1">
                        <p className="text-xs font-medium">Relationships:</p>
                        {graph.edges
                          .filter(e => e.source === selectedNode.id || e.target === selectedNode.id)
                          .slice(0, 8)
                          .map((e, i) => (
                            <div key={i} className="text-xs text-muted-foreground flex items-center gap-1">
                              <ChevronRight className="w-3 h-3 shrink-0" />
                              <span className="font-medium">{e.source === selectedNode.id ? e.target : e.source}</span>
                              <span className="opacity-60">— {e.predicate}</span>
                            </div>
                          ))}
                      </div>

                      <Button
                        size="sm"
                        variant="outline"
                        className="w-full"
                        onClick={() => { handleTraverse(selectedNode.label); setTab("search"); }}
                      >
                        <GitBranch className="w-3 h-3 mr-1" />
                        Traverse from here
                      </Button>
                    </CardContent>
                  </Card>
                ) : (
                  <Card>
                    <CardContent className="pt-4 text-sm text-muted-foreground space-y-2">
                      <p className="flex items-center gap-2">
                        <Info className="w-4 h-4 shrink-0" />
                        Click any node to inspect its relationships
                      </p>
                      <div className="space-y-1 pt-2">
                        <div className="flex items-center gap-2 text-xs">
                          <div className="w-3 h-3 rounded-full bg-indigo-500" />
                          <span>Entity</span>
                        </div>
                        <div className="flex items-center gap-2 text-xs">
                          <div className="w-3 h-3 rounded-full bg-emerald-500" />
                          <span>Concept</span>
                        </div>
                        {communities.length > 0 && (
                          <p className="text-xs pt-1 text-muted-foreground">
                            Colours = {communities.length} communities detected
                          </p>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                )}

                <Button variant="outline" size="sm" className="w-full" onClick={loadGraph}>
                  <RefreshCw className="w-3 h-3 mr-1" />
                  Refresh graph
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Extract Tab ── */}
      {tab === "extract" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Plus className="w-4 h-4" />
              Extract Entities
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Textarea
              placeholder="Paste any text — a conversation, article, notes… The LLM will extract entities and relationships into your graph."
              value={extractText}
              onChange={e => setExtractText(e.target.value)}
              rows={8}
              className="resize-none font-mono text-sm"
            />
            {err && <p className="text-red-500 text-sm">{err}</p>}
            {extractResult && (
              <div className="text-sm text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-950/30 p-3 rounded-lg">
                ✓ Added {extractResult.added} triples, skipped {extractResult.skipped} duplicates
              </div>
            )}
            <Button onClick={handleExtract} disabled={extracting || !extractText.trim()} className="w-full">
              {extracting
                ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Extracting…</>
                : <><Plus className="w-4 h-4 mr-2" />Extract to graph</>}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* ── Search Tab ── */}
      {tab === "search" && (
        <div className="space-y-4">
          <Card>
            <CardContent className="pt-4 space-y-3">
              <div className="space-y-2">
                <label className="text-sm font-medium">Natural-language search</label>
                <div className="flex gap-2">
                  <Input
                    placeholder="e.g. What do I know about machine learning?"
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && handleSearch()}
                  />
                  <Button onClick={handleSearch} disabled={searching || !searchQuery.trim()}>
                    {searching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                  </Button>
                </div>
              </div>

              <div className="border-t pt-3 space-y-2">
                <label className="text-sm font-medium">Traverse from entity</label>
                <div className="flex gap-2">
                  <Input
                    placeholder="Entity name, e.g. 'TypeScript'"
                    value={traverseFrom}
                    onChange={e => setTraverseFrom(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && handleTraverse("")}
                  />
                  <Button onClick={() => handleTraverse("")} disabled={traversing || !traverseFrom.trim()} variant="outline">
                    {traversing ? <Loader2 className="w-4 h-4 animate-spin" /> : <GitBranch className="w-4 h-4" />}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Result graph */}
          {searchResult && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">
                  Search result — {searchResult.nodes?.length ?? 0} nodes, {searchResult.edges?.length ?? 0} edges
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <svg width={W} height={H} className="w-full" style={{ background: "var(--background)" }}>
                  {(searchResult.edges ?? []).map((e, i) => {
                    const a = displayPositions[e.source];
                    const b = displayPositions[e.target];
                    if (!a || !b) return null;
                    return (
                      <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                        stroke="#94a3b8" strokeWidth={1} strokeOpacity={0.5} />
                    );
                  })}
                  {(searchResult.nodes ?? []).map(n => {
                    const p = displayPositions[n.id];
                    if (!p) return null;
                    return (
                      <g key={n.id}>
                        <circle cx={p.x} cy={p.y} r={NODE_R} fill={nodeColor(n)} fillOpacity={0.85} />
                        <text x={p.x} y={p.y + 1} fontSize={9} fill="white" textAnchor="middle" dominantBaseline="middle">
                          {n.label.length > 10 ? n.label.slice(0, 9) + "…" : n.label}
                        </text>
                      </g>
                    );
                  })}
                </svg>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* ── Communities Tab ── */}
      {tab === "communities" && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">{communities.length} communities detected</p>
            <Button variant="ghost" size="sm" onClick={loadCommunities}>
              <RefreshCw className="w-3 h-3 mr-1" />
              Refresh
            </Button>
          </div>
          {communities.length === 0 && (
            <Card>
              <CardContent className="pt-8 pb-8 text-center">
                <Layers className="w-10 h-10 text-muted-foreground mx-auto mb-3 opacity-40" />
                <p className="text-muted-foreground">No communities yet — extract more entities first</p>
              </CardContent>
            </Card>
          )}
          {communities.map(c => (
            <Card key={c.id}>
              <CardContent className="pt-4">
                <div className="flex items-center gap-2 mb-2">
                  <div
                    className="w-3 h-3 rounded-full shrink-0"
                    style={{ background: COMMUNITY_COLORS[c.id % COMMUNITY_COLORS.length] }}
                  />
                  <span className="text-sm font-medium">Community {c.id}</span>
                  <Badge variant="outline" className="text-xs">{c.entities?.length ?? 0} entities</Badge>
                </div>
                {c.summary && <p className="text-xs text-muted-foreground mb-2">{c.summary}</p>}
                <div className="flex flex-wrap gap-1">
                  {(c.entities ?? []).map(e => (
                    <Badge key={e} variant="secondary" className="text-xs font-normal">{e}</Badge>
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
