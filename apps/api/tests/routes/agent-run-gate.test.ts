// SPDX-License-Identifier: Apache-2.0
/**
 * A worker coding agent runs model-written shell on the worker host, so launching one passes
 * the exec gate once, and the caller can neither switch its safety net off nor pick its owner.
 */
import crypto from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const SECRET = "agent-run-gate-test-secret";
process.env.NEXUS_JWT_SECRET = SECRET;
delete process.env.NEXUS_EXEC_MODE;

const launched = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock("../../src/lib/agent-queue.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/lib/agent-queue.js")>();
  return {
    ...real,
    launchAgentRun: async (input: Record<string, unknown>) => {
      launched.push(input);
      return { sessionId: String(input.sessionId) };
    },
  };
});

const { buildServer } = await import("../../src/server.js");

function tokenFor(userId: string, role = "admin"): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub: userId, role, iat: now, exp: now + 3600 });
  const sig = crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

let app: FastifyInstance;
const ALICE = `alice-${crypto.randomUUID()}`;
const post = (url: string, payload?: object) =>
  app.inject({
    method: "POST",
    url,
    headers: { authorization: `Bearer ${tokenFor(ALICE)}` },
    payload,
  });

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});
afterAll(async () => {
  await app.close();
});
afterEach(() => {
  delete process.env.NEXUS_EXEC_DENY;
  launched.length = 0;
});

describe("POST /api/v1/agent/run", () => {
  it("asks once before launching and strips the caller's safety-net overrides", async () => {
    const sessionId = "client-minted-0001";
    const body = {
      instruction: "fix the tests",
      disableGovernance: true,
      userId: "someone-else",
      sessionId,
    };
    const unnamed = await post("/api/v1/agent/run", { ...body, sessionId: undefined });
    expect(unnamed.statusCode, unnamed.body).toBe(400);
    const asked = await post("/api/v1/agent/run", body);
    expect(asked.statusCode, asked.body).toBe(202);
    const { approvalId, ...rest } = asked.json<{ approvalId: string }>();
    expect(approvalId).toBeTruthy();
    expect(rest).not.toHaveProperty("sessionId");
    expect(launched).toHaveLength(0);

    expect((await post(`/api/v1/exec/approvals/${approvalId}/approve`)).statusCode).toBe(200);
    const ok = await post("/api/v1/agent/run", { ...body, approvalId });
    expect(ok.statusCode, ok.body).toBe(202);
    expect(launched).toHaveLength(1);
    expect(launched[0]).not.toHaveProperty("disableGovernance");
    expect(launched[0]!.userId).toBe(ALICE);
    // The client's id is namespaced by account, so two accounts naming the same id never share a run.
    expect(launched[0]!.sessionId).toMatch(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
    expect(ok.json<{ sessionId: string }>().sessionId).toBe(launched[0]!.sessionId);
  });

  it("approves the run's workspace and MCP servers, not just the shell", async () => {
    const body = {
      instruction: "tidy the repo",
      sessionId: "client-minted-0002",
      workspaceDir: "/srv/app",
      mcpServers: [{ name: "fs", command: "npx", args: ["mcp-fs"] }],
    };
    const asked = await post("/api/v1/agent/run", body);
    expect(asked.statusCode, asked.body).toBe(202);
    const { approvalId, action } = asked.json<{
      approvalId: string;
      action: { args: string[] };
    }>();
    expect(action.args.join(" ")).toContain("/srv/app");
    expect(action.args.join(" ")).toContain("mcp-fs");
    expect((await post(`/api/v1/exec/approvals/${approvalId}/approve`)).statusCode).toBe(200);

    const elsewhere = await post("/api/v1/agent/run", { ...body, workspaceDir: "/", approvalId });
    expect(launched).toHaveLength(0);
    expect(elsewhere.statusCode).not.toBe(200);

    const ok = await post("/api/v1/agent/run", { ...body, approvalId });
    expect(ok.statusCode, ok.body).toBe(202);
    expect(launched).toHaveLength(1);
    expect(launched[0]!.workspaceDir).toBe("/srv/app");
  });

  it("refuses a host shell to a non-admin account on a shared server", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/agent/run",
      headers: { authorization: `Bearer ${tokenFor(`bob-${crypto.randomUUID()}`, "agent")}` },
      payload: { instruction: "x", sessionId: "member-run-0001" },
    });
    expect(r.statusCode, r.body).toBe(403);
    expect(r.json<{ error: string }>().error).toBe("host_shell_admin_only");
    expect(launched).toHaveLength(0);
  });

  it("never launches when the policy denies the shell", async () => {
    process.env.NEXUS_EXEC_DENY = "bash";
    const r = await post("/api/v1/agent/run", { instruction: "x" });
    expect(r.statusCode).toBe(403);
    expect(launched).toHaveLength(0);
  });
});
