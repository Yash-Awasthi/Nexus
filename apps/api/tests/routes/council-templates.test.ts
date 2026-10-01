// SPDX-License-Identifier: Apache-2.0
/** Council templates set the members' roles and the chair's brief; the investment one rates. */
import crypto from "node:crypto";

import { DriverRegistry } from "@nexus/llm-drivers";
import type { LlmDriver, LlmRequestOptions, StreamHandler } from "@nexus/llm-drivers";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const SECRET = "council-templates-secret";
process.env.NEXUS_JWT_SECRET = SECRET;

const seen: Record<string, LlmRequestOptions[]> = {};
const replies: Record<string, string> = {
  "m-a": "Strong margins. RATING: Buy",
  "m-b": "Leverage worries me. RATING: Underweight",
  "m-c": "Momentum is positive. RATING: Overweight",
};
vi.mock("../../src/lib/provider-keys.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/provider-keys.js")>()),
  buildUserDriverRegistry: async (_u: string | undefined, providers: Iterable<string>) => {
    const registry = new DriverRegistry();
    const reply = async (o: LlmRequestOptions, h: StreamHandler) => {
      (seen[o.model] ??= []).push(o);
      const text = replies[o.model] ?? "chair synthesis";
      await h({ delta: text, done: true });
      return { content: text, model: o.model, usage: {}, finishReason: "stop" };
    };
    for (const p of new Set(providers))
      registry.register(
        {
          provider: p,
          model: "x",
          stream: reply,
          complete: (o: LlmRequestOptions) => reply(o, () => {}),
        } as unknown as LlmDriver,
        p,
      );
    return { registry, missing: [] as string[] };
  },
}));

const { buildServer } = await import("../../src/server.js");

const headers = (() => {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub: crypto.randomUUID(), role: "agent", iat: now, exp: now + 3600 });
  const sig = crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return { authorization: `Bearer ${head}.${body}.${sig}` };
})();

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

describe("GET /api/v1/council/templates", () => {
  it("lists the templates with their member roles", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/council/templates", headers });
    const { templates } = res.json<{ templates: { id: string; rating?: boolean }[] }>();
    expect(templates.map((t) => t.id)).toEqual(
      expect.arrayContaining(["debate", "research", "technical", "creative", "investment"]),
    );
    expect(templates.find((t) => t.id === "investment")?.rating).toBe(true);
  });
});

describe("POST /api/chat/stream with a template", () => {
  it("gives members the template's roles and adds the ratings to the verdict", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/chat/stream",
      headers,
      payload: {
        message: `Should we buy ACME shares? ${crypto.randomUUID()}`,
        members: ["m-a", "m-b", "m-c"].map((model, i) => ({
          label: "ABC"[i],
          provider: "openai",
          model,
        })),
        round: 0,
        rounds: 1,
        threadId: "tpl",
        templateId: "investment",
      },
    });
    const system = (model: string) =>
      String(seen[model]?.[0]?.messages.find((m) => m.role === "system")?.content ?? "");
    expect(system("m-a")).toContain("fundamental analyst");
    expect(system("m-b")).toContain("risk manager");
    const chair = seen["m-a"]!.at(-1)!.messages[0]!.content as string;
    expect(chair).toContain("portfolio manager");
    const verdict = res.payload
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => JSON.parse(l.slice(6)) as { type: string; text?: string })
      .filter((e) => e.type === "verdict")
      .map((e) => e.text)
      .join("");
    expect(verdict).toContain(
      "Ratings: A Buy, B Underweight, C Overweight · average +0.67 (Overweight)",
    );
  });
});
