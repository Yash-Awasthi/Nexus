// SPDX-License-Identifier: Apache-2.0
/** A submitted conversation keeps its id across a restart. */
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
  const { sftRoutes } = await import("../../src/routes/sft.ts");
  const app = Fastify();
  await app.register(sftRoutes);
  await app.ready();
  return app;
}

it("keeps a conversation, under the same id, across a restart", async () => {
  const first = await boot();
  const made = await first.inject({
    method: "POST",
    url: "/sft/conversations",
    payload: {
      turns: [
        { role: "user", content: "Explain closures in JavaScript." },
        {
          role: "assistant",
          content: "A closure keeps the variables of the scope it was made in.",
        },
      ],
    },
  });
  expect(made.statusCode, made.body).toBeLessThan(300);
  const body = made.json<{ id?: string; sample?: { id: string } }>();
  const id = body.id ?? body.sample!.id;
  await first.close();
  await new Promise((r) => setTimeout(r, 50));
  await (await import("../../src/lib/pg-pool.ts")).closePgPools();

  vi.resetModules();
  const second = await boot();
  const got = await second.inject({ method: "GET", url: `/sft/conversations/${id}` });
  expect(got.statusCode, got.body).toBe(200);
  await second.close();
});
