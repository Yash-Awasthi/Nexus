// SPDX-License-Identifier: Apache-2.0
/** An analysed conversation is still there after the server restarts. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Fastify from "fastify";
import { afterAll, expect, it, vi } from "vitest";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-conv-restart-"));
const DB = `pglite://${path.join(dir, "pg").replaceAll("\\", "/")}`;
process.env.DATABASE_URL = DB;

vi.mock("../../src/middleware/auth.ts", () => ({
  requireAuth: async (req: { nexusUserId?: string }) => {
    req.nexusUserId = "user-1";
  },
}));

const { migrateEmbedded } = await import("../../src/lib/migrate-embedded.ts");
const { closePgPools, getPgPool } = await import("../../src/lib/pg-pool.ts");
await migrateEmbedded(getPgPool(DB)!);
await closePgPools();

afterAll(async () => {
  const pools = await import("../../src/lib/pg-pool.ts");
  await pools.closePgPools();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function boot() {
  const { conversationAnalysisRoutes } = await import("../../src/routes/conversation-analysis.ts");
  const app = Fastify();
  await app.register(conversationAnalysisRoutes);
  await app.ready();
  return app;
}

it("keeps an insight across a restart", async () => {
  const first = await boot();
  const made = await first.inject({
    method: "POST",
    url: "/conversation-analysis/analyze",
    payload: { id: "conv-1", messages: [{ role: "user", content: "How do I deploy to Render?" }] },
  });
  expect(made.statusCode, made.body).toBe(200);
  await first.close();
  await new Promise((r) => setTimeout(r, 50));
  await (await import("../../src/lib/pg-pool.ts")).closePgPools();

  vi.resetModules();
  const second = await boot();
  const got = await second.inject({ method: "GET", url: "/conversation-analysis/conv-1" });
  expect(got.statusCode, got.body).toBe(200);
  await second.close();
});
