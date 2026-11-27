// SPDX-License-Identifier: Apache-2.0
/**
 * Saga compensation, exhaustively.
 *
 * The existing saga suite proves the reverse order for one shape of chain. This one forces *every*
 * compensable step to fail in turn and checks the documented rollback each time: the steps after the
 * failure never ran, every completed step before it was undone exactly once in reverse order, and the
 * failing step was not undone. It also pins the two promises the implementation makes around that
 * rollback — a compensation that throws does not stop the others or mask the original error, and a
 * suspension is not a failure so it compensates nothing.
 */
import { describe, it, expect } from "vite-plus/test";

import { createWorkflowChain, type WorkflowEvent } from "../src/workflow/index.ts";

const STEPS = ["reserve", "charge", "ship", "notify"] as const;

interface Trace {
  execute: string[];
  compensate: string[];
}

function chainFor(trace: Trace, opts: { failAt?: string; throwInCompensation?: string } = {}) {
  let chain = createWorkflowChain<number, number>({ id: "booking" });
  for (const id of STEPS) {
    chain = chain.andThen({
      id,
      execute: async () => {
        trace.execute.push(id);
        if (opts.failAt === id) throw new Error(`${id} failed`);
        return STEPS.indexOf(id) + 1;
      },
      compensate: async (_ctx, out) => {
        trace.compensate.push(`${id}:${out}`);
        if (opts.throwInCompensation === id) throw new Error(`${id} undo failed`);
      },
    });
  }
  return chain;
}

const compensated = (events: WorkflowEvent[]) =>
  events.filter((e) => e.type === "step:compensate").map((e) => e.stepId);

describe("saga compensation, every step in turn", () => {
  for (const failing of STEPS) {
    it(`rolls back exactly the completed steps when ${failing} fails`, async () => {
      const trace: Trace = { execute: [], compensate: [] };
      const result = await chainFor(trace, { failAt: failing }).run(0);
      if (result.status !== "error") throw new Error("expected error result");

      const index = STEPS.indexOf(failing);
      expect(result.error).toBe(`${failing} failed`);
      expect(result.stepId).toBe(failing);

      // Nothing after the failure ran.
      expect(trace.execute).toEqual(STEPS.slice(0, index + 1));
      // Every completed step was undone, newest first, with its own output; the failing step was not.
      expect(trace.compensate).toEqual(
        STEPS.slice(0, index)
          .reverse()
          .map((id, i) => `${id}:${index - i}`),
      );
      expect(compensated(result.events)).toEqual(
        STEPS.slice(0, index).reverse() as unknown as string[],
      );
    });
  }

  it("keeps rolling back after a compensation itself throws, and keeps the original error", async () => {
    const trace: Trace = { execute: [], compensate: [] };
    const result = await chainFor(trace, { failAt: "notify", throwInCompensation: "charge" }).run(
      0,
    );
    if (result.status !== "error") throw new Error("expected error result");

    // ship is undone, charge is attempted and fails, reserve is still undone.
    expect(trace.compensate).toEqual(["ship:3", "charge:2", "reserve:1"]);
    expect(result.error).toBe("notify failed");
    expect(compensated(result.events)).toEqual(["ship", "charge", "reserve"]);
    const failedUndo = result.events.find(
      (e) => e.type === "step:compensate" && e.stepId === "charge",
    )!;
    expect(failedUndo.data).toEqual({ error: "charge undo failed" });
  });

  it("does not compensate a step whose retries eventually succeeded", async () => {
    const trace: Trace = { execute: [], compensate: [] };
    let attempts = 0;
    const result = await createWorkflowChain<number, number>({ id: "retry-saga" })
      .andThen({
        id: "flaky",
        retries: 2,
        execute: async () => {
          attempts += 1;
          if (attempts < 2) throw new Error("not yet");
          return 1;
        },
        compensate: async () => {
          trace.compensate.push("flaky");
        },
      })
      .andThen({
        id: "boom",
        execute: async () => {
          throw new Error("boom");
        },
      })
      .run(0);

    if (result.status !== "error") throw new Error("expected error result");
    expect(attempts).toBe(2);
    // One compensation, not one per attempt.
    expect(trace.compensate).toEqual(["flaky"]);
  });

  it("compensates nothing when a step suspends instead of failing", async () => {
    const trace: Trace = { execute: [], compensate: [] };
    const chain = createWorkflowChain<number, number>({ id: "suspend-saga" })
      .andThen({
        id: "done-step",
        execute: async () => {
          trace.execute.push("done-step");
          return 1;
        },
        compensate: async () => {
          trace.compensate.push("done-step");
        },
      })
      .andThen({
        id: "wait",
        execute: async (ctx) => {
          await ctx.suspend("need approval");
          return 2;
        },
      });

    const result = await chain.run(0);
    expect(result.status).toBe("suspended");
    expect(trace.compensate).toEqual([]);
  });
});
