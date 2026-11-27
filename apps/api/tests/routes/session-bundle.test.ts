// SPDX-License-Identifier: Apache-2.0
/**
 * Session bundles, tested as a round trip: export a real thread over HTTP, import the bytes
 * into a *different* account, and check the transcript arrived intact and under a new id.
 *
 * The refusals matter as much as the happy path — a bundle with an unknown format, a
 * duplicated message id, an unknown role or an oversized body must be rejected before
 * anything is written, because a half-imported session is worse than a refused one.
 */
import crypto from "node:crypto";

import type { FastifyInstance } from "fastify";
import { beforeAll, describe, expect, it } from "vite-plus/test";

const DB = "pglite://:memory:session-bundle";
const SECRET = "session-bundle-secret";
process.env.DATABASE_URL = DB;
process.env.NEXUS_JWT_SECRET = SECRET;
process.env.NEXUS_SECRETS_KEY = "cd".repeat(32);

const { validateBundle, buildBundle, bundleFilename, BUNDLE_FORMAT, MAX_MESSAGES } =
  await import("../../src/lib/session-bundle.ts");
const { migrateEmbedded } = await import("../../src/lib/migrate-embedded.ts");
const { getPgPool } = await import("../../src/lib/pg-pool.ts");
const { buildServer } = await import("../../src/server.ts");

function tokenFor(userId: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub: userId, role: "admin", iat: now, exp: now + 3600 });
  const sig = crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

const author = crypto.randomUUID();
const reviewer = crypto.randomUUID();
const auth = { authorization: `Bearer ${tokenFor(author)}` };
const reviewerAuth = { authorization: `Bearer ${tokenFor(reviewer)}` };

let app: FastifyInstance;
let base = "";

async function call(method: string, url: string, body?: unknown, as = auth): Promise<Response> {
  return fetch(`${base}${url}`, {
    method,
    headers: body === undefined ? { ...as } : { ...as, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const message = (over: Record<string, unknown> = {}) => ({
  id: crypto.randomUUID(),
  role: "opinion",
  member: "Ada",
  content: "Ship it behind a kill switch.",
  round: 1,
  createdAt: new Date().toISOString(),
  ...over,
});

beforeAll(async () => {
  await migrateEmbedded(getPgPool(DB)!);
  app = await buildServer();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("no listening port");
  base = `http://127.0.0.1:${address.port}`;
}, 120_000);

describe("the format", () => {
  it("counts what it exports instead of trusting the caller", () => {
    const bundle = buildBundle(
      {
        id: "t1",
        title: "Migration A/B",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      [
        {
          id: "m1",
          role: "user",
          content: "Should we ship?",
          round: 0,
          createdAt: new Date().toISOString(),
        },
        {
          id: "m2",
          role: "opinion",
          member: "Ada",
          content: "Yes.",
          round: 1,
          createdAt: new Date().toISOString(),
        },
        {
          id: "m3",
          role: "verdict",
          member: "Chair",
          content: "Yes, with a switch.",
          round: 2,
          createdAt: new Date().toISOString(),
        },
      ],
    );
    expect(bundle.format).toBe(BUNDLE_FORMAT);
    expect(bundle.stats).toMatchObject({ messages: 3, rounds: 3 });
    expect(bundle.stats.members).toEqual(["Ada", "Chair"]);
    expect(bundle.stats.characters).toBe(15 + 4 + 19);
  });

  it("refuses an unknown format, a duplicate id, an unknown role and an oversized set", () => {
    const good = buildBundle(
      {
        id: "t",
        title: "T",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      [],
    );
    expect(validateBundle({ ...good, format: "nexus.session/2" })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("unsupported format"),
    });
    expect(validateBundle("not an object")).toMatchObject({ ok: false });
    expect(validateBundle({ ...good, thread: { title: "" } })).toMatchObject({ ok: false });
    const dup = { ...good, messages: [message({ id: "same" }), message({ id: "same" })] };
    expect(validateBundle(dup)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("duplicated"),
    });
    const badRole = { ...good, messages: [message({ role: "root" })] };
    expect(validateBundle(badRole)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("role"),
    });
    const tooMany = {
      ...good,
      messages: Array.from({ length: MAX_MESSAGES + 1 }, (_, i) => message({ id: `m${i}` })),
    };
    expect(validateBundle(tooMany)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("limited to"),
    });
  });

  it("names the file after the session and the day it started", () => {
    expect(bundleFilename("Migration A/B — Friday?", "2026-05-01T10:00:00.000Z")).toBe(
      "session-2026-05-01-migration-a-b-friday.json",
    );
    expect(bundleFilename("", "not a date")).toBe("session-undated-export.json");
  });
});

describe("export and import", () => {
  it("round-trips a real thread into another account under a new id", async () => {
    const created = await call("POST", "/api/threads", { title: "Migration A/B" });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    await call("POST", `/api/threads/${id}/messages`, {
      messages: [
        { id: "m1", role: "user", content: "Should we ship on Friday?", round: 0 },
        {
          id: "m2",
          role: "opinion",
          member: "Ada",
          content: "Yes, behind a kill switch.",
          round: 1,
        },
        { id: "m3", role: "verdict", member: "Chair", content: "Ship, with a switch.", round: 2 },
      ],
    });

    const exported = await call("GET", `/api/threads/${id}/export`);
    expect(exported.status).toBe(200);
    expect(exported.headers.get("content-disposition")).toContain('attachment; filename="session-');
    expect(exported.headers.get("content-type")).toContain("application/json");
    const bundle = (await exported.json()) as {
      format: string;
      thread: { id: string; title: string };
      messages: { id: string; content: string }[];
      stats: { messages: number };
    };
    expect(bundle.format).toBe(BUNDLE_FORMAT);
    expect(bundle.thread.title).toBe("Migration A/B");
    expect(bundle.stats.messages).toBe(3);

    // A reviewer in a different account imports the same bytes.
    const imported = await call("POST", "/api/threads/import", bundle, reviewerAuth);
    expect(imported.status).toBe(201);
    const result = (await imported.json()) as {
      thread: { id: string; title: string };
      imported: { messages: number; stored: number; sourceThreadId: string };
    };
    expect(result.thread.id).not.toBe(id);
    expect(result.thread.title).toBe("Migration A/B");
    expect(result.imported).toMatchObject({ messages: 3, stored: 3, sourceThreadId: id });

    const messages = (await (
      await call("GET", `/api/threads/${result.thread.id}/messages`, undefined, reviewerAuth)
    ).json()) as { messages: { id: string; content: string; member?: string | null }[] };
    expect(messages.messages.map((m) => m.content)).toEqual([
      "Should we ship on Friday?",
      "Yes, behind a kill switch.",
      "Ship, with a switch.",
    ]);
    expect(messages.messages[1]!.member).toBe("Ada");

    // Importing twice makes two sessions, not a conflict.
    const again = await call("POST", "/api/threads/import", bundle, reviewerAuth);
    expect(again.status).toBe(201);
    expect(((await again.json()) as { thread: { id: string } }).thread.id).not.toBe(
      result.thread.id,
    );
  });

  it("refuses a malformed bundle with a reason, and writes nothing", async () => {
    const before = (await (
      await call("GET", "/api/threads?limit=200", undefined, reviewerAuth)
    ).json()) as { threads: unknown[] };
    const bad = await call(
      "POST",
      "/api/threads/import",
      { format: "something-else", thread: { title: "x" }, messages: [] },
      reviewerAuth,
    );
    expect(bad.status).toBe(400);
    const body = (await bad.json()) as { error: string; message: string };
    expect(body.error).toBe("invalid_bundle");
    expect(body.message).toMatch(/unsupported format/);
    const after = (await (
      await call("GET", "/api/threads?limit=200", undefined, reviewerAuth)
    ).json()) as { threads: unknown[] };
    expect(after.threads.length).toBe(before.threads.length);
  });

  it("keeps an export private: another account cannot export a thread it does not own", async () => {
    const created = await call("POST", "/api/threads", { title: "Private" });
    const { id } = (await created.json()) as { id: string };
    expect((await call("GET", `/api/threads/${id}/export`, undefined, reviewerAuth)).status).toBe(
      404,
    );
    expect((await call("GET", "/api/threads/does-not-exist/export")).status).toBe(404);
  });
});
