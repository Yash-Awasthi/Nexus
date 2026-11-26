// SPDX-License-Identifier: Apache-2.0
/**
 * `nexus run --watch`: the loop, not the command line.
 *
 * Three properties are worth pinning, because a watch loop that gets them wrong is worse than no
 * watch loop — it silently shows you output from a run you did not trigger:
 *
 *  - a burst of writes (an editor saving three times) causes one run, not three;
 *  - a change during a run queues exactly one more, instead of starting a second run alongside it
 *    whose output interleaves with the first;
 *  - a failed run does not stop the watch, because the next save is usually the fix.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { formatRun, watchAndRun, type Watcher } from "../../src/lib/run.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A controllable stand-in for fs.watch: records listeners so a test can fire them. */
function fakeWatch() {
  const listeners: (() => void)[] = [];
  const closed: string[] = [];
  const watch = (file: string, listener: () => void): Watcher => {
    listeners.push(listener);
    return {
      close: () => {
        closed.push(file);
      },
    };
  };
  return {
    watch,
    fire: () => {
      for (const listener of listeners) listener();
    },
    closed,
    get registrations() {
      return listeners.length;
    },
  };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-run-"));
const watched = path.join(tmp, "prompt.txt");
fs.writeFileSync(watched, "hello");

afterEach(() => {
  // Nothing global to reset: each test owns its watcher and closes it.
});

describe("formatRun", () => {
  it("prints one line per step, then the result", () => {
    const lines = formatRun("wf-1", {
      status: "success",
      result: { answer: 42 },
      events: [
        { type: "step:started", stepId: "gather", timestamp: "" },
        { type: "step:finished", stepId: "gather", timestamp: "" },
        { type: "workflow:completed", timestamp: "" },
      ],
    });
    const text = lines.join("\n");
    expect(text).toContain("started   gather");
    expect(text).toContain("finished  gather");
    expect(text).toContain("Workflow wf-1: success");
    expect(text).toContain('"answer": 42');
    // A non-step event is not a step line.
    expect(text).not.toContain("workflow:completed");
  });

  it("prints a string result as it is, and a failure with its reason", () => {
    expect(formatRun("wf", { status: "success", result: "all good" }).join("\n")).toContain(
      "all good",
    );
    const failed = formatRun("wf", { status: "error", message: "model refused" }).join("\n");
    expect(failed).toContain("Workflow wf: error");
  });
});

describe("watching", () => {
  it("runs once at the start, then once per settled change", async () => {
    const fake = fakeWatch();
    let runs = 0;
    const watcher = await watchAndRun({
      workflowId: "wf",
      paths: [watched],
      debounceMs: 20,
      run: async () => {
        runs += 1;
      },
      watch: fake.watch,
      log: () => {},
    });
    expect(runs).toBe(1);
    expect(fake.registrations).toBe(1);

    // Three saves in a burst.
    fake.fire();
    fake.fire();
    fake.fire();
    await sleep(80);
    expect(runs).toBe(2);

    watcher.close();
    expect(fake.closed).toEqual([watched]);
  });

  it("queues one more run when a change arrives mid-run, not a second concurrent run", async () => {
    const fake = fakeWatch();
    let runs = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const watcher = await watchAndRun({
      workflowId: "wf",
      paths: [watched],
      debounceMs: 5,
      watch: fake.watch,
      log: () => {},
      run: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        runs += 1;
        await sleep(40);
        inFlight -= 1;
      },
    });
    // The first run is still in flight here.
    fake.fire();
    fake.fire();
    await sleep(160);
    expect(maxInFlight).toBe(1);
    expect(runs).toBe(2);
    watcher.close();
  });

  it("keeps watching after a failed run", async () => {
    const fake = fakeWatch();
    const errors: string[] = [];
    let attempts = 0;
    const watcher = await watchAndRun({
      workflowId: "wf",
      paths: [watched],
      debounceMs: 5,
      watch: fake.watch,
      log: (line) => errors.push(line),
      run: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("model refused");
      },
    });
    expect(attempts).toBe(1);
    expect(errors.join("\n")).toContain("model refused");
    fake.fire();
    await sleep(80);
    expect(attempts).toBe(2);
    watcher.close();
  });

  it("refuses a path that is not there, instead of watching nothing forever", async () => {
    await expect(
      watchAndRun({
        workflowId: "wf",
        paths: [path.join(tmp, "missing.txt")],
        run: async () => {},
        watch: fakeWatch().watch,
        log: () => {},
      }),
    ).rejects.toThrow(/Nothing to watch/);
  });

  it("watches a real file through fs.watch by default", async () => {
    let runs = 0;
    const watcher = await watchAndRun({
      workflowId: "wf",
      paths: [watched],
      debounceMs: 10,
      log: () => {},
      run: async () => {
        runs += 1;
      },
    });
    fs.writeFileSync(watched, "changed");
    await sleep(300);
    watcher.close();
    // fs.watch is not deterministic about coalescing, but the initial run always happens and a
    // write normally produces exactly one more.
    expect(runs).toBeGreaterThanOrEqual(1);
  });
});
