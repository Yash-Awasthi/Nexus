// SPDX-License-Identifier: Apache-2.0
/**
 * A saved connection that lists several models falls back across them before
 * leaving the connection: one model's spent allowance is not the key's.
 */
import { LlmError, type LlmDriver, type LlmRequestOptions } from "@nexus/llm-drivers";
import { describe, expect, it } from "vitest";

import { resetFailover } from "../../src/lib/llm-failover.js";
import { userContext } from "../../src/lib/user-context.js";
import { getDefaultDriver } from "../../src/routes/api-bridge.js";

function connection(spent: string[]): LlmDriver & { asked: string[] } {
  const asked: string[] = [];
  return {
    provider: "openai-compatible",
    model: "first:free",
    asked,
    complete: async (opts: LlmRequestOptions) => {
      const model = opts.model ?? "first:free";
      asked.push(model);
      if (spent.includes(model))
        throw new LlmError(
          "RATE_LIMITED",
          "You've used this campaign's own allowance.",
          "openai-compatible",
          429,
        );
      return {
        id: "x",
        content: `answer from ${model}`,
        model,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        finishReason: "stop",
        durationMs: 0,
      };
    },
    stream: async () => {
      throw new Error("not used");
    },
    countTokens: (t) => t.length,
  };
}

describe("own connection failover", () => {
  it("tries the connection's other models before any other provider", async () => {
    resetFailover();
    const driver = connection(["first:free"]);
    const res = await userContext.run(
      {
        userId: "u-models",
        userDrivers: [{ id: "harbor", driver, models: ["first:free", "second:free"] }],
      },
      () => getDefaultDriver()!.complete({ messages: [{ role: "user", content: "hi" }] }),
    );
    expect(driver.asked).toEqual(["first:free", "second:free"]);
    expect(res.content).toBe("answer from second:free");
  });
});
