// SPDX-License-Identifier: Apache-2.0
/** One account's drive is invisible to another: no listing, no reading, no reaching it by path. */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SECRET = "drive-isolation-test-secret";
process.env.NEXUS_JWT_SECRET = SECRET;
process.env.NEXUS_DRIVE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-drive-iso-"));

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
const ALICE = crypto.randomUUID();
const BOB = crypto.randomUUID();
const as = (user: string, method: "GET" | "POST", url: string, payload?: object) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${tokenFor(user)}` }, payload });

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

describe("drive isolation", () => {
  it("keeps one account's files from another", async () => {
    const up = await as(ALICE, "POST", "/api/v1/drive/upload", {
      path: "notes/secret.txt",
      content: "alice only",
    });
    expect(up.statusCode, up.body).toBeLessThan(300);
    expect((await as(ALICE, "GET", "/api/v1/drive/read?path=notes/secret.txt")).body).toContain(
      "alice only",
    );

    expect((await as(BOB, "GET", "/api/v1/drive/ls?dir=notes")).body).not.toContain("secret.txt");
    expect((await as(BOB, "GET", "/api/v1/drive/read?path=notes/secret.txt")).body).not.toContain(
      "alice only",
    );
    const escape = await as(BOB, "GET", `/api/v1/drive/read?path=../${ALICE}/notes/secret.txt`);
    expect(escape.statusCode).not.toBe(200);
    expect(escape.body).not.toContain("alice only");
  });
});
