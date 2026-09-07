// SPDX-License-Identifier: Apache-2.0
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { Network, Loader2, ArrowLeft, ExternalLink } from "lucide-react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "~/components/ui/card";

/**
 * Session spider-graph viewer.
 *
 * Renders the zero-write-cost pipeline graphs captured by the API
 * (lib/session-graph.ts): every research run and deliberation becomes a
 * directed graph of the AI's thinking pipeline — query → phases → milestones →
 * citations → report → notifications. The capture costs no LLM tokens by
 * construction (structural events only); this page is a pure read surface.
 */

type NodeKind =
  | "user"
  | "phase"
  | "milestone"
  | "citation"
  | "report"
  | "notification"
  | "thread"
  | "message"
  | "tool"
  | "mission"
  | "error";

interface GraphSummary {
  sessionId: string;
  kind: "research" | "deliberation" | "mission";
  title: string;
  nodeCount: number;
  edgeCount: number;
  createdAt: string;
  updatedAt: string;
}

interface GraphNode {
  id: string;
  kind: NodeKind;
  label: string;
  detail?: string;
  link?: string;
  ts: string;
}

interface GraphEdge {
  from: string;
  to: string;
  kind: string;
}

interface SessionGraph {
  sessionId: string;
  kind: "research" | "deliberation" | "mission";
  title: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  createdAt: string;
  updatedAt: string;
}

const KIND_COLORS: Record<NodeKind, string> = {
  user: "#38bdf8",
  phase: "#6366f1",
  milestone: "#10b981",
  citation: "#f59e0b",
  report: "#a78bfa",
  notification: "#ec4899",
  thread: "#22d3ee",
  message: "#94a3b8",
  tool: "#f472b6",
  mission: "#fb923c",
  error: "#ef4444",
};

const KIND_LABELS: Record<NodeKind, string> = {
  user: "User",
  phase: "Phase",
  milestone: "Milestone",
  citation: "Citation",
  report: "Report",
  notification: "Notification",
  thread: "Thread",
  message: "Message",
  tool: "Tool",
  mission: "Mission",
  error: "Error",
};

async function apiFetch<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { message?: string }).message ?? `Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

function timeAgo(iso: string): string {
  const s = Math.max(1, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Layered SVG layout: rows by kind, columns by order within the kind. */
function layout(nodes: GraphNode[], width: number, height: number) {
  const kindOrder: NodeKind[] = [
    "user",
    "thread",
    "mission",
    "phase",
    "tool",
    "milestone",
    "citation",
    "message",
    "report",
    "notification",
    "error",
  ];
  const byKind = new Map<NodeKind, GraphNode[]>();
  for (const kind of kindOrder) byKind.set(kind, []);
  for (const n of nodes) byKind.get(n.kind)?.push(n);

  const rows = kindOrder.filter((k) => (byKind.get(k)?.length ?? 0) > 0);
  const rowH = height / Math.max(rows.length, 1);
  const pos = new Map<string, { x: number; y: number }>();
  rows.forEach((kind, ri) => {
    const list = byKind.get(kind)!;
    const rowY = rowH * ri + rowH / 2;
    list.forEach((n, ci) => {
      const x = list.length === 1 ? width / 2 : (width * (ci + 0.5)) / list.length;
      pos.set(n.id, { x, y: rowY });
    });
  });
  return pos;
}

function GraphSVG({ graph }: { graph: SessionGraph }) {
  const width = 880;
  const height = Math.max(320, 90 * graph.nodes.length);
  const pos = useMemo(() => layout(graph.nodes, width, height), [graph]);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto">
      <defs>
        <marker
          id="arrow"
          viewBox="0 0 10 10"
          refX="16"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#64748b" />
        </marker>
      </defs>
      {graph.edges.map((e, i) => {
        const from = pos.get(e.from);
        const to = pos.get(e.to);
        if (!from || !to) return null;
        const mx = (from.x + to.x) / 2;
        const d = `M ${from.x} ${from.y} C ${mx} ${from.y}, ${mx} ${to.y}, ${to.x} ${to.y}`;
        return (
          <path
            key={i}
            d={d}
            fill="none"
            stroke="#64748b"
            strokeWidth="1.2"
            markerEnd="url(#arrow)"
            opacity="0.7"
          />
        );
      })}
      {graph.nodes.map((n) => {
        const p = pos.get(n.id);
        if (!p) return null;
        const color = KIND_COLORS[n.kind];
        const label = n.label.length > 28 ? `${n.label.slice(0, 27)}…` : n.label;
        return (
          <g key={n.id} className="cursor-pointer" opacity={n.kind === "error" ? 1 : 0.95}>
            <title>{`${KIND_LABELS[n.kind]}: ${n.label}${n.detail ? `\n${n.detail}` : ""}`}</title>
            <circle
              cx={p.x}
              cy={p.y}
              r={n.kind === "milestone" || n.kind === "report" ? 15 : 11}
              fill={color}
              stroke="#0f172a"
              strokeWidth="2"
            />
            {n.kind === "error" && (
              <text
                x={p.x}
                y={p.y + 4}
                textAnchor="middle"
                fontSize="11"
                fill="#fff"
                fontWeight="bold"
              >
                !
              </text>
            )}
            <text
              x={p.x}
              y={p.y + 30}
              textAnchor="middle"
              fontSize="10"
              fill="#e2e8f0"
              className="select-none"
            >
              {label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export default function SessionGraphPage() {
  const [graphs, setGraphs] = useState<GraphSummary[]>([]);
  const [selected, setSelected] = useState<SessionGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ graphs: GraphSummary[] }>("/api/session-graph")
      .then(({ graphs: list }) => {
        if (!cancelled) setGraphs(list);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load session graphs");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const openGraph = (sessionId: string) => {
    setError(null);
    apiFetch<{ graph: SessionGraph }>(`/api/session-graph/${encodeURIComponent(sessionId)}`)
      .then(({ graph }) => setSelected(graph))
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load graph"));
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-6xl mx-auto p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Network className="size-6 text-muted-foreground" />
            <div>
              <h1 className="text-xl font-semibold">Session Graphs</h1>
              <p className="text-sm text-muted-foreground">
                Spider-graph memory of every AI pipeline run — captured at zero write cost, no LLM
                tokens spent to store it
              </p>
            </div>
          </div>
        </div>

        {error && (
          <div className="bg-destructive/10 text-destructive text-xs px-3 py-2 rounded-md">
            {error}
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {/* Session list */}
            <div className="space-y-2 lg:col-span-1">
              {graphs.length === 0 && (
                <Card>
                  <CardContent className="py-8 text-center text-sm text-muted-foreground">
                    No sessions yet — run a deep research job or a deliberation and its pipeline
                    graph will appear here.
                  </CardContent>
                </Card>
              )}
              {graphs.map((g) => (
                <Card
                  key={g.sessionId}
                  className={`cursor-pointer hover:ring-2 hover:ring-primary/20 transition-all ${
                    selected?.sessionId === g.sessionId ? "ring-2 ring-primary/50" : ""
                  }`}
                  onClick={() => openGraph(g.sessionId)}
                >
                  <CardHeader className="pb-2">
                    <div className="flex items-start justify-between gap-2">
                      <CardTitle className="text-sm truncate">{g.title || g.sessionId}</CardTitle>
                      <Badge
                        variant={g.kind === "research" ? "default" : "secondary"}
                        className="text-[10px] shrink-0"
                      >
                        {g.kind}
                      </Badge>
                    </div>
                    <CardDescription className="text-xs">
                      {g.nodeCount} nodes · {g.edgeCount} edges · {timeAgo(g.updatedAt)}
                    </CardDescription>
                  </CardHeader>
                </Card>
              ))}
            </div>

            {/* Graph view */}
            <Card className="lg:col-span-2">
              <CardHeader className="pb-2">
                {selected ? (
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <CardTitle className="text-sm truncate">{selected.title}</CardTitle>
                      <CardDescription className="text-xs">
                        {selected.nodes.length} nodes · {selected.edges.length} edges ·{" "}
                        {new Date(selected.updatedAt).toLocaleString()}
                      </CardDescription>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {selected.kind === "research" && (
                        <Button size="sm" variant="outline" className="gap-1.5 text-xs h-7" asChild>
                          <Link
                            to={`/deep-research?id=${selected.sessionId.replace(/^research:/, "")}`}
                          >
                            <ExternalLink className="size-3" />
                            Open report
                          </Link>
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        className="gap-1.5 text-xs h-7"
                        onClick={() => setSelected(null)}
                      >
                        <ArrowLeft className="size-3" />
                        Back
                      </Button>
                    </div>
                  </div>
                ) : (
                  <CardTitle className="text-sm text-muted-foreground">
                    Select a session to view its pipeline graph
                  </CardTitle>
                )}
              </CardHeader>
              <CardContent className="overflow-x-auto">
                {selected ? (
                  <GraphSVG graph={selected} />
                ) : (
                  <div className="flex items-center justify-center py-20 text-sm text-muted-foreground">
                    The graph shows the AI's thinking pipeline — from your prompt through phases,
                    milestones, citations and the final report or notification.
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}
