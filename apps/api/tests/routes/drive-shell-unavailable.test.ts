// SPDX-License-Identifier: Apache-2.0
/** On a host without Docker the drive says its shell is off, and a command gets a plain 503. */
import crypto from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

const SECRET = "drive-shell-secret";
process.env.NEXUS_JWT_SECRET = SECRET;
process.env.NEXUS_DRIVE_ROOT = mkdtempSync(path.join(tmpdir(), "drive-shell-"));
delete process.env.ALLOW_UNSANDBOXED_EXEC;

vi.mock("@nexus/code-repl", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@nexus/code-repl")>()),
  isDockerAvailable: async () => false,
}));

const { buildServer } = await import("../../src/server.ts");
let app: FastifyInstance;

function auth(userId: string) {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub: userId, role: "admin", iat: now, exp: now + 3600 });
  const sig = crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return { authorization: `Bearer ${head}.${body}.${sig}` };
}

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

it("reports no shell and refuses commands plainly when Docker is missing", async () => {
  const headers = auth(crypto.randomUUID());
  const status = await app.inject({ method: "GET", url: "/api/v1/drive/status", headers });
  expect(status.json()).toMatchObject({ dockerAvailable: false, shellAvailable: false });

  const run = await app.inject({
    method: "POST",
    url: "/api/v1/drive/exec",
    headers,
    payload: { command: "echo hi" },
  });
  expect(run.statusCode).toBe(503);
  expect(run.json()).toMatchObject({ error: "sandbox_unavailable" });
});
