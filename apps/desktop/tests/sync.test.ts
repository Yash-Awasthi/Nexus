// SPDX-License-Identifier: Apache-2.0
/**
 * The sync loop (M3): what moves in each direction, how a key written on both
 * machines is settled, and what the ledger says afterwards.
 *
 * The conflict cases are the reason this file exists — a sync that quietly
 * picks a side is indistinguishable from one that loses data.
 */
import { describe, it, expect } from "vitest";

import {
  LEDGER_LIMIT,
  settle,
  syncOnce,
  type SyncLedgerEntry,
  type SyncOp,
  type SyncPorts,
  type SyncState,
  type SyncTransport,
} from "../src/sync";

function op(over: Partial<SyncOp> = {}): SyncOp {
  return {
    type: "set",
    key: "title",
    value: "v",
    deviceId: "laptop",
    logicalTime: 1,
    timestamp: "2026-09-22T00:00:00.000Z",
    ...over,
  };
}

/** A side that answers a fixed pull and records what it was pushed. */
function side(ops: SyncOp[]): SyncTransport & { pushed: SyncOp[][] } {
  const pushed: SyncOp[][] = [];
  return {
    pushed,
    pull: () => Promise.resolve({ ops }),
    push: (_id, sent) => {
      pushed.push(sent);
      return Promise.resolve({ opsApplied: sent.length });
    },
  };
}

function ports(
  localOps: SyncOp[],
  remoteOps: SyncOp[],
  state: SyncState = { cursor: 0, ledger: [] },
): SyncPorts & {
  written: SyncState[];
  local: ReturnType<typeof side>;
  remote: ReturnType<typeof side>;
} {
  const written: SyncState[] = [];
  const local = side(localOps);
  const remote = side(remoteOps);
  return {
    local,
    remote,
    written,
    deviceId: "laptop",
    now: () => "2026-09-22T12:00:00.000Z",
    readState: () => state,
    writeState: (s) => written.push(s),
  };
}

describe("settle", () => {
  it("gives the key to the later write", () => {
    expect(settle(op({ logicalTime: 5 }), op({ logicalTime: 3 })).winner).toBe("local");
    expect(settle(op({ logicalTime: 3 }), op({ logicalTime: 5 })).winner).toBe("remote");
  });

  it("breaks a tie by device id, so both machines agree without talking", () => {
    const a = op({ deviceId: "aaa", logicalTime: 4 });
    const b = op({ deviceId: "zzz", logicalTime: 4 });

    // Same pair, opposite roles: the surviving value must be the same one.
    expect(settle(a, b).winner).toBe("remote");
    expect(settle(b, a).winner).toBe("local");
  });
});

describe("syncOnce", () => {
  it("applies remote-only work locally and sends local-only work up", async () => {
    const p = ports([op({ key: "mine", logicalTime: 2 })], [op({ key: "theirs", logicalTime: 3 })]);

    const entry = await syncOnce("s1", p, "https://nexus.example");

    expect(entry.pulled).toBe(1);
    expect(entry.pushed).toBe(1);
    expect(entry.conflicts).toEqual([]);
    expect(p.local.pushed[0]?.[0]?.key).toBe("theirs");
    expect(p.remote.pushed[0]?.[0]?.key).toBe("mine");
  });

  it("names the losing value in the ledger rather than dropping it silently", async () => {
    const p = ports(
      [op({ key: "title", value: "local title", logicalTime: 2 })],
      [op({ key: "title", value: "remote title", logicalTime: 9, deviceId: "desk" })],
    );

    const entry = await syncOnce("s1", p, "https://nexus.example");

    expect(entry.conflicts).toEqual([
      { key: "title", winner: "remote", discarded: "local title", keptFrom: "desk" },
    ]);
  });

  it("does not push back a key the remote won", async () => {
    const p = ports(
      [op({ key: "title", value: "local", logicalTime: 2 })],
      [op({ key: "title", value: "remote", logicalTime: 9 })],
    );

    await syncOnce("s1", p, "https://nexus.example");

    expect(p.remote.pushed).toEqual([]);
    expect(p.local.pushed[0]?.[0]?.value).toBe("remote");
  });

  it("keeps a local win out of the local apply and sends it up", async () => {
    const p = ports(
      [op({ key: "title", value: "local", logicalTime: 9 })],
      [op({ key: "title", value: "remote", logicalTime: 2 })],
    );

    const entry = await syncOnce("s1", p, "https://nexus.example");

    expect(entry.conflicts[0]?.winner).toBe("local");
    expect(p.local.pushed).toEqual([]);
    expect(p.remote.pushed[0]?.[0]?.value).toBe("local");
  });

  it("advances the cursor to the newest op it saw", async () => {
    const p = ports([op({ key: "a", logicalTime: 4 })], [op({ key: "b", logicalTime: 11 })]);

    const entry = await syncOnce("s1", p, "https://nexus.example");

    expect(entry.cursor).toBe(11);
    expect(p.written[0]?.cursor).toBe(11);
  });

  it("records a failure and leaves the cursor where it was, so the next run retries", async () => {
    const p = ports([], []);
    p.remote.pull = () => Promise.reject(new Error("offline"));
    const withCursor = { ...p, readState: () => ({ cursor: 7, ledger: [] }) };

    const entry = await syncOnce("s1", withCursor, "https://nexus.example");

    expect(entry.error).toBe("offline");
    expect(entry.cursor).toBe(7);
    expect(entry.pulled).toBe(0);
    expect(entry.pushed).toBe(0);
  });

  it("keeps the ledger newest-first and bounded", async () => {
    const old: SyncLedgerEntry[] = Array.from({ length: LEDGER_LIMIT }, (_, i) => ({
      at: `old-${i}`,
      remote: "r",
      pulled: 0,
      pushed: 0,
      conflicts: [],
      cursor: 0,
    }));
    const p = ports([], [], { cursor: 0, ledger: old });

    await syncOnce("s1", p, "https://nexus.example");

    const ledger = p.written[0]!.ledger;
    expect(ledger).toHaveLength(LEDGER_LIMIT);
    expect(ledger[0]!.at).toBe("2026-09-22T12:00:00.000Z");
    expect(ledger[1]!.at).toBe("old-0");
  });
});
