// SPDX-License-Identifier: Apache-2.0
/** A connector's OAuth token lands in the secret store of the account that started the flow, and nowhere else. */
import crypto from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const SECRET = "connectors-credentials-test-secret";
process.env.NEXUS_JWT_SECRET = SECRET;
process.env.NEXUS_SECRETS_KEY = crypto.randomBytes(32).toString("hex");
process.env.GITHUB_CLIENT_ID = "gh-client-id";
process.env.GITHUB_CLIENT_SECRET = "gh-client-secret";

vi.mock("@nexus/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@nexus/runtime")>()),
  pinnedFetch: async () => ({
    ok: true,
    json: async () => ({ access_token: "gho_supersecrettoken", scope: "repo" }),
  }),
}));

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
const get = (url: string, user?: string) =>
  app.inject({
    method: "GET",
    url,
    headers: user ? { authorization: `Bearer ${tokenFor(user)}` } : {},
  });
const patch = (url: string, user: string, payload: object) =>
  app.inject({
    method: "PATCH",
    url,
    headers: { authorization: `Bearer ${tokenFor(user)}` },
    payload,
  });
type View = { id: string; enabled: boolean; status: string };
const view = async (user: string, id: string) =>
  (await get("/api/v1/connectors", user))
    .json<{ connectors: View[] }>()
    .connectors.find((c) => c.id === id);
const ALICE = `alice-${crypto.randomUUID()}`;
const BOB = `bob-${crypto.randomUUID()}`;

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

describe("connector OAuth credentials", () => {
  it("belong to the account that started the flow and are never returned", async () => {
    const start = await get("/api/v1/connectors/github/oauth/start", ALICE);
    expect(start.statusCode, start.body).toBe(200);
    const { state } = start.json<{ state: string }>();
    const done = await get(`/api/v1/connectors/github/oauth/callback?code=abc&state=${state}`);
    expect(done.statusCode, done.body).toBe(200);
    expect(done.body).not.toContain("gho_supersecrettoken");

    const mine = await get("/api/v1/connectors/github/oauth/credential", ALICE);
    expect(mine.statusCode, mine.body).toBe(200);
    expect(mine.json()).toMatchObject({ connector: "github", scope: "repo" });
    expect(mine.body).not.toContain("gho_");
    expect(mine.body).not.toContain("secrettoken");

    expect((await get("/api/v1/connectors/github/oauth/credential", BOB)).statusCode).toBe(404);
    const secrets = await get("/api/v1/secrets", ALICE);
    expect(secrets.body).toContain("CONNECTOR_GITHUB_OAUTH");
    expect(secrets.body).not.toContain("gho_");
    expect((await get("/api/v1/secrets", BOB)).body).not.toContain("CONNECTOR_GITHUB_OAUTH");
  });

  it("keep their enabled state and OAuth connection per account", async () => {
    const CAROL = `carol-${crypto.randomUUID()}`;
    const DAVE = `dave-${crypto.randomUUID()}`;
    const before = (await view(DAVE, "tavily"))?.enabled;
    const flip = await patch("/api/v1/connectors/tavily", CAROL, { enabled: !before });
    expect(flip.statusCode).toBe(200);
    expect((await view(CAROL, "tavily"))?.enabled).toBe(!before);
    expect((await view(DAVE, "tavily"))?.enabled).toBe(before);

    const start = await get("/api/v1/connectors/github/oauth/start", CAROL);
    const { state } = start.json<{ state: string }>();
    await get(`/api/v1/connectors/github/oauth/callback?code=abc&state=${state}`);
    expect((await view(CAROL, "github"))?.enabled).toBe(true);
    const connect = await app.inject({
      method: "POST",
      url: "/api/v1/connectors/connect",
      headers: { authorization: `Bearer ${tokenFor(DAVE)}` },
      payload: { id: "github" },
    });
    // Dave has no token of his own, so his GitHub stays a placeholder.
    expect(connect.json<{ result: { ok: boolean } }>().result.ok).toBe(false);
    expect((await view(DAVE, "github"))?.status).not.toBe("connected");
  });
});
