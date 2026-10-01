// SPDX-License-Identifier: Apache-2.0
/** A compressed mission that needs approval builds its composite once, not again on the approved retry. */
import crypto from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const SECRET = "missions-compress-test-secret";
process.env.NEXUS_JWT_SECRET = SECRET;
delete process.env.NEXUS_EXEC_MODE;

const calls = vi.hoisted(() => ({ n: 0 }));
vi.mock("../../src/lib/skill-compress.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/lib/skill-compress.js")>();
  return {
    ...real,
    compressSkillsForTaskSemantic: (
      ...args: Parameters<typeof real.compressSkillsForTaskSemantic>
    ) => {
      calls.n++;
      return real.compressSkillsForTaskSemantic(args[0], args[1], {
        ...args[2],
        embedBaseUrl: "http://127.0.0.1:9",
      });
    },
  };
});

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

describe("POST /api/missions with compress", () => {
  it("compresses once across the approval round trip", async () => {
    const ids: string[] = [];
    for (const name of ["CSV Reader", "JSON Writer"]) {
      const r = await post("/api/skills", {
        name,
        description: `${name} for data files`,
        language: "python",
        code: `print("${name}")`,
      });
      expect(r.statusCode, r.body).toBeLessThan(300);
      ids.push(r.json<{ id: string }>().id);
    }
    const body = { goal: "convert data", compress: { ids, task: "read CSV and write JSON" } };
    const asked = await post("/api/missions", body);
    expect(asked.statusCode, asked.body).toBe(202);
    const { approvalId } = asked.json<{ approvalId: string }>();
    expect(approvalId).toBeTruthy();
    expect((await post(`/api/v1/exec/approvals/${approvalId}/approve`)).statusCode).toBe(200);
    const started = await post("/api/missions", { ...body, approvalId });
    expect(started.statusCode, started.body).toBe(202);
    expect(started.json<{ id?: string }>().id).toMatch(/^mission-/);
    expect(calls.n).toBe(1);
  });
});
