// SPDX-License-Identifier: Apache-2.0
/**
 * Convergent merge for graph nodes and edges — the join both KGStore
 * implementations use for upsert, and the one federation sync uses to fold a
 * peer's graph into ours.
 *
 * The merge is a CRDT join: commutative, associative and idempotent, so two
 * peers that have seen the same set of facts hold the same graph regardless of
 * the order they arrived in, and re-sending a snapshot changes nothing. That
 * is what makes sync a plain exchange of state with no coordination.
 *
 * Node and edge ids are content hashes, so the same fact from two peers lands
 * on the same row. Per field:
 *
 *   confidence  max      — the strongest extraction that ever saw this fact
 *   sources     union    — grow-only set, sorted so equal sets serialise equally
 *   createdAt   min      — first sighting anywhere
 *   updatedAt   max      — last sighting anywhere
 *   name/type   last write wins on updatedAt
 *   properties  per-key last write wins on that key's own clock
 *
 * Properties carry `propertyClocks`: one timestamp per key, kept for deleted
 * keys too. A key with a clock but no value is a tombstone, and it beats a
 * peer that still carries the value at an older clock — without it a removed
 * property came back on the next sync. A key absent from both maps was never
 * seen by that peer and loses to any side that has seen it, which is what
 * separates "never had it" from "deleted it".
 *
 * A node that predates the clocks (none recorded) falls back to `updatedAt`
 * for every key, which is exactly the old whole-node behaviour, so existing
 * rows and older peers keep working. The merge writes clocks back, so a value
 * gains its own clock the first time it is merged.
 *
 * Ceiling: a tie on the same clock is still settled by comparing serialised
 * values — stable and identical on every peer, but arbitrary. A delete wins
 * that tie, on the grounds that a removal the user asked for should not be
 * undone by a concurrent write. Node and edge deletion has no tombstone
 * either; `deleteNode` still resurrects from a peer that has the node.
 */

import type { KGEdge, KGNode } from "./index.js";

/**
 * Pick between two values seen at different times. Falls back to comparing the
 * serialised values so peers break a tie the same way without talking.
 */
function lastWriteWins<T>(a: T, aAt: number, b: T, bAt: number): T {
  if (aAt !== bAt) return aAt > bAt ? a : b;
  return JSON.stringify(a) >= JSON.stringify(b) ? a : b;
}

function unionSorted(a: readonly string[], b: readonly string[]): string[] {
  return [...new Set([...a, ...b])].sort();
}

/** One key's state on one peer. `removed` is a tombstone: seen, then deleted. */
interface FieldState {
  at: number;
  value?: unknown;
  removed: boolean;
}

/** What `node` knows about `key`, or undefined when it has never seen it. */
function fieldState(node: KGNode, key: string): FieldState | undefined {
  const clock = node.propertyClocks?.[key];
  if (Object.hasOwn(node.properties, key)) {
    return { at: clock ?? node.updatedAt, value: node.properties[key], removed: false };
  }
  return clock === undefined ? undefined : { at: clock, removed: true };
}

function joinField(a: FieldState | undefined, b: FieldState | undefined): FieldState | undefined {
  if (!a || !b) return a ?? b;
  if (a.at !== b.at) return a.at > b.at ? a : b;
  if (a.removed !== b.removed) return a.removed ? a : b;
  return lastWriteWins(a, a.at, b, b.at);
}

interface MergedProperties {
  properties: Record<string, unknown>;
  propertyClocks?: Record<string, number>;
}

function mergeProperties(a: KGNode, b: KGNode): MergedProperties {
  const keys = new Set([
    ...Object.keys(a.properties),
    ...Object.keys(a.propertyClocks ?? {}),
    ...Object.keys(b.properties),
    ...Object.keys(b.propertyClocks ?? {}),
  ]);
  const properties: Record<string, unknown> = {};
  const propertyClocks: Record<string, number> = {};
  for (const key of [...keys].sort()) {
    const winner = joinField(fieldState(a, key), fieldState(b, key));
    if (!winner) continue;
    propertyClocks[key] = winner.at;
    if (!winner.removed) properties[key] = winner.value;
  }
  return Object.keys(propertyClocks).length > 0 ? { properties, propertyClocks } : { properties };
}

/**
 * Delete a property so the deletion survives a sync: the key leaves
 * `properties` but keeps a clock, which is what outranks a peer still holding
 * the value. Dropping the key without this reintroduces it on the next merge.
 */
export function removeNodeProperty(node: KGNode, key: string, at: number): KGNode {
  const properties = { ...node.properties };
  delete properties[key];
  return {
    ...node,
    properties,
    propertyClocks: { ...node.propertyClocks, [key]: at },
    updatedAt: Math.max(node.updatedAt, at),
  };
}

/** Join two versions of the same node. Throws when the ids differ. */
export function mergeNode(a: KGNode, b: KGNode): KGNode {
  if (a.id !== b.id) throw new Error(`mergeNode: different nodes (${a.id} vs ${b.id})`);
  return {
    id: a.id,
    name: lastWriteWins(a.name, a.updatedAt, b.name, b.updatedAt),
    type: lastWriteWins(a.type, a.updatedAt, b.type, b.updatedAt),
    confidence: Math.max(a.confidence, b.confidence),
    ...mergeProperties(a, b),
    sources: unionSorted(a.sources, b.sources),
    createdAt: Math.min(a.createdAt, b.createdAt),
    updatedAt: Math.max(a.updatedAt, b.updatedAt),
  };
}

/** Join two versions of the same edge. Throws when the ids differ. */
export function mergeEdge(a: KGEdge, b: KGEdge): KGEdge {
  if (a.id !== b.id) throw new Error(`mergeEdge: different edges (${a.id} vs ${b.id})`);
  return {
    id: a.id,
    subjectId: a.subjectId,
    predicate: a.predicate,
    objectId: a.objectId,
    confidence: Math.max(a.confidence, b.confidence),
    sources: unionSorted(a.sources, b.sources),
    createdAt: Math.min(a.createdAt, b.createdAt),
    updatedAt: Math.max(a.updatedAt, b.updatedAt),
  };
}

/** A whole graph as it travels between peers. */
export interface KGSnapshot {
  nodes: KGNode[];
  edges: KGEdge[];
}

function joinById<T extends { id: string }>(
  a: readonly T[],
  b: readonly T[],
  join: (x: T, y: T) => T,
): T[] {
  const out = new Map<string, T>();
  for (const item of [...a, ...b]) {
    const existing = out.get(item.id);
    out.set(item.id, existing ? join(existing, item) : item);
  }
  return [...out.values()].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}

/**
 * Join two graph snapshots. Id-sorted, so two peers holding the same facts
 * produce byte-identical output and can compare snapshots directly.
 */
export function mergeSnapshots(a: KGSnapshot, b: KGSnapshot): KGSnapshot {
  return {
    nodes: joinById(a.nodes, b.nodes, mergeNode),
    edges: joinById(a.edges, b.edges, mergeEdge),
  };
}
