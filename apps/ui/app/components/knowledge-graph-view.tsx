// SPDX-License-Identifier: Apache-2.0
import { Loader2, Minus, Pause, Play, Plus, Search, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { GraphEdge, GraphHandle, GraphNode } from "~/components/graph-3d";
import { Button } from "~/components/ui/button";
import { apiFetch } from "~/lib/api";

const LEGEND: [string, string, string][] = [
  ["PERSON", "People", "#7c83ff"],
  ["ORG", "Organisations", "#3fd0e0"],
  ["LOCATION", "Places", "#6ee7a8"],
  ["PRODUCT", "Products", "#c084fc"],
  ["EVENT", "Events", "#f472b6"],
  ["DATE", "Dates", "#fbbf24"],
  ["OTHER", "Other", "#9aa0b4"],
];

interface Drawn {
  nodes: GraphNode[];
  edges: GraphEdge[];
  total: { nodes: number; edges: number };
}

/** The graph as something to turn and click; a chosen entity lists what it is linked to. */
export function KnowledgeGraphView({
  reloadKey,
  onSearch,
}: {
  reloadKey: number;
  onSearch: (name: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<GraphHandle | null>(null);
  const [data, setData] = useState<Drawn | null>(null);
  const [error, setError] = useState("");
  const [webgl, setWebgl] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null);
  const [spinning, setSpinning] = useState(true);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const d = await apiFetch<Drawn>("/api/kg/graph?limit=150");
        if (live) setData(d);
      } catch (e: unknown) {
        if (live) {
          setError(e instanceof Error ? e.message : String(e));
          setData({ nodes: [], edges: [], total: { nodes: 0, edges: 0 } });
        }
      }
    })();
    return () => {
      live = false;
    };
  }, [reloadKey]);

  useEffect(() => {
    const el = host.current;
    if (!el || !data || data.nodes.length === 0) return;
    let stopped = false;
    void (async () => {
      try {
        const { mountGraph } = await import("~/components/graph-3d");
        if (stopped) return;
        const g = mountGraph(el, data.nodes, data.edges, {
          reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
          onSelect: setSelected,
          onHover: (id, x, y) => setHover(id ? { id, x, y } : null),
        });
        if (!g) setWebgl(false);
        handle.current = g;
      } catch {
        setWebgl(false);
      }
    })();
    return () => {
      stopped = true;
      handle.current?.dispose();
      handle.current = null;
      setSelected(null);
    };
  }, [data]);

  useEffect(() => {
    handle.current?.select(selected);
    setConfirming(false);
  }, [selected]);

  async function remove(id: string) {
    try {
      await apiFetch(`/api/kg/nodes/${encodeURIComponent(id)}`, { method: "DELETE" });
      setData(
        (d) =>
          d && {
            nodes: d.nodes.filter((n) => n.id !== id),
            edges: d.edges.filter((e) => e.subjectId !== id && e.objectId !== id),
            total: { nodes: d.total.nodes - 1, edges: d.total.edges },
          },
      );
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const byId = useMemo(() => new Map((data?.nodes ?? []).map((n) => [n.id, n])), [data]);
  const links = useMemo(() => {
    if (!selected || !data) return [];
    return data.edges
      .filter((e) => e.subjectId === selected || e.objectId === selected)
      .map((e) => {
        const out = e.subjectId === selected;
        const other = byId.get(out ? e.objectId : e.subjectId);
        return { id: e.id, predicate: e.predicate, out, other };
      });
  }, [selected, data, byId]);
  const chosen = selected ? byId.get(selected) : undefined;
  const hovered = hover ? byId.get(hover.id) : undefined;

  if (data === null) {
    return <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />;
  }
  if (data.nodes.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {error || "The graph is empty. Build it from a knowledge base, or add text below."}
      </p>
    );
  }
  if (!webgl) {
    return (
      <p className="text-sm text-muted-foreground">
        This browser cannot draw 3D, so the graph is listed under Communities instead.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="relative h-[22rem] overflow-hidden rounded-lg border bg-muted/40 sm:h-[28rem]">
        <div ref={host} className="absolute inset-0" role="img" aria-label="Knowledge graph" />
        {hovered && hover && (
          <span
            className="pointer-events-none absolute z-10 rounded-md border bg-popover px-2 py-1 text-xs shadow"
            style={{ left: Math.min(hover.x + 12, 9999), top: hover.y + 12 }}
          >
            {hovered.name}
            <span className="text-muted-foreground"> · {hovered.type}</span>
          </span>
        )}
        <div className="absolute right-2 bottom-2 flex gap-1">
          <Button
            size="icon"
            variant="secondary"
            className="size-8"
            aria-label={spinning ? "Stop turning" : "Turn slowly"}
            onClick={() => {
              handle.current?.spin(!spinning);
              setSpinning(!spinning);
            }}
          >
            {spinning ? <Pause className="size-4" /> : <Play className="size-4" />}
          </Button>
          <Button
            size="icon"
            variant="secondary"
            className="size-8"
            aria-label="Zoom in"
            onClick={() => handle.current?.zoom(0.8)}
          >
            <Plus className="size-4" />
          </Button>
          <Button
            size="icon"
            variant="secondary"
            className="size-8"
            aria-label="Zoom out"
            onClick={() => handle.current?.zoom(1.25)}
          >
            <Minus className="size-4" />
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {LEGEND.map(([type, label, color]) => (
          <span key={type} className="flex items-center gap-1.5">
            <span className="size-2 rounded-full" style={{ background: color }} /> {label}
          </span>
        ))}
        <span className="ml-auto">
          {data.nodes.length} of {data.total.nodes} entities · drag to turn
        </span>
      </div>

      {chosen && (
        <div className="space-y-2 rounded-lg border p-3 text-sm">
          <div className="flex items-center justify-between gap-2">
            <p className="font-medium break-words">
              {chosen.name}{" "}
              <span className="font-normal text-muted-foreground">· {chosen.type}</span>
            </p>
            <div className="flex shrink-0 gap-1.5">
              <Button size="sm" variant="outline" onClick={() => onSearch(chosen.name)}>
                <Search className="size-3.5" /> Search
              </Button>
              <Button
                size="sm"
                variant={confirming ? "destructive" : "outline"}
                onClick={() => (confirming ? void remove(chosen.id) : setConfirming(true))}
              >
                <Trash2 className="size-3.5" /> {confirming ? "Confirm" : "Delete"}
              </Button>
            </div>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          {links.length === 0 ? (
            <p className="text-xs text-muted-foreground">No relationships drawn for this one.</p>
          ) : (
            <ul className="space-y-1 text-xs">
              {links.map((l) => (
                <li key={l.id} className="break-words">
                  <span className="text-muted-foreground">
                    {l.out ? `${l.predicate} →` : `← ${l.predicate}`}
                  </span>{" "}
                  <button
                    type="button"
                    className="underline-offset-2 hover:underline"
                    onClick={() => l.other && setSelected(l.other.id)}
                  >
                    {l.other?.name ?? "unknown"}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
