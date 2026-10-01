// SPDX-License-Identifier: Apache-2.0
/**
 * On a shared server a host shell is the operator's to grant: a member cannot approve one,
 * however the request was raised (an org shell agent asks without an HTTP request of its own).
 */
import crypto from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";

const SECRET = "exec-approvals-host-secret";
process.env.NEXUS_JWT_SECRET = SECRET;
delete process.env.NEXUS_DESKTOP;
delete process.env.NEXUS_EXEC_MODE;

const { buildServer } = await import("../../src/server.js");
const { requestApproval } = await import("../../src/lib/exec-approvals.js");

function tokenFor(userId: string, role: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub: userId, role, iat: now, exp: now + 3600 });
  const sig = crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

const approve = (user: string, role: string, id: string) =>
  app.inject({
    method: "POST",
    url: `/api/v1/exec/approvals/${id}/approve`,
    headers: { authorization: `Bearer ${tokenFor(user, role)}` },
  });

it("lets an admin approve a host shell but not a member", async () => {
  const member = crypto.randomUUID();
  const admin = crypto.randomUUID();
  const shell = { surface: "pty" as const, command: "node", args: ["agent.js"] };
  const asked = requestApproval(member, shell, "org shell agent");
  const refused = await approve(member, "agent", asked.id);
  expect(refused.statusCode, refused.body).toBe(403);
  expect(refused.json<{ error: string }>().error).toBe("host_shell_admin_only");

  const own = requestApproval(admin, shell, "org shell agent");
  expect((await approve(admin, "admin", own.id)).statusCode).toBe(200);

  const sandboxed = requestApproval(member, { surface: "sandbox", command: "python" }, "code");
  expect((await approve(member, "agent", sandboxed.id)).statusCode).toBe(200);
});
