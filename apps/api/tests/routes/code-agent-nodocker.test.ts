// SPDX-License-Identifier: Apache-2.0
/** Without Docker or a browser, the endpoints that need them say so instead of faking a result. */
import crypto from "node:crypto";

import type { FastifyInstance } from "fastify";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const SECRET = "code-agent-test-secret";
process.env.NEXUS_JWT_SECRET = SECRET;
delete process.env.NEXUS_EXEC_MODE;

const docker = vi.hoisted(() => ({ up: false }));
vi.mock("@nexus/stealth-browser", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@nexus/stealth-browser")>()),
  isPatchrightAvailable: async () => false,
}));
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

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("code-agent kernels without Docker", () => {
  it("refuse honestly rather than pretend to run", async () => {
    for (const [url, body] of [
      ["/api/code-agent/execute", { code: "print(1)" }],
      ["/api/code-agent/sessions", { language: "python" }],
      ["/api/build/run", { code: "print(1)" }],
    ] as const) {
      const r = await call("POST", url, ALICE, body);
      expect(r.statusCode, url).toBe(503);
      expect(r.json<{ error: string }>().error, url).toBe("docker_required");
    }
  });
});

describe("the browser agent without a browser", () => {
  it("refuses rather than return a made-up page", async () => {
    for (const url of ["/api/browser-agent/navigate", "/api/browser-agent/scrape"]) {
      const r = await call("POST", url, ALICE, { url: "https://example.com/" });
      expect(r.statusCode, url).toBe(503);
    }
  });
});
