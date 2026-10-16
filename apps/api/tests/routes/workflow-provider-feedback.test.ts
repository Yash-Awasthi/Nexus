// SPDX-License-Identifier: Apache-2.0
import Fastify from "fastify";
import { DriverRegistry, type LlmDriver } from "@nexus/llm-drivers";
import { expect, it, vi } from "vitest";
import { workflowsRoutes } from "../../src/routes/workflows.ts";

it("does not send an explicitly selected missing provider's model to the default provider", async () => {
  const complete = vi.fn(async () => ({ content: "wrong provider answered" }));
  const app = Fastify();
  await workflowsRoutes(app, {
    getDefaultDriver: () =>
      ({ model: "local-model", provider: "ollama", complete }) as unknown as LlmDriver,
    buildChatRegistry: async () => ({ registry: new DriverRegistry(), sources: new Map() }),
  });
  try {
    const created = await app.inject({
      method: "POST",
      url: "/workflows",
      payload: {
        name: "missing-provider",
        steps: [{ id: "step-1", kind: "agent", provider: "missing-cloud", model: "cloud-only" }],
      },
    });
    const result = await app.inject({
      method: "POST",
      url: `/workflows/${created.json().id}/run`,
      payload: {},
    });
    expect(result.json().status).toBe("error");
    expect(result.body).toContain("missing-cloud");
    expect(result.body).toContain("Provider keys");
    expect(complete).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

it("hands an agent step the workflow data along with its task", async () => {
  const complete = vi.fn(async (_opts: { messages: { content: string }[] }) => ({ content: "ok" }));
  const app = Fastify();
  await workflowsRoutes(app, {
    getDefaultDriver: () => ({ model: "m", provider: "p", complete }) as unknown as LlmDriver,
    buildChatRegistry: async () => ({ registry: new DriverRegistry(), sources: new Map() }),
  });
  try {
    const created = await app.inject({
      method: "POST",
      url: "/workflows",
      payload: { name: "summarise", steps: [{ id: "s1", kind: "agent", task: "Summarise it." }] },
    });
    await app.inject({
      method: "POST",
      url: `/workflows/${created.json().id}/run`,
      payload: { input: { query: "quarterly churn rose to 4%" } },
    });
    const prompt = complete.mock.calls[0]?.[0].messages[0]?.content ?? "";
    expect(prompt).toContain("Summarise it.");
    expect(prompt).toContain("quarterly churn rose to 4%");
  } finally {
    await app.close();
  }
});
