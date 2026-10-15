// SPDX-License-Identifier: Apache-2.0
/**
 * A browser that never chose a council asks for the UI's built-in trio (ChatGPT, Gemini, Claude).
 * When the server holds none of those keys, NEXUS_DEFAULT_COUNCIL answers instead of an error.
 */
import { DriverRegistry } from "@nexus/llm-drivers";
import type { LlmDriver, LlmRequestOptions, LlmResponse, StreamHandler } from "@nexus/llm-drivers";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

process.env.NEXUS_DEFAULT_COUNCIL = "groq:open-model-a, groq:open-model-b";
const asked: string[] = [];

async function answer(opts: LlmRequestOptions, handler: StreamHandler): Promise<LlmResponse> {
  asked.push(opts.model);
  const text = `FINAL: four (${opts.model})`;
  await handler({ delta: text, done: true });
  return {
    id: "x",
    content: text,
    model: opts.model,
    usage: {},
    finishReason: "stop",
  } as LlmResponse;
}

// Only Groq has a key on this server.
vi.mock("../../src/lib/provider-keys.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/provider-keys.ts")>()),
  buildUserDriverRegistry: async (_userId: string | undefined, providers: Iterable<string>) => {
    const registry = new DriverRegistry();
    for (const p of new Set(providers))
      if (p === "groq")
        registry.register(
          {
            provider: p,
            model: "x",
            complete: (o: LlmRequestOptions) => answer(o, () => {}),
            stream: answer,
          } as unknown as LlmDriver,
          p,
        );
    return { registry, missing: [] as string[] };
  },
}));

const { buildServer } = await import("../../src/server.ts");
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

it("answers with the server's default council when none of the requested members has a key", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/chat/stream",
    payload: {
      message: "What is two plus two?",
      members: [
        { label: "ChatGPT", provider: "openai", model: "gpt-5.6-sol" },
        { label: "Gemini", provider: "gemini", model: "gemini-3.6-flash" },
        { label: "Claude", provider: "anthropic", model: "claude-sonnet-4-6" },
      ],
      round: 0,
      rounds: 1,
      threadId: "t-default",
    },
  });
  const events = res.payload
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)) as { type: string; message?: string; label?: string });

  expect(events.find((e) => e.type === "error")?.message).toBeUndefined();
  expect(events.some((e) => e.type === "notice" && /default council/i.test(e.message ?? ""))).toBe(
    true,
  );
  expect([...new Set(asked)].sort()).toEqual(["open-model-a", "open-model-b"]);
});
