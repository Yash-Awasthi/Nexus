// SPDX-License-Identifier: Apache-2.0
/**
 * Shared knowledge-graph wiring — extracted from api-bridge.ts (§16.7).
 *
 * Single owner of the lazy KG store/graph singletons. Consumers import
 * `getKGStore`/`getKG` from here: routes/kg.ts (the extracted /kg/* surface)
 * and the /symbolic/* surface still in api-bridge.ts. Behavior is
 * byte-identical to the previous bridge-local definitions.
 *
 * Store selection: pg-backed (NeonKGStore) when DATABASE_URL is set, else the
 * in-memory store. The default KnowledgeGraph uses null extractors, so
 * ingest/extract return zero entities unless real extractors are wired in
 * (flagged in routes/kg.ts).
 */

import { Pool } from "pg";

import {
  InMemoryKGStore,
  NeonKGStore,
  KnowledgeGraph,
  type KGStore,
  type NeonRow,
  type NeonQueryFn,
} from "@nexus/knowledge-graph";

let _kgStore: KGStore | null = null;
let _kg: KnowledgeGraph | null = null;

export function getKGStore(): KGStore {
  if (_kgStore) return _kgStore;
  if (process.env.DATABASE_URL) {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const queryFn: NeonQueryFn = (sql, params) =>
      pool.query(sql, params!).then((r) => ({ rows: r.rows as NeonRow[] }));
    _kgStore = new NeonKGStore({ query: queryFn });
  } else {
    _kgStore = new InMemoryKGStore();
  }
  return _kgStore;
}

export function getKG(): KnowledgeGraph {
  if (_kg) return _kg;
  _kg = new KnowledgeGraph(getKGStore());
  return _kg;
}