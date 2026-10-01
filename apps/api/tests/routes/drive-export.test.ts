// SPDX-License-Identifier: Apache-2.0
/** A drive exports as a gzipped tar of its files, with every .env left out. */
import crypto from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";

const SECRET = "drive-export-secret";
process.env.NEXUS_JWT_SECRET = SECRET;
process.env.NEXUS_DRIVE_ROOT = mkdtempSync(path.join(tmpdir(), "drive-export-"));

const { buildServer } = await import("../../src/server.js");

function tokenFor(userId: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub: userId, role: "admin", iat: now, exp: now + 3600 });
  const sig = crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

/** Name → content of every regular file in a tar archive. */
function untar(tar: Buffer): Map<string, string> {
  const files = new Map<string, string>();
  for (let at = 0; at + 512 <= tar.length;) {
    const h = tar.subarray(at, at + 512);
    if (h.every((b) => b === 0)) break;
    const field = (from: number, len: number) =>
      h
        .subarray(from, from + len)
        .toString("utf8")
        .replace(/\0.*$/s, "");
    const prefix = field(345, 155);
    const name = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
    const size = parseInt(field(124, 12).trim() || "0", 8);
    if (field(156, 1) === "0") files.set(name, tar.subarray(at + 512, at + 512 + size).toString());
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

it("packs the caller's files and never their keys", async () => {
  const headers = { authorization: `Bearer ${tokenFor(crypto.randomUUID())}` };
  const longDir = `${"deep/".repeat(30)}end`;
  for (const [p, content] of [
    ["notes.txt", "hello drive"],
    [`${longDir}/far.txt`, "far away"],
    [".env", "GROQ_API_KEY=gsk_secret"],
    ["app/.env", "TOKEN=secret"],
  ]) {
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/drive/upload",
      headers,
      payload: { path: p, content },
    });
    expect(r.statusCode, r.body).toBe(201);
  }

  const res = await app.inject({ method: "GET", url: "/api/v1/drive/export", headers });
  expect(res.statusCode).toBe(200);
  expect(res.headers["content-type"]).toBe("application/gzip");
  const files = untar(gunzipSync(res.rawPayload));
  expect(files.get("notes.txt")).toBe("hello drive");
  expect(files.get(`${longDir}/far.txt`)).toBe("far away");
  expect([...files.keys()].filter((n) => n.endsWith(".env"))).toEqual([]);
  expect(res.rawPayload.toString("latin1")).not.toContain("secret");
});

it("has nothing to export before the drive exists", async () => {
  const headers = { authorization: `Bearer ${tokenFor(crypto.randomUUID())}` };
  const res = await app.inject({ method: "GET", url: "/api/v1/drive/export", headers });
  expect(res.statusCode).toBe(404);
});
