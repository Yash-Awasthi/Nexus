// SPDX-License-Identifier: Apache-2.0
/** Conversation insights belong to the account that asked for them. */
import crypto from "node:crypto";

import Fastify from "fastify";
import { describe, it, expect } from "vitest";

const SECRET = "conversation-analysis-owner-secret";
process.env.NEXUS_JWT_SECRET = SECRET;

const { conversationAnalysisRoutes } = await import("../../src/routes/conversation-analysis.js");

function tokenFor(userId: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub: userId, role: "agent", iat: now, exp: now + 3600 });
  const sig = crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

describe("conversation analysis", () => {
  it("never lists, reads or replaces another account's insight", async () => {
    const app = Fastify();
    await app.register(conversationAnalysisRoutes);
    await app.ready();
    const as = (u: string) => ({ authorization: `Bearer ${tokenFor(u)}` });
    const analyze = (u: string, content: string) =>
      app.inject({
        method: "POST",
        url: "/conversation-analysis/analyze",
        headers: as(u),
        payload: { id: "shared-id", messages: [{ role: "user", content }] },
      });
    await analyze("alice", "alice talks about her salary negotiation");
    await analyze("bob", "bob asks about gardening");
    const bobList = await app.inject({
      method: "GET",
      url: "/conversation-analysis",
      headers: as("bob"),
    });
    expect(bobList.json<{ total: number }>().total).toBe(1);
    const aliceOwn = await app.inject({
      method: "GET",
      url: "/conversation-analysis/shared-id",
      headers: as("alice"),
    });
    expect(JSON.stringify(aliceOwn.json())).toMatch(/salary/);
    expect(JSON.stringify(aliceOwn.json())).not.toMatch(/garden/);
  });
});
