// SPDX-License-Identifier: Apache-2.0
import type { FastifyRequest, FastifyReply } from "fastify";
import { describe, it, expect, afterEach } from "vitest";

import { requireAuth } from "../../src/middleware/auth.js";

function makeRequest(authHeader?: string): FastifyRequest {
  return {
    headers: { authorization: authHeader },
  } as unknown as FastifyRequest;
}

function makeReply(): FastifyReply & { _statusCode: number; _body: unknown } {
  const reply = {
    _statusCode: 0,
    _body: undefined as unknown,
    code(statusCode: number) {
      this._statusCode = statusCode;
      return this;
    },
    send(body: unknown) {
      this._body = body;
      return this;
    },
  } as FastifyReply & { _statusCode: number; _body: unknown };
  return reply;
}

describe("requireAuth", () => {
  const ORIGINAL = process.env.NEXUS_API_KEY;

  afterEach(() => {
    // Restore env after each test
    if (ORIGINAL === undefined) {
      delete process.env.NEXUS_API_KEY;
    } else {
      process.env.NEXUS_API_KEY = ORIGINAL;
    }
  });

  it("passes through when NEXUS_API_KEY is not set (dev mode)", async () => {
    delete process.env.NEXUS_API_KEY;
    const req = makeRequest();
    const reply = makeReply();
    await requireAuth(req, reply);
    // No 401 — code was never called
    expect(reply._statusCode).toBe(0);
  });

  it("passes through with a valid Bearer token", async () => {
    process.env.NEXUS_API_KEY = "my-secret";
    const req = makeRequest("Bearer my-secret");
    const reply = makeReply();
    await requireAuth(req, reply);
    expect(reply._statusCode).toBe(0);
  });

  it("returns 401 when Authorization header is missing", async () => {
    process.env.NEXUS_API_KEY = "my-secret";
    const req = makeRequest(undefined);
    const reply = makeReply();
    await requireAuth(req, reply);
    expect(reply._statusCode).toBe(401);
    expect((reply._body as { message: string }).message).toMatch(/bearer/i);
  });

  it("returns 401 when Authorization header lacks Bearer prefix", async () => {
    process.env.NEXUS_API_KEY = "my-secret";
    const req = makeRequest("Basic my-secret");
    const reply = makeReply();
    await requireAuth(req, reply);
    expect(reply._statusCode).toBe(401);
  });

  it("returns 401 when token value is wrong", async () => {
    process.env.NEXUS_API_KEY = "correct-key";
    const req = makeRequest("Bearer wrong-key");
    const reply = makeReply();
    await requireAuth(req, reply);
    expect(reply._statusCode).toBe(401);
    expect((reply._body as { code: string }).code).toBe("INVALID_TOKEN");
  });

  it("passes through when token matches exactly", async () => {
    process.env.NEXUS_API_KEY = "abc123";
    const req = makeRequest("Bearer abc123");
    const reply = makeReply();
    await requireAuth(req, reply);
    expect(reply._statusCode).toBe(0);
  });
});
