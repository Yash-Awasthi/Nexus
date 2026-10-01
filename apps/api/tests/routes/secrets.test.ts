// SPDX-License-Identifier: Apache-2.0
/**
 * Stage F-Tier1 — the secret store, driven through the real routes.
 *
 * The property that matters most is a negative one: no route returns a value.
 * That is asserted twice — once per endpoint, and once by sweeping every
 * response in the file for the secret itself, so a future endpoint that leaks
 * one fails here rather than in production.
 */
import crypto from "node:crypto";

import type { FastifyInstance } from "fastify";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const SECRET_JWT = "secrets-route-test-secret";
const VALUE = "sk-live-this-must-never-be-returned";

process.env.NEXUS_JWT_SECRET = SECRET_JWT;
// A 32-byte key, so the store is usable: it fails closed without one.
process.env.NEXUS_SECRETS_KEY = "a".repeat(64);

const { buildServer } = await import("../../src/server.js");

let app: FastifyInstance;

function tokenFor(userId: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub: userId, role: "admin", iat: now, exp: now + 3600 });
  const sig = crypto.createHmac("sha256", SECRET_JWT).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

const ALICE = `alice-${crypto.randomUUID()}`;
const BOB = `bob-${crypto.randomUUID()}`;

/** Every response this file sees, for the leak sweep at the end. */
const seen: string[] = [];

async function call(
  method: "GET" | "PUT" | "POST" | "DELETE",
  url: string,
  userId: string,
  payload?: Record<string, unknown>,
) {
  const res = await app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${tokenFor(userId)}` },
    ...(payload === undefined ? {} : { payload }),
  });
  seen.push(res.payload);
  return res;
}

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  delete process.env.NEXUS_SECRETS_KEY;
});

describe("a stored secret", () => {
  it("is stored and answered with metadata only", async () => {
    const res = await call("PUT", "/api/v1/secrets/STRIPE_KEY", ALICE, {
      value: VALUE,
      description: "Payments.",
    });

    expect(res.statusCode).toBe(200);
    const { secret } = JSON.parse(res.payload) as {
      secret: { name: string; fingerprint: string; description: string };
    };
    expect(secret.name).toBe("STRIPE_KEY");
    expect(secret.description).toBe("Payments.");
    expect(secret.fingerprint).toHaveLength(8);
    expect(res.payload).not.toContain(VALUE);
  });

  it("is listed without its value", async () => {
    const res = await call("GET", "/api/v1/secrets", ALICE);

    const { secrets } = JSON.parse(res.payload) as { secrets: { name: string }[] };
    expect(secrets.some((s) => s.name === "STRIPE_KEY")).toBe(true);
    expect(res.payload).not.toContain(VALUE);
  });

  it("belongs to one user", async () => {
    const res = await call("GET", "/api/v1/secrets", BOB);

    expect(JSON.parse(res.payload).secrets).toEqual([]);
  });

  it("changes its fingerprint when rotated, and keeps its creation time", async () => {
    const before = JSON.parse(
      (await call("PUT", "/api/v1/secrets/ROTATE_ME", ALICE, { value: "first" })).payload,
    ) as { secret: { fingerprint: string; createdAt: string } };

    const after = JSON.parse(
      (await call("PUT", "/api/v1/secrets/ROTATE_ME", ALICE, { value: "second" })).payload,
    ) as { secret: { fingerprint: string; createdAt: string } };

    expect(after.secret.fingerprint).not.toBe(before.secret.fingerprint);
    expect(after.secret.createdAt).toBe(before.secret.createdAt);
  });

  it("is refused a name that is not a plain uppercase identifier", async () => {
    const res = await call("PUT", "/api/v1/secrets/not a name", ALICE, { value: "x" });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toBe("invalid_name");
  });

  it("is refused with no value", async () => {
    const res = await call("PUT", "/api/v1/secrets/EMPTY_ONE", ALICE, {});

    expect(res.statusCode).toBe(400);
  });

  it("is deleted by its owner and by nobody else", async () => {
    await call("PUT", "/api/v1/secrets/TO_DELETE", ALICE, { value: "x" });

    expect((await call("DELETE", "/api/v1/secrets/TO_DELETE", BOB)).statusCode).toBe(404);
    expect((await call("DELETE", "/api/v1/secrets/TO_DELETE", ALICE)).statusCode).toBe(200);
    expect((await call("DELETE", "/api/v1/secrets/TO_DELETE", ALICE)).statusCode).toBe(404);
  });
});

describe("asking for a secret instead of asking in conversation", () => {
  it("records what is needed and why", async () => {
    const res = await call("POST", "/api/v1/secrets/requests", ALICE, {
      name: "DEPLOY_TOKEN",
      reason: "Needed to push the release tag.",
    });

    expect(res.statusCode).toBe(201);
    const { request } = JSON.parse(res.payload) as {
      request: { name: string; status: string; reason: string };
    };
    expect(request.name).toBe("DEPLOY_TOKEN");
    expect(request.status).toBe("pending");
    expect(request.reason).toContain("release tag");
  });

  it("refuses a request with no reason, because nobody can judge it", async () => {
    const res = await call("POST", "/api/v1/secrets/requests", ALICE, { name: "MYSTERY" });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toBe("reason_required");
  });

  it("is answered by storing the value, not by replying with it", async () => {
    await call("POST", "/api/v1/secrets/requests", ALICE, {
      name: "WEBHOOK_SIGNING_KEY",
      reason: "Verifying inbound webhooks.",
    });

    await call("PUT", "/api/v1/secrets/WEBHOOK_SIGNING_KEY", ALICE, { value: VALUE });

    const { requests } = JSON.parse(
      (await call("GET", "/api/v1/secrets/requests", ALICE)).payload,
    ) as { requests: { name: string; status: string }[] };
    const fulfilled = requests.find((r) => r.name === "WEBHOOK_SIGNING_KEY");
    expect(fulfilled?.status).toBe("fulfilled");
  });

  it("can be withdrawn by its owner alone", async () => {
    const { request } = JSON.parse(
      (
        await call("POST", "/api/v1/secrets/requests", ALICE, {
          name: "NOT_NEEDED",
          reason: "Changed approach.",
        })
      ).payload,
    ) as { request: { id: string } };

    expect((await call("DELETE", `/api/v1/secrets/requests/${request.id}`, BOB)).statusCode).toBe(
      404,
    );
    const cancelled = await call("DELETE", `/api/v1/secrets/requests/${request.id}`, ALICE);
    expect(JSON.parse(cancelled.payload).request.status).toBe("cancelled");
  });
});

describe("the value itself", () => {
  it("is readable in-process and nowhere else", async () => {
    const store = await import("../../src/lib/secret-store.js");

    expect(store.resolveSecret(ALICE, "STRIPE_KEY")).toBe(VALUE);
    expect(store.resolveSecret(BOB, "STRIPE_KEY")).toBeNull();
  });

  it("records that it was used, without recording what it says", async () => {
    const store = await import("../../src/lib/secret-store.js");
    store.resolveSecret(ALICE, "STRIPE_KEY");

    const { secrets } = JSON.parse((await call("GET", "/api/v1/secrets", ALICE)).payload) as {
      secrets: { name: string; lastUsedAt?: string }[];
    };
    expect(secrets.find((s) => s.name === "STRIPE_KEY")?.lastUsedAt).toBeTruthy();
  });

  it("never appears in any response this file has seen", () => {
    expect(seen.length).toBeGreaterThan(10);
    expect(seen.filter((body) => body.includes(VALUE))).toEqual([]);
  });

  it("survives a restart, still sealed", async () => {
    const store = await import("../../src/lib/secret-store.js");
    store._resetSecretStoreForTests();
    await store.loadSecretStore();

    expect(store.resolveSecret(ALICE, "STRIPE_KEY")).toBe(VALUE);
  });
});

describe("with no encryption key configured", () => {
  it("refuses to store anything rather than writing plaintext", async () => {
    const key = process.env.NEXUS_SECRETS_KEY;
    delete process.env.NEXUS_SECRETS_KEY;
    try {
      const res = await call("PUT", "/api/v1/secrets/NO_KEY_HERE", ALICE, { value: VALUE });

      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.payload).error).toBe("encryption_unavailable");
    } finally {
      process.env.NEXUS_SECRETS_KEY = key;
    }

    const { secrets } = JSON.parse((await call("GET", "/api/v1/secrets", ALICE)).payload) as {
      secrets: { name: string }[];
    };
    expect(secrets.some((s) => s.name === "NO_KEY_HERE")).toBe(false);
  });
});
