// SPDX-License-Identifier: Apache-2.0
/** Drive routes answer bad input as client errors and count an overwrite once against the quota. */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";

const SECRET = "drive-routes-test-secret";
process.env.NEXUS_JWT_SECRET = SECRET;
process.env.NEXUS_DRIVE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-drive-routes-"));

const { buildServer } = await import("../../src/server.js");
const { DRIVE_QUOTA_BYTES, userDrivePath } = await import("@nexus/sandbox");

function tokenFor(userId: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub: userId, role: "admin", iat: now, exp: now + 3600 });
  const sig = crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

let app: FastifyInstance;
const USER = crypto.randomUUID();
const as = (method: "GET" | "POST", url: string, payload?: object) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${tokenFor(USER)}` }, payload });

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});
afterAll(async () => {
  await app.close();
  // The quota test leaves a file the size of a drive behind.
  fs.rmSync(process.env.NEXUS_DRIVE_ROOT!, { recursive: true, force: true });
});

it("refuses a listing outside the drive with 403", async () => {
  const r = await as("GET", "/api/v1/drive/ls?dir=../..");
  expect(r.statusCode, r.body).toBe(403);
});

it("refuses a working directory outside the drive with 403", async () => {
  const r = await as("POST", "/api/v1/drive/exec", { command: "pwd", cwd: "../.." });
  expect(r.statusCode, r.body).toBe(403);
});

it("answers non-text upload content with 400", async () => {
  const r = await as("POST", "/api/v1/drive/upload", { path: "a.txt", content: { not: "text" } });
  expect(r.statusCode, r.body).toBe(400);
});

it("lets a full drive overwrite a file with one of the same size", async () => {
  const first = await as("POST", "/api/v1/drive/upload", {
    path: "notes.txt",
    content: "x".repeat(1000),
  });
  expect(first.statusCode, first.body).toBe(201);
  // A sparse file fills the quota to within 500 bytes without using the disk.
  const big = path.join(userDrivePath(USER), "big.bin");
  fs.writeFileSync(big, "");
  fs.truncateSync(big, DRIVE_QUOTA_BYTES - 1000 - 500);

  const again = await as("POST", "/api/v1/drive/upload", {
    path: "notes.txt",
    content: "y".repeat(1000),
  });
  expect(again.statusCode, again.body).toBe(201);
  expect(again.json<{ quotaRemaining: number }>().quotaRemaining).toBe(500);
});
