// SPDX-License-Identifier: Apache-2.0
/**
 * With no job queue (the desktop app has no Redis), a coding-agent run happens in the API
 * process on the caller's own provider key, and its events reach the run's stream.
 */
import crypto from "node:crypto";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";

const DB = "pglite://:memory:agent-run-local";
const SECRET = "agent-run-local-test-secret";
process.env.DATABASE_URL = DB;
process.env.NEXUS_JWT_SECRET = SECRET;
process.env.NEXUS_SECRETS_KEY = "cd".repeat(32);
process.env.NEXUS_DESKTOP = "1";
delete process.env.NEXUS_EXEC_MODE;
delete process.env.REDIS_URL;

const { migrateEmbedded } = await import("../../src/lib/migrate-embedded.js");
const { getPgPool } = await import("../../src/lib/pg-pool.js");
const { buildServer } = await import("../../src/server.js");
const { globalBus } = await import("@nexus/sse");

function tokenFor(userId: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub: userId, role: "admin", iat: now, exp: now + 3600 });
  const sig = crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

let app: FastifyInstance;
let model: http.Server;
const USER = crypto.randomUUID();
const asked: string[] = [];

beforeAll(async () => {
  await migrateEmbedded(getPgPool(DB)!);
  model = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      asked.push((JSON.parse(body) as { model: string }).model);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: "all done" } }] }));
    });
  });
  await new Promise<void>((r) => model.listen(0, "127.0.0.1", r));
  app = await buildServer();
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app.close();
  model.close();
});

it("runs in this process on the caller's saved key and streams its events", async () => {
  const auth = { authorization: `Bearer ${tokenFor(USER)}` };
  const port = (model.address() as { port: number }).port;
  const saved = await app.inject({
    method: "POST",
    url: "/api/user/provider-keys",
    headers: auth,
    payload: { provider: "localllm", baseUrl: `http://127.0.0.1:${port}/v1`, models: ["tiny"] },
  });
  expect(saved.statusCode, saved.body).toBe(201);

  const workspaceDir = mkdtempSync(join(tmpdir(), "agent-run-"));
  const events: string[] = [];
  const stop = globalBus.subscribe<unknown>("agent", (e) =>
    events.push((e as { event: string }).event),
  );
  const run = (approvalId?: string) =>
    app.inject({
      method: "POST",
      url: "/api/v1/agent/run",
      headers: auth,
      payload: {
        instruction: "say done",
        provider: "localllm",
        model: "tiny",
        sessionId: "local-run-0001",
        workspaceDir,
        disableCouncilTools: true,
        disablePtc: true,
        approvalId,
      },
    });
  const { approvalId } = (await run()).json<{ approvalId: string }>();
  const approved = await app.inject({
    method: "POST",
    url: `/api/v1/exec/approvals/${approvalId}/approve`,
    headers: auth,
  });
  expect(approved.statusCode).toBe(200);
  const r = await run(approvalId);
  expect(r.statusCode, r.body).toBe(202);
  const { sessionId } = r.json<{ sessionId: string }>();
  await expect.poll(() => events, { timeout: 20_000 }).toContain("agent.status");
  stop();
  expect(events).toContain("agent.run_started");
  expect(asked).toContain("tiny");
  await expect
    .poll(async () => {
      const { rows } = await getPgPool(DB)!.query(
        "SELECT status, user_id FROM agent_sessions WHERE id = $1",
        [sessionId],
      );
      return rows[0];
    })
    .toEqual({ status: "completed", user_id: USER });
});
