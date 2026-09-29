// SPDX-License-Identifier: Apache-2.0
/** With the drive bucket configured, /v1/files keeps its bytes there, where every API process sees them. */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";

const SECRET = "openai-files-s3-secret";
const objects = new Map<string, Buffer>();
const bucket = http.createServer((req, res) => {
  const key = decodeURIComponent(new URL(req.url!, "http://x").pathname);
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    if (!String(req.headers.authorization).startsWith("AWS4-HMAC-SHA256")) {
      res.statusCode = 403;
      return res.end();
    }
    if (req.method === "PUT") objects.set(key, Buffer.concat(chunks));
    else if (req.method === "DELETE") objects.delete(key);
    else if (!objects.has(key)) res.statusCode = 404;
    else return res.end(objects.get(key));
    res.end();
  });
});

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-files-s3-"));
process.env.DATABASE_URL = "pglite://:memory:openai-files-s3";
process.env.NEXUS_JWT_SECRET = SECRET;
process.env.NEXUS_SECRETS_KEY = "cd".repeat(32);
process.env.NEXUS_DESKTOP = "1";
process.env.NEXUS_DATA_DIR = DATA;

function auth() {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub: "files-user", role: "admin", iat: now, exp: now + 3600 });
  const sig = crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return { authorization: `Bearer ${head}.${body}.${sig}` };
}

let app: FastifyInstance;
beforeAll(async () => {
  await new Promise<void>((r) => bucket.listen(0, "127.0.0.1", r));
  const port = (bucket.address() as { port: number }).port;
  Object.assign(process.env, {
    DRIVE_BACKUP_S3_ENDPOINT: `http://127.0.0.1:${port}`,
    DRIVE_BACKUP_S3_BUCKET: "nexus",
    DRIVE_BACKUP_S3_ACCESS_KEY_ID: "key",
    DRIVE_BACKUP_S3_SECRET_ACCESS_KEY: "secret",
    DRIVE_BACKUP_S3_REGION: "us-east-1",
  });
  const { migrateEmbedded } = await import("../../src/lib/migrate-embedded.js");
  const { getPgPool } = await import("../../src/lib/pg-pool.js");
  const { buildServer } = await import("../../src/server.js");
  await migrateEmbedded(getPgPool(process.env.DATABASE_URL)!);
  app = await buildServer();
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app.close();
  bucket.close();
  for (const k of Object.keys(process.env))
    if (k.startsWith("DRIVE_BACKUP_S3_")) delete process.env[k];
});

it("stores, serves and deletes file bytes in the bucket, not on this host", async () => {
  const b = `----nexus${crypto.randomUUID()}`;
  const content = '{"custom_id":"a"}\n';
  const up = await app.inject({
    method: "POST",
    url: "/v1/files",
    headers: { ...auth(), "content-type": `multipart/form-data; boundary=${b}` },
    payload:
      `--${b}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\nbatch\r\n` +
      `--${b}\r\nContent-Disposition: form-data; name="file"; filename="in.jsonl"\r\n\r\n` +
      `${content}\r\n--${b}--\r\n`,
  });
  expect(up.statusCode, up.body).toBe(200);
  const { id } = up.json<{ id: string }>();
  expect(objects.get(`/nexus/openai-files/${id}`)?.toString()).toBe(content);
  expect(fs.existsSync(path.join(DATA, "openai-files", id))).toBe(false);

  const got = await app.inject({ method: "GET", url: `/v1/files/${id}/content`, headers: auth() });
  expect(got.body).toBe(content);

  await app.inject({ method: "DELETE", url: `/v1/files/${id}`, headers: auth() });
  expect(objects.has(`/nexus/openai-files/${id}`)).toBe(false);
});
