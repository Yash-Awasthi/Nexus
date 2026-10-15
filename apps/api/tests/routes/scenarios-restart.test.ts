// SPDX-License-Identifier: Apache-2.0
/** A scenario, and the removal of one, outlast a restart. */
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
  const { scenarioPlannerRoutes } = await import("../../src/routes/scenario-planner.ts");
  const app = Fastify();
  await app.register(scenarioPlannerRoutes);
  await app.ready();
  return app;
}

it("keeps scenarios, and forgets a deleted one, across a restart", async () => {
  const make = (name: string) => ({
    method: "POST" as const,
    url: "/scenarios",
    payload: { name, outcomes: [{ name: "win", probability: 0.6, impact: 1 }] },
  });
  const first = await boot();
  const kept = await first.inject(make("Kept plan"));
  expect(kept.statusCode, kept.body).toBeLessThan(300);
  const dropped = await first.inject(make("Dropped plan"));
  const droppedId = dropped.json<{ id?: string; scenario?: { id: string } }>();
  const id = droppedId.id ?? droppedId.scenario!.id;
  expect((await first.inject({ method: "DELETE", url: `/scenarios/${id}` })).statusCode).toBe(200);
  await first.close();
  await new Promise((r) => setTimeout(r, 50));
  await (await import("../../src/lib/pg-pool.ts")).closePgPools();

  vi.resetModules();
  const second = await boot();
  const names = second
    .inject({ method: "GET", url: "/scenarios" })
    .then((r) => r.json<{ scenarios: { name: string }[] }>().scenarios.map((s) => s.name));
  expect(await names).toEqual(["Kept plan"]);
  await second.close();
});
