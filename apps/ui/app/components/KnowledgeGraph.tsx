// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState, useCallback } from "react";

interface Node {
  id: string;
  label: string;
  type: "paper" | "author" | "topic" | "concept";
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface Edge {
  source: string;
  target: string;
  weight: number;
}

const mockNodes: Node[] = [
  { id: "1", label: "Attention Is All You Need", type: "paper", x: 200, y: 150, vx: 0, vy: 0 },
  { id: "2", label: "BERT", type: "paper", x: 350, y: 100, vx: 0, vy: 0 },
  { id: "3", label: "GPT-3", type: "paper", x: 400, y: 250, vx: 0, vy: 0 },
  { id: "4", label: "Transformer", type: "concept", x: 280, y: 180, vx: 0, vy: 0 },
  { id: "5", label: "Vaswani et al.", type: "author", x: 150, y: 220, vx: 0, vy: 0 },
  { id: "6", label: "NLP", type: "topic", x: 320, y: 300, vx: 0, vy: 0 },
  { id: "7", label: "Deep Learning", type: "topic", x: 180, y: 320, vx: 0, vy: 0 },
  { id: "8", label: "Self-Attention", type: "concept", x: 250, y: 80, vx: 0, vy: 0 },
];

const mockEdges: Edge[] = [
  { source: "1", target: "4", weight: 3 },
  { source: "2", target: "4", weight: 2 },
  { source: "3", target: "4", weight: 2 },
  { source: "1", target: "5", weight: 1 },
  { source: "4", target: "8", weight: 2 },
  { source: "6", target: "4", weight: 1 },
  { source: "7", target: "6", weight: 1 },
  { source: "2", target: "6", weight: 1 },
];

const typeColors: Record<Node["type"], string> = {
  paper: "var(--accent, #7acc5a)",
  author: "var(--info, #5a8acc)",
  topic: "var(--warning, #ccb85a)",
  concept: "var(--danger, #cc5a5a)",
};

export function KnowledgeGraph() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  const hoveredNodeRef = useRef<Node | null>(null);
  const nodesRef = useRef<Node[]>(mockNodes);
  const edgesRef = useRef<Edge[]>(mockEdges);
  const nodeMapRef = useRef<Map<string, Node>>(new Map());
  const animFrameRef = useRef<number | undefined>(undefined);

  const getNodeAtPosition = useCallback((x: number, y: number): Node | null => {
    for (const node of nodesRef.current) {
      const dx = node.x - x;
      const dy = node.y - y;
      if (Math.sqrt(dx * dx + dy * dy) < 20) {
        return node;
      }
    }
    return null;
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const resizeCanvas = () => {
      const rect = canvas.parentElement?.getBoundingClientRect();
      if (rect) {
        canvas.width = rect.width * window.devicePixelRatio;
        canvas.height = rect.height * window.devicePixelRatio;
        canvas.style.width = rect.width + "px";
        canvas.style.height = rect.height + "px";
        ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
      }
    };

    resizeCanvas();
    window.addEventListener("resize", resizeCanvas);

    // Simple force simulation
    const simulate = () => {
      const nodes = nodesRef.current;
      const edges = edgesRef.current;

      // Repulsion between nodes
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const dx = nodes[j].x - nodes[i].x;
          const dy = nodes[j].y - nodes[i].y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const force = 5000 / (dist * dist);
          nodes[i].vx -= (dx / dist) * force;
          nodes[i].vy -= (dy / dist) * force;
          nodes[j].vx += (dx / dist) * force;
          nodes[j].vy += (dy / dist) * force;
        }
      }

      // Attraction along edges
      for (const edge of edges) {
        const source = nodes.find((n) => n.id === edge.source);
        const target = nodes.find((n) => n.id === edge.target);
        if (!source || !target) continue;

        const dx = target.x - source.x;
        const dy = target.y - source.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const force = (dist - 100) * 0.01;
        source.vx += (dx / dist) * force;
        source.vy += (dy / dist) * force;
        target.vx -= (dx / dist) * force;
        target.vy -= (dy / dist) * force;
      }

      // Center gravity
      const centerX = canvas.width / window.devicePixelRatio / 2;
      const centerY = canvas.height / window.devicePixelRatio / 2;
      for (const node of nodes) {
        node.vx += (centerX - node.x) * 0.001;
        node.vy += (centerY - node.y) * 0.001;
      }

      // Apply velocity with damping
      for (const node of nodes) {
        node.vx *= 0.9;
        node.vy *= 0.9;
        node.x += node.vx;
        node.y += node.vy;
        // Bounds
        node.x = Math.max(30, Math.min(canvas.width / window.devicePixelRatio - 30, node.x));
        node.y = Math.max(30, Math.min(canvas.height / window.devicePixelRatio - 30, node.y));
      }
    };

    const draw = () => {
      const nodes = nodesRef.current;
      const edges = edgesRef.current;
      const map = nodeMapRef.current;
      const dpr = window.devicePixelRatio;
      const w = canvas.width / dpr;
      const h = canvas.height / dpr;

      ctx.clearRect(0, 0, w, h);

      ctx.strokeStyle = "rgba(128, 128, 128, 0.2)";
      ctx.lineWidth = 1;
      for (const edge of edges) {
        const source = map.get(edge.source);
        const target = map.get(edge.target);
        if (!source || !target) continue;
        ctx.beginPath();
        ctx.moveTo(source.x, source.y);
        ctx.lineTo(target.x, target.y);
        ctx.stroke();
      }

      const hovered = hoveredNodeRef.current;
      const selected = selectedNode;
      for (const node of nodes) {
        const isH = hovered?.id === node.id;
        const isS = selected?.id === node.id;
        const r = isH || isS ? 18 : 14;

        ctx.beginPath();
        ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
        ctx.fillStyle = typeColors[node.type];
        ctx.fill();

        if (isS) {
          ctx.strokeStyle = "#fff";
          ctx.lineWidth = 2;
          ctx.stroke();
        }

        ctx.fillStyle = "#e8e9ed";
        ctx.font = "11px Inter, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(node.label, node.x, node.y + r + 14);
      }

      simulate();
      animFrameRef.current = requestAnimationFrame(draw);
    };

    // Build node lookup map
    nodeMapRef.current = new Map(nodesRef.current.map((n) => [n.id, n]));
    draw();

    return () => {
      window.removeEventListener("resize", resizeCanvas);
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, [selectedNode]);

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const node = getNodeAtPosition(x, y);
    hoveredNodeRef.current = node;
    canvasRef.current!.style.cursor = node ? "pointer" : "default";
  };

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const node = getNodeAtPosition(x, y);
    setSelectedNode(node);
  };

  return (
    <div
      className="relative h-full w-full rounded-lg overflow-hidden"
      style={{ background: "var(--surface)" }}
    >
      <canvas
        ref={canvasRef}
        className="h-full w-full"
        onMouseMove={handleMouseMove}
        onClick={handleClick}
      />

      {/* Legend */}
      <div
        className="absolute bottom-4 left-4 rounded-lg p-3"
        style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}
      >
        <p className="text-xs font-medium mb-2" style={{ color: "var(--text-muted)" }}>
          Node Types
        </p>
        <div className="space-y-1">
          {Object.entries(typeColors).map(([type, color]) => (
            <div key={type} className="flex items-center gap-2">
              <div className="h-2.5 w-2.5 rounded-full" style={{ background: color }} />
              <span className="text-xs capitalize" style={{ color: "var(--text-muted)" }}>
                {type}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Selected node info */}
      {selectedNode && (
        <div
          className="absolute top-4 right-4 rounded-lg p-4 w-64"
          style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}
        >
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
              {selectedNode.label}
            </span>
            <button
              onClick={() => setSelectedNode(null)}
              className="text-xs"
              style={{ color: "var(--text-muted)" }}
            >
              ×
            </button>
          </div>
          <div className="space-y-1">
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>
              Type: <span className="capitalize">{selectedNode.type}</span>
            </p>
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>
              Connections:{" "}
              {
                edgesRef.current.filter(
                  (e) => e.source === selectedNode.id || e.target === selectedNode.id,
                ).length
              }
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
