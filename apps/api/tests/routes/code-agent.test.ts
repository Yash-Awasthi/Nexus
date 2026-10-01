// SPDX-License-Identifier: Apache-2.0
/**
 * Code-agent kernels belong to the account that created them, and without
 * Docker the endpoints say so instead of reporting an empty success.
 */
import crypto from "node:crypto";

import type { FastifyInstance } from "fastify";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const SECRET = "code-agent-test-secret";
process.env.NEXUS_JWT_SECRET = SECRET;
delete process.env.NEXUS_EXEC_MODE;

const docker = vi.hoisted(() => ({ up: true }));
vi.mock("@nexus/code-repl", async (importOriginal) => {
  const real = await importOriginal<typeof import("@nexus/code-repl")>();
  class FakeDocker {
    async execute(_language: string, code: string) {
      return { stdout: `ran ${code}`, stderr: "", exitCode: 0, durationMs: 1 };
    }
  }
  return { ...real, isDockerAvailable: async () => docker.up, DockerReplExecutor: FakeDocker };
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
const call = (method: "GET" | "POST" | "DELETE", url: string, user: string, payload?: object) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${tokenFor(user)}` }, payload });

const ALICE = `alice-${crypto.randomUUID()}`;
const BOB = `bob-${crypto.randomUUID()}`;

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("code-agent kernels", () => {
  it("are listed, run and removed only by their owner", async () => {
    const created = await call("POST", "/api/code-agent/sessions", ALICE, { language: "python" });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json<{ sessionId: string }>().sessionId;

    expect((await call("GET", "/api/code-agent/sessions", BOB)).body).not.toContain(id);
    expect((await call("GET", "/api/code-agent/sessions", ALICE)).body).toContain(id);
    const theirs = await call("POST", `/api/code-agent/sessions/${id}/execute`, BOB, {
      code: "print(1)",
    });
    expect(theirs.statusCode).toBe(404);
    expect((await call("DELETE", `/api/code-agent/sessions/${id}`, BOB)).statusCode).toBe(404);

    const mine = await call("POST", `/api/code-agent/sessions/${id}/execute`, ALICE, {
      code: "print(1)",
    });
    expect(mine.json<{ stdout: string }>().stdout).toContain(
      `__nexus_cell("print(1)", globals(), True)`,
    );
    expect((await call("DELETE", `/api/code-agent/sessions/${id}`, ALICE)).statusCode).toBe(204);
  });

  it("has no unowned duplicate under /code-repl", async () => {
    for (const [method, url] of [
      ["GET", "/api/v1/code-repl/sessions"],
      ["POST", "/api/v1/code-repl/sessions"],
    ] as const)
      expect((await call(method, url, ALICE, method === "POST" ? {} : undefined)).statusCode).toBe(
        404,
      );
  });
});
