// SPDX-License-Identifier: Apache-2.0
/**
 * Session spider-graph memory — ZERO write cost by construction.
 *
 * Each session (research job / deliberation thread) gets a directed graph of
 * the pipeline's thinking: user prompt → phases → milestones → citations →
 * report → notifications. Nodes and edges are recorded from events that ALREADY
 * flow through the pipeline (research phase transitions, thread rounds,
 * notification emits). No LLM call, no embedding, no summarization is ever
 * made to write memory — the only cost is a bounded, debounce-free KV write
 * that is fire-and-forget from the caller's perspective (a handful of appends
 * per session, never on a hot per-token path).
 *
 * Layout (shared KV, mirroring threads-store / research-jobs-store):
 *   graph:<userId>:<sessionId>  — the graph record (30 d TTL, 200-node cap)
 *   graph:idx:<userId>          — id-list index (100 graphs cap)
 *
 * `edge.from === "last"` is a sentinel resolved at append time to the most
 * recently added node, so callers never need to track graph internals.
 */

import { getSharedKV } from "./shared-kv.js";
import { withKeyLock } from "./with-key-lock.js";

const GRAPH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_NODES = 200;
const MAX_GRAPHS_PER_USER = 100;

export type GraphNodeKind =
  | "user"
  | "phase"
  | "milestone"
  | "citation"
  | "report"
  | "notification"
  | "thread"
  | "message"
  | "tool"
  | "skill"
  | "mission"
  | "error";

/** Lifecycle status of a runtime-executed unit (e.g. a skill code run). */
export type ExecutionStatus = "started" | "completed" | "failed";

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  label: string;
  detail?: string;
  link?: string;
  /** Set on runtime-emitted execution events (skill runs etc.). */
  status?: ExecutionStatus;
  ts: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: string;
}

export type SessionKind = "research" | "deliberation" | "mission";

export interface SessionGraph {
  sessionId: string;
  userId: string;
  kind: SessionKind;
  title: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  createdAt: string;
  updatedAt: string;
}

export interface GraphEvent {
  /** Node to record (ts is stamped here — callers never provide it). */
  node: Omit<GraphNode, "ts">;
  /** Optional edge from an existing node ("last" resolves to the newest node). */
  edge?: { from: string; to: string; kind?: string };
  /** Set on the first event to name the session (later events are ignored). */
  title?: string;
}

function userIdFor(uid: string | undefined): string {
  return (uid ?? "anon").slice(0, 200);
}

function itemKey(uid: string, sessionId: string): string {
  return `graph:${uid}:${sessionId}`;
}

function indexKey(uid: string): string {
  return `graph:idx:${uid}`;
}

/** Append one pipeline event to a session graph. Never throws to callers. */
export async function appendGraphEvent(
  userId: string | undefined,
  sessionId: string,
  kind: SessionKind,
  event: GraphEvent,
): Promise<void> {
  const uid = userIdFor(userId);
  const key = itemKey(uid, sessionId);
  try {
    await withKeyLock(key, async () => {
      const kv = getSharedKV();
      const existing = await kv.get<SessionGraph>(key);
      const nowIso = new Date().toISOString();
      const node: GraphNode = { ...event.node, ts: nowIso };
      const graph: SessionGraph = existing ?? {
        sessionId,
        userId: uid,
        kind,
        title: event.title ?? sessionId,
        nodes: [],
        edges: [],
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      if (!graph.nodes.some((n) => n.id === node.id)) {
        graph.nodes.push(node);
        if (event.edge) {
          // Resolve the "last" sentinel to the node BEFORE the one just pushed
          // (the previous newest node). On an empty graph there IS no previous
          // node — skip the edge rather than self-link the first node.
          const from =
            event.edge.from === "last"
              ? graph.nodes.length >= 2
                ? graph.nodes[graph.nodes.length - 2]!.id
                : undefined
              : event.edge.from;
          if (from !== undefined && graph.nodes.some((n) => n.id === from)) {
            graph.edges.push({ from, to: node.id, kind: event.edge.kind ?? "next" });
          }
        }
        // Ring cap — drop the oldest nodes (and edges touching them).
        if (graph.nodes.length > MAX_NODES) {
          const dropped = new Set(
            graph.nodes.slice(0, graph.nodes.length - MAX_NODES).map((n) => n.id),
          );
          graph.nodes = graph.nodes.slice(-MAX_NODES);
          graph.edges = graph.edges.filter((e) => !dropped.has(e.from) && !dropped.has(e.to));
        }
        if (event.title) graph.title = event.title.slice(0, 200);
        graph.updatedAt = nowIso;
        await kv.set(key, graph, GRAPH_TTL_MS);
        // Maintain the per-user id index (best-effort, cap 100).
        const ids = (await kv.get<string[]>(indexKey(uid))) ?? [];
        if (!ids.includes(sessionId)) {
          await kv.set(
            indexKey(uid),
            [sessionId, ...ids].slice(0, MAX_GRAPHS_PER_USER),
            GRAPH_TTL_MS,
          );
        }
      }
    });
  } catch (err) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "session-graph.append-failed",
        sessionId,
        error: (err as Error).message,
      }),
    );
  }
}

/** Recent session graphs for a user (newest first). */
export async function listSessionGraphs(
  userId: string | undefined,
  limit = 50,
): Promise<SessionGraph[]> {
  const uid = userIdFor(userId);
  const kv = getSharedKV();
  try {
    const ids = (await kv.get<string[]>(indexKey(uid))) ?? [];
    const out: SessionGraph[] = [];
    for (const id of ids.slice(0, Math.min(limit, 100))) {
      const g = await kv.get<SessionGraph>(itemKey(uid, id));
      if (g) out.push(g);
    }
    return out;
  } catch {
    return [];
  }
}

/** Fetch one session graph (undefined → caller 404s; per-user isolation). */
export async function getSessionGraph(
  userId: string | undefined,
  sessionId: string,
): Promise<SessionGraph | undefined> {
  const uid = userIdFor(userId);
  try {
    return await getSharedKV().get<SessionGraph>(itemKey(uid, sessionId));
  } catch {
    return undefined;
  }
}
