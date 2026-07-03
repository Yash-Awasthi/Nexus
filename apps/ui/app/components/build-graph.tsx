// SPDX-License-Identifier: Apache-2.0
/**
 * BuildGraph — DAG view of build tasks.
 *
 * Renders the parent→child structure of the Build board as a layered graph
 * using @xyflow/react (same library the Workflows page uses). Nodes are colored
 * by status; clicking a node opens the existing TaskDetailPanel via onSelect.
 *
 * Layout is a simple layered placement: depth = length of the parentId chain
 * (roots at depth 0), y = depth, x = order within the depth band. Tasks whose
 * parentId points outside the loaded window are treated as roots (and surfaced
 * via the `orphans` banner) rather than dropped silently.
 */
import { ReactFlow, Background, Controls, MiniMap, type Node, type Edge } from "@xyflow/react";
import { useMemo } from "react";
import "@xyflow/react/dist/style.css";

import type { BuildTask, TaskStatus } from "~/routes/build";

// Status → solid color (hex), matching the Kanban column palette.
const STATUS_COLOR: Record<TaskStatus, string> = {
  planned: "#64748b", // slate
  claimed: "#3b82f6", // blue
  in_progress: "#eab308", // amber
  review: "#a855f7", // purple
  done: "#22c55e", // green
  blocked: "#ef4444", // red
};

const NODE_WIDTH = 200;
const X_GAP = 230;
const Y_GAP = 120;

export function BuildGraph({
  tasks,
  onSelect,
}: {
  tasks: BuildTask[];
  onSelect: (t: BuildTask) => void;
}) {
  const { nodes, edges, orphanCount } = useMemo(() => {
    const byId = new Map<number, BuildTask>(tasks.map((t) => [t.id, t]));

    // Depth of each task: 0 for roots (no parent, or parent outside the window),
    // else parent depth + 1. Memoized with cycle protection.
    const depthCache = new Map<number, number>();
    let orphans = 0;
    const depthOf = (t: BuildTask, seen: Set<number>): number => {
      const cached = depthCache.get(t.id);
      if (cached != null) return cached;
      let d: number;
      if (t.parentId == null) {
        d = 0;
      } else if (!byId.has(t.parentId)) {
        orphans += 1;
        d = 0; // parent not in loaded window — treat as a root
      } else if (seen.has(t.id)) {
        d = 0; // cycle guard
      } else {
        seen.add(t.id);
        d = depthOf(byId.get(t.parentId)!, seen) + 1;
      }
      depthCache.set(t.id, d);
      return d;
    };

    const bandCounts = new Map<number, number>();
    const builtNodes: Node[] = tasks.map((t) => {
      const depth = depthOf(t, new Set());
      const col = bandCounts.get(depth) ?? 0;
      bandCounts.set(depth, col + 1);
      const color = STATUS_COLOR[t.status] ?? STATUS_COLOR.planned;
      return {
        id: String(t.id),
        position: { x: col * X_GAP, y: depth * Y_GAP },
        data: {
          label: (
            <div className="text-left">
              <div
                className="text-[11px] font-medium truncate"
                style={{ maxWidth: NODE_WIDTH - 24 }}
              >
                {t.title}
              </div>
              <div className="text-[9px] uppercase tracking-wide opacity-90">{t.status}</div>
            </div>
          ),
        },
        style: {
          background: color,
          color: "#fff",
          border: "1px solid rgba(255,255,255,0.25)",
          borderRadius: 8,
          width: NODE_WIDTH,
          padding: "6px 10px",
          fontSize: 11,
        },
      };
    });

    const builtEdges: Edge[] = tasks
      .filter((t) => t.parentId != null && byId.has(t.parentId))
      .map((t) => ({
        id: `e-${t.parentId}-${t.id}`,
        source: String(t.parentId),
        target: String(t.id),
        animated: t.status === "in_progress",
        style: { stroke: "#64748b" },
      }));

    return { nodes: builtNodes, edges: builtEdges, orphanCount: orphans };
  }, [tasks]);

  if (tasks.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-xs text-gray-400">
        No tasks to graph
      </div>
    );
  }

  return (
    <div className="flex-1 relative">
      {orphanCount > 0 && (
        <div className="absolute top-2 left-2 z-10 text-[10px] px-2 py-1 rounded bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300">
          {orphanCount} task{orphanCount === 1 ? "" : "s"} shown as roots (parent outside loaded
          window)
        </div>
      )}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodeClick={(_, node) => {
          const t = tasks.find((x) => String(x.id) === node.id);
          if (t) onSelect(t);
        }}
        fitView
        nodesDraggable={false}
        nodesConnectable={false}
        style={{ background: "#0a0a0a" }}
      >
        <Background color="#333" gap={20} />
        <Controls showInteractive={false} />
        <MiniMap
          style={{ background: "#1a1a1a" }}
          nodeColor={(n) => (n.style?.background as string) ?? "#666"}
        />
      </ReactFlow>
    </div>
  );
}
