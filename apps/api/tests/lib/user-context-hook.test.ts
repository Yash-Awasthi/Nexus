// SPDX-License-Identifier: Apache-2.0
/** Every scoped request runs as its caller, even when the route resolves identity itself later. */
import crypto from "node:crypto";

import type { FastifyReply, FastifyRequest } from "fastify";
import { describe, it, expect } from "vitest";

const SECRET = "user-context-hook-secret";
process.env.NEXUS_JWT_SECRET = SECRET;

const { enterUserContext } = await import("../../src/server.js");
const { userContext } = await import("../../src/lib/user-context.js");

function tokenFor(userId: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub: userId, role: "agent", iat: now, exp: now + 3600 });
  const sig = crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

describe("enterUserContext", () => {
  it("resolves the caller before entering their context", async () => {
    const request = { headers: { authorization: `Bearer ${tokenFor("ctx-user")}` } };
    const seen = await new Promise<string | null | undefined>((resolve) =>
      enterUserContext(request as unknown as FastifyRequest, {} as FastifyReply, () =>
        resolve(userContext.getStore()?.userId),
      ),
    );
    expect(seen).toBe("ctx-user");
  });

  it("enters an anonymous context for a request with no identity", async () => {
    const seen = await new Promise<string | null | undefined>((resolve) =>
      enterUserContext({ headers: {} } as unknown as FastifyRequest, {} as FastifyReply, () =>
        resolve(userContext.getStore()?.userId),
      ),
    );
    expect(seen).toBeNull();
  });
});
