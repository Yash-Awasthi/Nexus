// SPDX-License-Identifier: Apache-2.0
// Saga compensation (Temporal parity) — focused tests.
import { describe, it, expect, beforeEach } from "vitest";
import { createWorkflowChain, type WorkflowEvent } from "./index.js";

const log: string[] = [];

beforeEach(() => {
  log.length = 0;
});

describe("saga compensation", () => {
  it("runs compensations in reverse completion order when a later step fails", async () => {
    const chain = createWorkflowChain<number, number>({ id: "saga" })
      .andThen({
        id: "a",
        execute: async () => {
          log.push("a");
          return 1;
        },
        compensate: async (_ctx, out) => {
          log.push(`undo-a:${out}`);
        },
      })
      .andThen({
        id: "b",
        execute: async () => {
          log.push("b");
          return 2;
        },
        compensate: async () => {
          log.push("undo-b");
        },
      })
      .andThen({
        id: "c",
        execute: async () => {
          throw new Error("c failed");
        },
      });

    const res = await chain.run(0);
    if (res.status !== "error") throw new Error("expected error result");
    expect(res.error).toBe("c failed");
    expect(res.stepId).toBe("c");
    // c never completed, so only b then a are undone, each with its output.
    expect(log).toEqual(["a", "b", "undo-b", "undo-a:1"]);
    const comps = res.events.filter((e) => e.type === "step:compensate");
    expect(comps.map((e) => e.stepId)).toEqual(["b", "a"]);
  });

  it("runs no compensations on success", async () => {
    const chain = createWorkflowChain<number, number>({ id: "saga" })
      .andThen({
        id: "a",
        execute: async () => 1,
        compensate: async () => {
          log.push("undo-a");
        },
      })
      .andThen({ id: "b", execute: async () => 2 });
    const res = await chain.run(0);
    expect(res.status).toBe("completed");
    expect(log).toEqual([]);
  });

  it("never lets a failing compensation mask the original error", async () => {
    const chain = createWorkflowChain<number, number>({ id: "saga" })
      .andThen({
        id: "a",
        execute: async () => 1,
        compensate: async () => {
          throw new Error("undo failed");
        },
      })
      .andThen({
        id: "b",
        execute: async () => {
          throw new Error("b failed");
        },
      });
    const res = await chain.run(0);
    if (res.status !== "error") throw new Error("expected error result");
    expect(res.error).toBe("b failed");
    const comps = res.events.filter((e) => e.type === "step:compensate") as WorkflowEvent[];
    expect(comps[0]).toMatchObject({ stepId: "a", data: { error: "undo failed" } });
  });

  it("compensates after retries are exhausted", async () => {
    const chain = createWorkflowChain<number, number>({ id: "saga" })
      .andThen({
        id: "a",
        execute: async () => {
          log.push("a");
          return 1;
        },
        compensate: async () => {
          log.push("undo-a");
        },
      })
      .andThen({
        id: "b",
        execute: async () => {
          throw new Error("boom");
        },
        retries: 1,
      });
    const res = await chain.run(0);
    if (res.status !== "error") throw new Error("expected error result");
    expect(res.error).toBe("boom");
    expect(log).toEqual(["a", "undo-a"]);
    expect(res.events.some((e) => e.type === "step:retry")).toBe(true);
  });

  it("compensates when the workflow is aborted mid-flight", async () => {
    const controller = new AbortController();
    const chain = createWorkflowChain<number, number>({ id: "saga" })
      .andThen({
        id: "a",
        execute: async () => {
          log.push("a");
          return 1;
        },
        compensate: async () => {
          log.push("undo-a");
        },
      })
      .andThen({
        id: "b",
        execute: async () => {
          controller.abort();
          return 2;
        },
      })
      .andThen({ id: "c", execute: async () => 3 });
    const res = await chain.run(0, { signal: controller.signal });
    if (res.status !== "error") throw new Error("expected error result");
    expect(res.error).toBe("Workflow aborted");
    expect(log).toEqual(["a", "undo-a"]);
  });

  it("does not compensate on suspension", async () => {
    const chain = createWorkflowChain<number, number>({ id: "saga" })
      .andThen({
        id: "a",
        execute: async () => {
          log.push("a");
          return 1;
        },
        compensate: async () => {
          log.push("undo-a");
        },
      })
      .andThen({
        id: "b",
        execute: async (ctx) => {
          await ctx.suspend("waiting for approval");
          return 2;
        },
      });
    const res = await chain.run(0);
    expect(res.status).toBe("suspended");
    expect(log).toEqual(["a"]);
  });
});