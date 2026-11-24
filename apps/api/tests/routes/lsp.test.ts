// SPDX-License-Identifier: Apache-2.0
/**
 * The /lsp surface: status never leaks the command line, restart belongs to an
 * admin, and a spawn the policy stops for runs exactly once after a human
 * approves it.
 */
import crypto from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

const SECRET = "lsp-routes-secret";
const DB = "pglite://:memory:lsp-routes";
const ROOT = mkdtempSync(join(tmpdir(), "nexus-lsp-routes-"));
const FAKE_SERVER = fileURLToPath(
  new URL("../../../../packages/lsp/src/testing/fake-server.mjs", import.meta.url),
);

process.env.NEXUS_JWT_SECRET = SECRET;
process.env.DATABASE_URL = DB;
process.env.NEXUS_LSP = "1";
process.env.NEXUS_LSP_ROOTS = ROOT;
process.env.NEXUS_LSP_TYPESCRIPT_CMD = `"${process.execPath}" "${FAKE_SERVER}" --stdio`;
delete process.env.NEXUS_EXEC_MODE;
delete process.env.NEXUS_EXEC_DENY;
delete process.env.NEXUS_EXEC_ASK_SURFACES;

const { migrateEmbedded } = await import("../../src/lib/migrate-embedded.ts");
const { closePgPools, getPgPool } = await import("../../src/lib/pg-pool.ts");
const { buildServer } = await import("../../src/server.ts");
const { _resetLspForTests } = await import("../../src/lib/lsp.ts");
const { db } = await import("@nexus/db");
const { users } = await import("@nexus/db/schema");

const MEMBER = crypto.randomUUID();
const ADMIN = crypto.randomUUID();

function tokenFor(userId: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub: userId, role: "admin", iat: now, exp: now + 3600 });
  const sig = crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

let app: FastifyInstance;

beforeAll(async () => {
  await migrateEmbedded(getPgPool(DB)!);
  await db.insert(users).values([
    { id: MEMBER, email: "lsp-member@example.com", passwordHash: "x", role: "member" },
    { id: ADMIN, email: "lsp-admin@example.com", passwordHash: "x", role: "admin" },
  ]);
  app = await buildServer();
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app.close();
  await _resetLspForTests();
  await closePgPools();
  rmSync(ROOT, { recursive: true, force: true });
  delete process.env.NEXUS_EXEC_ASK_SURFACES;
  delete process.env.NEXUS_EXEC_DENY;
});

const call = (method: "GET" | "POST", url: string, user: string, payload?: object) =>
  app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${tokenFor(user)}` },
    ...(payload === undefined ? {} : { payload }),
  });

describe("GET /api/v1/lsp/status", () => {
  it("reports the pool, the root and per-language availability", async () => {
    const res = await call("GET", "/api/v1/lsp/status", MEMBER);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<{
      enabled: boolean;
      root?: string;
      servers: { language: string; state: string; pid?: number; rssMb: number; requests: number }[];
      languages: { language: string; available: boolean; reason?: string }[];
    }>();

    expect(body.enabled).toBe(true);
    expect(body.root).toBe(realpathSync.native(ROOT));
    expect(body.servers).toEqual([]);
    expect(body.languages.map((l) => l.language)).toEqual(["typescript", "python", "go", "rust"]);
    expect(body.languages.every((l) => l.available)).toBe(true);
    expect(body.languages.every((l) => l.reason === undefined)).toBe(true);
  });

  it("never includes the command line", async () => {
    const res = await call("GET", "/api/v1/lsp/status", MEMBER);
    const text = res.body;
    expect(text).not.toContain("fake-server.mjs");
    expect(text).not.toContain(process.execPath);
    expect(text).not.toContain("NEXUS_LSP_TYPESCRIPT_CMD");
  });
});

describe("POST /api/v1/lsp/servers/:language/restart", () => {
  it("is allowed for an admin and refused to another user", async () => {
    const refused = await call("POST", "/api/v1/lsp/servers/typescript/restart", MEMBER);
    expect(refused.statusCode, refused.body).toBe(403);

    const allowed = await call("POST", "/api/v1/lsp/servers/typescript/restart", ADMIN);
    expect(allowed.statusCode, allowed.body).toBe(200);
    expect(allowed.json<{ restarted: boolean }>().restarted).toBe(true);
  });

  it("rejects a language no server handles", async () => {
    const res = await call("POST", "/api/v1/lsp/servers/cobol/restart", ADMIN);
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe("unknown_language");
  });
});

describe("a spawn the policy denies", () => {
  it("names the rule that denied it", async () => {
    process.env.NEXUS_EXEC_DENY = "node";
    try {
      const res = await call("POST", "/api/v1/lsp/servers/typescript/start", MEMBER);
      expect(res.statusCode, res.body).toBe(403);
      const body = res.json<{ error: string; rule?: string; message: string }>();
      expect(body.error).toBe("exec_denied");
      expect(body.rule).toBe("deny:0:node");
      expect(body.message).toContain("deny:0:node");
    } finally {
      delete process.env.NEXUS_EXEC_DENY;
    }
  });
});

describe("a spawn the policy stops for", () => {
  it("runs once after approval and cannot replay that approval", async () => {
    process.env.NEXUS_EXEC_ASK_SURFACES = "lsp";
    try {
      const asked = await call("POST", "/api/v1/lsp/servers/typescript/start", ADMIN);
      expect(asked.statusCode, asked.body).toBe(202);
      const { approvalId } = asked.json<{ error: string; approvalId: string }>();
      expect(asked.json<{ error: string }>().error).toBe("approval_required");
      expect(approvalId).toBeTruthy();

      const approvals = await call("GET", "/api/v1/exec/approvals", ADMIN);
      const record = approvals
        .json<{ approvals: { id: string; surface: string; status: string }[] }>()
        .approvals.find((a) => a.id === approvalId);
      expect(record?.surface).toBe("lsp");
      expect(record?.status).toBe("pending");

      const approved = await call("POST", `/api/v1/exec/approvals/${approvalId}/approve`, ADMIN);
      expect(approved.statusCode, approved.body).toBe(200);

      const started = await call("POST", "/api/v1/lsp/servers/typescript/start", ADMIN, {
        approvalId,
      });
      expect(started.statusCode, started.body).toBe(200);
      expect(started.json<{ started: boolean }>().started).toBe(true);

      const status = await call("GET", "/api/v1/lsp/status", ADMIN);
      const server = status
        .json<{ servers: { language: string; state: string; requests: number }[] }>()
        .servers.find((s) => s.language === "typescript");
      expect(server?.state).toBe("ready");
      expect(server?.requests).toBe(1);

      const replay = await call("POST", "/api/v1/lsp/servers/typescript/start", ADMIN, {
        approvalId,
      });
      expect(replay.statusCode, replay.body).toBe(403);
      expect(replay.json<{ error: string; message: string }>().message).toContain("cannot be used");
    } finally {
      delete process.env.NEXUS_EXEC_ASK_SURFACES;
    }
  });
});
