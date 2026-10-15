// SPDX-License-Identifier: Apache-2.0
/** Pending corpus samples outlast a restart. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Fastify from "fastify";
import { afterAll, expect, it, vi } from "vitest";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-conv-restart-"));
const DB = `pglite://${path.join(dir, "pg").replaceAll("\\", "/")}`;
process.env.DATABASE_URL = DB;

vi.mock("../../src/middleware/auth.ts", () => ({
  requireAuthWithTier: async (req: { nexusUserId?: string }) => {
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
  const { corpusBuilderRoutes } = await import("../../src/routes/corpus-builder.ts");
  const app = Fastify();
  await app.register(corpusBuilderRoutes);
  await app.ready();
  return app;
}

it("keeps pending samples across a restart", async () => {
  const first = await boot();
  for (const n of [1, 2]) {
    const r = await first.inject({
      method: "POST",
      url: "/corpus/samples",
      payload: { prompt: `question ${n}`, completion: `answer ${n}` },
    });
    expect(r.statusCode, r.body).toBe(201);
  }
  await first.close();
  await new Promise((r) => setTimeout(r, 50));
  await (await import("../../src/lib/pg-pool.ts")).closePgPools();

  vi.resetModules();
  const second = await boot();
  const pending = await second.inject({ method: "GET", url: "/corpus/pending" });
  expect(pending.json<{ pending: number }>().pending).toBe(2);
  await second.close();
});
