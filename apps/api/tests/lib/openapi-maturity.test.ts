// SPDX-License-Identifier: Apache-2.0
/**
 * The durability split is a contract: every generated operation must carry
 * exactly one of the three maturity tags, so a new route cannot land untagged.
 */
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vite-plus/test";

process.env.DATABASE_URL ??= "pglite://:memory:openapi-maturity";
process.env.NEXUS_JWT_SECRET ??= "openapi-maturity-secret";

const { migrateEmbedded } = await import("../../src/lib/migrate-embedded.ts");
const { closePgPools, getPgPool } = await import("../../src/lib/pg-pool.ts");
const { buildServer } = await import("../../src/server.ts");

const MATURITY = new Set(["durable", "bridge", "dedicated-volatile"]);
const METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

let app: FastifyInstance;
beforeAll(async () => {
  await migrateEmbedded(getPgPool(process.env.DATABASE_URL)!);
  app = await buildServer();
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await closePgPools();
});

it("tags every operation with exactly one durability class", () => {
  const swagger = (app as unknown as { swagger: () => Record<string, unknown> }).swagger();
  const paths = swagger.paths as Record<string, Record<string, { tags?: string[] }>>;
  const untagged: string[] = [];
  let operations = 0;
  for (const [path, item] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (!METHODS.has(method.toLowerCase())) continue;
      operations += 1;
      const tags = (operation.tags ?? []).filter((tag) => MATURITY.has(tag));
      if (tags.length !== 1) untagged.push(`${method.toUpperCase()} ${path} (${tags.length})`);
    }
  }
  expect(operations).toBeGreaterThan(300);
  expect(untagged).toEqual([]);
});
