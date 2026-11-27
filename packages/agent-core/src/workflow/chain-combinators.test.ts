// SPDX-License-Identifier: Apache-2.0
/**
 * The fluent chain's step kinds, one test each.
 *
 * `saga.test.ts` covers compensation and nothing else, so the six builders — `andWhen`, `andAgent`,
 * `andLoop`, `andParallel`, `andFinally`, plus the event subscription — had no test at all. Two of them
 * were documented behaviour that did not happen: `andLoop`'s `reduce` was accepted and ignored, and
 * `andFinally` was advertised as "always executes, even on error" while running only on the happy path.
 * Both are pinned here, so the docstring and the code cannot drift apart again.
 */
import { describe, expect, it } from "vite-plus/test";

import { createWorkflowChain, type WorkflowEvent } from "./index.ts";

const agent = (answers: Record<string, string>) => ({
  calls: [] as string[],
  async generate(input: string) {
    this.calls.push(input);
    return answers[input] ?? `default:${input}`;
  },
});

describe("andThen", () => {
  it("threads data from step to step and exposes earlier outputs", async () => {
    const chain = createWorkflowChain<number, number>({ id: "then" })
      .andThen({ id: "double", execute: async ({ data }) => data * 2 })
      .andThen({
        id: "plus",
        execute: async ({ data, getStepOutput }) => data + (getStepOutput<number>("double") ?? 0),
      });

    const result = await chain.run(3);
    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    expect(result.result).toBe(12); // 3 → 6 → 6 + 6
  });
});

describe("andWhen", () => {
  it("takes the true branch and leaves the false branch alone", async () => {
    const chain = createWorkflowChain<number, string>({ id: "when" }).andWhen({
      id: "is-big",
      condition: async ({ data }) => data > 10,
      execute: async () => "big",
      otherwise: async () => "small",
    });
    const big = await chain.run(50);
    const small = await chain.run(5);
    expect(big.status === "completed" && big.result).toBe("big");
    expect(small.status === "completed" && small.result).toBe("small");
  });

  it("passes the data through unchanged when the condition is false and no otherwise is given", async () => {
    const chain = createWorkflowChain<number, number>({ id: "when-no-else" }).andWhen({
      id: "never",
      condition: () => false,
      execute: async () => 999,
    });
    const result = await chain.run(7);
    expect(result.status === "completed" && result.result).toBe(7);
  });
});

describe("andAgent", () => {
  it("takes a fixed task string and returns the agent's text", async () => {
    const fake = agent({ "say hi": "hello" });
    const chain = createWorkflowChain<string, string>({ id: "agent" }).andAgent({
      id: "greet",
      agent: fake,
      task: "say hi",
    });
    const result = await chain.run("ignored");
    expect(result.status === "completed" && result.result).toBe("hello");
    expect(fake.calls).toEqual(["say hi"]);
  });

  it("builds the prompt from the running data and maps the answer into the workflow's shape", async () => {
    const fake = agent({ "count 4": "four" });
    const chain = createWorkflowChain<number, number>({ id: "agent-map" }).andAgent({
      id: "spell",
      agent: fake,
      task: ({ data }) => `count ${data}`,
      map: (output) => (output === "four" ? 4 : 0),
    });
    const result = await chain.run(4);
    expect(result.status === "completed" && result.result).toBe(4);
  });
});

describe("andLoop", () => {
  it("iterates the items that items() returns, with an index", async () => {
    const seen: string[] = [];
    const chain = createWorkflowChain<number, unknown[]>({ id: "loop" }).andLoop({
      id: "each",
      items: ({ data }) => [data, data + 1, data + 2],
      execute: async (_ctx, item, index) => {
        seen.push(`${index}:${String(item)}`);
        return item;
      },
    });
    const result = await chain.run(10);
    expect(seen).toEqual(["0:10", "1:11", "2:12"]);
    expect(result.status === "completed" && result.result).toEqual([10, 11, 12]);
  });

  it("stops at maxIterations, which is a safety limit rather than a promise about the input", async () => {
    let ran = 0;
    const chain = createWorkflowChain<null, unknown[]>({ id: "loop-limit" }).andLoop({
      id: "each",
      items: () => Array.from({ length: 10 }, (_, i) => i),
      maxIterations: 3,
      execute: async () => {
        ran += 1;
        return ran;
      },
    });
    const result = await chain.run(null);
    expect(ran).toBe(3);
    expect(result.status === "completed" && result.result).toEqual([1, 2, 3]);
  });

  it("applies reduce, which was accepted and ignored until this test existed", async () => {
    const chain = createWorkflowChain<number, number>({ id: "loop-reduce" }).andLoop({
      id: "sum",
      items: () => [1, 2, 3, 4],
      execute: async (_ctx, item) => Number(item) * 2,
      reduce: (results) => (results as number[]).reduce((sum, value) => sum + value, 0),
    });
    const result = await chain.run(0);
    expect(result.status === "completed" && result.result).toBe(20);
  });
});

describe("andParallel", () => {
  it("runs every branch against the same input data and returns their results in order", async () => {
    const order: string[] = [];
    const chain = createWorkflowChain<number, unknown[]>({ id: "parallel" }).andParallel({
      id: "fan",
      steps: [
        {
          id: "slow",
          execute: async ({ data }) => {
            await new Promise((resolve) => setTimeout(resolve, 5));
            order.push("slow");
            return data + 1;
          },
        },
        {
          id: "fast",
          execute: async ({ data }) => {
            order.push("fast");
            return data + 2;
          },
        },
      ],
    });
    const result = await chain.run(1);
    // The faster branch finishes first, but positions are the caller's order, not completion order.
    expect(order).toEqual(["fast", "slow"]);
    expect(result.status === "completed" && result.result).toEqual([2, 3]);
  });

  it("fails the whole workflow when a branch fails and continueOnFailure is not set", async () => {
    const chain = createWorkflowChain<number, unknown[]>({ id: "parallel-fail" }).andParallel({
      id: "fan",
      steps: [
        { id: "ok", execute: async () => "ok" },
        {
          id: "boom",
          execute: async () => {
            throw new Error("branch exploded");
          },
        },
      ],
    });
    const result = await chain.run(1);
    expect(result.status).toBe("error");
    expect(result.status === "error" && result.error).toContain("branch exploded");
  });

  it("puts null in the failed branch's slot when continueOnFailure is set", async () => {
    const chain = createWorkflowChain<number, unknown[]>({ id: "parallel-continue" }).andParallel({
      id: "fan",
      continueOnFailure: true,
      steps: [
        { id: "ok", execute: async () => "ok" },
        {
          id: "boom",
          execute: async () => {
            throw new Error("ignored");
          },
        },
      ],
    });
    const result = await chain.run(1);
    expect(result.status === "completed" && result.result).toEqual(["ok", null]);
  });
});

describe("andFinally", () => {
  it("runs after the last step on the happy path and keeps its output", async () => {
    const chain = createWorkflowChain<number, string>({ id: "finally-ok" })
      .andThen({ id: "work", execute: async ({ data }) => data + 1 })
      .andFinally({ id: "done", execute: async ({ data }) => `finished at ${data}` });
    const result = await chain.run(1);
    expect(result.status === "completed" && result.result).toBe("finished at 2");
  });

  it("still runs when an earlier step fails, which is what 'finally' means", async () => {
    const ran: string[] = [];
    const chain = createWorkflowChain<number, number>({ id: "finally-error" })
      .andThen({
        id: "boom",
        execute: async () => {
          throw new Error("step failed");
        },
      })
      .andFinally({
        id: "cleanup",
        execute: async () => {
          ran.push("cleanup");
          return 0;
        },
      });
    const result = await chain.run(1);
    expect(result.status).toBe("error");
    // The workflow still reports the original error; the finally step must not mask it.
    expect(result.status === "error" && result.error).toContain("step failed");
    expect(ran).toEqual(["cleanup"]);
  });

  it("does not turn a failing finally step into a success", async () => {
    const chain = createWorkflowChain<number, number>({ id: "finally-throws" })
      .andThen({ id: "work", execute: async ({ data }) => data })
      .andFinally({
        id: "cleanup",
        execute: async () => {
          throw new Error("cleanup exploded");
        },
      });
    const result = await chain.run(1);
    expect(result.status).toBe("error");
    expect(result.status === "error" && result.error).toContain("cleanup exploded");
  });
});

describe("onEvent", () => {
  it("delivers each step's events to a subscriber and stops after unsubscribe", async () => {
    const chain = createWorkflowChain<number, number>({ id: "events" }).andThen({
      id: "one",
      execute: async ({ data }) => data * 2,
    });
    const seen: WorkflowEvent["type"][] = [];
    const stop = chain.onEvent((event) => seen.push(event.type));

    const first = await chain.run(2);
    expect(first.status === "completed" && first.events.map((event) => event.type)).toEqual([
      "step:start",
      "step:complete",
      "workflow:complete",
    ]);

    stop();
    seen.length = 0;
    await chain.run(3);
    expect(seen).toEqual([]);
  });

  it("reports a failing step with its id and message before the workflow error", async () => {
    const chain = createWorkflowChain<number, number>({ id: "events-err" }).andThen({
      id: "boom",
      execute: async () => {
        throw new Error("no");
      },
    });
    const result = await chain.run(1);
    const types = result.events.map((event) => event.type);
    expect(types).toEqual(["step:start", "step:error", "workflow:error"]);
    expect(result.events[1]!.stepId).toBe("boom");
    expect(result.status === "error" && result.stepId).toBe("boom");
  });
});

describe("retries and control flow", () => {
  it("retries a failing step up to its retry budget and then succeeds", async () => {
    let attempts = 0;
    const chain = createWorkflowChain<number, number>({ id: "retry" }).andThen({
      id: "flaky",
      retries: 2,
      execute: async ({ data, retryCount }) => {
        attempts += 1;
        if (attempts < 3) throw new Error(`attempt ${retryCount}`);
        return data + 1;
      },
    });
    const result = await chain.run(1);
    expect(attempts).toBe(3);
    expect(result.status === "completed" && result.result).toBe(2);
    expect(result.events.filter((event) => event.type === "step:retry")).toHaveLength(2);
  });

  it("gives up after the retry budget and reports the original error", async () => {
    const chain = createWorkflowChain<number, number>({ id: "retry-exhausted" }).andThen({
      id: "dead",
      retries: 1,
      execute: async () => {
        throw new Error("always fails");
      },
    });
    const result = await chain.run(1);
    expect(result.status).toBe("error");
    expect(result.status === "error" && result.error).toContain("always fails");
  });

  it("returns suspended, then resumes at the named step with the caller's data", async () => {
    const chain = createWorkflowChain<number, unknown[]>({ id: "suspend" })
      .andThen({ id: "before", execute: async ({ data }) => data + 1 })
      .andThen({
        id: "approval",
        execute: async ({ suspend, resumeData }) => {
          // First pass: no resume data, so the step suspends and the run reports it. Second pass: the
          // caller supplied an answer and `resumeData` carries it.
          if (resumeData === undefined) await suspend("needs a human", { asked: "who" });
          return resumeData;
        },
      });
    const suspended = await chain.run(1);
    expect(suspended.status).toBe("suspended");
    if (suspended.status !== "suspended") return;
    expect(suspended.stepId).toBe("approval");
    expect(suspended.reason).toBe("needs a human");
    expect(suspended.suspendData).toEqual({ asked: "who" });

    const resumed = await chain.run(1, { resumeStepId: "approval", resumeData: "approved" });
    expect(resumed.status === "completed" && resumed.result).toBe("approved");
  });

  it("stops before the next step when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const chain = createWorkflowChain<number, number>({ id: "abort" }).andThen({
      id: "never",
      execute: async ({ data }) => data + 1,
    });
    const result = await chain.run(1, { signal: controller.signal });
    expect(result.status).toBe("error");
    expect(result.status === "error" && result.error).toContain("aborted");
  });
});
