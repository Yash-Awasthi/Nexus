// SPDX-License-Identifier: Apache-2.0
/**
 * Real transport and storage for the sync loop (contract in `sync.ts`).
 *
 * The wire format is the existing `/api/v1/session-sync/:id/{pull,push}`
 * surface, so the cloud side needs nothing new to talk to a desktop.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { SyncOp, SyncState, SyncTransport } from "./sync";

const EMPTY: SyncState = { cursor: 0, ledger: [] };

/** One side of a sync, addressed by base URL and bearer token. */
export function httpSyncTransport(baseUrl: string, token: string): SyncTransport {
  const base = baseUrl.replace(/\/+$/, "");
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  return {
    async pull(sessionId, since) {
      const url = `${base}/api/v1/session-sync/${encodeURIComponent(sessionId)}/pull?since=${since}`;
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
      // A session this side has never seen has nothing to send, which is not
      // an error — it is the first sync.
      if (res.status === 404) return { ops: [] };
      if (!res.ok) throw new Error(`pull failed: HTTP ${res.status}`);
      return (await res.json()) as { ops: SyncOp[] };
    },

    async push(sessionId, ops) {
      const url = `${base}/api/v1/session-sync/${encodeURIComponent(sessionId)}/push`;
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ ops }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`push failed: HTTP ${res.status}`);
      return (await res.json()) as { opsApplied: number };
    },
  };
}

/** Cursor and ledger on disk, beside the database they describe. */
export function fileSyncState(dataDir: string): {
  readState: () => SyncState;
  writeState: (state: SyncState) => void;
  path: string;
} {
  const path = join(dataDir, "sync-state.json");
  return {
    path,
    readState: () => {
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<SyncState>;
        return {
          cursor: typeof parsed.cursor === "number" ? parsed.cursor : 0,
          ledger: Array.isArray(parsed.ledger) ? parsed.ledger : [],
        };
      } catch {
        // No file yet, or one this build cannot read: syncing from zero is
        // correct and safe — the merge is idempotent.
        return EMPTY;
      }
    },
    writeState: (state) => {
      if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
      writeFileSync(path, JSON.stringify(state, null, 2), "utf8");
    },
  };
}
