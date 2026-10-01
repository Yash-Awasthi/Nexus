// SPDX-License-Identifier: Apache-2.0
/** The document pipeline reads an image through OCR and chunks the recognised text. */
import crypto from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("tesseract.js", () => ({
  createWorker: async () => ({
    recognize: async () => ({ data: { text: "Invoice 42: amount due 100 USD" } }),
    terminate: async () => {},
  }),
}));

const DB = "pglite://:memory:doc-pipeline-ocr";
const SECRET = "doc-pipeline-ocr-secret";
process.env.DATABASE_URL = DB;
process.env.NEXUS_JWT_SECRET = SECRET;
process.env.NEXUS_SECRETS_KEY = "6f".repeat(32);
process.env.NEXUS_DESKTOP = "1";
delete process.env.REDIS_URL;

const { migrateEmbedded } = await import("../../src/lib/migrate-embedded.js");
const { getPgPool } = await import("../../src/lib/pg-pool.js");
const { buildServer } = await import("../../src/server.js");

function tokenFor(userId: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub: userId, role: "admin", iat: now, exp: now + 3600 });
  const sig = crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

let app: FastifyInstance;
const auth = { authorization: `Bearer ${tokenFor(crypto.randomUUID())}` };

beforeAll(async () => {
  await migrateEmbedded(getPgPool(DB)!);
  app = await buildServer();
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app.close();
});

it("ingests an image by OCR", async () => {
  const r = await app.inject({
    method: "POST",
    url: "/api/v1/doc-pipeline/ingest",
    headers: auth,
    payload: { format: "image", content: Buffer.from("png bytes").toString("base64") },
  });
  expect(r.statusCode, r.body).toBe(201);
  expect(r.json()).toMatchObject({
    format: "image",
    rawTextLength: "Invoice 42: amount due 100 USD".length,
    chunks: 1,
  });
});
