// SPDX-License-Identifier: Apache-2.0
/** Fine-tuning datasets (SFT conversations, corpus samples) belong to their submitter. */
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/middleware/auth.js", async (importOriginal) => {
  const who = async (req: { headers: Record<string, string>; nexusUserId?: string }) => {
    req.nexusUserId = req.headers["x-user"];
  };
  return {
    ...(await importOriginal<typeof import("../../src/middleware/auth.js")>()),
    requireAuth: who,
    requireAuthWithTier: who,
  };
});

const { sftRoutes } = await import("../../src/routes/sft.js");
const { corpusBuilderRoutes } = await import("../../src/routes/corpus-builder.js");

async function appWith(routes: (app: ReturnType<typeof Fastify>) => Promise<void>) {
  const app = Fastify();
  await app.register(routes);
  return (user: string, method: "GET" | "POST", url: string, payload?: object) =>
    app.inject({ method, url, headers: { "x-user": user }, ...(payload ? { payload } : {}) });
}

describe("SFT conversations", () => {
  it("are listed and exported only for their submitter", async () => {
    const as = await appWith(sftRoutes);
    const added = await as("alice", "POST", "/sft/conversations", {
      turns: [
        { role: "user", content: "alice private question about her payroll" },
        { role: "assistant", content: "alice private answer about her payroll" },
      ],
    });
    expect(added.statusCode, added.body).toBeLessThan(300);
    for (const url of ["/sft/conversations", "/sft/export", "/sft/stats"]) {
      expect((await as("bob", "GET", url)).body, url).not.toContain("payroll");
    }
    expect((await as("alice", "GET", "/sft/conversations")).body).toContain("payroll");
  });
});

describe("corpus samples", () => {
  it("are queried only by their submitter", async () => {
    const as = await appWith(corpusBuilderRoutes);
    const added = await as("alice", "POST", "/corpus/samples", {
      prompt: "alice private prompt about her payroll",
      completion: "alice private completion about her payroll",
    });
    expect(added.statusCode, added.body).toBeLessThan(300);
    const bob = await as("bob", "POST", "/corpus/query", {});
    expect(bob.body).not.toContain("payroll");
    expect((await as("bob", "GET", "/corpus/pending")).json()).toMatchObject({ pending: 0 });
  });
});
