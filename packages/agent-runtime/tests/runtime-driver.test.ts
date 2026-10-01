// SPDX-License-Identifier: Apache-2.0
/** The documented SDK form: an AgentRuntime built on a driver, run on a task. */
import { expect, it } from "vitest";

import { AgentRuntime } from "../src/index.js";

it("runs a task on a driver", async () => {
  const seen: { system?: string; user: string }[] = [];
  const driver = {
    provider: "fake",
    model: "fake-model",
    async complete(opts: { messages: { role: string; content: string }[]; systemPrompt?: string }) {
      seen.push({ system: opts.systemPrompt, user: opts.messages.at(-1)!.content });
      return { content: "The PDF says hello." };
    },
  };
  const agent = new AgentRuntime({ driver });
  const result = await agent.run({ task: "Summarise the attached PDF." });
  expect(result.finalContent).toBe("The PDF says hello.");
  expect(seen[0]!.user).toContain("Summarise the attached PDF.");
  expect(seen[0]!.system).toBeTruthy();
});
