// SPDX-License-Identifier: Apache-2.0
/** NX-FEAT-011: audit entries leave the database for a write-once bucket, each exactly once. */
import crypto from "node:crypto";

import { MemoryKVStore } from "@nexus/kv";
import { afterAll, beforeAll, expect, it } from "vitest";

const DB = "pglite://:memory:audit-export";
process.env.DATABASE_URL = DB;

const { migrateEmbedded } = await import("../../src/lib/migrate-embedded.ts");
const { closePgPools, getPgPool } = await import("../../src/lib/pg-pool.ts");
const { exportAuditLog } = await import("../../src/lib/audit-export.ts");
const { db } = await import("@nexus/db");
const { auditLog } = await import("@nexus/db/schema");

beforeAll(async () => {
  await migrateEmbedded(getPgPool(DB)!);
});

afterAll(async () => {
  await closePgPools();
});

async function append(from: number, to: number): Promise<void> {
  for (let sequence = from; sequence <= to; sequence++)
    await db.insert(auditLog).values({
      sequence,
      entityType: "user",
      entityId: crypto.randomUUID(),
      action: "test.event",
      actor: "tester",
      payload: { sequence },
      payloadHash: "p",
      chainHash: `c${sequence}`,
    });
}

function fakeBucket() {
  const objects = new Map<string, { body: string; headers: Record<string, string> }>();
  return {
    objects,
    bucket: {
      list: async () => [],
      get: async () => null,
      remove: async () => {
        throw new Error("an export never deletes");
      },
      put: async (key: string, body: unknown, headers: Record<string, string> = {}) => {
        objects.set(key, { body: String(body), headers });
      },
    },
  };
}

it("writes new entries once, in order, with object lock and an MD5", async () => {
  const kv = new MemoryKVStore();
  const { bucket, objects } = fakeBucket();
  const opts = { prefix: "audit/", retainDays: 30, batch: 2, kv };

  await append(1, 3);
  expect(await exportAuditLog(bucket, opts)).toBe(3);
  expect([...objects.keys()]).toEqual([
    "audit/000000000001-000000000002.jsonl",
    "audit/000000000003-000000000003.jsonl",
  ]);
  const first = objects.get("audit/000000000001-000000000002.jsonl")!;
  const lines = first.body
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { sequence: number });
  expect(lines.map((l) => l.sequence)).toEqual([1, 2]);
  expect(first.headers["x-amz-object-lock-mode"]).toBe("COMPLIANCE");
  expect(Date.parse(first.headers["x-amz-object-lock-retain-until-date"]!)).toBeGreaterThan(
    Date.now() + 29 * 86_400_000,
  );
  expect(first.headers["Content-MD5"]).toBe(
    crypto.createHash("md5").update(first.body).digest("base64"),
  );

  expect(await exportAuditLog(bucket, opts)).toBe(0);
  await append(4, 4);
  expect(await exportAuditLog(bucket, opts)).toBe(1);
  expect(objects.has("audit/000000000004-000000000004.jsonl")).toBe(true);
});

it("leaves lock headers to the bucket when no retention is set", async () => {
  const { bucket, objects } = fakeBucket();
  await exportAuditLog(bucket, { prefix: "a/", kv: new MemoryKVStore() });
  const [obj] = [...objects.values()];
  expect(obj!.headers["x-amz-object-lock-mode"]).toBeUndefined();
});
