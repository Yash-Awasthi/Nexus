// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";

import { llmDriverToToolFn, type LlmToolDriver } from "../src/index.js";

function driverFailing(errors: unknown[], streamFirst = false) {
  let calls = 0;
  const driver: LlmToolDriver = {
    model: "m",
    stream: async (_opts, onDelta) => {
      calls += 1;
      const err = errors.shift();
      if (err) {
        if (streamFirst) onDelta({ delta: "partial", done: false });
        throw err;
      }
      return { content: "ok", toolCalls: [], usage: undefined } as never;
    },
  };
  return { driver, calls: () => calls };
}

const outage = Object.assign(new Error("The deployment is currently unavailable"), {
  code: "SERVER_ERROR",
  statusCode: 503,
});

describe("llmDriverToToolFn transient retry", () => {
  it("retries a provider outage and returns the next answer", async () => {
    const { driver, calls } = driverFailing([outage]);
    const turn = await llmDriverToToolFn(driver, undefined, [0])([], {});
    expect(turn.content).toBe("ok");
    expect(calls()).toBe(2);
  });

  it("gives up after the last delay", async () => {
    const { driver, calls } = driverFailing([outage, outage, outage]);
    await expect(llmDriverToToolFn(driver, undefined, [0, 0])([], {})).rejects.toBe(outage);
    expect(calls()).toBe(3);
  });

  it("never retries an auth failure or a call that already streamed text", async () => {
    const auth = Object.assign(new Error("bad key"), { code: "AUTH_FAILED", statusCode: 401 });
    const a = driverFailing([auth]);
    await expect(llmDriverToToolFn(a.driver, undefined, [0])([], {})).rejects.toBe(auth);
    expect(a.calls()).toBe(1);

    const b = driverFailing([outage], true);
    await expect(
      llmDriverToToolFn(b.driver, undefined, [0])([], { onText: () => {} }),
    ).rejects.toBe(outage);
    expect(b.calls()).toBe(1);
  });
});
