// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/session-sync — Raft leader election (hashicorp/raft parity slice).
 *
 * session-sync already resolves *conflicts* (vector clocks, LWW/union
 * merges); it has no way to pick a *leader* — the coordination step that
 * precedes replication. This module implements the Raft paper's leader
 * election (§5.2): randomized election timeouts, term-based votes,
 * majority rule, heartbeat renewal, and step-down on higher terms.
 *
 * Scope
 * ─────
 * Election only — log replication, commit indices, and membership
 * changes remain out of scope, so a full hashicorp/raft port is not
 * claimed. Nodes are pure logic: the clock (`now`), transport (`send`),
 * and jitter (`random`) are injected, so clusters are deterministic in
 * tests and can be wired to any real transport in production.
 *
 * Usage
 * ─────
 * ```ts
 * const node = new RaftNode({
 *   id: "a", peers: ["a", "b", "c"],
 *   now, send: (to, msg) => transport.deliver(to, msg),
 * });
 * setInterval(() => node.tick(), 10);   // drives timeouts + heartbeats
 * node.start();
 * ```
 */

export type RaftRole = "follower" | "candidate" | "leader";

export type RaftMessage =
  | { type: "requestVote"; term: number; candidateId: string }
  | { type: "grantVote"; term: number; from: string }
  | { type: "denyVote"; term: number; from: string }
  | { type: "heartbeat"; term: number; leaderId: string };

export interface RaftNodeState {
  id: string;
  role: RaftRole;
  term: number;
  votedFor: string | null;
  votes: number;
  leaderId: string | null;
}

export interface RaftNodeConfig {
  id: string;
  /** All node ids in the cluster, including this node. */
  peers: string[];
  /** Base election timeout in ms; actual deadline adds up to this much jitter. */
  electionTimeoutMs: number;
  /** Leader heartbeat interval in ms. */
  heartbeatMs: number;
  now: () => number;
  send: (to: string, msg: RaftMessage) => void;
  random?: () => number;
  onRoleChange?: (state: RaftNodeState) => void;
}

export class RaftNode {
  readonly id: string;
  private readonly peers: string[];
  private readonly electionTimeoutMs: number;
  private readonly heartbeatMs: number;
  private readonly now: () => number;
  private readonly send: (to: string, msg: RaftMessage) => void;
  private readonly random: () => number;
  private readonly onRoleChange: (state: RaftNodeState) => void;

  private role: RaftRole = "follower";
  private term = 0;
  private votedFor: string | null = null;
  private votes = 0;
  private leaderId: string | null = null;
  private electionDeadline = 0;
  private lastHeartbeat = 0;
  private started = false;

  constructor(config: RaftNodeConfig) {
    this.id = config.id;
    this.peers = [...config.peers];
    this.electionTimeoutMs = config.electionTimeoutMs;
    this.heartbeatMs = config.heartbeatMs;
    this.now = config.now;
    this.send = config.send;
    this.random = config.random ?? Math.random;
    this.onRoleChange = config.onRoleChange ?? (() => {});
  }

  getState(): RaftNodeState {
    return {
      id: this.id,
      role: this.role,
      term: this.term,
      votedFor: this.votedFor,
      votes: this.votes,
      leaderId: this.leaderId,
    };
  }

  /** Begin participation: reset timers and start counting timeouts. */
  start(): void {
    this.started = true;
    this.resetElectionDeadline();
  }

  /** Drive the node: fire election timeouts and leader heartbeats. */
  tick(): void {
    if (!this.started) return;
    if (this.role !== "leader" && this.now() >= this.electionDeadline) {
      this.startElection();
    }
    if (this.role === "leader" && this.now() - this.lastHeartbeat >= this.heartbeatMs) {
      this.broadcastHeartbeat();
    }
  }

  receive(msg: RaftMessage): void {
    if (!this.started) return;
    if (msg.term > this.term) {
      this.stepDown(msg.term);
    }
    switch (msg.type) {
      case "requestVote":
        this.handleVoteRequest(msg);
        break;
      case "grantVote":
        this.handleGrant(msg);
        break;
      case "heartbeat":
        this.handleHeartbeat(msg);
        break;
      case "denyVote":
        break;
    }
  }

  private handleVoteRequest(msg: { term: number; candidateId: string }): void {
    if (msg.term < this.term) {
      this.send(msg.candidateId, { type: "denyVote", term: this.term, from: this.id });
      return;
    }
    if (this.role === "leader") {
      this.send(msg.candidateId, { type: "denyVote", term: this.term, from: this.id });
      return;
    }
    if (this.votedFor === null || this.votedFor === msg.candidateId) {
      this.votedFor = msg.candidateId;
      this.resetElectionDeadline();
      this.send(msg.candidateId, { type: "grantVote", term: this.term, from: this.id });
    } else {
      this.send(msg.candidateId, { type: "denyVote", term: this.term, from: this.id });
    }
  }

  private handleGrant(msg: { term: number; from: string }): void {
    if (msg.term < this.term || this.role !== "candidate") return;
    this.votes++;
    if (this.votes >= this.majority()) {
      this.becomeLeader();
    }
  }

  private becomeLeader(): void {
    this.role = "leader";
    this.leaderId = this.id;
    this.lastHeartbeat = this.now();
    this.emitRoleChange();
    this.broadcastHeartbeat();
  }

  private handleHeartbeat(msg: { term: number; leaderId: string }): void {
    if (msg.term < this.term) return;
    if (this.role !== "follower") {
      this.role = "follower";
      this.votes = 0;
      this.emitRoleChange();
    }
    this.leaderId = msg.leaderId;
    this.lastHeartbeat = this.now();
    this.resetElectionDeadline();
  }

  private startElection(): void {
    this.term++;
    this.role = "candidate";
    this.votedFor = this.id;
    this.votes = 1;
    this.leaderId = null;
    this.emitRoleChange();
    if (this.votes >= this.majority()) {
      // Single-node (or already-granted) cluster: self-vote is the majority.
      this.becomeLeader();
      return;
    }
    this.resetElectionDeadline();
    for (const peer of this.peers) {
      if (peer !== this.id) {
        this.send(peer, { type: "requestVote", term: this.term, candidateId: this.id });
      }
    }
  }

  private broadcastHeartbeat(): void {
    this.lastHeartbeat = this.now();
    for (const peer of this.peers) {
      if (peer !== this.id) {
        this.send(peer, { type: "heartbeat", term: this.term, leaderId: this.id });
      }
    }
  }

  private stepDown(term: number): void {
    this.term = term;
    this.role = "follower";
    this.votedFor = null;
    this.votes = 0;
    this.leaderId = null;
    this.resetElectionDeadline();
    this.emitRoleChange();
  }

  private resetElectionDeadline(): void {
    const jitter = Math.floor(this.random() * (this.electionTimeoutMs + 1));
    this.electionDeadline = this.now() + this.electionTimeoutMs + jitter;
  }

  private majority(): number {
    return Math.floor(this.peers.length / 2) + 1;
  }

  private emitRoleChange(): void {
    this.onRoleChange(this.getState());
  }
}