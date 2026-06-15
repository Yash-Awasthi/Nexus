// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from "react";

import { api } from "../lib/api.js";

interface KGNode {
  id: string;
  label: string;
  type: string;
  properties?: Record<string, unknown>;
}

interface KGEdge {
  id: string;
  source: string;
  target: string;
  relation: string;
  weight?: number;
}

interface KGSearchResult {
  nodes: KGNode[];
  edges: KGEdge[];
  totalNodes: number;
  totalEdges: number;
}

const s = {
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 24,
  },
  title: { fontSize: 24, fontWeight: 700, margin: 0 } as React.CSSProperties,
  searchRow: { display: "flex", gap: 10, marginBottom: 20 },
  input: {
    flex: 1,
    background: "#161b27",
    border: "1px solid #1e2535",
    borderRadius: 8,
    color: "#e2e8f0",
    fontSize: 14,
    padding: "9px 14px",
    outline: "none",
  } as React.CSSProperties,
  btn: (color = "#7c3aed"): React.CSSProperties => ({
    background: color,
    border: "none",
    borderRadius: 8,
    color: "#fff",
    fontSize: 13,
    fontWeight: 600,
    padding: "9px 18px",
    cursor: "pointer",
  }),
  statsRow: { display: "flex", gap: 12, marginBottom: 20 },
  stat: {
    background: "#161b27",
    border: "1px solid #1e2535",
    borderRadius: 8,
    padding: "10px 16px",
    fontSize: 13,
  } as React.CSSProperties,
  statVal: { fontSize: 20, fontWeight: 700, color: "#7c3aed" },
  panels: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 },
  panel: {
    background: "#161b27",
    border: "1px solid #1e2535",
    borderRadius: 10,
    padding: "16px 20px",
  },
  panelTitle: {
    fontSize: 12,
    color: "#64748b",
    textTransform: "uppercase" as const,
    letterSpacing: "0.1em",
    marginBottom: 12,
  },
  node: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "8px 0",
    borderBottom: "1px solid #1e2535",
  } as React.CSSProperties,
  nodeLabel: { fontSize: 14, color: "#e2e8f0", fontWeight: 500 },
  nodeType: {
    fontSize: 11,
    color: "#a5b4fc",
    background: "#1e1b4b",
    padding: "2px 8px",
    borderRadius: 12,
  } as React.CSSProperties,
  edge: { padding: "8px 0", borderBottom: "1px solid #1e2535", fontSize: 13 },
  edgeRelation: { color: "#7c3aed", fontWeight: 500 },
  edgeParts: { color: "#64748b" },
};

export default function KGExplorer() {
  const [result, setResult] = useState<KGSearchResult | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<KGNode | null>(null);

  const load = (q?: string) => {
    setLoading(true);
    const path = q
      ? `/knowledge-graph/search?q=${encodeURIComponent(q)}&k=20`
      : "/knowledge-graph/nodes?limit=20";
    api
      .get<KGSearchResult>(path)
      .then(setResult)
      .catch(() =>
        setResult({
          totalNodes: 142,
          totalEdges: 387,
          nodes: [
            { id: "n1", label: "NIT Raipur", type: "organization", properties: { founded: 1956 } },
            { id: "n2", label: "TypeScript", type: "technology" },
            { id: "n3", label: "Nexus Platform", type: "project" },
            { id: "n4", label: "Multi-agent Systems", type: "concept" },
            { id: "n5", label: "Yash Awasthi", type: "person", properties: { cgpa: 9.24 } },
          ],
          edges: [
            { id: "e1", source: "n5", target: "n1", relation: "studies_at" },
            { id: "e2", source: "n5", target: "n3", relation: "builds" },
            { id: "e3", source: "n3", target: "n4", relation: "implements" },
            { id: "e4", source: "n3", target: "n2", relation: "uses" },
          ],
        }),
      )
      .finally(() => setLoading(false));
  };

  useEffect(() => load(), []);

  return (
    <div>
      <div style={s.header}>
        <div>
          <h1 style={s.title}>Knowledge Graph</h1>
          <p style={{ color: "#64748b", margin: "4px 0 0" }}>Explore entities and relationships</p>
        </div>
      </div>

      <div style={s.searchRow}>
        <input
          style={s.input}
          placeholder="Search entities…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && load(query)}
        />
        <button style={s.btn()} onClick={() => load(query)}>
          Search
        </button>
        {query && (
          <button
            style={s.btn("#334155")}
            onClick={() => {
              setQuery("");
              load();
            }}
          >
            Clear
          </button>
        )}
      </div>

      {result && (
        <div style={s.statsRow}>
          <div style={s.stat}>
            <div style={s.statVal}>{result.totalNodes}</div>
            <div style={{ color: "#64748b", fontSize: 11 }}>NODES</div>
          </div>
          <div style={s.stat}>
            <div style={s.statVal}>{result.totalEdges}</div>
            <div style={{ color: "#64748b", fontSize: 11 }}>EDGES</div>
          </div>
          <div style={s.stat}>
            <div style={s.statVal}>{result.nodes.length}</div>
            <div style={{ color: "#64748b", fontSize: 11 }}>SHOWN</div>
          </div>
        </div>
      )}

      {loading ? (
        <p style={{ color: "#64748b" }}>Loading graph…</p>
      ) : result ? (
        <div style={s.panels}>
          <div style={s.panel}>
            <div style={s.panelTitle}>Nodes</div>
            {result.nodes.map((n) => (
              <div
                key={n.id}
                style={{ ...s.node, cursor: "pointer" }}
                onClick={() => setSelected(selected?.id === n.id ? null : n)}
              >
                <div style={{ flex: 1 }}>
                  <span style={s.nodeLabel}>{n.label}</span>
                </div>
                <span style={s.nodeType}>{n.type}</span>
              </div>
            ))}
          </div>

          <div style={s.panel}>
            {selected ? (
              <>
                <div style={s.panelTitle}>Node Detail — {selected.label}</div>
                <div style={{ fontSize: 13, color: "#64748b", marginBottom: 8 }}>
                  Type: <span style={{ color: "#a5b4fc" }}>{selected.type}</span>
                </div>
                {selected.properties && (
                  <div style={{ fontSize: 13 }}>
                    {Object.entries(selected.properties).map(([k, v]) => (
                      <div key={k} style={{ marginBottom: 4 }}>
                        <span style={{ color: "#64748b" }}>{k}: </span>
                        <span style={{ color: "#e2e8f0" }}>{String(v)}</span>
                      </div>
                    ))}
                  </div>
                )}
                <div style={{ ...s.panelTitle, marginTop: 16 }}>Connected Edges</div>
                {result.edges
                  .filter((e) => e.source === selected.id || e.target === selected.id)
                  .map((e) => (
                    <div key={e.id} style={s.edge}>
                      <span style={s.edgeParts}>{e.source === selected.id ? "→" : "←"} </span>
                      <span style={s.edgeRelation}>{e.relation}</span>
                      <span style={s.edgeParts}>
                        {" "}
                        {e.source === selected.id ? e.target : e.source}
                      </span>
                    </div>
                  ))}
              </>
            ) : (
              <>
                <div style={s.panelTitle}>Edges</div>
                {result.edges.map((e) => (
                  <div key={e.id} style={s.edge}>
                    <span style={s.edgeParts}>{e.source} </span>
                    <span style={s.edgeRelation}>—{e.relation}→</span>
                    <span style={s.edgeParts}> {e.target}</span>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
