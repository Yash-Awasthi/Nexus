// SPDX-License-Identifier: Apache-2.0
/** Emoji reactions are the reacting account's, and a rule's webhook stays public on edit. */
import crypto from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SECRET = "reactions-owner-secret";
process.env.NEXUS_JWT_SECRET = SECRET;

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
beforeAll(async () => {
  app = await buildServer();
  await app.ready();
}, 120_000);
afterAll(async () => {
  await app.close();
});

const call = (url: string, user: string, payload: object) =>
  app.inject({
    method: "POST",
    url,
    headers: { authorization: `Bearer ${tokenFor(user)}` },
    payload,
  });

describe("reactions", () => {
  it("lists only the caller's own emoji reactions on a message", async () => {
    const alice = `alice-${crypto.randomUUID()}`;
    const bob = `bob-${crypto.randomUUID()}`;
    const messageId = `m-${crypto.randomUUID()}`;
    await call("/api/reactions", alice, { messageId, emoji: "👍" });
    const listed = await app.inject({
      method: "GET",
      url: `/api/reactions?messageId=${messageId}`,
      headers: { authorization: `Bearer ${tokenFor(bob)}` },
    });
    expect(listed.json()).toEqual([]);
  });

  it("refuses a private webhook URL when a rule is edited", async () => {
    const alice = `alice-${crypto.randomUUID()}`;
    const rule = await call("/api/reactions", alice, {
      eventPattern: "task.*",
      handlerType: "webhook",
      handlerConfig: { url: "https://hooks.example.com/x" },
    });
    const id = rule.json<{ id: string }>().id;
    const edited = await app.inject({
      method: "PATCH",
      url: `/api/reactions/${id}`,
      headers: { authorization: `Bearer ${tokenFor(alice)}` },
      payload: { handlerConfig: { url: "http://169.254.169.254/latest/meta-data" } },
    });
    expect(edited.statusCode).toBe(400);
  });
});
