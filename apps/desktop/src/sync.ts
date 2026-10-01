// SPDX-License-Identifier: Apache-2.0
/**
 * Delta sync between the local API and a cloud deployment (spec milestone M3).
 *
 * The protocol is the existing `/api/v1/session-sync/:id/{pull,push}` surface,
 * so nothing new is invented on the wire. What this adds is the loop and the
 * record of it:
 *
 *   pull remote ops since our cursor → apply them locally → push local ops the
 *   remote has not seen → write a ledger entry.
 *
 * **Conflict policy.** Both sides carry a per-key logical time, so a key
 * written on one side only is not a conflict at all — it is applied. A key
 * written on both is settled per field by the later logical time, and on a tie
 * by device id, which every peer orders the same way. Losing values are not
 * discarded silently: every one is named in the ledger entry, with which side
 * won and what the other side had. A conflict the user can read about is
 * recoverable; one that only appears as a changed value is not.
 *
 * **The ledger is the point.** "It syncs" is not a claim a user can check.
 * Each run appends an entry saying what moved in each direction, what
 * conflicted, and what failed, so the answer to "did my work reach the other
 * machine" is a record rather than a reassurance.
 *
 * Free of Electron and of Node's filesystem: transport and storage come in as
 * ports, so the loop is testable without either.
 */

export interface SyncOp {
  type: "set" | "delete" | "merge";
  key: string;
  value?: unknown;
  deviceId: string;
  logicalTime: number;
  timestamp: string;
}

/** One key that both sides changed, and how it was settled. */
export interface SyncConflict {
  key: string;
  winner: "local" | "remote";
  /** The value that did not win, kept so it can be recovered. */
  discarded: unknown;
  keptFrom: string;
}

/** One sync run, as the user can read it back. */
export interface SyncLedgerEntry {
  at: string;
  remote: string;
  pulled: number;
  pushed: number;
  conflicts: SyncConflict[];
  /** Cursor to pull from next time. */
  cursor: number;
  error?: string;
}

export interface SyncState {
  cursor: number;
  ledger: SyncLedgerEntry[];
}

export interface SyncTransport {
  pull(sessionId: string, since: number): Promise<{ ops: SyncOp[] }>;
  push(sessionId: string, ops: SyncOp[]): Promise<{ opsApplied: number }>;
}

export interface SyncPorts {
  /** The cloud deployment. */
  remote: SyncTransport;
  /** This machine's API. */
  local: SyncTransport;
  readState(): SyncState;
  writeState(state: SyncState): void;
  now(): string;
  deviceId: string;
}

/** How many runs the ledger keeps. Older entries answer nothing actionable. */
export const LEDGER_LIMIT = 50;

/**
 * Settle one key written on both sides. Later logical time wins; a tie goes to
 * the higher device id so both machines reach the same answer without talking.
 */
export function settle(local: SyncOp, remote: SyncOp): { winner: "local" | "remote" } {
  if (local.logicalTime !== remote.logicalTime) {
    return { winner: local.logicalTime > remote.logicalTime ? "local" : "remote" };
  }
  return { winner: local.deviceId >= remote.deviceId ? "local" : "remote" };
}

/** Last op per key, which is the only one that can still be in conflict. */
function latestByKey(ops: readonly SyncOp[]): Map<string, SyncOp> {
  const out = new Map<string, SyncOp>();
  for (const op of ops) {
    const seen = out.get(op.key);
    if (!seen || op.logicalTime >= seen.logicalTime) out.set(op.key, op);
  }
  return out;
}

/**
 * Run one sync. Never throws: a failed run is a ledger entry with an error and
 * an unchanged cursor, so the next run retries exactly what did not land.
 */
export async function syncOnce(
  sessionId: string,
  ports: SyncPorts,
  remoteLabel: string,
): Promise<SyncLedgerEntry> {
  const state = ports.readState();
  const base: SyncLedgerEntry = {
    at: ports.now(),
    remote: remoteLabel,
    pulled: 0,
    pushed: 0,
    conflicts: [],
    cursor: state.cursor,
  };

  let entry: SyncLedgerEntry;
  try {
    const [remoteSide, localSide] = await Promise.all([
      ports.remote.pull(sessionId, state.cursor),
      ports.local.pull(sessionId, state.cursor),
    ]);

    const localLatest = latestByKey(localSide.ops);
    const conflicts: SyncConflict[] = [];
    const toApplyLocally: SyncOp[] = [];

    for (const incoming of remoteSide.ops) {
      const mine = localLatest.get(incoming.key);
      if (!mine) {
        toApplyLocally.push(incoming);
        continue;
      }
      const { winner } = settle(mine, incoming);
      conflicts.push({
        key: incoming.key,
        winner,
        discarded: winner === "local" ? incoming.value : mine.value,
        keptFrom: winner === "local" ? mine.deviceId : incoming.deviceId,
      });
      if (winner === "remote") toApplyLocally.push(incoming);
    }

    // Only ops the remote did not win are worth sending back.
    const lostKeys = new Set(conflicts.filter((c) => c.winner === "remote").map((c) => c.key));
    const toPush = localSide.ops.filter((op) => !lostKeys.has(op.key));

    const applied =
      toApplyLocally.length > 0 ? await ports.local.push(sessionId, toApplyLocally) : null;
    const pushed = toPush.length > 0 ? await ports.remote.push(sessionId, toPush) : null;

    const highest = [...remoteSide.ops, ...localSide.ops].reduce(
      (max, op) => Math.max(max, op.logicalTime),
      state.cursor,
    );

    entry = {
      ...base,
      pulled: applied?.opsApplied ?? 0,
      pushed: pushed?.opsApplied ?? 0,
      conflicts,
      cursor: highest,
    };
  } catch (err) {
    entry = { ...base, error: err instanceof Error ? err.message : String(err) };
  }

  ports.writeState({
    cursor: entry.cursor,
    ledger: [entry, ...state.ledger].slice(0, LEDGER_LIMIT),
  });
  return entry;
}
