// SPDX-License-Identifier: Apache-2.0
/** A drive file can be fetched without a session through a signed link that expires. */
import crypto from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

const SECRET = "drive-link-secret";
process.env.NEXUS_JWT_SECRET = SECRET;
const ROOT = mkdtempSync(path.join(tmpdir(), "drive-link-"));
process.env.NEXUS_DRIVE_ROOT = ROOT;

const { buildServer } = await import("../../src/server.js");

function tokenFor(userId: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub: userId, role: "admin", iat: now, exp: now + 3600 });
  const sig = crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

const userId = crypto.randomUUID();
const headers = { authorization: `Bearer ${tokenFor(userId)}` };
const bytes = Buffer.from([0, 255, 1, 254, 10, 13, 0x89, 0x50]);

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildServer();
  await app.ready();
  const dir = path.join(ROOT, Buffer.from(userId, "utf8").toString("hex"), "out");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "chart.png"), bytes);
  writeFileSync(path.join(dir, "..", ".env"), "GROQ_API_KEY=secret");
});
afterAll(async () => {
  vi.useRealTimers();
  await app.close();
});

const link = (p: string, extra: Record<string, unknown> = {}) =>
  app.inject({
    method: "POST",
    url: "/api/v1/drive/link",
    headers,
    payload: { path: p, ...extra },
  });

it("serves the file's exact bytes to anyone holding the link", async () => {
  const r = await link("out/chart.png");
  expect(r.statusCode, r.body).toBe(200);
  const { url, expiresAt } = r.json() as { url: string; expiresAt: string };
  expect(url).toMatch(/^\/api\/v1\/drive\/file\?t=/);
  expect(Date.parse(expiresAt) - Date.now()).toBeGreaterThan(29 * 60_000);

  const res = await app.inject({ method: "GET", url });
  expect(res.statusCode).toBe(200);
  expect(Buffer.compare(res.rawPayload, bytes)).toBe(0);
  expect(res.headers["content-disposition"]).toBe('attachment; filename="chart.png"');
  expect(res.headers["content-type"]).toBe("application/octet-stream");
});

it("refuses a tampered link and one past its expiry", async () => {
  const { url } = (await link("out/chart.png", { ttlMinutes: 1 })).json() as { url: string };
  const bad = url.slice(0, -2) + (url.endsWith("AA") ? "BB" : "AA");
  expect((await app.inject({ method: "GET", url: bad })).statusCode).toBe(403);

  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 2 * 60_000);
  expect((await app.inject({ method: "GET", url })).statusCode).toBe(403);
  vi.useRealTimers();
});

it("never links the drive's key file or a missing file", async () => {
  expect((await link(".env")).statusCode).toBe(403);
  expect((await link("out/../.env")).statusCode).toBe(403);
  expect((await link("out/nothing.png")).statusCode).toBe(404);
  expect((await link("../elsewhere")).statusCode).toBe(403);
});

it("needs a session to make a link", async () => {
  const r = await app.inject({
    method: "POST",
    url: "/api/v1/drive/link",
    payload: { path: "out/chart.png" },
  });
  expect(r.statusCode).toBe(401);
});
