// SPDX-License-Identifier: Apache-2.0
/**
 * A mission's run_command is model-written bash. It runs when the policy allows bash, or when the
 * owner approved the shell for that one mission at its start; a deny rule wins either way.
 */
import crypto from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const SECRET = "missions-shell-test-secret";
process.env.NEXUS_JWT_SECRET = SECRET;
delete process.env.NEXUS_EXEC_MODE;

const { missionExec } = await import("../../src/routes/missions.js");
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
  delete process.env.NEXUS_EXEC_MODE;
  delete process.env.NEXUS_EXEC_ALLOW;
  delete process.env.NEXUS_EXEC_DENY;
});

describe("mission run_command", () => {
  it("does not run under the default policy without a start approval", async () => {
    const r = await missionExec(false)("echo pwned > /tmp/nexus-mission-shell-test", {});
    expect(r.exitCode).toBe(126);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("Not run");
  });

  it("runs once a trusted policy allows bash", async () => {
    process.env.NEXUS_EXEC_MODE = "trusted";
    process.env.NEXUS_EXEC_ALLOW = "bash";
    const r = await missionExec(false)("echo ok", { timeoutMs: 10_000 });
    expect(r.stderr).not.toContain("Not run");
  });

  it("runs after the mission's start approval, but never past a deny rule", async () => {
    expect((await missionExec(true)("echo ok", { timeoutMs: 10_000 })).stderr).not.toContain(
      "Not run",
    );
    process.env.NEXUS_EXEC_DENY = "bash";
    expect((await missionExec(true)("echo ok", {})).exitCode).toBe(126);
  });
});

describe("POST /api/missions with shell", () => {
  it("asks once, bound to the mission id, and starts that mission after approval", async () => {
    const unnamed = await post("/api/missions", { goal: "list files", shell: true });
    expect(unnamed.statusCode, unnamed.body).toBe(400);
    const missionId = "mission-client-0001";
    const asked = await post("/api/missions", { goal: "list files", shell: true, missionId });
    expect(asked.statusCode, asked.body).toBe(202);
    const { approvalId, action, ...rest } = asked.json();
    expect(approvalId).toBeTruthy();
    expect(rest).not.toHaveProperty("missionId");
    expect(action.args).toContain(missionId);

    const early = await post("/api/missions", {
      goal: "list files",
      shell: true,
      missionId,
      approvalId,
    });
    expect(early.statusCode).toBe(403);

    const again = await post("/api/missions", {
      goal: "list files",
      shell: true,
      missionId: "mission-client-0002",
    });
    const other = again.json();
    expect((await post(`/api/v1/exec/approvals/${other.approvalId}/approve`)).statusCode).toBe(200);
    const swapped = await post("/api/missions", {
      goal: "list files",
      shell: true,
      missionId,
      approvalId: other.approvalId,
    });
    expect(swapped.json().error).toBe("action_mismatch");

    expect((await post(`/api/v1/exec/approvals/${approvalId}/approve`)).statusCode).toBe(200);
    const started = await post("/api/missions", {
      goal: "list files",
      shell: true,
      missionId,
      approvalId,
    });
    expect(started.statusCode, started.body).toBe(202);
    expect(started.json().id).toBe(missionId);
  });

  it("refuses the shell outright when bash is denied", async () => {
    process.env.NEXUS_EXEC_DENY = "bash";
    const r = await post("/api/missions", { goal: "x", shell: true });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe("exec_denied");
  });

  it("never lets another account stop or delete a mission", async () => {
    const missionId = "mission-owner-check-0001";
    process.env.NEXUS_EXEC_MODE = "trusted";
    process.env.NEXUS_EXEC_ALLOW = "bash";
    const started = await post("/api/missions", { goal: "list files", shell: true, missionId });
    expect(started.statusCode, started.body).toBe(202);
    const bob = { authorization: `Bearer ${tokenFor(`bob-${crypto.randomUUID()}`)}` };
    const del = await app.inject({
      method: "DELETE",
      url: `/api/missions/${missionId}`,
      headers: bob,
    });
    expect(del.statusCode).toBe(404);
    const abort = await app.inject({
      method: "POST",
      url: `/api/missions/${missionId}/abort`,
      headers: bob,
    });
    expect(abort.statusCode).toBe(404);
    const mine = await app.inject({
      method: "GET",
      url: `/api/missions/${missionId}`,
      headers: { authorization: `Bearer ${tokenFor(ALICE)}` },
    });
    expect(mine.json<{ status: string }>().status).not.toBe("aborted");
  });
});
