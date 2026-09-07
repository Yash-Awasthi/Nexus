// SPDX-License-Identifier: Apache-2.0
// Raft leader election (hashicorp/raft parity slice) — deterministic tests
// driven by an injected clock and a deferred in-memory transport.
import { describe, it, expect } from "vitest";
import { RaftNode, type RaftMessage } from "./raft-election.js";

interface Cluster {
  clock: { t: number };
  nodes: Map<string, RaftNode>;
  sent: Array<{ to: string; msg: RaftMessage }>;
  advance(ms: number): void;
}

/**
 * Build a cluster with a shared virtual clock. Messages are queued during
 * a tick round and delivered afterwards, so simultaneous timeouts produce
 * real split votes (the way network latency would in production).
 */
function makeCluster(
  ids: string[],
  opts: { electionMs?: number; heartbeatMs?: number; rngs?: Record<string, () => number> } = {},
): Cluster {
  const clock = { t: 0 };
  const nodes = new Map<string, RaftNode>();
  const sent: Array<{ to: string; msg: RaftMessage }> = [];
  const pending: Array<{ to: string; msg: RaftMessage }> = [];
  const rngs = opts.rngs ?? {};
  for (const id of ids) {
    const node = new RaftNode({
      id,
      peers: ids,
      electionTimeoutMs: opts.electionMs ?? 100,
      heartbeatMs: opts.heartbeatMs ?? 20,
      now: () => clock.t,
      random: rngs[id] ?? (() => 0.5),
      send: (to, msg) => {
        sent.push({ to, msg });
        pending.push({ to, msg });
      },
    });
    nodes.set(id, node);
  }
  for (const n of nodes.values()) n.start();
  const advance = (ms: number) => {
    clock.t += ms;
    for (const n of nodes.values()) n.tick();
    while (pending.length) {
      const { to, msg } = pending.shift()!;
      nodes.get(to)?.receive(msg);
    }
  };
  return { clock, nodes, sent, advance };
}

describe("RaftNode leader election", () => {
  it("self-elects in a single-node cluster", () => {
    const c = makeCluster(["a"]);
    c.advance(150); // deadline = 100 + floor(0.5 * 101) = 150
    const s = c.nodes.get("a")!.getState();
    expect(s.role).toBe("leader");
    expect(s.term).toBe(1);
    expect(s.leaderId).toBe("a");
  });

  it("elects exactly one leader and keeps it stable via heartbeats", () => {
    const c = makeCluster(["a", "b", "c"], {
      rngs: { a: () => 0, b: () => 0.5, c: () => 0.9 },
    });
    c.advance(100); // a times out first (deadline 100); b at 150, c at 190
    const a = c.nodes.get("a")!.getState();
    expect(a.role).toBe("leader");
    expect(a.term).toBe(1);
    for (const id of ["b", "c"]) {
      const s = c.nodes.get(id)!.getState();
      expect(s.role).toBe("follower");
      expect(s.leaderId).toBe("a");
      expect(s.term).toBe(1);
    }
    for (let i = 0; i < 25; i++) c.advance(20); // heartbeats renew follower deadlines
    for (const id of ["a", "b", "c"]) {
      const s = c.nodes.get(id)!.getState();
      expect(s.leaderId).toBe("a");
      expect(s.role === "leader" ? id === "a" : true).toBe(true);
    }
  });

  it("never elects a leader without a majority (split vote)", () => {
    const c = makeCluster(["a", "b", "c"], { rngs: { a: () => 0, b: () => 0, c: () => 0 } });
    c.advance(100); // all three time out in the same round
    for (const id of ["a", "b", "c"]) {
      const s = c.nodes.get(id)!.getState();
      expect(s.role).toBe("candidate");
      expect(s.term).toBe(1);
      expect(s.votes).toBe(1); // every request denied — each node voted for itself
      expect(s.leaderId).toBeNull();
    }
  });

  it("converges after a split vote once jitter staggers the timeouts", () => {
    let bCalls = 0;
    const c = makeCluster(["a", "b", "c"], {
      rngs: {
        a: () => 0,
        b: () => (bCalls++ === 0 ? 0 : 0.9),
        c: () => 0,
      },
    });
    c.advance(100); // term-1 split: everyone votes for themselves
    expect(c.nodes.get("a")!.getState().role).toBe("candidate");
    c.advance(100); // a and c retry at term 2; b's longer deadline makes it grant a
    const a = c.nodes.get("a")!.getState();
    expect(a.role).toBe("leader");
    expect(a.term).toBe(2);
    for (const id of ["b", "c"]) {
      expect(c.nodes.get(id)!.getState().leaderId).toBe("a");
    }
  });

  it("steps down when it hears from a higher term", () => {
    const c = makeCluster(["a", "b", "c"], { rngs: { a: () => 0, b: () => 0.5, c: () => 0.9 } });
    c.advance(100); // a is leader at term 1
    c.nodes.get("a")!.receive({ type: "heartbeat", term: 2, leaderId: "x" });
    const s = c.nodes.get("a")!.getState();
    expect(s.role).toBe("follower");
    expect(s.term).toBe(2);
    expect(s.leaderId).toBe("x");
    expect(s.votedFor).toBeNull();
  });

  it("re-elects after the leader disappears", () => {
    let bCalls = 0;
    const c = makeCluster(["a", "b"], {
      rngs: { a: () => 0, b: () => (bCalls++ === 0 ? 0 : 0.9) },
    });
    c.advance(100); // split at term 1 (2-node majority is 2)
    c.advance(100); // b's longer deadline keeps it out of term 2; a wins its vote
    expect(c.nodes.get("a")!.getState().role).toBe("leader");
    // Leader a is lost: it steps down on a term-3 heartbeat and then goes
    // silent (simulated crash), so b must win a re-election on its own.
    const a = c.nodes.get("a")!;
    a.receive({ type: "heartbeat", term: 3, leaderId: "x" });
    a.tick = () => {}; // crashed: no heartbeats, no elections
    for (let i = 0; i < 25; i++) c.advance(20); // b times out, retries at term 3, wins a's vote
    const b = c.nodes.get("b")!.getState();
    expect(b.role).toBe("leader");
    expect(b.term).toBe(3);
    expect(c.nodes.get("a")!.getState().leaderId).toBe("b");
  });

  it("grants one vote per term and denies stale or duplicate requests", () => {
    const c = makeCluster(["a", "b"]);
    const a = c.nodes.get("a")!;
    a.receive({ type: "requestVote", term: 2, candidateId: "b" });
    expect(a.getState().votedFor).toBe("b");
    a.receive({ type: "requestVote", term: 2, candidateId: "c" }); // same term, other candidate
    expect(a.getState().votedFor).toBe("b");
    const stale = c.sent.filter((s) => s.to === "c").pop()!;
    expect(stale.msg).toEqual({ type: "denyVote", term: 2, from: "a" });
    a.receive({ type: "requestVote", term: 1, candidateId: "d" }); // stale term
    const denied = c.sent.filter((s) => s.to === "d").pop()!;
    expect(denied.msg).toEqual({ type: "denyVote", term: 2, from: "a" });
  });

  it("counts votes toward the 5-node majority of 3", () => {
    const c = makeCluster(["a", "b", "c", "d", "e"], { rngs: { a: () => 0 } });
    c.advance(100); // only a times out; all four peers grant
    const a = c.nodes.get("a")!.getState();
    expect(a.role).toBe("leader");
    expect(a.votes).toBeGreaterThanOrEqual(3); // majority reached; later grants correctly ignored
  });
});