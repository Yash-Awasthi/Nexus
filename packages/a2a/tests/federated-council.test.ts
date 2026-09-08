// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import {
  A2AClient,
  federatedCouncil,
  aggregateCouncilDecision,
  outcomeAnswer,
  type A2ATask,
  type DelegationOutcome,
} from "../src/index.js";

const RPC = "https://agent.example.com/a2a";

function clientReturning(result: unknown): A2AClient {
  return new A2AClient({
    rpcUrl: RPC,
    fetchFn: vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ jsonrpc: "2.0", id: "1", result }), { status: 200 }),
    ) as unknown as typeof fetch,
  });
}

const DONE: A2ATask = {
  kind: "task",
  id: "t1",
  status: { state: "completed" },
  artifacts: [{ artifactId: "a", parts: [{ kind: "text", text: "sunny, 24C" }] }],
};

describe("federatedCouncil (§15.2)", () => {
  it("extracts answers from task artifacts", async () => {
    const decision = await federatedCouncil([
      { label: "peer-a", client: clientReturning(DONE), message: A2AClient.textMessage("weather?") },
    ], { maxAttempts: 1 });
    expect(decision.reachedQuorum).toBe(true);
    expect(decision.votes).toHaveLength(1);
    expect(decision.votes[0]).toEqual({ peer: "peer-a", ok: true, answer: "sunny, 24C" });
    expect(decision.errors).toHaveLength(0);
  });

  it("isolates dead peers into errors without breaking the round", async () => {
    const dead = new A2AClient({
      rpcUrl: RPC,
      fetchFn: vi.fn().mockRejectedValue(new Error("down")) as unknown as typeof fetch,
    });
    const decision = await federatedCouncil([
      { label: "alive", client: clientReturning(DONE), message: A2AClient.textMessage("q") },
      { label: "dead", client: dead, message: A2AClient.textMessage("q") },
    ], { maxAttempts: 1 });
    expect(decision.votes.map((v) => v.peer)).toEqual(["alive"]);
    expect(decision.errors).toEqual([{ peer: "dead", error: "down" }]);
    expect(decision.quorum).toEqual({ answered: 1, asked: 2 });
  });

  it("no quorum when every peer fails", async () => {
    const dead = new A2AClient({
      rpcUrl: RPC,
      fetchFn: vi.fn().mockRejectedValue(new Error("down")) as unknown as typeof fetch,
    });
    const decision = await federatedCouncil([
      { label: "dead", client: dead, message: A2AClient.textMessage("q") },
    ], { maxAttempts: 1 });
    expect(decision.reachedQuorum).toBe(false);
    expect(decision.votes).toHaveLength(0);
  });

  it("aggregateCouncilDecision is pure over raw outcomes", () => {
    const outcomes: DelegationOutcome[] = [
      { label: "a", ok: true, task: DONE },
      { label: "b", ok: false, error: new Error("boom") },
      { label: "c", ok: true }, // ok but no content → counted as an error
    ];
    const d = aggregateCouncilDecision(outcomes);
    expect(d.votes.map((v) => v.peer)).toEqual(["a"]);
    expect(d.errors.map((e) => e.peer).sort()).toEqual(["b", "c"]);
    expect(d.errors.find((e) => e.peer === "b")!.error).toBe("boom");
    expect(d.errors.find((e) => e.peer === "c")!.error).toBe("no answer content");
  });

  it("outcomeAnswer prefers artifacts then status message", () => {
    const withStatus: A2ATask = {
      kind: "task", id: "t", status: { state: "completed", message: { kind: "message", role: "agent", parts: [{ kind: "text", text: "from status" }], messageId: "m" } },
    };
    expect(outcomeAnswer({ ok: true, task: withStatus })).toBe("from status");
    expect(outcomeAnswer({ ok: false, error: new Error("x") })).toBeUndefined();
  });
});
